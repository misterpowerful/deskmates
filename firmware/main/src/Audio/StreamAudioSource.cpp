#include "StreamAudioSource.h"
#include <algorithm>
#include <cstring>
#include <esp_log.h>

static const char* TAG = "StreamAudio";

AudioStream::AudioStream(size_t expectedBytes) : expectedBytes(expectedBytes){
	data.reserve(expectedBytes);
}

void AudioStream::append(const uint8_t* bytes, size_t count){
	std::lock_guard lock(mtx);
	data.insert(data.end(), bytes, bytes + count);
}

void AudioStream::finish(){
	ended = true;
}

void AudioStream::fail(){
	ended = true;
}

size_t AudioStream::size() const{
	std::lock_guard lock(mtx);
	return data.size();
}

StreamAudioSource::StreamAudioSource(std::shared_ptr<AudioStream> stream) : stream(std::move(stream)){
}

void StreamAudioSource::open(){
	pos = 0;
	buffering = true;
	closed = false;
}

void StreamAudioSource::close(){
	closed = true;
}

size_t StreamAudioSource::getData(uint8_t* buffer, size_t bytes){
	if(closed || !stream){
		return 0;
	}

	std::lock_guard lock(stream->mtx);
	const size_t available = stream->data.size() - pos;
	const bool ended = stream->ended.load();

	if(buffering){
		if(available < PrebufferBytes && !ended){
			std::memset(buffer, 0, bytes);
			return bytes;
		}
		buffering = false;
		if(!started){
			started = true;
			ESP_LOGI(TAG, "Reply playback started (%u of %u bytes in)", (unsigned) stream->data.size(), (unsigned) stream->expectedBytes);
		}
	}

	// Whole 16-bit samples only: websocket chunks can end on an odd byte.
	const size_t n = std::min(bytes, available) & ~static_cast<size_t>(1);
	if(n == 0){
		if(ended){
			return 0;
		}
		// Underrun: play silence and rebuffer rather than ending the clip.
		ESP_LOGW(TAG, "Reply playback underrun at %u bytes, rebuffering", (unsigned) pos);
		buffering = true;
		std::memset(buffer, 0, bytes);
		return bytes;
	}

	std::memcpy(buffer, stream->data.data() + pos, n);
	pos += n;
	return n;
}

StreamAudioSource::operator bool() const{
	if(closed || !stream){
		return false;
	}
	return !(stream->isEnded() && pos >= stream->size());
}
