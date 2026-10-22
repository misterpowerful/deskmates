#include "ConverseState.h"
#include "BBStateMachine.h"
#include "IdleState.h"
#include "ListenState.h"
#include "Util/TurnToSpeaker.h"
#include "RCState.h"
#include <Core/Application.h>
#include <Statics/ApplicationStatics.h>
#include <Services/Audio/Audio.h>
#include <Util/ServiceLocator.h>
#include <Phrases.h>
#include <esp_log.h>
#include <utility>
#include <esp_heap_caps.h>
#include "Audio/AudioFrontend.h"
#include "Audio/MemoryAudioSource.h"
#include "Audio/StreamAudioSource.h"
#include "Audio/SpeechAudioSource.h"
#include "Audio/SpeechGen.h"
#include "Net/NetService.h"
#include "Util/PSRAMAllocator.h"
#include "Enums.h"
#include <Util/stdafx.h>

static const char* TAG = "ConverseState";

namespace {
	// Hard fallback, per the architecture doc. Lives in firmware (not on the server) because it's
	// what plays when the server can't be reached. v1 speaks it with the stock on-device synth;
	// swapping in a pre-rendered clip in Gatsby's voice is a later polish item.
	constexpr const char* FallbackLine = "Well, you've gone and done it. I'm speechless.";

	// Internal RAM shrinks across turns until a model load starves the radio; log it per turn stage.
	void logHeap(const char* where){
		ESP_LOGI(TAG, "[heap turn %s] internal free %u, largest block %u, min ever %u", where,
				 (unsigned) heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
				 (unsigned) heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
				 (unsigned) heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL));
	}
}

bool ConverseState::followUpNext = false;

ConverseState::ConverseState(BBStateMachine* sm) : State(sm){
	followUp = std::exchange(followUpNext, false);
	const Application* app = ApplicationStatics::getApplication();
	audio = app->getService<Audio>();
	net = ServiceLocator::NetServiceInstance.get();
	turnStartMs = millis();
	logHeap("start");

	if(auto buttons = app->getService<ISRButtonInput>()){
		sm->bindState(buttons->OnButtonEvent, this, &ConverseState::onButtonEvent);
	}
	if(Com* com = app->getService<Com>()){
		sm->bindState(com->OnCommand, this, &ConverseState::onCommand);
		sm->bindState(com->OnRCData, this, &ConverseState::onRCData);
	}

	bool heardSpeech = false;
	PSRAMVector<int16_t> utterance;
	if(AudioFrontend* afe = app->getService<AudioFrontend>()){
		utterance = afe->takeCapture(heardSpeech);
	}

	if(!heardSpeech || utterance.empty()){
		ESP_LOGI(TAG, "No speech captured");
		playTimeoutPhrase();
		return;
	}

	if(net == nullptr || !net->isServerReady()){
		ESP_LOGW(TAG, "Brain server not reachable (wifi=%d)", net ? (int) net->isWiFiUp() : -1);
		if(net){
			net->cancelSpeechStream();
		}
		playFallback();
		return;
	}

	// Already uploaded while the person spoke: just close the stream.
	if(net->hasSpeechStream()){
		if(net->finishSpeechStream()){
			PSRAMVector<int16_t>().swap(utterance);
			TurnToSpeaker::service(); // speech sent: turn while the server works on the reply
			turnStartMs = millis();
			phase = Phase::Waiting;
			return;
		}
		ESP_LOGW(TAG, "Speech stream failed; uploading the whole utterance");
	}

	if(!net->sendSpeech(utterance.data(), utterance.size())){
		playFallback();
		return;
	}
	PSRAMVector<int16_t>().swap(utterance); // sent; release the PSRAM now
	TurnToSpeaker::service(); // speech sent: turn while the server works on the reply

	// The reply timeout counts from when the upload finished, not from when it started.
	turnStartMs = millis();
	phase = Phase::Waiting;
}

ConverseState::~ConverseState(){
	TurnToSpeaker::cancelPending(); // a turn the reply never confirmed
	if(net && phase == Phase::Waiting){
		net->cancelTurn();
	}
	// Refill the filler now that nothing is uploading (see NetService::takeFiller).
	if(net){
		net->prefetchFiller();
	}
	logHeap("end");
}

void ConverseState::tick(float){
	if(phase == Phase::Finishing){
		// A reply that stops downloading mid-playback would otherwise play silence while it waits to rebuffer.
		if(replyStream && !replyStream->isEnded() && net && net->msSinceLastRx() > ReplyStallMs){
			ESP_LOGW(TAG, "Reply audio stalled: no data for %u ms, ending playback", (unsigned) net->msSinceLastRx());
			replyStream->fail();
		}
		if(audio == nullptr || !audio->isPlaying()){
			logHeap("playback done");
			// A robot command from Gatsby (e.g. "find me") runs from IdleState: skip the follow-up listen.
			const bool robotCommand = net && net->hasRobotCommand();
			if(replied && !robotCommand){
				ListenState::requestFollowUp();
				sm->transitionTo<ListenState>();
			}else{
				sm->transitionTo<IdleState>();
			}
		}
		return;
	}

	using TS = NetService::TurnStatus;
	const uint64_t now = millis();

	switch(net->getTurnStatus()){
		case TS::Streaming: {
			ESP_LOGI(TAG, "Reply streaming %llu ms after upload", (unsigned long long) (now - turnStartMs));
			logHeap("reply streaming");
			if(ServiceLocator::LEDControlInstance){
				ServiceLocator::LEDControlInstance->endWakeAck(); // one-breath wake: stop the "heard you" flicker
			}
			// The reply may play while a turn is still finishing (motors and speaker don't interfere;
			// nothing is listening). The next listen waits for the turn, keeping motor noise out.
			if(net->takeTurnStream(replyStream) && audio && ServiceLocator::PCMGenInstance){
				// enqueue: if the filler is still playing, the reply starts right after it.
				audio->enqueue(ServiceLocator::PCMGenInstance.get(), std::make_unique<StreamAudioSource>(replyStream));
				replied = true;
			}
			phase = Phase::Finishing;
			return;
		}

		case TS::NoSpeech:
			net->cancelTurn();
			phase = Phase::Finishing;
			playTimeoutPhrase();
			return;

		case TS::ErrorAwaiting:
			if(errorSeenMs == 0){
				errorSeenMs = now;
			}else if(now - errorSeenMs > ErrorGraceMs){
				net->cancelTurn();
				phase = Phase::Finishing;
				playFallback();
			}
			return;

		case TS::Pending: {
			const uint64_t waited = now - turnStartMs;
			// Only cover a slow reply with the filler line; quick replies just play. A tool lookup
			// (calendar, email...) is always slow, so fill as soon as the server says one started.
			const bool toolLookup = net->isTurnToolInProgress();
			if(!fillerTried && (waited > FillerDelayMs || toolLookup) && !net->isTurnReplyStarted()){
				fillerTried = true;
				PSRAMByteBuffer filler;
				if(net->takeFiller(filler) && audio && ServiceLocator::PCMGenInstance){
					ESP_LOGI(TAG, "Reply slow (%llu ms%s): playing filler", (unsigned long long) waited, toolLookup ? ", tool lookup" : "");
					audio->play(ServiceLocator::PCMGenInstance.get(), std::make_unique<MemoryAudioSource>(std::move(filler)));
				}
			}
			bool timedOut = false;
			if(!net->isTurnReplyStarted()){
				if(waited > TurnTimeoutMs){
					ESP_LOGW(TAG, "Turn timed out: no speech_result %llu ms after upload (limit %llu)",
							 (unsigned long long) waited, (unsigned long long) TurnTimeoutMs);
					timedOut = true;
				}
			}else if(net->msSinceLastRx() > ReplyStallMs){
				ESP_LOGW(TAG, "Turn timed out: reply audio stalled, no data for %u ms (%llu ms after upload)",
						 (unsigned) net->msSinceLastRx(), (unsigned long long) waited);
				timedOut = true;
			}else if(waited > ReplyMaxMs){
				ESP_LOGW(TAG, "Turn timed out: reply audio still downloading %llu ms after upload (limit %llu)",
						 (unsigned long long) waited, (unsigned long long) ReplyMaxMs);
				timedOut = true;
			}
			if(timedOut){
				net->cancelTurn();
				phase = Phase::Finishing;
				playFallback();
			}
			return;
		}

		case TS::Failed:
		case TS::Idle:
		default:
			net->cancelTurn();
			phase = Phase::Finishing;
			playFallback();
			return;
	}
}

void ConverseState::playFallback(){
	phase = Phase::Finishing;
	if(audio && ServiceLocator::SpeechAudioGenInstance){
		audio->enqueue(ServiceLocator::SpeechAudioGenInstance.get(), std::make_unique<SpeechAudioSource>(SpeechGen::InputType::Text, FallbackLine));
	}
}

void ConverseState::playTimeoutPhrase(){
	phase = Phase::Finishing;
	if(followUp){
		ESP_LOGI(TAG, "No speech in the follow-up: back to idle quietly");
		return;
	}
	const int16_t id = Phrases::get(Phrase::ListeningTimeout);
	if(id < 0 || audio == nullptr || !ServiceLocator::SpeechAudioGenInstance){
		return;
	}
	const std::string text = Phrases::map(Phrase::ListeningTimeout, id);
	if(!text.empty()){
		audio->enqueue(ServiceLocator::SpeechAudioGenInstance.get(), std::make_unique<SpeechAudioSource>(SpeechGen::InputType::Text, text));
	}
}

void ConverseState::abort(){
	if(net && phase == Phase::Waiting){
		net->cancelTurn();
	}
	if(replyStream){
		replyStream->fail();
	}
	replied = false;
	phase = Phase::Finishing;
	if(audio){
		audio->stop();
	}
}

void ConverseState::onButtonEvent(int button, ISRButtonInput::Action action){
	if(action != ISRButtonInput::Action::Press || button != (int) Button::Power){
		return;
	}
	abort();
	sm->transitionTo<IdleState>();
}

void ConverseState::onCommand(Ctrl::Command cmd){
	if(cmd == Ctrl::Command::Listen || cmd == Ctrl::ShutUp){
		abort();
		sm->transitionTo<IdleState>();
	}
}

void ConverseState::onRCData(const RCData&){
	// ControllerState stores the SSID/password itself (it binds to OnRCData directly).
	abort();
	sm->transitionTo<RCState>();
}
