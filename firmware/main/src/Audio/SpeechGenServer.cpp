#include <sdkconfig.h>
#if !CONFIG_BB_STOCK_VOICE
#include "SpeechGen.h"
#include <algorithm>
#include <cstring>
#include <esp_log.h>
#include <freertos/task.h>
#include <Util/ServiceLocator.h>
#include "Net/NetService.h"
#include "Util/stdafx.h"

// Stock voice off (CONFIG_BB_STOCK_VOICE): stock phrases are sent to the server as text and
// played back in the companion voice (16 kHz PCM, the same format flite produced). Without the
// server they are silent.

static const char* TAG = "SpeechGen";

SpeechGen::SpeechGen() = default;

SpeechGen::~SpeechGen() = default;

void SpeechGen::parseText(std::string text){
	cancel();
	NetService* net = ServiceLocator::NetServiceInstance.get();
	if(net == nullptr || !net->isServerReady() || !net->requestSpeak(text)){
		ESP_LOGW(TAG, "Server unreachable: stock line not spoken: \"%s\"", text.c_str());
		return;
	}
	std::lock_guard lock(mtx);
	active = true;
	deadlineMs = millis() + ServerSpeechTimeoutMs;
}

void SpeechGen::parsePhonemes(const std::string& phonemes){
	cancel();
	ESP_LOGW(TAG, "No on-device voice for phonemes \"%s\": not spoken", phonemes.c_str());
}

void SpeechGen::parseSSML(std::string ssml){
	// The server only needs the words.
	std::string text;
	bool inTag = false;
	for(char c : ssml){
		if(c == '<') inTag = true;
		else if(c == '>'){ inTag = false; text += ' '; }
		else if(!inTag) text += c;
	}
	parseText(std::move(text));
}

void SpeechGen::cancel(){
	{
		std::lock_guard lock(mtx);
		active = false;
		PSRAMByteBuffer().swap(pcm);
		pos = 0;
	}
	if(NetService* net = ServiceLocator::NetServiceInstance.get()){
		net->cancelSpeak();
	}
}

int SpeechGen::generate(std::span<int16_t> output, bool& last, TickType_t timeout){
	last = false;
	NetService* net = ServiceLocator::NetServiceInstance.get();
	const TickType_t start = xTaskGetTickCount();
	for(;;){
		{
			std::lock_guard lock(mtx);
			if(!active){
				last = true;
				return 0;
			}
			if(pcm.empty() && net){
				PSRAMByteBuffer got;
				switch(net->takeSpeak(got)){
					case NetService::SpeakState::Ready:
						pcm = std::move(got);
						pos = 0;
						break;
					case NetService::SpeakState::Failed:
						active = false;
						last = true;
						return 0;
					case NetService::SpeakState::Pending:
						break;
				}
			}
			if(!pcm.empty()){
				const size_t samples = std::min(output.size(), (pcm.size() - pos) / sizeof(int16_t));
				memcpy(output.data(), pcm.data() + pos, samples * sizeof(int16_t));
				pos += samples * sizeof(int16_t);
				if(pos + sizeof(int16_t) > pcm.size()){
					active = false;
					last = true;
					PSRAMByteBuffer().swap(pcm);
				}
				return (int) samples;
			}
			if(millis() > deadlineMs){
				ESP_LOGW(TAG, "Server didn't send the stock line within %u ms", (unsigned) ServerSpeechTimeoutMs);
				active = false;
				last = true;
				return 0;
			}
		}
		if(xTaskGetTickCount() - start >= timeout){
			return 0;
		}
		vTaskDelay(pdMS_TO_TICKS(10));
	}
}

#endif // !CONFIG_BB_STOCK_VOICE
