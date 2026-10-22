// Replaces ESP-IDF's phy_track_pll_init/deinit (linked with --wrap, see main/CMakeLists.txt).
//
// Stock IDF creates and deletes the PHY's PLL-track esp_timer every time the PHY is enabled and
// disabled. With BLE modem sleep that is every BLE wake, and esp_timer_create allocates from internal
// RAM behind an ESP_ERROR_CHECK. While the AFE/MultiNet models load, internal RAM briefly drops to
// ~1 KB, so a BLE wake at that moment aborted the whole app (phy_track_pll_init: ESP_ERR_NO_MEM).
//
// Here the timer is created once, on the first PHY enable at boot when RAM is plentiful, and only
// started/stopped afterwards. The callback does what IDF's does: track PLL under the PHY lock.

#include <sys/lock.h>
#include "esp_err.h"
#include "esp_timer.h"
#include "esp_private/phy.h"
#include "sdkconfig.h"

#if !CONFIG_ESP_PHY_DISABLE_PLL_TRACK

#define PLL_TRACK_PERIOD_US (CONFIG_ESP_PHY_PLL_TRACK_PERIOD_MS * 1000)

static esp_timer_handle_t s_pll_timer;

static void pll_timer_cb(void* arg)
{
	_lock_t phy_lock = phy_get_lock();
	_lock_acquire(&phy_lock);
	phy_track_pll(); // tracks if a period has passed since the last track (same timestamps IDF uses)
	_lock_release(&phy_lock);
}

void __wrap_phy_track_pll_init(void)
{
	if(s_pll_timer == NULL){
		const esp_timer_create_args_t args = {
			.callback = &pll_timer_cb,
			.name = "phy-track-pll-timer"
		};
		ESP_ERROR_CHECK(esp_timer_create(&args, &s_pll_timer));
	}
	if(!esp_timer_is_active(s_pll_timer)){
		ESP_ERROR_CHECK(esp_timer_start_periodic(s_pll_timer, PLL_TRACK_PERIOD_US));
	}
}

void __wrap_phy_track_pll_deinit(void)
{
	if(s_pll_timer != NULL && esp_timer_is_active(s_pll_timer)){
		esp_timer_stop(s_pll_timer);
	}
}

#endif
