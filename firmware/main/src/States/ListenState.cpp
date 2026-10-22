#include "ListenState.h"
#include "BBStateMachine.h"
#include "Audio/AudioFrontend.h"
#include "Audio/SpeechAudioGen.h"
#include "Audio/SpeechAudioSource.h"
#include "Audio/SpeechGen.h"
#include <Core/Application.h>
#include <Statics/ApplicationStatics.h>
#include <Phrases.h>
#include <Services/Audio/Audio.h>
#include <Services/Audio/AACAudioGenerator.h>
#include "Audio/MemoryAudioSource.h"
#include "Util/PSRAMAllocator.h"
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <limits>
#include <memory>
#include <span>
#include <utility>
#include <vector>
#include <esp_log.h>
#include <Util/ServiceLocator.h>
#include "BBData.h"
#include "Enums.h"
#include "IdleState.h"
#include "RCState.h"
#include "ScenarioState.h"
#include "ConverseState.h"
#include "Util/TurnToSpeaker.h"
#include "Services/Com.h"
#include "Services/ScenarioRoutineService.h"
#include "Services/IRStorage.h"
#include "Routines/IRActionRoutine.h"
#include "ScenarioRoutineMappings.h"

DEFINE_LOG(ListenState)

static void playPhraseBlocking(const Application* app, Phrase phrase){
    if(app == nullptr){
        return;
    }

    Audio* audio = app->getService<Audio>();
    if(audio == nullptr || !ServiceLocator::SpeechAudioGenInstance || !ServiceLocator::SpeechGenInstance){
        return;
    }

    const int16_t id = Phrases::get(phrase);
    if(id < 0){
        return;
    }

    const std::string text = Phrases::map(phrase, id);
    if(text.empty()){
        return;
    }

    auto source = std::make_unique<SpeechAudioSource>(SpeechGen::InputType::Text, text);
    audio->play(ServiceLocator::SpeechAudioGenInstance.get(), std::move(source));
    audio->waitEnd(portMAX_DELAY);
}

static const char* TAG = "ListenState";

namespace {
    constexpr uint32_t IntroWindowMs = 2500;

    struct SoundEffect { const char* path; uint16_t durationMs; };
    struct StartPrompt { const char* text; uint16_t durationMs; };

    constexpr StartPrompt StartPrompts[] = {
        { "Yes?",                  753 },
        { "I'm listening",         978 },
        { "How can I help?",      1303 },
        { "Another task?",        1010 },
        { "How may I assist?",    1417 },
        { "You have my attention", 1531 },
        { "Awaiting input",       1144 },
        { "State your request",   1511 },
    };

    constexpr SoundEffect Lasers1[] = {
        { "/spiffs/listen/lasers1/phaseJump1.aac",  384 },
        { "/spiffs/listen/lasers1/phaseJump2.aac",  384 },
        { "/spiffs/listen/lasers1/phaseJump3.aac",  320 },
        { "/spiffs/listen/lasers1/phaseJump4.aac",  256 },
        { "/spiffs/listen/lasers1/phaseJump5.aac",  384 },
        { "/spiffs/listen/lasers1/phaserDown1.aac", 384 },
        { "/spiffs/listen/lasers1/phaserDown2.aac", 320 },
        { "/spiffs/listen/lasers1/phaserDown3.aac", 384 },
    };

    constexpr SoundEffect Lasers2[] = {
        { "/spiffs/listen/lasers2/laser1.aac", 384 },
        { "/spiffs/listen/lasers2/laser2.aac", 384 },
        { "/spiffs/listen/lasers2/laser3.aac", 384 },
        { "/spiffs/listen/lasers2/laser4.aac", 384 },
        { "/spiffs/listen/lasers2/laser5.aac", 384 },
        { "/spiffs/listen/lasers2/laser6.aac", 320 },
        { "/spiffs/listen/lasers2/laser7.aac", 384 },
        { "/spiffs/listen/lasers2/laser8.aac", 384 },
        { "/spiffs/listen/lasers2/laser9.aac", 384 },
    };

    constexpr SoundEffect Robot[] = {
        { "/spiffs/listen/robot/robot_1.aac", 256 },
        { "/spiffs/listen/robot/robot_2.aac", 384 },
        { "/spiffs/listen/robot/robot_3.aac", 320 },
        { "/spiffs/listen/robot/robot_4.aac", 256 },
    };

    struct SfxGroup { const char* name; std::span<const SoundEffect> clips; };
    constexpr SfxGroup SfxGroups[] = {
        { "lasers1", Lasers1 },
        { "lasers2", Lasers2 },
        { "robot",   Robot   },
    };

    PSRAMByteBuffer readFile(const char* path){
        std::ifstream f(path, std::ios::binary | std::ios::ate);
        if(!f){
            return {};
        }
        const std::streamsize size = f.tellg();
        if(size <= 0){
            return {};
        }
        f.seekg(0);
        PSRAMByteBuffer buf(static_cast<size_t>(size));
        f.read(reinterpret_cast<char*>(buf.data()), size);
        buf.resize(static_cast<size_t>(f.gcount()));
        return buf;
    }

    void buildAndPlayIntro(const Application* app){
        Audio* audio = app->getService<Audio>();
        AACAudioGenerator* aacGen = app->getService<AACAudioGenerator>();
        if(audio == nullptr || aacGen == nullptr || ServiceLocator::SpeechAudioGenInstance == nullptr || ServiceLocator::SpeechGenInstance == nullptr){
            return;
        }

        const StartPrompt& prompt = StartPrompts[rand() % std::size(StartPrompts)];
        const uint32_t budget = prompt.durationMs >= IntroWindowMs ? 0 : IntroWindowMs - prompt.durationMs;

        const SfxGroup& group = SfxGroups[rand() % std::size(SfxGroups)];

        const uint32_t preloadStart = millis();

        const size_t maxAttempts = group.clips.size() * 4;

        std::vector<Audio::GenSourcePair> batch;
        batch.reserve(maxAttempts + 1); // + 1 for the spoken prompt source

        std::vector<size_t> pool;
        pool.reserve(group.clips.size());
        uint32_t accumulated = 0;
        size_t attempts = 0;
        while(accumulated < budget && attempts < maxAttempts){
            ++attempts;
            if(pool.empty()){
                for(size_t i = 0; i < group.clips.size(); ++i){
                    pool.push_back(i);
                }
            }
            const size_t poolIdx = rand() % pool.size();
            const SoundEffect& sfx = group.clips[pool[poolIdx]];
            pool.erase(pool.begin() + poolIdx);

            // Preload the clip into PSRAM now (before loadModel() hammers the flash),
            // so the audio task can play it without blocking on the flash lock.
            PSRAMByteBuffer bytes = readFile(sfx.path);
            if(bytes.empty()){
                continue;
            }

            batch.emplace_back(aacGen, std::make_unique<MemoryAudioSource>(std::move(bytes)));
            accumulated += sfx.durationMs;
        }

        batch.emplace_back(ServiceLocator::SpeechAudioGenInstance.get(), std::make_unique<SpeechAudioSource>(SpeechGen::InputType::Text, prompt.text));

        audio->play(std::span<Audio::GenSourcePair>(batch));
    }

    // Companion mode: Gatsby's own "listening" line (cached from the server) instead of the
    // beeps + synth prompt. False if none is cached (offline, or not fetched yet).
    bool playListenAck(const Application* app){
        Audio* audio = app->getService<Audio>();
        PSRAMByteBuffer ack;
        if(audio == nullptr || !ServiceLocator::PCMGenInstance || !ServiceLocator::NetServiceInstance ||
           !ServiceLocator::NetServiceInstance->takeListenAck(ack)){
            return false;
        }
        audio->play(ServiceLocator::PCMGenInstance.get(), std::make_unique<MemoryAudioSource>(std::move(ack)));
        return true;
    }

}

std::vector<AudioFrontend::Phrase> ListenState::phrases;
bool ListenState::followUpNext = false;
std::atomic_bool ListenState::warmNext{ false };

void ListenState::buildCommandPhrases(std::vector<AudioFrontend::Phrase>& out){
    for(const ScenarioActivation& activation : activations){
        const RoutineFactory factory = routineForScenario({ activation.scenario, activation.scenarioData });
        out.push_back({ activation.string, activation.phonemes, activation.fuzzyCore, activation.fuzzyThreshold, reinterpret_cast<const void*>(factory) });
    }

    if(ServiceLocator::IRStorageInstance){
        for(uint8_t i = 0; i < ServiceLocator::IRStorageInstance->getCount(); ++i){
            const IRCommand& cmd = ServiceLocator::IRStorageInstance->getCommand(i);
            out.push_back({ cmd.phonemes, cmd.phonemes });
        }
    }
}

void ListenState::preallocate(){
	phrases.reserve(activations.size() * 2);
}

ListenState::ListenState(BBStateMachine* sm) : State(sm){
	phrases.clear();
	followUp = std::exchange(followUpNext, false);
	startedAsFollowUp = followUp;
	const bool warm = warmNext.exchange(false);

    const Application* app = ApplicationStatics::getApplication();

    if(!followUp && !playListenAck(app)){
        buildAndPlayIntro(app);
    }

    auto buttonInput = app->getService<ISRButtonInput>();
    if(buttonInput == nullptr){
        ESP_LOGE(TAG, "ButtonInput service missing!");
        return;
    }

    sm->bindState(buttonInput->OnButtonEvent, this, &ListenState::onButtonEvent);

    if(!ServiceLocator::ScenarioRoutineServiceInstance){
        CMF_LOG(ListenState, LogLevel::Error, "ScenarioRoutineService missing in constructor");
        return;
    }

    ServiceLocator::ScenarioRoutineServiceInstance->reset();

    com = ApplicationStatics::getApplication()->getService<Com>();
    if(com == nullptr){
        ESP_LOGE(TAG, "Com service missing!");
        return;
    }

    sm->bindState(com->OnCommand, this, &ListenState::onCommand);
    ListenData listenData{.phase = ListenData::Phase::Listening};
    com->sendData(BB::State::Listen, BB::Action::Listen{}, listenData);


    AudioFrontend* audioFrontend = app->getService<AudioFrontend>();
    if(audioFrontend == nullptr){
        CMF_LOG(ListenState, LogLevel::Error, "AudioFrontend service missing in constructor");
        return;
    }

	audioFrontend->loadModel(); // no-op on a warm start: IdleState left it loaded

    audioFrontend->setMode(AudioFrontend::Mode::Off);

    if(followUp){
        // Conversation only: skipping the stock command set keeps the reload short (its FST build takes
        // ~1.5s). Still set (abort-only) phrases so fuzzy matching can't use a stale list.
        audioFrontend->setSpeechPhrases({});
    }else if(!warm && !activations.empty()){
        // (A warm start already has these registered, followed by the wake phrases.)
        buildCommandPhrases(phrases);
        audioFrontend->setSpeechPhrases(phrases);
    }

    if(Audio* audio = app->getService<Audio>()){
        audio->waitEnd(portMAX_DELAY);
        TurnToSpeaker::waitDone(2500); // a follow-up can start while the last turn finishes: keep motor noise out

        sm->bindState(audioFrontend->onPhrase, this, &ListenState::onPhrase);
        const bool companion = ServiceLocator::NetServiceInstance && ServiceLocator::NetServiceInstance->isEnabled();
        audioFrontend->setCaptureEnabled(companion);
        if(companion){
            ServiceLocator::NetServiceInstance->cancelSpeechStream(); // a stale one from an abandoned listen
            audioFrontend->setCaptureStream([](const int16_t* samples, size_t count){
                ServiceLocator::NetServiceInstance->streamSpeech(samples, count);
            });
        }else{
            audioFrontend->setCaptureStream(nullptr);
        }
        audioFrontend->setMode(AudioFrontend::Mode::Speech);
        listenStartMs = millis();
        if(followUp){
            ESP_LOGI("WakeWord", "Follow-up: listening %llu ms for more", (unsigned long long) FollowUpWindowMs);
        }
    }
}

void ListenState::tick(float){
    if(!followUp || listenStartMs == 0 || sm->isTransitionPending() || millis() - listenStartMs < FollowUpWindowMs){
        return;
    }
    followUp = false;
    AudioFrontend* audioFrontend = ApplicationStatics::getApplication()->getService<AudioFrontend>();
    if(audioFrontend && audioFrontend->heardSpeech()){
        return; // they're talking: carry on as a normal listen
    }
    ESP_LOGI("WakeWord", "No follow-up, back to idle");
    sm->transitionTo<IdleState>();
}

ListenState::~ListenState(){
    // Event bindings are dropped by BBStateMachine::unbindStateEvents() after this dtor runs.
    const Application* app = ApplicationStatics::getApplication();
    if(AudioFrontend* audioFrontend = app->getService<AudioFrontend>()){
        audioFrontend->setMode(AudioFrontend::Mode::Off);
        audioFrontend->setCaptureEnabled(false);
        if(!routedToConverse){
            audioFrontend->discardCapture(); // ConverseState takes it otherwise
            if(ServiceLocator::NetServiceInstance){
                ServiceLocator::NetServiceInstance->prefetchFiller(); // refill the listening line (ConverseState does otherwise)
            }
        }
		audioFrontend->unloadModel();
    }

    if(timedOut){
        playPhraseBlocking(app, Phrase::ListeningTimeout);
    }
}

void ListenState::onRC(){
    sm->transitionTo<RCState>();
}

void ListenState::onPhrase(bool recognized, int index, const std::string& transcript, float confidence){
	// Runs on the AFE proc task. Do NOT stop the AFE or play audio here
	if(AudioFrontend* afe = ApplicationStatics::getApplication()->getService<AudioFrontend>()){
		TurnToSpeaker::onUtteranceEnd(afe, afe->utteranceSpeechMs()); // turned toward in ConverseState
	}
    if(!recognized){
    	CMF_LOG(ListenState, LogLevel::Info, "Listen result: recognized=%d, index=%d, transcript='%s', confidence=%.2f",
			recognized, index, transcript.c_str(), confidence);

        // Companion mode: no stock command matched, so this may be conversation for the brain
        // server. ConverseState decides whether speech was actually heard and whether the server
        // is reachable; stock "not understood" behavior is kept when companion mode is disabled.
        if(ServiceLocator::NetServiceInstance && ServiceLocator::NetServiceInstance->isEnabled()){
            routedToConverse = true;
            if(startedAsFollowUp){
                ConverseState::markFollowUp();
            }
            sm->transitionTo<ConverseState>();
            return;
        }

        ListenData listenData{.phase = ListenData::Phase::NotUnderstand};
        com->sendData(BB::State::Listen, BB::Action::Listen{}, listenData);
        timedOut = true;
        sm->transitionTo<IdleState>();
        return;
    }

    ESP_LOGI("WakeWord", "Stock command %d recognized: \"%s\" (%.2f)", index, transcript.c_str(), confidence);

	if(index < 0){
        // Abort phrase
        aborted();
        sm->transitionTo<IdleState>();
        return;
    }

    if(!ServiceLocator::ScenarioRoutineServiceInstance){
        CMF_LOG(ListenState, LogLevel::Error, "ScenarioRoutineService missing in onPhrase");
        return;
    }

    const int irCount = ServiceLocator::IRStorageInstance ? ServiceLocator::IRStorageInstance->getCount() : 0;
    if(index >= static_cast<int>(activations.size()) + irCount){
        return; // a wake phrase (still registered after a warm start from IdleState): keep listening
    }

    if(index >= static_cast<int>(activations.size())){
        const int irIndex = index - static_cast<int>(activations.size());
        if(ServiceLocator::IRStorageInstance){
            ServiceLocator::IRStorageInstance->setSelectedIndex(static_cast<uint8_t>(irIndex));
        }
        ServiceLocator::ScenarioRoutineServiceInstance->setRoutineFactory(&makeRoutine<IRActionRoutine>);
        sm->transitionTo<ScenarioState>();
        return;
    }

    const ScenarioActivation& activation = activations[index];
    const RoutineFactory factory = routineForScenario({ activation.scenario, activation.scenarioData });
    if(factory == nullptr){
        CMF_LOG(ListenState, LogLevel::Error, "No routine mapped for scenario %d", static_cast<int>(activation.scenario));
        sm->transitionTo<IdleState>();
        return;
    }

    ServiceLocator::ScenarioRoutineServiceInstance->setRoutineFactory(factory);
    sm->transitionTo<ScenarioState>();
}

void ListenState::onButtonEvent(int button, ISRButtonInput::Action action){
    if(action != ISRButtonInput::Action::Press || button != (int)Button::Power){
        return;
    }
    aborted();
    sm->transitionTo<IdleState>();
}

void ListenState::onCommand(Ctrl::Command cmd) {
    if(cmd == Ctrl::Command::Listen || cmd == Ctrl::ShutUp){
        aborted();
        sm->transitionTo<IdleState>();
    	return;
    }
}

void ListenState::aborted(){
	if(ServiceLocator::ScenarioRoutineServiceInstance){
		if(Audio* audio = ApplicationStatics::getApplication()->getService<Audio>()){
			audio->stop();
			audio->play(ServiceLocator::SpeechAudioGenInstance.get(), std::make_unique<SpeechAudioSource>(SpeechGen::InputType::Text, Phrases::map(Phrase::ListenAbort, Phrases::get(Phrase::ListenAbort))));
		}
	}

    if(com == nullptr){
        return;
    }

    ListenData listenData{.phase = ListenData::Phase::Abort};
    com->sendData(BB::State::Listen, BB::Action::Listen{}, listenData);
}
