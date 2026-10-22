#ifndef BUTTERBOT_FIRMWARE_STREAMAUDIOSOURCE_H
#define BUTTERBOT_FIRMWARE_STREAMAUDIOSOURCE_H

#include <Services/Audio/AudioSource.h>
#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include "Util/PSRAMAllocator.h"

/**
 * Raw PCM that is still arriving (the server's reply audio). The websocket task appends to it
 * while the audio task plays from it, so the reply starts speaking before the download finishes.
 */
class AudioStream {
public:
	explicit AudioStream(size_t expectedBytes);

	void append(const uint8_t* data, size_t bytes);

	/** All bytes arrived. */
	void finish();

	/** Download broke off; playback ends after whatever already arrived. */
	void fail();

	bool isEnded() const { return ended.load(); }
	size_t size() const;
	size_t expected() const { return expectedBytes; }

private:
	friend class StreamAudioSource;

	mutable std::mutex mtx;
	PSRAMByteBuffer data;
	const size_t expectedBytes;
	std::atomic_bool ended{ false };
};

/**
 * Plays an AudioStream. Audio::tick treats a 0-byte read as end of clip, so while the stream is
 * waiting for data this outputs silence instead, buffering PrebufferBytes before (re)starting so a
 * slow patch doesn't turn into a stutter.
 */
class StreamAudioSource : public AudioSource {
public:
	explicit StreamAudioSource(std::shared_ptr<AudioStream> stream);

	void open() override;

	void close() override;

	size_t getData(uint8_t* buffer, size_t bytes) override;

	operator bool() const override;

private:
	static constexpr size_t PrebufferBytes = 16000 * 2 / 4; // 250ms of 16kHz mono 16-bit

	std::shared_ptr<AudioStream> stream;
	size_t pos = 0;
	bool buffering = true;
	bool closed = false;
	bool started = false;
};

#endif //BUTTERBOT_FIRMWARE_STREAMAUDIOSOURCE_H
