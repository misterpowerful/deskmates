#include "TurnToSpeaker.h"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <esp_log.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <Core/Application.h>
#include <Statics/ApplicationStatics.h>
#include "Audio/AudioFrontend.h"
#include "Services/BaseBoard.h"
#include "Services/MotionService.h"

static const char* TAG = "TurnToSpeaker";

namespace {
	// a4f5e8b's calibration: lag (right channel trailing left, samples) with the speaker straight ahead;
	// right read -1, left 0 (2026-10-10 tests).
	constexpr float CenterLag = -0.55f;
	constexpr float DeadZone = 0.2f;    // |lag - CenterLag| below this: ahead, don't turn
	constexpr float FarSide = 0.45f;    // at or beyond this: clearly to one side, 90 instead of 45
	constexpr int MinWindows = 3;       // fewer loud windows than this: no reliable estimate
	// ~2 in between the mics: a voice arrives at most ~2.4 samples earlier on one side. A larger lag
	// (e.g. -6.00, the search edge, from the robot's own listening-line echo) is not a voice.
	constexpr float MaxPlausibleLag = 2.5f;
	constexpr uint32_t MinSpeechMs = 300;   // an utterance without real speech never turns the robot
	constexpr uint32_t WakeValidMs = 15000; // a wake reading older than this isn't a fallback any more
	constexpr uint32_t SettleMs = 250;      // after a turn, motor and gear noise die down

	// Rotation timing from SummonEventRoutine: ~45 deg per 1000 ms at full speed.
	constexpr int8_t RotateSpeed = 100;
	constexpr uint32_t Ms45 = 1000;

	std::atomic<int> pendingDeg{ 0 };       // +right / -left, 0 = none
	std::atomic<float> wakeLag{ 0 };
	std::atomic<uint32_t> wakeAtMs{ 0 };    // 0 = no usable wake reading
	std::atomic<uint32_t> quietSinceMs{ 0 }; // audio before this (a turn's motor noise) is never used
	std::atomic_bool turning{ false };
	esp_timer_handle_t stopTimer = nullptr;

	uint32_t nowMs(){ return (uint32_t) (esp_timer_get_time() / 1000); }

	void stopCb(void*){
		if(BaseBoard* bb = ApplicationStatics::getApplication()->getService<BaseBoard>()){
			bb->stopMotors();
		}
		quietSinceMs = nowMs() + SettleMs;
		turning = false;
	}

	// The utterance plus the trailing VAD silence that ended it, but nothing from a turn or before it.
	AudioFrontend::Direction estimate(AudioFrontend* afe, uint32_t speechMs){
		uint32_t windowMs = speechMs + 700 + 300;
		const uint32_t now = nowMs(), quiet = quietSinceMs.load();
		if(turning){
			windowMs = 0;
		}else if(quiet != 0){
			windowMs = std::min(windowMs, now > quiet ? now - quiet : 0);
		}
		return afe->estimateDirection(windowMs);
	}

	int degreesFor(float lagF){
		// a4f5e8b's mapping. (Inverting it, 2026-10-17, was a mistake: the wrong-way turns that prompted
		// it came from listening-line echo readings, now rejected; the owner on the left read +0.18/+0.01.)
		const float offset = lagF - CenterLag; // < 0: speaker to the robot's right, > 0: left
		if(std::fabs(offset) < DeadZone){
			return 0;
		}
		const int magnitude = std::fabs(offset) >= FarSide ? 90 : 45;
		return offset < 0 ? magnitude : -magnitude;
	}
}

namespace TurnToSpeaker {

void noteWake(AudioFrontend* afe, uint32_t speechMs){
	wakeAtMs = 0;
	if(afe == nullptr || speechMs < MinSpeechMs){
		return;
	}
	const AudioFrontend::Direction dir = estimate(afe, speechMs);
	ESP_LOGI(TAG, "wake: lag %+.2f (%d windows, corr %.2f)", dir.lagF, dir.windows, dir.corr);
	if(dir.windows >= MinWindows && std::fabs(dir.lagF) <= MaxPlausibleLag){
		wakeLag = dir.lagF;
		wakeAtMs = nowMs();
	}
}

void onUtteranceEnd(AudioFrontend* afe, uint32_t speechMs){
	pendingDeg = 0;
	const uint32_t wakeAt = wakeAtMs.exchange(0);
	if(afe == nullptr || speechMs < MinSpeechMs){
		ESP_LOGI(TAG, "no real speech (%u ms): no turn", (unsigned) speechMs);
		return;
	}
	const AudioFrontend::Direction dir = estimate(afe, speechMs);
	float lag = dir.lagF;
	const char* source = "question";
	if(dir.windows < MinWindows || std::fabs(dir.lagF) > MaxPlausibleLag){
		if(wakeAt == 0 || nowMs() - wakeAt > WakeValidMs){
			ESP_LOGI(TAG, "lag %+.2f (%d windows): unusable and no wake reading, no turn", dir.lagF, dir.windows);
			return;
		}
		lag = wakeLag.load();
		source = "wake phrase (question unusable)";
	}
	const int deg = degreesFor(lag);
	ESP_LOGI(TAG, "%s: lag %+.2f (offset %+.2f, %d windows, corr %.2f) -> %s", source, lag, lag - CenterLag,
			 dir.windows, dir.corr, deg == 0 ? "ahead, no turn" : (deg > 0 ? (deg == 90 ? "turn right 90" : "turn right 45") :
			 (deg == -90 ? "turn left 90" : "turn left 45")));
	pendingDeg = deg;
}

void cancelPending(){
	pendingDeg = 0;
}

void service(){
	const int deg = pendingDeg.exchange(0);
	if(deg == 0 || turning){
		return;
	}
	BaseBoard* bb = ApplicationStatics::getApplication()->getService<BaseBoard>();
	if(bb == nullptr){
		return;
	}
	// No upright check: MotionService is disabled outside IdleState, so its pose went stale mid-conversation
	// and blocked every turn after a while (2026-10-10). The bottom sensor is live, though: no floor, no turn
	// (and losing the floor mid-turn stops the motors in MotionService).
	if(MotionService* motion = ApplicationStatics::getApplication()->getService<MotionService>(); motion && motion->floorLost()){
		ESP_LOGW(TAG, "floor not seen: no turn");
		return;
	}
	if(stopTimer == nullptr){
		const esp_timer_create_args_t args = { .callback = &stopCb, .name = "turn-stop" };
		if(esp_timer_create(&args, &stopTimer) != ESP_OK){
			return;
		}
	}
	// Turning right: left wheel forward, right wheel back (as SummonEventRoutine's centering).
	const bool right = deg > 0;
	turning = true;
	bb->setMotors(right ? RotateSpeed : -RotateSpeed, right ? -RotateSpeed : RotateSpeed);
	esp_timer_start_once(stopTimer, (uint64_t) Ms45 * (uint64_t) std::abs(deg) / 45 * 1000ULL);
}

void waitDone(uint32_t maxMs){
	const int64_t until = esp_timer_get_time() + (int64_t) maxMs * 1000;
	while(turning && esp_timer_get_time() < until){
		vTaskDelay(pdMS_TO_TICKS(20));
	}
}

}
