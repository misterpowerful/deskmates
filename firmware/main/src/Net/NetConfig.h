#ifndef BUTTERBOT_FIRMWARE_NETCONFIG_H
#define BUTTERBOT_FIRMWARE_NETCONFIG_H

#include <cstddef>
#include <cstdint>
#include <span>
#include "Net/NetTypes.h"

#if __has_include("Net/Secrets.h")
	#include "Net/Secrets.h"
	#define BUTTERBOT_COMPANION_ENABLED 1
#else
	#warning "main/src/Net/Secrets.h not found - companion mode (home WiFi + server) is DISABLED. Copy Secrets.example.h to Secrets.h to enable."
	#define BUTTERBOT_COMPANION_ENABLED 0
#endif

namespace NetConfig {

#if BUTTERBOT_COMPANION_ENABLED
inline std::span<const KnownNetwork> networks(){ return Secrets::Networks; }
inline constexpr const char* ServerUri = Secrets::ServerUri;
inline constexpr const char* BotAuthToken = Secrets::BotAuthToken;
#else
inline std::span<const KnownNetwork> networks(){ return {}; }
inline constexpr const char* ServerUri = "";
inline constexpr const char* BotAuthToken = "";
#endif

// Conversation mode sent with every request. v1: pressing the button is a
// deliberate owner action, so FRIENDLY. Wiring face-recognition/sentry into
// this is an open item - see architecture doc.
inline constexpr const char* DefaultMode = "friendly";

// Attempts per network before moving to the next one in the list.
inline constexpr uint8_t ConnectRetriesPerNetwork = 3;

// Delay before retrying WiFi after all networks failed.
inline constexpr uint32_t WiFiRetryBackoffMs = 10000;

// WebSocket auto-reconnect interval once WiFi is up.
inline constexpr int WsReconnectMs = 3000;

// If WiFi is up but the server has been unreachable this long, tear the websocket down and rebuild it.
inline constexpr uint32_t WsWatchdogRestartMs = 15000;
inline constexpr uint32_t WsWatchdogPeriodMs = 5000;

// Largest audio payload we'll accept from the server (~62s of 16kHz mono PCM).
inline constexpr size_t MaxIncomingAudioBytes = 2 * 1024 * 1024;

// Largest JSON header we'll accept from the server.
inline constexpr size_t MaxIncomingJsonBytes = 16 * 1024;

}

#endif //BUTTERBOT_FIRMWARE_NETCONFIG_H
