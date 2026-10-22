#include "PCMPassthroughGenerator.h"

void PCMPassthroughGenerator::open(std::unique_ptr<AudioSource> resource){
	// Audio re-opens the same generator without close() when consecutive queued clips share it
	// (e.g. filler then reply), so release the previous source here.
	if(source){
		source->close();
	}
	source = std::move(resource);
	if(source){
		source->open();
	}
}

void PCMPassthroughGenerator::close(){
	if(source){
		source->close();
		source.reset();
	}
}

size_t PCMPassthroughGenerator::getData(uint8_t* buffer, size_t bytes){
	if(!source || !*source){
		return 0;
	}
	// Keep whole 16-bit samples so an odd-sized read can't shift the byte alignment.
	return source->getData(buffer, bytes & ~static_cast<size_t>(1));
}
