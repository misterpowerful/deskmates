#ifndef BUTTERBOT_FIRMWARE_LISTENSTATE_H
#define BUTTERBOT_FIRMWARE_LISTENSTATE_H

#include <atomic>
#include <vector>
#include "State.h"
#include "CtrlData.h"
#include "Audio/AudioFrontend.h"
#include "Services/Com.h"
#include "Services/ISRButtonInput.h"

class ListenState : public State {
public:
    explicit ListenState(BBStateMachine* sm);
    virtual ~ListenState() override;

    static void preallocate();

    /** Next ListenState is a follow-up after a reply: no intro, conversation only, gives up after FollowUpWindowMs. */
    static void requestFollowUp(){ followUpNext = true; }

    /** Next ListenState takes over the model IdleState's wake listener already has loaded (stock commands
     *  plus wake phrases), skipping the ~2s reload. Callable from the AFE proc task. */
    static void requestWarmStart(){ warmNext = true; }

    /** Stock command phrases (scenario activations, then saved IR commands) in MultiNet order. */
    static void buildCommandPhrases(std::vector<AudioFrontend::Phrase>& out);

    void tick(float deltaTime) override;
    int64_t getDynamicTickInterval() const override { return followUp ? 100 : -1; }

private:
    Com* com;

    bool timedOut = false;
    bool routedToConverse = false;
    bool followUp = false;
    bool startedAsFollowUp = false;
    uint64_t listenStartMs = 0;

    static bool followUpNext;
    static std::atomic_bool warmNext;
    static constexpr uint64_t FollowUpWindowMs = 3000;

    void onRC();
    void onPhrase(bool recognized, int index, const std::string& transcript, float confidence);
    void onButtonEvent(int button, ISRButtonInput::Action action);
    void onCommand(Ctrl::Command cmd);

    void aborted();

	static std::vector<AudioFrontend::Phrase> phrases;
};

#endif //BUTTERBOT_FIRMWARE_LISTENSTATE_H
