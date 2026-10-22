#include "GatsbyLines.h"
#include <cstdint>
#include <esp_log.h>
#include <esp_random.h>
#include <Core/Application.h>
#include <Statics/ApplicationStatics.h>
#include <Services/Audio/AACAudioGenerator.h>
#include <Services/Audio/Audio.h>
#include "Audio/MemoryAudioSource.h"
#include "Net/NetService.h"

static const char* TAG = "GatsbyLines";

#define GATSBY_LINE(name) \
	extern const uint8_t name##_start[] asm("_binary_" #name "_aac_start"); \
	extern const uint8_t name##_end[] asm("_binary_" #name "_aac_end");
GATSBY_LINE(boot_1)
GATSBY_LINE(boot_2)
GATSBY_LINE(boot_3)
GATSBY_LINE(bye_1)
GATSBY_LINE(bye_2)
GATSBY_LINE(bye_3)

namespace {
	struct Line { const uint8_t* start; const uint8_t* end; };
	const Line StartupLines[] = { { boot_1_start, boot_1_end }, { boot_2_start, boot_2_end }, { boot_3_start, boot_3_end } };
	const Line GoodbyeLines[] = { { bye_1_start, bye_1_end }, { bye_2_start, bye_2_end }, { bye_3_start, bye_3_end } };
}

namespace GatsbyLines {

bool play(Audio* audio, Kind kind){
	if(audio == nullptr || !NetService::isConfigured()){
		return false;
	}
	AACAudioGenerator* aac = ApplicationStatics::getApplication()->getService<AACAudioGenerator>();
	if(aac == nullptr){
		return false;
	}
	const Line* lines = kind == Kind::Startup ? StartupLines : GoodbyeLines;
	const Line& line = lines[esp_random() % 3];
	// Copied to PSRAM so playback never waits on the flash (MemoryAudioSource).
	PSRAMByteBuffer data(line.start, line.end);
	ESP_LOGI(TAG, "%s line (%u bytes)", kind == Kind::Startup ? "Startup" : "Goodbye", (unsigned) data.size());
	audio->play(aac, std::make_unique<MemoryAudioSource>(std::move(data)));
	return true;
}

}
