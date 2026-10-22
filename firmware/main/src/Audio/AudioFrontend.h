#ifndef BUTTERBOT_FIRMWARE_AUDIOFRONTEND_H
#define BUTTERBOT_FIRMWARE_AUDIOFRONTEND_H

#include "Object/Object.h"
#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>
#include <freertos/ringbuf.h>
#include <freertos/semphr.h>
#include <array>
#include <atomic>
#include <mutex>
#include <functional>
#include <cstdint>
#include <vector>
#include "esp_vad.h"
#include "esp_mn_iface.h"
#include "MicInput.h"
#include "Util/PSRAMAllocator.h"
#include "Thread/Threaded.h"
#include "Event/EventBroadcaster.h"
#include "esp_afe_sr_iface.h"
#include "esp_mn_iface.h"
#include "model_path.h"
#include "Services/LEDControl.h"

class AudioFrontend : public Object {
	GENERATED_BODY(AudioFrontend, Object, void);
public:
	AudioFrontend();

	~AudioFrontend() override;

	enum class Mode : uint8_t {
		Audio, Wake, Speech, VAD, Off
	};

	void setMode(Mode mode);

	static constexpr float DefaultFuzzyThreshold = 0.2f;

	struct Phrase {
		const char* string; //Phrase string (graphemes)
		const char* phonemes; //Phrase phonemes, generated using multinet_g2p.py[esp-sr/tool/multinet_g2p.py]
		const char* fuzzyCore = nullptr;
		float fuzzyThreshold = DefaultFuzzyThreshold;
		const void* action = nullptr;
	};

	struct PhraseResult {
		bool recognized;
		int index;
		std::string transcript;
		float confidence;
	};

	/**
	 * Clears previous phrases and replaces them with specified phrases.
	 */
	void setSpeechPhrases(std::span<Phrase> phrases);

	/** True once VAD has heard speech since Mode::Speech/Wake was entered. */
	bool heardSpeech() const { return captureHeardSpeech.load(); }

	/** VAD speech in the utterance being decided (valid inside an onPhrase callback). */
	uint32_t utteranceSpeechMs() const { return (uint32_t) (speechSamples / 16); }

	/** Inter-channel direction estimate (TurnToSpeaker), medians over the louder recent windows. */
	struct Direction {
		int windows = 0;   // windows used (0 = no estimate)
		float lagF = 0;    // samples by which the right channel trails the left (parabolic sub-sample fit)
		float corr = 0;    // normalized cross-correlation at that lag (1 = identical shape)
	};

	/** Direction over the last windowMs of Wake/Speech-mode audio (the louder half of the windows). */
	Direction estimateDirection(uint32_t windowMs);

	/**
	 * Blocks until a phrase is detected or the recognition window times out.
	 * Mode must be Off before calling. Sets mode to Speech internally and restores it to Off on return.
	 */
	PhraseResult waitForPhrase();

	void setOutputBuffer(RingbufHandle_t rb);

	/**
	 * Adjust voice activity detection parameters.
	 * Can only be called when AudioFrontend's Mode is set to Off
	 * @param vad_mode The value can be: VAD_MODE_0 to VAD_MODE_4, ranging from least to most aggressive detection rate
	 * @param min_speech_ms The minimum duration of speech in ms. It should be bigger than 32 ms, default: 128 ms
	 * @param min_noise_ms The minimum duration of noise or silence in ms. It should be bigger than 64 ms, default: 1000 ms
	 * @param vad_delay_ms The delay of the first speech frame in ms, default: 128 ms
	 */
	void setVADParams(vad_mode_t vad_mode, int min_speech_ms, int min_noise_ms, int vad_delay_ms);


	/**
	 * size_t samples - number of samples sent to output buffer; 0 - outputBuffer is full
	 */
	DECLARE_EVENT(AudioEvent, AudioFrontend, size_t)
	AudioEvent onAudio = AudioEvent(this);

	/**
	 * bool recognized - true if a registered phrase (or abort phrase) was detected, false if timeout - also invalidates all values except transcript
	 * int index - index of detected phrase, from previously set phrases with setSpeechPhrases(), -1 for abort phrases
	 * std::string transcript - phonemic transcript of detected phrase
	 * float confidence - confidence of detection
	 */
	DECLARE_EVENT(PhraseEvent, AudioFrontend, bool, int, std::string, float)
	PhraseEvent onPhrase = PhraseEvent(this);

	/**
	 * bool active - true when voice activity is ongoing, false when no voice activity.
	 * Fires only on changes; the first fetch after entering Mode::VAD always fires
	 * to publish the initial state.
	 */
	DECLARE_EVENT(VADEvent, AudioFrontend, bool)
	VADEvent onVAD = VADEvent(this);

	void loadModel();
	void unloadModel();

	/**
	 * Companion mode: everything the AFE hears while in Mode::Speech is also copied into a PSRAM
	 * capture buffer (reset each time Speech mode starts). If on-device recognition doesn't match
	 * a stock command, ListenState hands this to ConverseState to send to the server.
	 * Only call while Mode is Off. heardSpeech is true if VAD flagged speech at any point.
	 */
	PSRAMVector<int16_t> takeCapture(bool& heardSpeech);
	void discardCapture();

	/** Capture only runs for ListenState, not for stock routines (dance, IR training...) that also use Speech mode. Set before setMode(Speech). */
	void setCaptureEnabled(bool enabled){ captureEnabled = enabled; }

	/** Speech mode with capture on: called on the proc task with each new chunk of the capture, from
	 *  CapturePadSamples before speech starts (NetService::streamSpeech). Set only while Off. */
	void setCaptureStream(std::function<void(const int16_t*, size_t)> sink){ streamSink = std::move(sink); }

private:
	void feedTaskFunc();

	std::unique_ptr<Threaded> feedTask;

	void procTaskFunc();

	std::unique_ptr<Threaded> procTask;

	/**
	 * Event group that coordinates whether the feed/proc tasks should be doing work.
	 * When RunBit is clear, each task blocks at the start of its loop on its respective gate
	 * until RunBit is set again. AtGate bits let setMode/the constructor wait until the tasks
	 * have actually reached the blocked state before mutating shared state.
	 */
	EventGroupHandle_t taskGate = nullptr;
	static constexpr EventBits_t RunBit = BIT0;
	static constexpr EventBits_t FeedAtGate = BIT1;
	static constexpr EventBits_t ProcAtGate = BIT2;

	void waitAtGate(EventBits_t atGateBit);

	void processAudio(afe_fetch_result_t* res);

	void processSpeech(afe_fetch_result_t* res);

	void processVAD(afe_fetch_result_t* res);

	// Last vad_state observed in Mode::VAD that was broadcast on onVAD.
	// -1 is a sentinel meaning "nothing fired yet"; used to force the first
	// fetch after entering VAD mode to publish the initial state.
	std::atomic<int8_t> lastVADState{ -1 };

	std::atomic<Mode> currentMode = Mode::Off;

	RingbufHandle_t outputBuffer = nullptr;

	srmodel_list_t* models = nullptr;

	afe_config_t* afe_config = nullptr;
	const esp_afe_sr_iface_t* afe_handle = nullptr;
	esp_afe_sr_data_t* afe_data = nullptr;

	esp_mn_iface_t* multinet_handle = nullptr;
	model_iface_data_t* multinet_data = nullptr;

	//MultiNet speech recognition buffer size
	//Companion mode: raised from stock 4000 so free-form sentences for the server aren't cut
	//off. Recognized stock commands still fire immediately; only the no-match timeout gets longer.
	static constexpr int32_t MultinetDuration = 6000; //[ms]

	//Companion mode endpointing: end the utterance once VAD has heard this much silence after speech
	//(500ms: the owner, 2026-10-13; the web app uses 700ms), ignoring blips shorter than MinUtteranceSamples (coughs, clicks).
	static constexpr int VadEndSilenceMs = 500;
	static constexpr size_t MinUtteranceSamples = 16000 * 3 / 10; // 300ms
	bool vadInSpeech = false; // proc task only
	size_t speechSamples = 0; // VAD_SPEECH samples in the current utterance (proc task only)
	// Wake mode with capture on keeps only this much audio before speech starts (a rolling pre-roll).
	static constexpr size_t WakePreRollSamples = 16000 / 2; // 500ms
	void resetWakeUtterance();

	// Direction of arrival (TurnToSpeaker), as in a4f5e8b: cross-correlation of the raw stereo on the
	// feed task, before the AFE mixes it down. Only the lag is kept (the SRP-PHAT angle went unused).
	static constexpr int MaxLag = 6;              // ~2 in between the mics is ~2.4 samples at 16 kHz
	static constexpr int DoaWindowSamples = 1024; // per channel, 64 ms
	struct DoaSample { uint32_t ms; uint32_t level; float lagF; float corr; };
	PSRAMVector<int16_t> doaLeft, doaRight;
	size_t doaFill = 0;
	std::array<DoaSample, 128> doaRing{}; // ~8 s
	size_t doaHead = 0, doaCount = 0;
	std::mutex doaMtx;
	void processDoa(const int16_t* interleaved, size_t frames);

	//Companion mode utterance capture (see takeCapture)
	static constexpr size_t MaxCaptureSamples = 16000 * 8; // 8s @ 16kHz mono, 256KB PSRAM
	PSRAMVector<int16_t> capture;
	std::atomic<bool> captureHeardSpeech{ false };
	size_t captureSpeechStart = SIZE_MAX; // first sample of the first VAD_SPEECH frame
	size_t captureSpeechEnd = 0;          // one past the last VAD_SPEECH frame
	static constexpr size_t CapturePadSamples = 16000 * 3 / 10; // 300ms either side of speech
	std::atomic<bool> captureEnabled{ false };
	std::function<void(const int16_t*, size_t)> streamSink;
	size_t streamedUpTo = SIZE_MAX; // capture samples already streamed; SIZE_MAX = none yet

	static constexpr float MultinetDetThreshold = 0.35f;

	/*
	 * FeedBuffer size is inferred from chunksize in runtime, since it can depend on available AFE features and config.
	 * This would change if the underlying AudioFrontend's configuration is modified.
	 */
	static constexpr size_t FeedBufferSize = 1024;
	PSRAMVector<int16_t> feedBuffer; //Buffer used by feedTask; sized to FeedBufferSize in ctor, backed by PSRAM

	SemaphoreHandle_t phraseSem = nullptr;
	PhraseResult phraseWaitResult{};
	std::atomic<bool> phraseWaiting{ false };

	std::string lastRawTranscript;

	std::vector<Phrase> speechPhrases;

	int fuzzyMatch(const std::string& transcript);

	void reportPhrase(bool recognized, int index, const std::string& transcript, float confidence);

	static constexpr int AbortAction{};

	static constexpr Phrase AbortPhrases[] = {
		{ "cancel", "KaNScL", "KaNScL", DefaultFuzzyThreshold, &AbortAction },
		{ "nevermind", "NfVkMiND", "NfVkMiND", DefaultFuzzyThreshold, &AbortAction }
	};
	static constexpr uint8_t AbortPhrasesNum = 2;
};


#endif //BUTTERBOT_FIRMWARE_AUDIOFRONTEND_H
