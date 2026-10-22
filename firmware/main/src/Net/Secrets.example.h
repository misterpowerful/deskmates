// Copy this file to Secrets.h (same folder) and fill it in.
// Secrets.h is gitignored - it must never be committed.
#ifndef DESKMATES_FIRMWARE_SECRETS_H
#define DESKMATES_FIRMWARE_SECRETS_H

#include "Net/NetTypes.h"

namespace Secrets {

// Known networks, tried in order. Home first, phone hotspot second is a good default.
inline constexpr KnownNetwork Networks[] = {
	{ "HomeNetworkSSID",   "home-password" },
	{ "PhoneHotspotSSID",  "hotspot-password" },
};

// Server WebSocket endpoint.
inline constexpr const char* ServerUri = "wss://your-server.example.com/";

// Must exactly match BOT_AUTH_TOKEN in the server's .env
// (sent as the X-Butterbot-Token header on connect).
inline constexpr const char* BotAuthToken = "paste-BOT_AUTH_TOKEN-here";

}

#endif //DESKMATES_FIRMWARE_SECRETS_H
