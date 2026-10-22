#ifndef BUTTERBOT_FIRMWARE_PCMPASSTHROUGHGENERATOR_H
#define BUTTERBOT_FIRMWARE_PCMPASSTHROUGHGENERATOR_H

#include <memory>
#include <Services/Audio/AudioGenerator.h>

/**
 * Plays raw 16kHz / mono / 16-bit PCM straight from its source. The speaker I2S is configured
 * for exactly that format, and the server returns ElevenLabs pcm_16000, so no decoding
 * or resampling is needed. Pair with MemoryAudioSource for server-delivered audio.
 */
class PCMPassthroughGenerator : public AudioGenerator {
public:
	void open(std::unique_ptr<AudioSource> resource) override;
	void close() override;
	size_t getData(uint8_t* buffer, size_t bytes) override;

private:
	std::unique_ptr<AudioSource> source;
};

#endif //BUTTERBOT_FIRMWARE_PCMPASSTHROUGHGENERATOR_H
