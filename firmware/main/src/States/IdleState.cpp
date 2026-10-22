#include "IdleState.h"
#include <Core/Application.h>
#include <Statics/ApplicationStatics.h>
#include <Routines/MotionRoutine.h>
#include <Services/MotionService.h>
#include <Util/ServiceLocator.h>
#include "BBStateMachine.h"
#include "Enums.h"
#include "ListenState.h"
#include "ConverseState.h"
#include "Util/TurnToSpeaker.h"
#include "ScenarioState.h"
#include "ScenarioRoutineMappings.h"
#include "Services/Com.h"
#include "RCState.h"
#include "Routines/RambleRoutine.h"
#include "Routines/ObserveRoutine.h"
#include "Routines/PersonRoutine.h"
#include "Routines/EventRoutines/BatteryEventRoutine.h"
#include "Routines/EventRoutines/GasEventRoutine.h"
#include "Routines/EventRoutines/IntruderEventRoutine.h"
#include "Routines/EventRoutines/ModuleEventRoutine.h"
#include "Routines/EventRoutines/PhoneConnEventRoutine.h"
#include "Routines/EventRoutines/PokeEventRoutine.h"
#include "Routines/EventRoutines/GasConfiguredEventRoutine.h"
#include "Routines/EventRoutines/SummonEventRoutine.h"
#include "Routines/WanderRoutine.h"
#include "Net/NetService.h"
#include "Net/RobotControl.h"
#include "ScenarioState.h"
#include "ScenarioRoutineMappings.h"
#include "Services/ScenarioRoutineService.h"
#include "Services/BaseBoard.h"
#include "Services/MotionService.h"
#include <optional>
#include <algorithm>
#include "Audio/MemoryAudioSource.h"
#include "Audio/PCMPassthroughGenerator.h"
#include <Services/Audio/Audio.h>
#include <esp_log.h>

DEFINE_LOG(IdleState)

// Phonemes from esp-sr tool/multinet_g2p.py (CMU: HH EY1 / HH AY1, G AE1 T S B IY0), plus the way
// MultiNet actually hears the name on this mic: " cGfN Bm" / "gl cGfNST Bm" (G EH ... B IY).
std::array<AudioFrontend::Phrase, 4> IdleState::WakePhrases = {{
	{ "hey gatsby", "hd GaTSBm", "GaTSBm" },
	{ "hi gatsby", "hi GaTSBm", "GaTSBm" },
	{ "gatsby", "GaTSBm", "GaTSBm" },
	{ "getsby", "GfTSBm", "GfTSBm" },
}};

std::vector<AudioFrontend::Phrase> IdleState::wakeSet;
size_t IdleState::wakeBase = 0;

size_t IdleState::phonemesAfterGatsby(const std::string& transcript){
	// Same pattern as soundsLikeGatsby; counts what follows the IY ('m') that ends the name.
	std::string s;
	for(char c : transcript){
		if(c != ' '){
			s += c;
		}
	}
	for(size_t g = s.find('G'); g != std::string::npos; g = s.find('G', g + 1)){
		if(g + 3 >= s.size() || (s[g + 1] != 'f' && s[g + 1] != 'a') || (s[g + 2] != 'N' && s[g + 2] != 'T')){
			continue;
		}
		const size_t m = s.find('m', g + 3);
		if(m != std::string::npos && m - (g + 3) <= 3){
			return s.size() - (m + 1);
		}
	}
	return 0;
}

bool IdleState::soundsLikeGatsby(const std::string& transcript){
	// G, then EH/AE ('f'/'a'), then N/T, then IY ('m') within a few more phonemes. Matches every
	// "hey gatsby" heard so far: GfNBm, GfNSTBm, GfTBm, GfTSBm, GfNm, GaNm, GfTSm.
	std::string s;
	for(char c : transcript){
		if(c != ' '){
			s += c;
		}
	}
	for(size_t g = s.find('G'); g != std::string::npos; g = s.find('G', g + 1)){
		if(g + 3 >= s.size() || (s[g + 1] != 'f' && s[g + 1] != 'a') || (s[g + 2] != 'N' && s[g + 2] != 'T')){
			continue;
		}
		const size_t m = s.find('m', g + 3);
		if(m != std::string::npos && m - (g + 3) <= 3){
			return true;
		}
	}
	return false;
}

const std::vector<IdleState::RandomRoutineDef> IdleState::RandomRoutines = {
	{ &makeRoutine<RambleRoutine>, 3 },
	{ &makeRoutine<ObserveRoutine>, 1 },
	{ &makeRoutine<WanderRoutine>, 2 },
	{ &makeRoutine<PersonRoutine>, 1 },
};

const std::array<EventRoutineFactory, static_cast<uint8_t>(EventBag::EventType::COUNT)> IdleState::EventRoutines = {
	nullptr, // None
	nullptr, // IncomingCall
	&makeEventRoutine<BatteryEventRoutine>,
	nullptr, // Notification
	&makeEventRoutine<GasEventRoutine>,
	&makeEventRoutine<IntruderEventRoutine>,
	&makeEventRoutine<ModuleEventRoutine>,
	&makeEventRoutine<ModuleEventRoutine>,
	&makeEventRoutine<GasConfiguredEventRoutine>,
	&makeEventRoutine<PhoneConnEventRoutine>,
	&makeEventRoutine<SummonEventRoutine>,
	nullptr, // Scenario
};

IdleState::IdleState(BBStateMachine* sm) : State(sm){
	nextRandomRoutineTime = millis() + MinRandomDelay;
	if(ServiceLocator::NetServiceInstance){
		ServiceLocator::NetServiceInstance->cancelSpeechStream(); // a listen that ended in a command, not a turn
	}

	const Application* app = ApplicationStatics::getApplication();
	eventBag = app->getService<EventBag>();
	if(eventBag == nullptr){
		CMF_LOG(IdleState, LogLevel::Error, "EventBag service missing in constructor");
		return;
	}

	ISRButtonInput* buttonInput = app->getService<ISRButtonInput>();
	if(buttonInput == nullptr){
		CMF_LOG(IdleState, LogLevel::Error, "ButtonInput service missing in constructor");
		return;
	}

	sm->bindState(buttonInput->OnButtonEvent, this, &IdleState::onButtonEvent);

	com = app->getService<Com>();
	if(com == nullptr){
		CMF_LOG(IdleState, LogLevel::Error, "Com service missing in constructor");
		return;
	}

	sm->bindState(com->OnCommand, this, &IdleState::onCommand);
	sm->bindState(com->OnRCData, this, &IdleState::onRCData);

	auto motionService = app->getService<MotionService>();
	if(motionService == nullptr){
		CMF_LOG(IdleState, LogLevel::Error, "MotionService missing in constructor");
		return;
	}

	motionService->enable();

	// Motion and Poke are not queued in the EventBag; they are handled the instant they arrive,
	// dropped while a routine is running, and dropped for StaleEventWindow after a routine ends
	// (events broadcast during a blocking routine are drained right after it retires - see
	// endActiveRoutine). Both callbacks run on the StateMachine thread.
	sm->bindState(motionService->onMotion, this, &IdleState::onMotion);

	if(AudioFrontend* afe = app->getService<AudioFrontend>()){
		sm->bindState(afe->onPhrase, this, &IdleState::onWakePhrase);
	}

	if(!eventBag->probe()){
		com->sendData(BB::State::Idle, BB::Action::Idle::None);
		startWake(); // tick() may not run for minutes when nothing is scheduled
	}
}

IdleState::~IdleState(){
	// The active routine and event bindings are torn down by BBStateMachine::destroyState().
	if(warmHandoff && wakeActive){
		// Wake phrase: stop the AFE but keep the model (and its command set) loaded for ListenState.
		wakeActive = false;
		if(AudioFrontend* afe = ApplicationStatics::getApplication()->getService<AudioFrontend>()){
			afe->setMode(AudioFrontend::Mode::Off);
			afe->setCaptureEnabled(false);
			afe->discardCapture();
		}
	}else{
		stopWake();
	}

	const Application* app = ApplicationStatics::getApplication();

	if(MotionService* motionService = app->getService<MotionService>()){
		motionService->disable();
	}
}

void IdleState::tick(float deltaTime){
	if(sm->isTransitionPending()){
		return;
	}

	if(eventBag == nullptr){
		CMF_LOG(IdleState, LogLevel::Error, "Event Bag is nullptr.");
		return;
	}

	const bool eventPending = eventBag->probe();

	// A running random routine yields to a pending event so the event is handled now.
	if(sm->getActiveRoutine() != nullptr && shouldYieldToEvent(eventPending)){
		endActiveRoutine();
	}

	// A robot command from Gatsby (via the server) comes first.
	if(sm->getActiveRoutine() == nullptr){
		maybeStartRobotCommand();
		if(leavingForCommand){
			return; // a move/dance routine starts in ScenarioState
		}
	}

	// Start a new routine if nothing is active. Pending events take priority over random routines.
	if(sm->getActiveRoutine() == nullptr){
		if(eventPending){
			startEventRoutine(eventBag->pop());
		} else{
			maybeStartRandomRoutine();
		}
	}

	// Tick whatever is active now - including a routine created during this same tick -
	// and retire it the moment it reports completion.
	if(Routine* routine = sm->getActiveRoutine()){
		lastTickingState = routine->tick(deltaTime);

		if(lastTickingState == Routine::TickingState::Done){
			endActiveRoutine();
		}
	}

	// Greet once the server first connects, then listen for the wake phrase whenever nothing
	// else needs the microphone (or the speaker: the bot shouldn't hear itself).
	if(sm->getActiveRoutine() == nullptr && !sm->isTransitionPending()){
		maybePlayGreeting();
		// A board acknowledgement on its way plays first: the wake model's reload would hold it ~2.5 s.
		const bool announcementDue = ServiceLocator::NetServiceInstance && ServiceLocator::NetServiceInstance->announcementExpected();
		if(!greetingPlaying && !announcementDue){
			startWake();
		}
	}
}

void IdleState::maybePlayGreeting(){
	Audio* audio = ApplicationStatics::getApplication()->getService<Audio>();
	if(greetingPlaying){
		greetingPlaying = audio && audio->isPlaying();
		return;
	}
	PSRAMByteBuffer greeting;
	if(!audio || !ServiceLocator::PCMGenInstance || !ServiceLocator::NetServiceInstance ||
	   !ServiceLocator::NetServiceInstance->takeGreeting(greeting)){
		return;
	}
	ESP_LOGI("WakeWord", "Playing greeting/announcement from the server");
	stopWake();
	audio->play(ServiceLocator::PCMGenInstance.get(), std::make_unique<MemoryAudioSource>(std::move(greeting)));
	greetingPlaying = true;
}

bool IdleState::wakeReady(){
	return ServiceLocator::NetServiceInstance && ServiceLocator::NetServiceInstance->isEnabled() &&
		   ServiceLocator::NetServiceInstance->isWiFiUp();
}

bool IdleState::maybeStartRobotCommand(){
	NetService* net = ServiceLocator::NetServiceInstance.get();
	std::string id, action, arg;
	if(net == nullptr || !net->takeRobotCommand(id, action, arg)){
		return false;
	}
	if(action != "summon"){
		return startCommandRoutine(net, id, action, arg);
	}
	ESP_LOGI("WakeWord", "Robot command %s: starting summon", id.c_str());
	stopWake();
	EventBag::EventData data{};
	data.type = EventBag::EventType::Summon;
	sm->startEventRoutine(EventRoutines[static_cast<uint8_t>(EventBag::EventType::Summon)], data);
	rescheduleRandomRoutine();
	return true;
}

// Gatsby's move/dance commands run the stock routines; their stock-voice lines go back to him instead.
bool IdleState::startCommandRoutine(NetService* net, const std::string& id, const std::string& action, const std::string& arg){
	net->takeActiveRobotCommand(); // reported by RobotControl, not by a routine claiming the id
	// "forward:25" = 25 cm, "left:45" = 45 degrees; a bare direction is the stock step (10 cm, 90 degrees).
	const size_t colon = arg.find(':');
	const std::string dir = arg.substr(0, colon);
	const long amount = colon == std::string::npos ? 0 : std::strtol(arg.c_str() + colon + 1, nullptr, 10);
	uint32_t moveMs = 0;
	if(amount > 0 && (dir == "forward" || dir == "backward")){
		moveMs = std::clamp<long>(amount, MoveMinCm, MoveMaxCm) * MoveMsPerCm;
	}else if(amount > 0 && (dir == "left" || dir == "right")){
		moveMs = std::clamp<long>(amount, TurnMinDeg, TurnMaxDeg) * TurnMsPer90Deg / 90;
	}

	std::optional<std::pair<BB::Action::Scenario, ScenarioData>> scenario;
	if(action == "dance"){
		scenario = { BB::Action::Scenario::Dance, {} };
	}else if(action == "move"){
		using Dir = VoiceScenarioData::Direction;
		if(dir == "forward") scenario = { BB::Action::Scenario::VoiceControl, VoiceScenarioData{ Dir::Forward } };
		else if(dir == "backward") scenario = { BB::Action::Scenario::VoiceControl, VoiceScenarioData{ Dir::Backward } };
		else if(dir == "left") scenario = { BB::Action::Scenario::VoiceControl, VoiceScenarioData{ Dir::Left } };
		else if(dir == "right") scenario = { BB::Action::Scenario::VoiceControl, VoiceScenarioData{ Dir::Right } };
		else if(dir == "around") scenario = { BB::Action::Scenario::VoiceControl, VoiceScenarioData{ Dir::Rotate } };
	}
	const RoutineFactory factory = scenario ? routineForScenario(*scenario) : nullptr;
	if(factory == nullptr || !ServiceLocator::ScenarioRoutineServiceInstance){
		ESP_LOGW("WakeWord", "Unsupported robot command \"%s %s\"", action.c_str(), arg.c_str());
		net->sendRobotResult(id, action.c_str(), "unsupported", false, false);
		return false;
	}

	const Application* app = ApplicationStatics::getApplication();
	BaseBoard* base = app->getService<BaseBoard>();
	MotionService* motion = app->getService<MotionService>();
	if(base && base->getChargingState() != ChargingState::Unplugged){
		net->sendRobotResult(id, action.c_str(), "charging", false, false);
		return false;
	}
	if(motion && !motion->isUprightOnGround()){
		net->sendRobotResult(id, action.c_str(), "unsafe", false, false);
		return false;
	}

	ESP_LOGI("WakeWord", "Robot command %s: %s %s (%u ms)", id.c_str(), action.c_str(), arg.c_str(), (unsigned) moveMs);
	stopWake();
	RobotControl::beginRoutine(id, action, moveMs);
	ServiceLocator::ScenarioRoutineServiceInstance->setRoutineFactory(factory);
	leavingForCommand = true;
	sm->transitionTo<ScenarioState>();
	return true;
}

void IdleState::startWake(){
	if(wakeActive || !wakeReady() || ServiceLocator::NetServiceInstance->hasRobotCommand()){
		return;
	}
	AudioFrontend* afe = ApplicationStatics::getApplication()->getService<AudioFrontend>();
	if(afe == nullptr){
		return;
	}
	// Register the stock commands too (same order as ListenState), so a wake can hand the loaded model
	// straight to ListenState instead of reloading it (~2s with the command FST build).
	wakeSet.clear();
	ListenState::buildCommandPhrases(wakeSet);
	wakeBase = wakeSet.size();
	wakeSet.insert(wakeSet.end(), WakePhrases.begin(), WakePhrases.end());
	afe->loadModel();
	afe->setSpeechPhrases(wakeSet);
	afe->setCaptureEnabled(true); // rolling recording, for "hey gatsby, <question>" in one breath
	afe->setMode(AudioFrontend::Mode::Wake);
	wakeActive = true;
	ESP_LOGI("WakeWord", "Listening for \"hey gatsby\"");
}

void IdleState::stopWake(){
	if(!wakeActive){
		return;
	}
	wakeActive = false;
	if(AudioFrontend* afe = ApplicationStatics::getApplication()->getService<AudioFrontend>()){
		afe->setMode(AudioFrontend::Mode::Off);
		afe->setCaptureEnabled(false);
		if(!oneBreath){
			afe->discardCapture(); // ConverseState takes it after a one-breath wake
		}
		afe->unloadModel();
	}
}

void IdleState::onWakePhrase(bool recognized, int index, const std::string& transcript, float confidence){
	// Runs on the AFE proc task: only queue the transition here (IdleState's dtor stops the AFE).
	if(!wakeActive){
		return;
	}
	if(recognized && index >= 0 && index < (int) wakeBase){
		return; // a stock command heard while idle: only the wake phrase counts here
	}
	if(!recognized || index < 0){
		// MultiNet's periodic no-match timeouts land here too; log what it heard to tune the phrase.
		if(transcript.empty()){
			return;
		}
		if(!soundsLikeGatsby(transcript)){
			ESP_LOGI("WakeWord", "No match: \"%s\"", transcript.c_str());
			return;
		}
	}
	if(ServiceLocator::LEDControlInstance){
		ServiceLocator::LEDControlInstance->startWakeAck(); // "heard you", until listening or the reply starts
	}
	AudioFrontend* afe = ApplicationStatics::getApplication()->getService<AudioFrontend>();
	const uint32_t speechMs = afe ? afe->utteranceSpeechMs() : 0;
	const bool moreAfterName = phonemesAfterGatsby(transcript) >= OneBreathMinPhonemes || speechMs >= OneBreathLongSpeechMs;
	if(afe && speechMs >= OneBreathSpeechMs && moreAfterName && ServiceLocator::NetServiceInstance &&
	   ServiceLocator::NetServiceInstance->isServerReady()){
		// "hey gatsby, <question>": the question is already in this recording. Freeze it (capture off
		// before AudioFrontend resets the utterance) and send it as-is, wake phrase included.
		afe->setCaptureEnabled(false);
		oneBreath = true;
		TurnToSpeaker::onUtteranceEnd(afe, speechMs); // turned toward while the server works on the reply
		ESP_LOGI("WakeWord", "Heard \"%s\" with a question (%u ms of speech): sending it", transcript.c_str(), (unsigned) speechMs);
		sm->transitionTo<ConverseState>();
		return;
	}
	ESP_LOGI("WakeWord", "Heard \"%s\" (%u ms of speech), listening", transcript.c_str(), (unsigned) speechMs);
	TurnToSpeaker::noteWake(afe, speechMs); // fallback if the question gives no clear reading
	warmHandoff = true;
	ListenState::requestWarmStart();
	sm->transitionTo<ListenState>();
}

bool IdleState::shouldYieldToEvent(bool eventPending) const{
	// Only random (non-event) routines yield; an active EventRoutine runs to completion.
	const Routine* routine = sm->getActiveRoutine();
	return routine != nullptr && !routine->isEventRoutine() && eventPending;
}

void IdleState::endActiveRoutine(){
	sm->endRoutine();

	// Poke/Motion events broadcast while the routine blocked this thread sit in their CMF callQueues
	// and get drained on the very next scanEvents pass, where the canStartInstantRoutine() guard would
	// let the first one through. They arrive within ~1ms of this point; anything handled inside the
	// window is stale and dropped.
	instantEventCutoff = millis() + StaleEventWindow;

	lastTickingState = Routine::TickingState::None;

	com->sendData(BB::State::Idle, BB::Action::Idle::None);
}

void IdleState::startEventRoutine(const EventBag::EventData& data){
	if(data.type == EventBag::EventType::Scenario){
		startScenario(data);
		return;
	}

	// Some event types (e.g. IncomingCall, Notification) have no routine mapped. Drop them instead of constructing a null routine.
	const EventRoutineFactory factory = EventRoutines[static_cast<uint8_t>(data.type)];
	if(factory == nullptr){
		CMF_LOG(IdleState, LogLevel::Warning, "No EventRoutine mapped for event type %u", static_cast<uint8_t>(data.type));
		com->sendData(BB::State::Idle, BB::Action::Idle::None);
		rescheduleRandomRoutine();
		return;
	}

	// Each routine is implemented to take only one parameter of type EventBag::EventData, that it then interprets in its own way.
	stopWake();
	sm->startEventRoutine(factory, data);

	rescheduleRandomRoutine();
}

void IdleState::startScenario(const EventBag::EventData& data){
	const EventBag::ScenarioEventData* scenarioEvent = std::get_if<EventBag::ScenarioEventData>(&data.payload);
	if(scenarioEvent == nullptr || !ServiceLocator::ScenarioRoutineServiceInstance){
		CMF_LOG(IdleState, LogLevel::Error, "Scenario event missing payload or ScenarioRoutineService");
		com->sendData(BB::State::Idle, BB::Action::Idle::None);
		rescheduleRandomRoutine();
		return;
	}

	const RoutineFactory factory = routineForScenario({ scenarioEvent->scenario, scenarioEvent->data });
	if(factory == nullptr){
		CMF_LOG(IdleState, LogLevel::Error, "No routine mapped for scenario %d", static_cast<int>(scenarioEvent->scenario));
		com->sendData(BB::State::Idle, BB::Action::Idle::None);
		rescheduleRandomRoutine();
		return;
	}

	ServiceLocator::ScenarioRoutineServiceInstance->setRoutineFactory(factory);
	sm->transitionTo<ScenarioState>();
}

void IdleState::maybeStartRandomRoutine(){
	if(RandomRoutines.empty()){
		rescheduleRandomRoutine();
		return;
	}

	// While the button is held, suppress new random routines so none start before the transition to ListenState commits on release.
	if(buttonHeld){
		return;
	}

	if(millis() < nextRandomRoutineTime){
		return;
	}

	RoutineFactory nextRandomRoutine = pickRandomRoutine();
	if(nextRandomRoutine != nullptr){
		stopWake();
		sm->startRoutine(nextRandomRoutine);
	}

	rescheduleRandomRoutine();
}

RoutineFactory IdleState::pickRandomRoutine() const{
	size_t weightSum = 0;
	for(const RandomRoutineDef& routineDef : RandomRoutines){
		weightSum += routineDef.weight;
	}

	const size_t random = rand() % (weightSum + 1);

	size_t sum = 0;
	for(const RandomRoutineDef& routineDef : RandomRoutines){
		if(routineDef.weight == 0){
			continue;
		}

		sum += routineDef.weight;

		if(random <= sum){
			return routineDef.routine;
		}
	}

	return nullptr;
}

void IdleState::rescheduleRandomRoutine(){
	nextRandomRoutineTime = millis() + (rand() % (MaxRandomDelay - MinRandomDelay) + MinRandomDelay);
}

int64_t IdleState::getDynamicTickInterval() const{
	if(eventBag == nullptr){
		CMF_LOG(IdleState, LogLevel::Error, "Event Bag is nullptr.");
		return -1;
	}

	if(eventBag->probe()){
		return 0;
	}

	if(ServiceLocator::NetServiceInstance && ServiceLocator::NetServiceInstance->hasRobotCommand()){
		return 0;
	}

	// Connect greeting pending or playing: check back often so it plays promptly and the wake
	// listener resumes right after.
	if(sm->getActiveRoutine() == nullptr && (greetingPlaying ||
	   (ServiceLocator::NetServiceInstance && ServiceLocator::NetServiceInstance->greetingPending()))){
		return 250;
	}

	// Wake listener not running yet (e.g. at boot, before NetService exists or WiFi is up): check back
	// every second. Uses the static check since this is first evaluated before NetService is created.
	if(!wakeActive && sm->getActiveRoutine() == nullptr && NetService::isConfigured()){
		return 1000;
	}

	if(sm->getActiveRoutine() != nullptr){
		if(lastTickingState == Routine::TickingState::Continue){
			return 0;
		}

		// Block: sleep until the awaited event wakes the tick thread.
		if(lastTickingState == Routine::TickingState::Block){
			return portMAX_DELAY;
		}
	}

	if(millis() >= nextRandomRoutineTime){
		return 0;
	}

	// Frames from the server (announcements, robot commands) don't wake this thread: in companion
	// mode check back often instead of sleeping until the next random routine (a board announcement
	// waited 4.5 s here, ready to play).
	const int64_t untilRandom = nextRandomRoutineTime - millis();
	return NetService::isConfigured() ? std::min<int64_t>(untilRandom, ServerPollMs) : untilRandom;
}

// Button or app "listen": hand the loaded wake model over like a wake phrase does. Reloading it took
// ~2.5 s after the listening prompt, and a question asked straight after the prompt was lost.
void IdleState::listenNow(){
	if(wakeActive){
		warmHandoff = true;
		ListenState::requestWarmStart();
	}
	sm->transitionTo<ListenState>();
}

void IdleState::onCommand(Ctrl::Command cmd){
	if(cmd == Ctrl::Command::Listen){
		listenNow();
		return;
	}

	if(cmd == Ctrl::Command::Poke && millis() >= instantEventCutoff && canStartInstantRoutine()){
		stopWake();
		sm->startRoutine<PokeEventRoutine>();
	}
}

void IdleState::onMotion(MotionType type){
	if(millis() >= instantEventCutoff && canStartInstantRoutine()){
		stopWake();
		sm->startRoutine<MotionRoutine>(type);
	}
}

bool IdleState::canStartInstantRoutine() const{
	return sm->getActiveRoutine() == nullptr && !sm->isTransitionPending();
}

void IdleState::onRCData(const RCData& data){
	if(ServiceLocator::ControllerStateInstance){
		ServiceLocator::ControllerStateInstance->updateRCData(data);
	}

	sm->transitionTo<RCState>();
	return;
}

void IdleState::onButtonEvent(int button, ISRButtonInput::Action action){
	if(button != static_cast<int>(Button::Power)){
		return;
	}

	if(action == ISRButtonInput::Action::Press){
		buttonHeld = true;
		lastBtnPressTime = millis();
		return;
	}

	buttonHeld = false;

	if(millis() - lastBtnPressTime > MaximumBtnHoldForTransition){
		return;
	}

	listenNow();
}
