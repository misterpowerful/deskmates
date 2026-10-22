#include "RobotControl.h"
#include "NetService.h"
#include <Core/Application.h>
#include <Statics/ApplicationStatics.h>
#include <Util/ServiceLocator.h>
#include <Services/Modules/ModuleService.h>
#include <Services/Modules/ModuleDevices/RM_TempHumModule.h>
#include <Services/Modules/ModuleDevices/RM_CO2Sensor.h>
#include <Services/Modules/ModuleDevices/RM_MotionSensor.h>
#include "Services/LEDModuleControl.h"
#include "Services/BaseBoard.h"
#include "Services/MotionService.h"
#include "Battery/Battery.h"
#include <cJSON.h>
#include <esp_log.h>
#include <mutex>
#include <utility>

static const char* TAG = "RobotControl";
static constexpr uint32_t AnnouncementWaitMs = 3000;

namespace {
	std::mutex mtx;
	bool capturingLines = false;
	std::string capturedLines, routineId, routineAction;
	uint32_t routineMoveMs = 0;
	const char* stopReason = nullptr;

	void send(cJSON* root){
		NetService* net = ServiceLocator::NetServiceInstance.get();
		char* json = cJSON_PrintUnformatted(root);
		if(net && json){
			net->sendJson(json);
		}
		cJSON_free(json);
		cJSON_Delete(root);
	}

	cJSON* makeResult(const std::string& id, const std::string& action, const char* outcome){
		cJSON* root = cJSON_CreateObject();
		cJSON_AddStringToObject(root, "type", "robot_result");
		cJSON_AddStringToObject(root, "id", id.c_str());
		cJSON_AddStringToObject(root, "action", action.c_str());
		cJSON_AddStringToObject(root, "outcome", outcome);
		return root;
	}

	const char* setLed(const std::string& mode){
		const Application* app = ApplicationStatics::getApplication();
		ModuleService* modules = app->getService<ModuleService>();
		LEDModuleControl* leds = app->getService<LEDModuleControl>();
		if(modules == nullptr || leds == nullptr) return "error";
		if(modules->getInserted(0) != Modules::Type::RM_LED) return "missing";
		if(mode == "on") leds->turnLedOn();
		else if(mode == "off") leds->turnLedOff();
		else if(mode == "strobe") leds->turnLedStrobe();
		else if(mode == "breathe") leds->turnLedBreathe();
		else if(mode == "faster") leds->turnLedFaster();
		else if(mode == "slower") leds->turnLedSlower();
		else return "unsupported";
		return "done";
	}

	// Everything the robot can tell about itself, plus a fresh reading from whichever board is plugged in.
	void addStatus(cJSON* root){
		const Application* app = ApplicationStatics::getApplication();
		ModuleService* modules = app->getService<ModuleService>();
		const Modules::Type type = modules ? modules->getInserted(0) : Modules::Type::Unknown;
		cJSON_AddStringToObject(root, "module", RobotControl::moduleName(type));

		if(Battery* battery = app->getService<Battery>()){
			cJSON_AddNumberToObject(root, "battery_pct", (int) battery->getPerc());
		}
		if(BaseBoard* base = app->getService<BaseBoard>()){
			static constexpr const char* Charging[] = { "unplugged", "charging", "full" };
			cJSON_AddStringToObject(root, "charging", Charging[(int) base->getChargingState() % 3]);
		}
		if(MotionService* motion = app->getService<MotionService>()){
			cJSON_AddBoolToObject(root, "upright_on_floor", motion->isUprightOnGround());
		}
		if(LEDModuleControl* leds = app->getService<LEDModuleControl>(); leds && type == Modules::Type::RM_LED){
			cJSON_AddBoolToObject(root, "led_on", leds->isLedOn());
		}
		if(modules == nullptr) return;

		ModuleDevice* device = modules->getDevice(0).get();
		if(auto* climate = cast<RM_TempHumModule>(device)){
			climate->sample();
			cJSON_AddNumberToObject(root, "temperature_c", climate->getTemperature());
			cJSON_AddNumberToObject(root, "humidity_pct", climate->getHumidity());
		}else if(auto* co2 = cast<RM_CO2Sensor>(device)){
			cJSON_AddNumberToObject(root, "co2_reading", co2->getReading());
			cJSON_AddBoolToObject(root, "air_ok", co2->isOK());
		}else if(auto* pir = cast<RM_MotionSensor>(device)){
			cJSON_AddBoolToObject(root, "motion_detected", pir->getState());
		}
	}
}

void RobotControl::tick(){
	NetService* net = ServiceLocator::NetServiceInstance.get();
	std::string id, action, arg;
	if(net == nullptr || !net->takeQuickCommand(id, action, arg)){
		return;
	}

	cJSON* root;
	if(action == "led"){
		root = makeResult(id, action, setLed(arg));
	}else if(action == "status"){
		root = makeResult(id, action, "done");
		addStatus(root);
	}else{
		root = makeResult(id, action, "unsupported");
	}
	ESP_LOGI(TAG, "Quick command %s: %s %s -> %s", id.c_str(), action.c_str(), arg.c_str(),
			 cJSON_GetStringValue(cJSON_GetObjectItem(root, "outcome")));
	send(root);
}

void RobotControl::beginRoutine(const std::string& id, const std::string& action, uint32_t moveMs){
	std::lock_guard lock(mtx);
	capturingLines = true;
	capturedLines.clear();
	routineId = id;
	routineAction = action;
	routineMoveMs = moveMs;
	stopReason = nullptr;
}

uint32_t RobotControl::moveDurationMs(uint32_t stockMs){
	std::lock_guard lock(mtx);
	return capturingLines && routineMoveMs > 0 ? routineMoveMs : stockMs;
}

bool RobotControl::unsafeToMove(ProxState front, ProxState bottom){
	const char* reason = front == ProxState::Covered ? "obstacle" : bottom == ProxState::Uncovered ? "edge" : nullptr;
	std::lock_guard lock(mtx);
	stopReason = reason;
	if(reason) ESP_LOGW(TAG, "Not moving: %s", reason);
	return reason != nullptr;
}

bool RobotControl::stopsMovement(ProxSensor sensor, bool state){
	const char* reason = sensor == ProxSensor::Front && state ? "obstacle" : sensor == ProxSensor::Bottom && !state ? "edge" : nullptr;
	if(reason == nullptr) return false;
	if(BaseBoard* base = ApplicationStatics::getApplication()->getService<BaseBoard>()){
		base->stopMotors();
	}
	ESP_LOGW(TAG, "Stopped moving: %s", reason);
	std::lock_guard lock(mtx);
	stopReason = reason;
	return true;
}

const char* RobotControl::takeStopReason(){
	std::lock_guard lock(mtx);
	return std::exchange(stopReason, nullptr);
}

void RobotControl::endRoutine(){
	std::string id, action, lines;
	const char* outcome;
	{
		std::lock_guard lock(mtx);
		if(!capturingLines) return;
		capturingLines = false;
		id = std::move(routineId);
		action = std::move(routineAction);
		lines = std::move(capturedLines);
		outcome = std::exchange(stopReason, nullptr);
		if(outcome == nullptr) outcome = "done";
	}
	ESP_LOGI(TAG, "Routine %s (%s) %s; it would have said: \"%s\"", id.c_str(), action.c_str(), outcome, lines.c_str());
	cJSON* root = makeResult(id, action, outcome);
	cJSON_AddStringToObject(root, "text", lines.c_str());
	send(root);
}

bool RobotControl::capturing(){
	std::lock_guard lock(mtx);
	return capturingLines;
}

void RobotControl::capture(const std::string& text){
	std::lock_guard lock(mtx);
	if(!capturedLines.empty()) capturedLines += " ";
	capturedLines += text;
}

bool RobotControl::reportModule(Modules::Type type, bool inserted){
	NetService* net = ServiceLocator::NetServiceInstance.get();
	if(net == nullptr || !net->isServerReady()){
		return false;
	}
	cJSON* root = cJSON_CreateObject();
	cJSON_AddStringToObject(root, "type", "module_event");
	cJSON_AddStringToObject(root, "module", moduleName(type));
	cJSON_AddBoolToObject(root, "inserted", inserted);
	ESP_LOGI(TAG, "Board %s %s", moduleName(type), inserted ? "plugged in" : "removed");
	send(root);
	net->expectAnnouncement(AnnouncementWaitMs); // play it before reloading the wake model (~2.5 s)
	return true;
}

const char* RobotControl::moduleName(Modules::Type type){
	switch(type){
#ifdef CONFIG_RM_TempHum
		case Modules::Type::RM_TempHum: return "climate";
#endif
#ifdef CONFIG_RM_LED
		case Modules::Type::RM_LED: return "led";
#endif
#ifdef CONFIG_RM_Motion
		case Modules::Type::RM_Motion: return "motion";
#endif
#ifdef CONFIG_RM_CO2
		case Modules::Type::RM_CO2: return "co2";
#endif
#ifdef CONFIG_RM_IR
		case Modules::Type::RM_IR: return "ir";
#endif
#ifdef CONFIG_RM_PerfBoard
		case Modules::Type::RM_PerfBoard: return "perfboard";
#endif
		default: return "none";
	}
}
