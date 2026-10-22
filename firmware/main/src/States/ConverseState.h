#ifndef BUTTERBOT_FIRMWARE_CONVERSESTATE_H
#define BUTTERBOT_FIRMWARE_CONVERSESTATE_H

#include <memory>
#include "State.h"
#include "CtrlData.h"
#include "Services/Com.h"
#include "Services/ISRButtonInput.h"

class Audio;
class AudioStream;
class NetService;

/**
 * Companion-mode conversation turn. Entered from ListenState when on-device recognition didn't
 * match a stock command but speech was heard:
 *   1. send the captured utterance to the server (speech_request + PCM)
 *   2. if no reply has started FillerDelayMs after the upload, play the cached in-character filler line
 *   3. queue the real reply behind the filler as soon as it starts arriving (it plays while downloading)
 *   4. when playback ends: a short follow-up listen after a real reply (ListenState), else back to Idle
 * If the server can't be reached or the turn fails, plays the hard fallback line instead.
 * Kept small: the state lives in BBStateMachine's 512-byte placement buffer.
 */
class ConverseState : public State {
public:
	explicit ConverseState(BBStateMachine* sm);

	/** Next ConverseState comes from a follow-up listen: if no speech is found, go quiet instead of
	 *  playing the "didn't catch that" line (it was most likely room noise, not a question). */
	static void markFollowUp(){ followUpNext = true; }
	~ConverseState() override;

	void tick(float deltaTime) override;
	int64_t getDynamicTickInterval() const override { return 50; }

private:
	enum class Phase : uint8_t { Waiting, Finishing };
	Phase phase = Phase::Finishing;

	Audio* audio = nullptr;
	NetService* net = nullptr;

	uint64_t turnStartMs = 0;
	uint64_t errorSeenMs = 0;
	std::shared_ptr<AudioStream> replyStream;
	bool fillerTried = false;
	bool followUp = false;
	static bool followUpNext;
	static constexpr uint64_t FillerDelayMs = 4000; // after the upload; chat replies start 2.4-3.3s, tool turns 5-7s
	bool replied = false; // a real reply played: listen for a follow-up afterwards

	// Give up on the server after this long with no reply (counted from the end of the upload). 60 s:
	// a "think hard" turn (Claude Code research) took 25 s and was dropped at the old 20 s.
	static constexpr uint64_t TurnTimeoutMs = 60000;
	// Once the server has replied, its audio downloads at roughly real time, so a long reply can take
	// well past TurnTimeoutMs. Keep waiting while data arrives; give up on a stall or an absurd total.
	static constexpr uint32_t ReplyStallMs = 10000;
	static constexpr uint64_t ReplyMaxMs = 90000;
	// After speech_error, how long to wait for the server's pushed pipeline_error line.
	static constexpr uint64_t ErrorGraceMs = 3000;

	void playFallback();
	void playTimeoutPhrase();
	void abort();

	void onButtonEvent(int button, ISRButtonInput::Action action);
	void onCommand(Ctrl::Command cmd);
	void onRCData(const RCData& data);
};

#endif //BUTTERBOT_FIRMWARE_CONVERSESTATE_H
