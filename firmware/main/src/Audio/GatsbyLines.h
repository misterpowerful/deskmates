#ifndef BUTTERBOT_FIRMWARE_GATSBYLINES_H
#define BUTTERBOT_FIRMWARE_GATSBYLINES_H

class Audio;

/**
 * Companion mode: a few lines in Gatsby's (ElevenLabs) voice built into the firmware, for moments when
 * the server can't supply one - power on (it isn't connected yet), power off, and a turn the
 * server can't answer. AAC files in
 * main/assets/gatsby, embedded in the app; one is picked at random each time.
 */
namespace GatsbyLines {

	enum class Kind { Startup, Goodbye, Offline };

	/** Starts a line playing (doesn't wait). False if companion mode is off or it can't play: use the stock phrase. */
	bool play(Audio* audio, Kind kind);

}

#endif //BUTTERBOT_FIRMWARE_GATSBYLINES_H
