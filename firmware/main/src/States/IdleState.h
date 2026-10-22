#ifndef BUTTERBOT_FIRMWARE_IDLESTATE_H
#define BUTTERBOT_FIRMWARE_IDLESTATE_H

#include <array>
#include <atomic>
#include <string>
#include <vector>
#include <CtrlData.h>
#include "State.h"
#include "StateRoutineFactory.h"
#include "EventBag.h"
#include "Services/Com.h"
#include "Services/ISRButtonInput.h"
#include "Services/MotionService.h"
#include "Audio/AudioFrontend.h"

class IdleState : public State {
public:
	explicit IdleState(BBStateMachine* sm);
	~IdleState() override;

	virtual void tick(float deltaTime) override;
	virtual int64_t getDynamicTickInterval() const override;

private:
	struct RandomRoutineDef {
		RoutineFactory routine;
		uint8_t weight; // The higher the weight, the more likely the routine will be chosen randomly. If 0, routine will never be chosen.
	};

	static const std::vector<RandomRoutineDef> RandomRoutines;
	static const std::array<EventRoutineFactory, static_cast<uint8_t>(EventBag::EventType::COUNT)> EventRoutines;

	// Random delay works in a [MinRandomDelay, MaxRandomDelay> range
	static constexpr TickType_t MinRandomDelay = 5 * 60000;
	static constexpr TickType_t MaxRandomDelay = 20 * 60000;

private:
	EventBag* eventBag = nullptr;
	uint64_t lastBtnPressTime;
	uint64_t nextRandomRoutineTime;
	Com* com = nullptr;
	Routine::TickingState lastTickingState = Routine::TickingState::None;
	bool buttonHeld = false;
	// Poke/Motion events handled before this time are stale (queued while a routine ran) and are dropped.
	uint64_t instantEventCutoff = 0;

	// Companion mode wake phrase ("hey/hi gatsby"), spotted by MultiNet while idle and nothing else
	// is using the microphone. Paused for every routine, since many of them use AudioFrontend.
	static std::array<AudioFrontend::Phrase, 4> WakePhrases;
	static bool soundsLikeGatsby(const std::string& transcript);
	// Phonemes heard after the name in a raw MultiNet transcript (0 if no match): > 0 means more was said.
	static size_t phonemesAfterGatsby(const std::string& transcript);
	std::atomic_bool wakeActive{ false };
	std::atomic_bool warmHandoff{ false }; // wake heard: leave the model loaded for ListenState
	std::atomic_bool oneBreath{ false };   // wake + question in one utterance: hand the capture to ConverseState
	static constexpr uint32_t OneBreathSpeechMs = 1500;   // "hey gatsby" alone is ~0.6-1.5s of speech
	static constexpr size_t OneBreathMinPhonemes = 3;     // ...so also require words after the name
	static constexpr uint32_t OneBreathLongSpeechMs = 2500; // or an utterance clearly longer than the name
	static std::vector<AudioFrontend::Phrase> wakeSet; // stock commands, then WakePhrases
	static size_t wakeBase;                            // index of the first wake phrase in wakeSet
	bool greetingPlaying = false; // connect greeting is playing: keep the wake listener off meanwhile
	void maybePlayGreeting();

	static constexpr uint64_t MaximumBtnHoldForTransition = 500;
	static constexpr uint64_t StaleEventWindow = 100; // ms

private:
	void onCommand(Ctrl::Command cmd);
	void onRCData(const RCData& data);
	void onButtonEvent(int button, ISRButtonInput::Action action);
	void onMotion(MotionType type);
	void onWakePhrase(bool recognized, int index, const std::string& transcript, float confidence);

	bool maybeStartRobotCommand();
	void startWake();
	void stopWake();
	// Companion WiFi is up (NetService is created after IdleState at boot, so this polls until it is).
	static bool wakeReady();

	// tick() helpers. All run on the StateMachine thread, serialized with onButtonEvent.
	bool shouldYieldToEvent(bool eventPending) const;
	// True when a Motion/Poke routine may start now: nothing is running and no transition is queued.
	bool canStartInstantRoutine() const;
	void endActiveRoutine();
	void startEventRoutine(const EventBag::EventData& data);
	void startScenario(const EventBag::EventData& data);
	void maybeStartRandomRoutine();
	RoutineFactory pickRandomRoutine() const;
	void rescheduleRandomRoutine();
};

#endif //BUTTERBOT_FIRMWARE_IDLESTATE_H
