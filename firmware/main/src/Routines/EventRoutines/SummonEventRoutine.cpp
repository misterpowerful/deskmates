#include "SummonEventRoutine.h"
#include "Net/RobotControl.h"
#include "States/BBStateMachine.h"
#include <Statics/ApplicationStatics.h>
#include <Core/Application.h>
#include <Services/Audio/Audio.h>
#include <Util/stdafx.h>
#include <cstdlib>
#include <cmath>
#include <memory>
#include <Phrases.h>
#include <BBData.h>
#include <Util/ServiceLocator.h>
#include "Audio/SpeechAudioGen.h"
#include "Audio/SpeechAudioSource.h"
#include "Audio/SpeechGen.h"
#include "Services/BaseBoard.h"
#include "Services/MotionService.h"
#include "Services/Com.h"
#include "FaceDet.h"
#include "Net/NetService.h"

DEFINE_LOG(SummonEventRoutine)

SummonEventRoutine::~SummonEventRoutine(){
	report("interrupted"); // no-op if an outcome was already reported
	const Application* app = ApplicationStatics::getApplication();

	if(BaseBoard* bb = app->getService<BaseBoard>()){
		bb->stopMotors();
	}

	if(faceDetActive){
		if(FaceDet* fd = app->getService<FaceDet>()){
			fd->stop();
			sm->unbindRoutine(fd->OnDetect);
			fd->unloadModel();
		}
	}
}

Routine::TickingState SummonEventRoutine::tick(float deltaTime){
	const Application* app = ApplicationStatics::getApplication();

	if(phase != Phase::Init && phase != Phase::ProxCheck && proxInterrupted){
		CMF_LOG(SummonEventRoutine, LogLevel::Info, "Unsafe proximity state - interrupting");
		baseBoard->stopMotors();
		speak(Phrase::RoutineInterrupted, SummonData::Phase::Interrupted);
		const char* why = RobotControl::takeStopReason(); // "edge" or "obstacle"
		report(why ? why : "interrupted");
		return TickingState::Done;
	}

	switch(phase){
		case Phase::Init: {
			if(ServiceLocator::NetServiceInstance){
				robotCmdId = ServiceLocator::NetServiceInstance->takeActiveRobotCommand();
			}
			baseBoard = app->getService<BaseBoard>();
			faceDet = app->getService<FaceDet>();
			MotionService* motionService = app->getService<MotionService>();

			if(baseBoard == nullptr || faceDet == nullptr || motionService == nullptr){
				CMF_LOG(SummonEventRoutine, LogLevel::Error, "Missing required service(s)");
				report("error");
				return TickingState::Done;
			}

			if(baseBoard->getChargingState() != ChargingState::Unplugged){
				CMF_LOG(SummonEventRoutine, LogLevel::Info, "Charging - skipping");
				speak(Phrase::SummonCharging, SummonData::Phase::Charging);
				report("charging");
				return TickingState::Done;
			}

			if(!motionService->isUprightOnGround()){
				CMF_LOG(SummonEventRoutine, LogLevel::Info, "Not upright on the ground - skipping");
				speak(Phrase::CannotMove, SummonData::Phase::Unsafe);
				const char* why = RobotControl::takeStopReason();
				report(why ? why : "unsafe");
				return TickingState::Done;
			}

			const bool turnRight = rand() % 2;
			scanMotorLeft = turnRight ? RotateSpeed : -RotateSpeed;
			scanMotorRight = turnRight ? -RotateSpeed : RotateSpeed;

			sm->bindRoutine(baseBoard->onProximityReading, this, &SummonEventRoutine::onProximityReading);
			sm->bindRoutine(baseBoard->onProximityChange, this, &SummonEventRoutine::onProximityChange);
			baseBoard->requestProximityState();
			proxDeadlineMs = millis() + ProxReadingTimeoutMs;
			phase = Phase::ProxCheck;
			return TickingState::Continue;
		}

		case Phase::ProxCheck: {
			if(proxUnsafe || proxInterrupted){
				CMF_LOG(SummonEventRoutine, LogLevel::Info, "Unsafe proximity state - skipping");
				speak(Phrase::CannotMove, SummonData::Phase::Unsafe);
				report("unsafe");
				return TickingState::Done;
			}
			if(!proxReadingReceived && millis() < proxDeadlineMs){
				return TickingState::Continue;
			}

			faceDet->loadModel();
			ownerEnrolled = faceDet->knowsFace();
			sm->bindRoutine(faceDet->OnDetect, this, &SummonEventRoutine::onDetect);
			faceDet->start(false);
			faceDetActive = true;

			detected = false;
			speak(Phrase::SummonStart, SummonData::Phase::Start);

			scanDeadlineMs = millis() + ScanWindowMs;
			phase = Phase::Scanning;
			return TickingState::Continue;
		}

		case Phase::Scanning: {
			if(detected){
				beginApproach();
				return TickingState::Continue;
			}

			if(millis() >= scanDeadlineMs){
				if(rotationCount >= MaxRotations){
					CMF_LOG(SummonEventRoutine, LogLevel::Info, "No face after full rotation");
					faceDet->stop();
					speak(Phrase::SummonNotFound, SummonData::Phase::NotFound);
					report("not_found");
					return TickingState::Done;
				}

				faceDet->stop();
				baseBoard->setMotors(scanMotorLeft, scanMotorRight);
				rotateDeadlineMs = millis() + Rotate45Ms;
				phase = Phase::Rotating;
			}

			return TickingState::Continue;
		}

		case Phase::Rotating: {
			if(millis() >= rotateDeadlineMs){
				baseBoard->stopMotors();
				rotationCount++;
				faceDet->start(false);
				detected = false;
				scanDeadlineMs = millis() + ScanWindowMs;
				phase = Phase::Scanning;
			}

			return TickingState::Continue;
		}

		case Phase::Centering: {
			const float error = faceCenterX - 0.5f;

			if(std::fabs(error) <= CenterDeadband || millis() >= centerDeadlineMs){
				baseBoard->stopMotors();
				driveEndMs = millis() + DriveMinMs + static_cast<uint32_t>(rand() % (DriveMaxMs - DriveMinMs + 1));
				baseBoard->setMotors(DriveSpeed, DriveSpeed);
				phase = Phase::Driving;
				return TickingState::Continue;
			}

			// A face on the right of the frame (error > 0) is to the robot's right, so turn right.
			if(error > 0.0f){
				baseBoard->setMotors(CenterSpeed, -CenterSpeed);
			} else{
				baseBoard->setMotors(-CenterSpeed, CenterSpeed);
			}

			return TickingState::Continue;
		}

		case Phase::Driving: {
			if(millis() >= driveEndMs){
				baseBoard->stopMotors();
				faceDet->stop();
				speak(Phrase::SummonFound, SummonData::Phase::Found);
				report("found");
				return TickingState::Done;
			}

			return TickingState::Continue;
		}
	}

	return TickingState::Done;
}

void SummonEventRoutine::beginApproach(){
	centerDeadlineMs = millis() + CenterTimeoutMs;
	phase = Phase::Centering;
}

void SummonEventRoutine::speak(Phrase phrase, SummonData::Phase dataPhase){
	const Application* app = ApplicationStatics::getApplication();
	Audio* audio = app->getService<Audio>();
	Com* com = app->getService<Com>();

	if(audio == nullptr || ServiceLocator::SpeechAudioGenInstance == nullptr || ServiceLocator::SpeechGenInstance == nullptr || com == nullptr){
		CMF_LOG(SummonEventRoutine, LogLevel::Error, "Missing required service(s)");
		return;
	}

	const int16_t id = Phrases::get(phrase);
	if(id < 0){
		CMF_LOG(SummonEventRoutine, LogLevel::Warning, "Phrases::get returned no phrase id");
		return;
	}

	SummonData data{};
	data.phase = dataPhase;
	data.id = static_cast<uint8_t>(id);
	com->sendData(BB::State::Idle, BB::Action::Idle::Summon, data);

	if(!robotCmdId.empty()){
		return; // Gatsby started this search and speaks for himself (see report())
	}

	auto source = std::make_unique<SpeechAudioSource>(SpeechGen::InputType::Text, Phrases::map(phrase, id));
	audio->play(ServiceLocator::SpeechAudioGenInstance.get(), std::move(source));
	audio->waitEnd(portMAX_DELAY);
}

void SummonEventRoutine::onDetect(int faceCount, bool known, glm::vec2 pos, glm::vec2 size){
	if(faceCount <= 0){
		return;
	}

	faceCenterX = pos.x + size.x * 0.5f;
	detected = true;
	ownerSeen = ownerSeen || known;
}

void SummonEventRoutine::report(const char* outcome){
	if(reported || robotCmdId.empty() || !ServiceLocator::NetServiceInstance){
		return;
	}
	reported = true;
	ServiceLocator::NetServiceInstance->sendRobotResult(robotCmdId, "summon", outcome, ownerSeen, ownerEnrolled);
}

void SummonEventRoutine::onProximityReading(ProxState front, ProxState bottom){
	proxReadingReceived = true;
	proxUnsafe = RobotControl::unsafeToMove(front, bottom);
}

void SummonEventRoutine::onProximityChange(ProxSensor sensor, bool state){
	if(RobotControl::stopsMovement(sensor, state)){
		proxInterrupted = true;
	}
}
