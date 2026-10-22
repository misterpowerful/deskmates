#ifndef BUTTERBOT_FIRMWARE_NETSERVICE_H
#define BUTTERBOT_FIRMWARE_NETSERVICE_H

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <esp_event.h>
#include <esp_netif.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include "Util/PSRAMAllocator.h"

class AudioStream;
struct esp_websocket_client;
typedef struct esp_websocket_client* esp_websocket_client_handle_t;

/**
 * Companion mode networking: joins home WiFi / phone hotspot (DHCP, real internet) and keeps
 * one long-lived WebSocket open to the server.
 *
 * Deliberately independent from CMF's WiFi class, which hardcodes the controller link's static
 * 11.0.0.x addressing and can't reach the internet. The two can never run at the same time
 * (both own the ESP-IDF default event loop and WiFi driver), so RCState calls suspend() before
 * building its own WiFi and resume() after tearing it down.
 *
 * Wire protocol matches the butterbot server (server.js): JSON header frame, then one binary
 * frame of raw 16kHz/mono/16-bit PCM, correlated by "id".
 */
class NetService {
public:
	NetService();
	~NetService();

	/** Bring up companion WiFi + WebSocket. No-op if already running or no networks configured. */
	void start();

	/** Full, blocking teardown of WiFi, WebSocket and the default event loop. Safe to call twice. */
	void suspend();

	/** Same as start(); named for symmetry with suspend(). */
	void resume(){ start(); }

	bool isEnabled() const { return isConfigured(); }

	/** Companion mode compiled in with networks configured. Usable before the service exists. */
	static bool isConfigured();
	bool isWiFiUp() const { return wifiUp.load(); }
	bool isServerReady() const { return serverUp.load(); }

	// ---------- Filler lines ----------

	/** Moves the cached filler (raw PCM) into out. Returns false if none cached. Call prefetchFiller() once the turn is over. */
	bool takeFiller(PSRAMByteBuffer& out);

	/** Requests a filler (and a "listening" acknowledgement) from the server if not cached or in flight. */
	void prefetchFiller();

	/** Moves the cached in-voice "listening" acknowledgement (raw PCM) into out. False if none cached. */
	bool takeListenAck(PSRAMByteBuffer& out);

	// ---------- Connect greeting ----------

	/** True from boot until the first-connect greeting has been handed out (or the server had none). */
	bool greetingPending() const;

	/** Moves the downloaded greeting (raw PCM) into out. Returns false if it hasn't arrived. */
	bool takeGreeting(PSRAMByteBuffer& out);
	// (Robot announcements from the server - Gatsby reacting to a robot_result - land in the same
	//  slot and are played by IdleState the same way.)

	// ---------- Robot commands (Gatsby driving the robot) ----------

	/** A robot_command from the server is waiting to be run. */
	bool hasRobotCommand() const;

	/** Takes the waiting command; it becomes the active one until takeActiveRobotCommand(). */
	bool takeRobotCommand(std::string& id, std::string& action);

	/** The routine running the active command claims its id (to report back); "" if none. */
	std::string takeActiveRobotCommand();

	/** Reports how a robot command ended (robot_result). */
	void sendRobotResult(const std::string& id, const char* action, const char* outcome, bool ownerRecognized, bool ownerEnrolled);

	// ---------- Speech turns ----------

	enum class TurnStatus : uint8_t {
		Idle,           // no turn in progress
		Pending,        // request sent, waiting on server
		ErrorAwaiting,  // server reported speech_error; a pushed pipeline_error line may still follow
		Streaming,      // response audio is arriving (real reply, memory ack, or pipeline_error line)
		NoSpeech,       // server heard nothing usable
		Failed          // hard failure (disconnect, canned_error, send failure)
	};

	/** Sends speech_request + the utterance. Returns false (and leaves no turn pending) on failure. */
	bool sendSpeech(const int16_t* samples, size_t count);

	// Upload while the person is still talking (ListenState captures): AudioFrontend feeds each new
	// chunk from just before speech starts, a background task sends it as it arrives, and
	// finishSpeechStream() closes it and starts the turn the way sendSpeech() does - so the server
	// already has the audio when the speaker stops, instead of waiting out a whole upload.
	void streamSpeech(const int16_t* samples, size_t count); // AFE proc task
	bool hasSpeechStream() const;
	/** False if the stream failed: the caller sends the whole capture with sendSpeech() instead. */
	bool finishSpeechStream();
	void cancelSpeechStream();

	TurnStatus getTurnStatus() const;

	/** If status is Streaming, hands out the reply audio (still downloading) and resets the turn to Idle. */
	bool takeTurnStream(std::shared_ptr<AudioStream>& out);

	/** Abandons the current turn; any late reply for it is discarded. */
	void cancelTurn();

	/** True once the server has answered the pending turn (speech_result) and its audio is downloading. */
	bool isTurnReplyStarted() const { return turnReplyStarted.load(); }

	/** The server said it's running a tool for this turn (turn_progress): the reply will be slow. */
	bool isTurnToolInProgress() const { return turnToolInProgress.load(); }

	/** Milliseconds since the websocket last delivered any data. Detects a stalled reply download. */
	uint32_t msSinceLastRx() const { return (uint32_t) ((esp_timer_get_time() - lastRxUs.load()) / 1000); }

private:
	// WiFi
	std::atomic_bool running{ false };
	std::atomic_bool suspending{ false };
	std::atomic_bool wifiUp{ false };
	esp_netif_t* netif = nullptr;
	esp_event_handler_instance_t wifiHandler = nullptr;
	esp_event_handler_instance_t ipHandler = nullptr;
	esp_timer_handle_t retryTimer = nullptr;
	size_t networkIndex = 0;
	uint8_t attemptsOnNetwork = 0;
	size_t networksTriedThisRound = 0;

	void applyNetwork(size_t index);
	void onWiFiEvent(int32_t id, void* data);
	void onIpEvent(int32_t id, void* data);
	static void wifiEventTrampoline(void* arg, esp_event_base_t base, int32_t id, void* data);
	static void retryTimerCb(void* arg);

	// Fetches the first filler shortly after the server connects (not from inside the ws event handler).
	esp_timer_handle_t fillerTimer = nullptr;
	static void fillerTimerCb(void* arg);
	void requestGreeting();
	bool requestCanned(const char* category, char idPrefix, std::string& reqId, const PSRAMByteBuffer& cache);

	// Rebuilds the websocket if WiFi is up but the server has been unreachable for a while
	// (the client gives up for good after some server-side closes).
	esp_timer_handle_t watchTimer = nullptr;
	int64_t serverDownSinceUs = 0;
	static void watchTimerCb(void* arg);

	// WebSocket
	std::atomic_bool serverUp{ false };
	esp_websocket_client_handle_t ws = nullptr;
	std::recursive_mutex wsMtx; // guards ws create/destroy against concurrent sends
	std::string sessionUri;
	std::string authHeader;

	void startWebSocket();
	void stopWebSocket();
	static void wsEventTrampoline(void* arg, esp_event_base_t base, int32_t id, void* data);
	void onWsEvent(int32_t id, void* data);
	bool sendText(const std::string& json);

	// Incoming message reassembly (runs on the websocket task only)
	bool rxIsBinary = false;
	std::string rxText;
	PSRAMByteBuffer rxBin;
	bool rxDropping = false;
	size_t rxNextProgressLog = 0;
	size_t rxReceived = 0;
	std::shared_ptr<AudioStream> rxStream; // turn reply audio being received
	void resetRx();
	int64_t rxStartUs = 0;
	std::atomic<int64_t> lastRxUs{ 0 };
	void onTextMessage(const std::string& json);
	void onBinaryMessage(PSRAMByteBuffer&& data);

	// Shared state, guarded by mtx
	mutable std::mutex mtx;
	enum class BinDest : uint8_t { None, Filler, Greeting, ListenAck, Turn, Discard };
	BinDest expectBin = BinDest::None;
	size_t expectBinBytes = 0; // size the server announced for the next binary frame (0 = unknown)
	uint32_t idCounter = 0;

	std::string fillerReqId;
	PSRAMByteBuffer cachedFiller;

	std::string robotCmdId, robotCmdAction; // waiting robot_command
	std::string activeRobotCmdId;           // taken by IdleState, claimed by the routine

	bool greetingWanted = true; // only the first connection after boot is greeted
	std::string greetingReqId;
	PSRAMByteBuffer cachedGreeting;

	std::string listenReqId;
	PSRAMByteBuffer cachedListen;

	std::string turnId;
	TurnStatus turnStatus = TurnStatus::Idle;
	std::shared_ptr<AudioStream> turnStream;
	std::atomic_bool turnReplyStarted{ false };
	std::atomic_bool turnToolInProgress{ false };

	void failTurnLocked(const char* reason);

	enum class UpState : uint8_t { None, Open, Ending, Failed };
	mutable std::mutex upMtx;
	UpState upState = UpState::None;
	std::string upId;
	bool upHeaderSent = false;
	bool upBusy = false;              // the upload task holds a chunk it hasn't finished sending
	PSRAMVector<int16_t> upQueue;     // audio not yet sent
	size_t upBytesSent = 0;
	TaskHandle_t upTask = nullptr;
	static void upTaskFunc(void* arg);
	void upLoop();
};

#endif //BUTTERBOT_FIRMWARE_NETSERVICE_H
