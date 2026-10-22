#ifndef BUTTERBOT_FIRMWARE_ROBOTCONTROL_H
#define BUTTERBOT_FIRMWARE_ROBOTCONTROL_H

#include <string>
#include <Services/Modules/ModuleType.h>
#include "Services/BaseBoard.h"

/**
 * Robot functions driven by Gatsby (the server).
 * Quick commands (LED board, status and sensor readings) are answered straight away, in any state, so
 * Gatsby gets the answer inside his tool call. Physical ones (move, dance) run the stock routine from
 * IdleState after his reply; the lines that routine would speak in the stock voice are captured and
 * handed back to him instead of played.
 */
namespace RobotControl {
	/** State machine thread: runs any waiting quick command and sends its robot_result. */
	void tick();

	/** A stock routine started for a server command; its spoken lines are captured until endRoutine(). */
	void beginRoutine(const std::string& id, const std::string& action, uint32_t moveMs = 0);
	void endRoutine();

	/** A commanded move's motor time: what Gatsby asked for (distance or angle), else the stock one. */
	uint32_t moveDurationMs(uint32_t stockMs);

	/**
	 * Every routine that drives the motors checks the proximity sensors through these. Stock routines
	 * only stopped for an obstacle ahead; the bottom sensor losing the floor (a table edge, or being
	 * picked up) now stops them too. stopsMovement() cuts the motors itself, straight away.
	 */
	bool unsafeToMove(ProxState front, ProxState bottom);
	bool stopsMovement(ProxSensor sensor, bool state);
	/** Why the last move stopped early ("edge", "obstacle"), or nullptr; reading it clears it. */
	const char* takeStopReason();

	bool capturing();
	void capture(const std::string& text);

	/** Tells the server a board went in or out. False when it isn't reachable (stock behavior then). */
	bool reportModule(Modules::Type type, bool inserted);

	const char* moduleName(Modules::Type type);
}

#endif //BUTTERBOT_FIRMWARE_ROBOTCONTROL_H
