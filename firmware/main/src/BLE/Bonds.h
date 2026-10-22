#ifndef BUTTERBOT_FIRMWARE_BONDS_H
#define BUTTERBOT_FIRMWARE_BONDS_H

#include <cstring>
#include <memory>
#include <esp_gap_ble_api.h>

namespace BLE {

// Upstream 1.0.1 references this header but never shipped it; this is a reconstruction.
// True if the peer's address is in Bluedroid's persisted bond list.
inline bool isBonded(const uint8_t* addr){
	int num = esp_ble_get_bond_device_num();
	if(num <= 0) return false;

	auto list = std::make_unique<esp_ble_bond_dev_t[]>(num);
	if(esp_ble_get_bond_device_list(&num, list.get()) != ESP_OK) return false;

	for(int i = 0; i < num; i++){
		if(memcmp(list[i].bd_addr, addr, ESP_BD_ADDR_LEN) == 0) return true;
	}
	return false;
}

}

#endif //BUTTERBOT_FIRMWARE_BONDS_H
