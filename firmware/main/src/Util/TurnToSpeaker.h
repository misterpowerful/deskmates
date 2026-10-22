#ifndef BUTTERBOT_FIRMWARE_TURNTOSPEAKER_H
#define BUTTERBOT_FIRMWARE_TURNTOSPEAKER_H

#include <cstdint>

class AudioFrontend;

/**
 * Companion mode: turn the robot toward whoever is talking. The two head mics (~2 in apart, either side
 * of the camera) give left / right / ahead from the inter-channel lag (AudioFrontend::estimateDirection),
 * with a4f5e8b's calibration and steps (2026-10-10: the build that "rotated great").
 *
 * One turn per exchange, made while the server prepares the reply (service() in ConverseState): the
 * question decides it, falling back to the wake phrase when the question gave no clear reading. Never
 * before listening - a4f5e8b turned between the wake phrase and the question with the mic off, so the
 * question was lost to gear clicks ("no speech detected") and the reading taken from them.
 */
namespace TurnToSpeaker {

	/** AFE proc task, on a wake phrase that hands over to listening: remember its direction (no turn). */
	void noteWake(AudioFrontend* afe, uint32_t speechMs);

	/** AFE proc task, when the utterance that goes to the server ends: decide the turn. */
	/** Drop a decided turn that won't happen (the server heard no speech, or the turn failed). */
	void cancelPending();
	void onUtteranceEnd(AudioFrontend* afe, uint32_t speechMs);

	/** State machine task (ConverseState, once the speech is sent): start the decided turn, if any.
	 *  the owner's order: send the speech, then turn; the reply plays as soon as it arrives, mid-turn
	 *  if need be. Only the next listen waits for the turn to finish. */
	void service();

	/** Blocks until a turn in progress has finished (or maxMs passed). */
	void waitDone(uint32_t maxMs);

}

#endif //BUTTERBOT_FIRMWARE_TURNTOSPEAKER_H
