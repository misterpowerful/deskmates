#include "NetService.h"
#include "Net/NetConfig.h"
#include "Audio/StreamAudioSource.h"
#include <cstring>
#include <cstdio>
#include <esp_log.h>
#include <esp_heap_caps.h>
#include <esp_mac.h>
#include <esp_wifi.h>
#include <esp_crt_bundle.h>
#include <esp_websocket_client.h>
#include <cJSON.h>
#include <freertos/idf_additions.h>

static const char* TAG = "NetService";

namespace {
	constexpr int OpContinuation = 0x0;
	constexpr int OpText = 0x1;
	constexpr int OpBinary = 0x2;
	constexpr TickType_t SendTimeout = pdMS_TO_TICKS(10000);

	// Log download progress of large binary frames (reply audio) so throughput and stalls show up.
	constexpr size_t RxProgressMinFrame = 128 * 1024;
	constexpr size_t RxProgressStep = 64 * 1024;

	// Internal RAM is the scarce resource once WiFi + BLE + TLS are all up; log it at milestones.
	void logInternalHeap(const char* where){
		ESP_LOGI(TAG, "[heap %s] internal free %u, largest block %u, min ever %u", where,
				 (unsigned) heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
				 (unsigned) heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
				 (unsigned) heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL));
	}

	std::string jsonString(const cJSON* obj, const char* key){
		const cJSON* item = cJSON_GetObjectItemCaseSensitive(obj, key);
		return cJSON_IsString(item) && item->valuestring ? std::string(item->valuestring) : std::string();
	}
}

NetService::NetService(){
	uint8_t mac[6] = {};
	esp_read_mac(mac, ESP_MAC_WIFI_STA);
	char session[32];
	snprintf(session, sizeof(session), "bb-%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

	// session_id lets the server resume conversation memory across reconnects (e.g. after RC mode).
	sessionUri = NetConfig::ServerUri;
	sessionUri += (sessionUri.find('?') == std::string::npos) ? "?session_id=" : "&session_id=";
	sessionUri += session;

	authHeader = std::string("X-Butterbot-Token: ") + NetConfig::BotAuthToken + "\r\n";

	// Speech stream sender. Stack in PSRAM: internal RAM is what ran out in the turn-2 crash.
	xTaskCreatePinnedToCoreWithCaps(upTaskFunc, "speech-up", 4096, this, 5, &upTask, tskNO_AFFINITY, MALLOC_CAP_SPIRAM);
}

NetService::~NetService(){
	suspend();
}

bool NetService::isConfigured(){
	return BUTTERBOT_COMPANION_ENABLED && !NetConfig::networks().empty();
}

// ============================ WiFi ============================

void NetService::start(){
	if(!isEnabled()){
		ESP_LOGW(TAG, "Companion mode disabled (no Secrets.h or no networks configured)");
		return;
	}
	if(running.exchange(true)){
		return;
	}
	suspending = false;
	wifiUp = false;
	serverUp = false;
	networkIndex = 0;
	attemptsOnNetwork = 0;
	networksTriedThisRound = 0;

	ESP_LOGI(TAG, "Starting companion WiFi");
	logInternalHeap("before wifi");

	const esp_err_t loopErr = esp_event_loop_create_default();
	if(loopErr != ESP_OK && loopErr != ESP_ERR_INVALID_STATE){
		ESP_LOGE(TAG, "event loop create failed: %s", esp_err_to_name(loopErr));
		running = false;
		return;
	}

	ESP_ERROR_CHECK(esp_netif_init());
	netif = esp_netif_create_default_wifi_sta(); // DHCP client enabled - unlike CMF's WiFi

	const wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
	ESP_ERROR_CHECK(esp_wifi_init(&cfg));
	ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM)); // don't persist creds to NVS

	ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &NetService::wifiEventTrampoline, this, &wifiHandler));
	ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &NetService::wifiEventTrampoline, this, &ipHandler));

	const esp_timer_create_args_t timerArgs = {
		.callback = &NetService::retryTimerCb,
		.arg = this,
		.dispatch_method = ESP_TIMER_TASK,
		.name = "net_retry",
		.skip_unhandled_events = true,
	};
	ESP_ERROR_CHECK(esp_timer_create(&timerArgs, &retryTimer));

	const esp_timer_create_args_t fillerArgs = {
		.callback = &NetService::fillerTimerCb,
		.arg = this,
		.dispatch_method = ESP_TIMER_TASK,
		.name = "net_filler",
		.skip_unhandled_events = true,
	};
	ESP_ERROR_CHECK(esp_timer_create(&fillerArgs, &fillerTimer));

	const esp_timer_create_args_t watchArgs = {
		.callback = &NetService::watchTimerCb,
		.arg = this,
		.dispatch_method = ESP_TIMER_TASK,
		.name = "net_watch",
		.skip_unhandled_events = true,
	};
	ESP_ERROR_CHECK(esp_timer_create(&watchArgs, &watchTimer));
	serverDownSinceUs = 0;
	esp_timer_start_periodic(watchTimer, (uint64_t) NetConfig::WsWatchdogPeriodMs * 1000ULL);

	ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
	applyNetwork(0);
	ESP_ERROR_CHECK(esp_wifi_start()); // -> WIFI_EVENT_STA_START -> esp_wifi_connect()
}

void NetService::suspend(){
	if(!running.load()){
		return;
	}
	ESP_LOGI(TAG, "Suspending companion WiFi");
	suspending = true;

	stopWebSocket();

	if(retryTimer){
		esp_timer_stop(retryTimer);
		esp_timer_delete(retryTimer);
		retryTimer = nullptr;
	}
	if(fillerTimer){
		esp_timer_stop(fillerTimer);
		esp_timer_delete(fillerTimer);
		fillerTimer = nullptr;
	}
	if(watchTimer){
		esp_timer_stop(watchTimer);
		esp_timer_delete(watchTimer);
		watchTimer = nullptr;
	}

	if(wifiHandler){
		esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, wifiHandler);
		wifiHandler = nullptr;
	}
	if(ipHandler){
		esp_event_handler_instance_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, ipHandler);
		ipHandler = nullptr;
	}

	esp_wifi_disconnect();
	esp_wifi_stop();
	esp_wifi_deinit();

	if(netif){
		esp_netif_destroy_default_wifi(netif);
		netif = nullptr;
	}

	// CMF's WiFi constructor ESP_ERROR_CHECKs esp_event_loop_create_default(), which aborts if the
	// default loop already exists. It must be gone before RCState builds its WiFi.
	esp_event_loop_delete_default();

	wifiUp = false;
	serverUp = false;
	{
		std::lock_guard lock(mtx);
		failTurnLocked("companion WiFi suspended");
		fillerReqId.clear();
		expectBin = BinDest::None;
	}
	running = false;
	suspending = false;
}

void NetService::applyNetwork(size_t index){
	const auto nets = NetConfig::networks();
	networkIndex = index % nets.size();
	const KnownNetwork& net = nets[networkIndex];

	wifi_config_t cfg = {};
	strncpy(reinterpret_cast<char*>(cfg.sta.ssid), net.ssid, sizeof(cfg.sta.ssid) - 1);
	strncpy(reinterpret_cast<char*>(cfg.sta.password), net.password, sizeof(cfg.sta.password) - 1);
	cfg.sta.scan_method = WIFI_ALL_CHANNEL_SCAN; // home routers aren't on the controller's fixed channel
	cfg.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
	cfg.sta.threshold.authmode = (net.password[0] == '\0') ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA_PSK;
	cfg.sta.pmf_cfg.capable = true;
	cfg.sta.pmf_cfg.required = false;

	esp_wifi_set_config(WIFI_IF_STA, &cfg);
	ESP_LOGI(TAG, "Trying network %u: '%s'", (unsigned) networkIndex, net.ssid);
}

void NetService::wifiEventTrampoline(void* arg, esp_event_base_t base, int32_t id, void* data){
	auto* self = static_cast<NetService*>(arg);
	if(self == nullptr || self->suspending.load()){
		return;
	}
	if(base == WIFI_EVENT){
		self->onWiFiEvent(id, data);
	}else if(base == IP_EVENT){
		self->onIpEvent(id, data);
	}
}

void NetService::onWiFiEvent(int32_t id, void* data){
	switch(id){
		case WIFI_EVENT_STA_START:
			esp_wifi_connect();
			break;

		case WIFI_EVENT_STA_DISCONNECTED: {
			const auto* info = static_cast<wifi_event_sta_disconnected_t*>(data);
			const bool wasUp = wifiUp.exchange(false);
			serverUp = false;
			ESP_LOGW(TAG, "WiFi disconnected (reason %d)", info ? info->reason : -1);

			if(wasUp){
				// Lost an established link: retry the same network first.
				attemptsOnNetwork = 0;
				networksTriedThisRound = 0;
				esp_wifi_connect();
				break;
			}

			if(++attemptsOnNetwork < NetConfig::ConnectRetriesPerNetwork){
				esp_wifi_connect();
				break;
			}

			attemptsOnNetwork = 0;
			if(++networksTriedThisRound >= NetConfig::networks().size()){
				networksTriedThisRound = 0;
				ESP_LOGW(TAG, "No known network reachable, backing off %lu ms", (unsigned long) NetConfig::WiFiRetryBackoffMs);
				applyNetwork(0);
				esp_timer_start_once(retryTimer, (uint64_t) NetConfig::WiFiRetryBackoffMs * 1000ULL);
				break;
			}
			applyNetwork(networkIndex + 1);
			esp_wifi_connect();
			break;
		}

		default:
			break;
	}
}

void NetService::onIpEvent(int32_t id, void* data){
	if(id != IP_EVENT_STA_GOT_IP){
		return;
	}
	const auto* ev = static_cast<ip_event_got_ip_t*>(data);
	ESP_LOGI(TAG, "Got IP " IPSTR " on '%s'", IP2STR(&ev->ip_info.ip), NetConfig::networks()[networkIndex].ssid);
	wifiUp = true;
	logInternalHeap("got ip");
	attemptsOnNetwork = 0;
	networksTriedThisRound = 0;
	startWebSocket(); // no-op if already created; it auto-reconnects on its own after that
}

void NetService::watchTimerCb(void* arg){
	auto* self = static_cast<NetService*>(arg);
	if(self == nullptr || self->suspending.load()){
		return;
	}
	if(!self->wifiUp.load() || self->serverUp.load()){
		self->serverDownSinceUs = 0;
		return;
	}
	const int64_t now = esp_timer_get_time();
	if(self->serverDownSinceUs == 0){
		self->serverDownSinceUs = now;
		return;
	}
	if(now - self->serverDownSinceUs < (int64_t) NetConfig::WsWatchdogRestartMs * 1000){
		return;
	}

	std::unique_lock lock(self->wsMtx, std::try_to_lock);
	if(!lock.owns_lock()){
		return; // a send is in progress; check again next tick
	}
	ESP_LOGW(TAG, "Brain server unreachable for %lu ms with WiFi up, restarting websocket", (unsigned long) NetConfig::WsWatchdogRestartMs);
	self->stopWebSocket();
	self->startWebSocket();
	self->serverDownSinceUs = now;
}

void NetService::fillerTimerCb(void* arg){
	auto* self = static_cast<NetService*>(arg);
	if(self && !self->suspending.load()){
		self->requestGreeting();
		self->prefetchFiller();
	}
}

void NetService::retryTimerCb(void* arg){
	auto* self = static_cast<NetService*>(arg);
	if(self && !self->suspending.load() && !self->wifiUp.load()){
		esp_wifi_connect();
	}
}

// ============================ WebSocket ============================

void NetService::startWebSocket(){
	std::lock_guard lock(wsMtx);
	if(ws != nullptr){
		return;
	}

	esp_websocket_client_config_t cfg = {};
	cfg.uri = sessionUri.c_str();
	cfg.headers = authHeader.c_str();
	cfg.crt_bundle_attach = esp_crt_bundle_attach;
	cfg.reconnect_timeout_ms = NetConfig::WsReconnectMs;
	cfg.network_timeout_ms = 10000;
	cfg.buffer_size = 4096;
	cfg.task_stack = 6 * 1024;
	cfg.ping_interval_sec = 20; // server also pings every 25s; client answers those automatically
	cfg.enable_close_reconnect = true; // otherwise the client stops for good after a server-side close

	ws = esp_websocket_client_init(&cfg);
	if(ws == nullptr){
		ESP_LOGE(TAG, "websocket init failed");
		return;
	}
	esp_websocket_register_events(ws, WEBSOCKET_EVENT_ANY, &NetService::wsEventTrampoline, this);
	if(esp_websocket_client_start(ws) != ESP_OK){
		ESP_LOGE(TAG, "websocket start failed");
		esp_websocket_client_destroy(ws);
		ws = nullptr;
	}
}

void NetService::stopWebSocket(){
	std::lock_guard lock(wsMtx);
	if(ws == nullptr){
		return;
	}
	serverUp = false;
	esp_websocket_client_stop(ws);
	esp_websocket_client_destroy(ws);
	ws = nullptr;
}

void NetService::wsEventTrampoline(void* arg, esp_event_base_t, int32_t id, void* data){
	auto* self = static_cast<NetService*>(arg);
	if(self){
		self->onWsEvent(id, data);
	}
}

void NetService::onWsEvent(int32_t id, void* data){
	switch(id){
		case WEBSOCKET_EVENT_CONNECTED:
			ESP_LOGI(TAG, "Connected to server");
			logInternalHeap("ws connected");
			if(fillerTimer){
				esp_timer_stop(fillerTimer);
				esp_timer_start_once(fillerTimer, 500 * 1000ULL);
			}
			serverUp = true;
			resetRx();
			break;

		case WEBSOCKET_EVENT_DISCONNECTED:
		case WEBSOCKET_EVENT_CLOSED:
		case WEBSOCKET_EVENT_ERROR: {
			if(serverUp.exchange(false)){
				ESP_LOGW(TAG, "Brain server connection lost (event %ld)", (long) id);
			}
			// Drop any half-received frame: after a mid-frame transport error the client can hand up
			// leftover bytes as a "new" frame, which must not be taken for the reply.
			resetRx();
			std::lock_guard lock(mtx);
			failTurnLocked("server connection lost");
			fillerReqId.clear();
			greetingReqId.clear();
			listenReqId.clear();
			expectBin = BinDest::None;
			expectBinBytes = 0;
			break;
		}

		case WEBSOCKET_EVENT_DATA: {
			const auto* ev = static_cast<esp_websocket_event_data_t*>(data);
			if(ev == nullptr){
				break;
			}
			const int op = ev->op_code;
			if(op != OpText && op != OpBinary && op != OpContinuation){
				break; // ping/pong/close are handled inside the client
			}
			lastRxUs = esp_timer_get_time();

			if(ev->payload_offset == 0 && op != OpContinuation){
				rxIsBinary = (op == OpBinary);
				rxText.clear();
				rxBin.clear();
				const size_t limit = rxIsBinary ? NetConfig::MaxIncomingAudioBytes : NetConfig::MaxIncomingJsonBytes;
				rxDropping = ev->payload_len < 0 || (size_t) ev->payload_len > limit;
				if(rxDropping){
					ESP_LOGW(TAG, "Dropping oversized %s frame (%d bytes)", rxIsBinary ? "binary" : "text", ev->payload_len);
				}else if(rxIsBinary){
					rxStartUs = esp_timer_get_time();
					rxNextProgressLog = RxProgressStep;
					rxReceived = 0;
					std::lock_guard lock(mtx);
					if(expectBin == BinDest::Turn){
						if(expectBinBytes != 0 && (size_t) ev->payload_len != expectBinBytes){
							ESP_LOGW(TAG, "Reply frame is %d bytes, server announced %u: dropping it", ev->payload_len, (unsigned) expectBinBytes);
							failTurnLocked("reply size mismatch");
							expectBin = BinDest::Discard;
							rxDropping = true;
						}else{
							// Stream it: ConverseState starts playback while the rest downloads.
							rxStream = std::make_shared<AudioStream>(ev->payload_len);
							turnStream = rxStream;
							turnStatus = TurnStatus::Streaming;
						}
					}else{
						rxBin.reserve(ev->payload_len);
					}
				}else{
					rxText.reserve(ev->payload_len);
				}
			}

			if(!rxDropping && ev->data_len > 0){
				if(rxIsBinary){
					if(rxStream){
						rxStream->append((const uint8_t*) ev->data_ptr, ev->data_len);
					}else{
						rxBin.insert(rxBin.end(), (const uint8_t*) ev->data_ptr, (const uint8_t*) ev->data_ptr + ev->data_len);
					}
					rxReceived += ev->data_len;
					if(ev->payload_len >= (int) RxProgressMinFrame && rxReceived >= rxNextProgressLog){
						rxNextProgressLog += RxProgressStep;
						const int64_t ms = (esp_timer_get_time() - rxStartUs) / 1000;
						ESP_LOGI(TAG, "rx %u/%d KB in %lld ms (%lld KB/s)", (unsigned) (rxReceived / 1024), ev->payload_len / 1024,
								 (long long) ms, (long long) (ms > 0 ? (int64_t) rxReceived / ms : 0));
					}
				}else{
					rxText.append(ev->data_ptr, ev->data_len);
				}
			}

			const bool complete = ev->fin && (ev->payload_offset + ev->data_len >= ev->payload_len);
			if(!complete){
				break;
			}

			if(rxDropping){
				rxDropping = false;
				if(rxIsBinary){
					std::lock_guard lock(mtx);
					if(expectBin == BinDest::Turn){
						failTurnLocked("response audio too large");
					}else if(expectBin == BinDest::Filler){
						fillerReqId.clear();
					}
					expectBin = BinDest::None;
				}
				break;
			}

			if(rxIsBinary && rxStream){
				rxStream->finish();
				ESP_LOGI(TAG, "Reply audio received (%u bytes in %lld ms)", (unsigned) rxReceived,
						 (long long) ((esp_timer_get_time() - rxStartUs) / 1000));
				logInternalHeap("reply audio");
				rxStream.reset();
				std::lock_guard lock(mtx);
				expectBin = BinDest::None;
				expectBinBytes = 0;
				turnId.clear();
			}else if(rxIsBinary){
				onBinaryMessage(std::move(rxBin));
				rxBin = PSRAMByteBuffer();
			}else{
				onTextMessage(rxText);
				rxText.clear();
			}
			break;
		}

		default:
			break;
	}
}

void NetService::onTextMessage(const std::string& json){
	cJSON* root = cJSON_ParseWithLength(json.data(), json.size());
	if(root == nullptr){
		ESP_LOGW(TAG, "Unparseable JSON from server");
		return;
	}

	const std::string type = jsonString(root, "type");
	const std::string id = jsonString(root, "id");
	const std::string reason = jsonString(root, "reason");

	const cJSON* bytesItem = cJSON_GetObjectItemCaseSensitive(root, "bytes");
	const size_t announcedBytes = cJSON_IsNumber(bytesItem) && bytesItem->valuedouble > 0 ? (size_t) bytesItem->valuedouble : 0;

	std::lock_guard lock(mtx);
	const bool isTurn = !turnId.empty() && id == turnId;
	const bool isFiller = !fillerReqId.empty() && id == fillerReqId;
	const bool isGreeting = !greetingReqId.empty() && id == greetingReqId;
	const bool isListen = !listenReqId.empty() && id == listenReqId;
	// After a pipeline failure the server pushes an unsolicited pipeline_error line with a "pushed-" id.
	const bool isPushed = id.rfind("pushed-", 0) == 0;
	const bool turnWantsAudio = turnStatus == TurnStatus::Pending || turnStatus == TurnStatus::ErrorAwaiting;

	if(type == "speech_result" || type == "canned_result" || type == "announce"){
		expectBinBytes = announcedBytes;
	}

	if(type == "turn_progress"){
		// The server is about to run a tool (calendar, email, ...) for this turn.
		if(isTurn){
			ESP_LOGI(TAG, "Turn %s: using %s", id.c_str(), jsonString(root, "stage").c_str());
			turnToolInProgress = true;
		}
		return;
	}

	if(type == "robot_command"){
		robotCmdId = id;
		robotCmdAction = jsonString(root, "action");
		ESP_LOGI(TAG, "Robot command %s: %s", id.c_str(), robotCmdAction.c_str());
	}else if(type == "announce"){
		// Gatsby reacting to a robot_result: played by IdleState like the connect greeting.
		ESP_LOGI(TAG, "Announcement: \"%s\"", jsonString(root, "text").c_str());
		expectBin = BinDest::Greeting;
	}

	if(type == "speech_result"){
		expectBin = isTurn ? BinDest::Turn : BinDest::Discard;
		if(isTurn){
			const std::string heard = jsonString(root, "user_text");
			const std::string said = jsonString(root, "text");
			ESP_LOGI(TAG, "Heard: \"%s\" -> Reply: \"%s\"", heard.c_str(), said.c_str());
			turnReplyStarted = true;
			logInternalHeap("speech_result");
		}
	}else if(type == "canned_result"){
		if(isGreeting){
			expectBin = BinDest::Greeting;
		}else if(isListen){
			expectBin = BinDest::ListenAck;
		}else if(isFiller){
			expectBin = BinDest::Filler;
		}else if((isTurn || isPushed) && turnWantsAudio){
			expectBin = BinDest::Turn; // memory-save ack, or pushed pipeline_error line
		}else{
			expectBin = BinDest::Discard;
		}
	}else if(type == "speech_error"){
		if(isTurn){
			ESP_LOGW(TAG, "speech_error: %s", reason.c_str());
			turnStatus = (reason == "no speech detected") ? TurnStatus::NoSpeech : TurnStatus::ErrorAwaiting;
		}
	}else if(type == "canned_error"){
		if(isGreeting){
			ESP_LOGW(TAG, "greeting fetch failed: %s", reason.c_str());
			greetingReqId.clear();
		}else if(isListen){
			ESP_LOGW(TAG, "listening line fetch failed: %s", reason.c_str());
			listenReqId.clear();
		}else if(isFiller){
			ESP_LOGW(TAG, "filler fetch failed: %s", reason.c_str());
			fillerReqId.clear();
		}else if((isTurn || isPushed) && turnWantsAudio){
			failTurnLocked(reason.c_str());
		}
	}else if(type == "error"){
		ESP_LOGW(TAG, "server error (id %s): %s", id.c_str(), reason.c_str());
		if(isTurn){
			failTurnLocked(reason.c_str());
		}else if(isFiller){
			fillerReqId.clear();
		}
	}

	cJSON_Delete(root);
}

void NetService::onBinaryMessage(PSRAMByteBuffer&& data){
	std::lock_guard lock(mtx);
	const BinDest dest = expectBin;
	expectBin = BinDest::None;

	switch(dest){
		case BinDest::ListenAck:
			cachedListen = std::move(data);
			listenReqId.clear();
			break;
		case BinDest::Greeting:
			cachedGreeting = std::move(data);
			greetingReqId.clear();
			ESP_LOGI(TAG, "Greeting ready (%u bytes)", (unsigned) cachedGreeting.size());
			break;
		case BinDest::Filler:
			cachedFiller = std::move(data);
			fillerReqId.clear();
			ESP_LOGI(TAG, "Filler cached (%u bytes)", (unsigned) cachedFiller.size());
			logInternalHeap("filler cached");
			break;
		default:
			break; // unexpected or stale
	}
}

bool NetService::sendText(const std::string& json){
	std::lock_guard lock(wsMtx);
	if(ws == nullptr || !serverUp.load()){
		return false;
	}
	return esp_websocket_client_send_text(ws, json.c_str(), (int) json.size(), SendTimeout) >= 0;
}

// ============================ Filler ============================

bool NetService::takeFiller(PSRAMByteBuffer& out){
	bool had;
	{
		std::lock_guard lock(mtx);
		had = !cachedFiller.empty();
		if(had){
			out = std::move(cachedFiller);
			cachedFiller = PSRAMByteBuffer();
		}
	}
	// No prefetch here: a filler download running alongside the utterance upload fills the few
	// WiFi RX buffers (the upload holds the client lock, so nothing reads it), which drops the
	// server's ACKs and stalls the upload. ConverseState refetches once the turn is over.
	return had;
}

void NetService::requestGreeting(){
	std::string id;
	{
		std::lock_guard lock(mtx);
		if(!greetingWanted || !serverUp.load()){
			return;
		}
		greetingWanted = false;
		id = "g-" + std::to_string(++idCounter);
		greetingReqId = id;
	}

	// Pre-rendered in-character greeting lines on the server (personality/<mode>/greeting).
	const std::string json = std::string(R"({"type":"get_canned","id":")") + id +
			R"(","category":"greeting","mode":")" + NetConfig::DefaultMode + R"("})";
	if(!sendText(json)){
		std::lock_guard lock(mtx);
		if(greetingReqId == id){
			greetingReqId.clear();
		}
	}
}

bool NetService::hasRobotCommand() const{
	std::lock_guard lock(mtx);
	return !robotCmdId.empty();
}

bool NetService::takeRobotCommand(std::string& id, std::string& action){
	std::lock_guard lock(mtx);
	if(robotCmdId.empty()){
		return false;
	}
	id = std::move(robotCmdId);
	action = std::move(robotCmdAction);
	robotCmdId.clear();
	robotCmdAction.clear();
	activeRobotCmdId = id;
	return true;
}

std::string NetService::takeActiveRobotCommand(){
	std::lock_guard lock(mtx);
	std::string id = std::move(activeRobotCmdId);
	activeRobotCmdId.clear();
	return id;
}

void NetService::sendRobotResult(const std::string& id, const char* action, const char* outcome, bool ownerRecognized, bool ownerEnrolled){
	ESP_LOGI(TAG, "Robot result %s: %s %s (owner recognized %d, enrolled %d)", id.c_str(), action, outcome, ownerRecognized, ownerEnrolled);
	char json[256];
	snprintf(json, sizeof(json),
			 R"({"type":"robot_result","id":"%s","action":"%s","outcome":"%s","owner_recognized":%s,"owner_enrolled":%s})",
			 id.c_str(), action, outcome, ownerRecognized ? "true" : "false", ownerEnrolled ? "true" : "false");
	sendText(json);
}

bool NetService::greetingPending() const{
	std::lock_guard lock(mtx);
	return greetingWanted || !greetingReqId.empty() || !cachedGreeting.empty();
}

bool NetService::takeGreeting(PSRAMByteBuffer& out){
	std::lock_guard lock(mtx);
	if(cachedGreeting.empty()){
		return false;
	}
	out = std::move(cachedGreeting);
	cachedGreeting = PSRAMByteBuffer();
	return true;
}

void NetService::prefetchFiller(){
	requestCanned("filler", 'f', fillerReqId, cachedFiller);
	requestCanned("listening", 'l', listenReqId, cachedListen);
}

bool NetService::requestCanned(const char* category, char idPrefix, std::string& reqId, const PSRAMByteBuffer& cache){
	std::string id;
	{
		std::lock_guard lock(mtx);
		if(!serverUp.load() || !cache.empty() || !reqId.empty()){
			return false;
		}
		id = std::string(1, idPrefix) + "-" + std::to_string(++idCounter);
		reqId = id;
	}

	const std::string json = std::string(R"({"type":"get_canned","id":")") + id +
			R"(","category":")" + category + R"(","mode":")" + NetConfig::DefaultMode + R"("})";
	if(!sendText(json)){
		std::lock_guard lock(mtx);
		if(reqId == id){
			reqId.clear();
		}
		return false;
	}
	return true;
}

bool NetService::takeListenAck(PSRAMByteBuffer& out){
	std::lock_guard lock(mtx);
	if(cachedListen.empty()){
		return false;
	}
	out = std::move(cachedListen);
	cachedListen = PSRAMByteBuffer();
	return true;
}

// ============================ Speech turns ============================

bool NetService::sendSpeech(const int16_t* samples, size_t count){
	std::lock_guard wsLock(wsMtx);
	if(ws == nullptr || !serverUp.load() || samples == nullptr || count == 0){
		return false;
	}

	std::string id;
	{
		std::lock_guard lock(mtx);
		id = "s-" + std::to_string(++idCounter);
		turnId = id;
		turnStatus = TurnStatus::Pending; // set before sending so a fast reply can't be dropped
		turnStream.reset();
		turnReplyStarted = false;
		turnToolInProgress = false;
	}

	const std::string header = std::string(R"({"type":"speech_request","id":")") + id +
			R"(","mode":")" + NetConfig::DefaultMode + R"("})";

	const int bytes = (int) (count * sizeof(int16_t));
	wifi_ap_record_t ap = {};
	const int rssi = esp_wifi_sta_get_ap_info(&ap) == ESP_OK ? ap.rssi : 0;
	ESP_LOGI(TAG, "speech_request %s: sending %d bytes (%.1fs), rssi %d", id.c_str(), bytes, count / 16000.0f, rssi);
	logInternalHeap("before send");
	const int64_t t0 = esp_timer_get_time();

	const bool headerOk = sendText(header);
	const int sent = headerOk ? esp_websocket_client_send_bin(ws, reinterpret_cast<const char*>(samples), bytes, SendTimeout) : -1;
	const bool ok = headerOk && sent == bytes;

	if(!ok){
		{
			std::lock_guard lock(mtx);
			turnId.clear();
			turnStatus = TurnStatus::Idle;
		}
		ESP_LOGW(TAG, "speech_request send failed (%s, returned %d) after %lld ms",
				 headerOk ? "audio" : "header", sent, (long long) ((esp_timer_get_time() - t0) / 1000));
		logInternalHeap("send failed");
		return false;
	}

	ESP_LOGI(TAG, "speech_request %s sent in %lld ms", id.c_str(), (long long) ((esp_timer_get_time() - t0) / 1000));
	return true;
}

// ============================ Speech stream ============================

void NetService::streamSpeech(const int16_t* samples, size_t count){
	if(samples == nullptr || count == 0 || upTask == nullptr || !serverUp.load()){
		return;
	}
	{
		std::lock_guard lock(upMtx);
		if(upState == UpState::None){
			{
				std::lock_guard idLock(mtx);
				upId = "s-" + std::to_string(++idCounter);
			}
			upState = UpState::Open;
			upHeaderSent = false;
			upBytesSent = 0;
			upQueue.clear();
			ESP_LOGI(TAG, "speech stream %s: started", upId.c_str());
		}
		if(upState != UpState::Open){
			return; // ending, or failed (the turn falls back to a whole upload)
		}
		upQueue.insert(upQueue.end(), samples, samples + count);
	}
	xTaskNotifyGive(upTask);
}

bool NetService::hasSpeechStream() const{
	std::lock_guard lock(upMtx);
	return upState != UpState::None;
}

void NetService::upTaskFunc(void* arg){
	static_cast<NetService*>(arg)->upLoop();
}

void NetService::upLoop(){
	for(;;){
		ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(100));
		PSRAMVector<int16_t> chunk;
		std::string id;
		bool needHeader;
		{
			std::lock_guard lock(upMtx);
			if(upState != UpState::Open && upState != UpState::Ending){
				upQueue.clear();
				continue;
			}
			chunk.swap(upQueue);
			id = upId;
			needHeader = !upHeaderSent;
			if(!needHeader && chunk.empty()){
				continue;
			}
			upBusy = true;
		}

		bool ok = true;
		if(needHeader){
			ok = sendText(std::string(R"({"type":"speech_stream_start","id":")") + id + R"(","mode":")" +
						  NetConfig::DefaultMode + R"("})");
		}
		const int bytes = (int) (chunk.size() * sizeof(int16_t));
		if(ok && bytes > 0){
			std::lock_guard wsLock(wsMtx);
			ok = ws != nullptr && serverUp.load() &&
				 esp_websocket_client_send_bin(ws, reinterpret_cast<const char*>(chunk.data()), bytes, SendTimeout) == bytes;
		}

		std::lock_guard lock(upMtx);
		upBusy = false;
		if(id != upId || upState == UpState::None){
			continue; // cancelled meanwhile
		}
		if(!ok){
			ESP_LOGW(TAG, "speech stream %s: send failed after %u bytes", id.c_str(), (unsigned) upBytesSent);
			upState = UpState::Failed;
			upQueue.clear();
			continue;
		}
		upHeaderSent = true;
		upBytesSent += bytes;
		if(!upQueue.empty()){
			xTaskNotifyGive(upTask);
		}
	}
}

bool NetService::finishSpeechStream(){
	std::string id;
	{
		std::lock_guard lock(upMtx);
		if(upState != UpState::Open){
			upState = UpState::None;
			return false;
		}
		upState = UpState::Ending;
		id = upId;
	}
	xTaskNotifyGive(upTask);

	// Wait for the last chunk (at most a few hundred ms of audio) to go out.
	const int64_t t0 = esp_timer_get_time();
	for(;;){
		{
			std::lock_guard lock(upMtx);
			if(upState == UpState::Failed){
				upState = UpState::None;
				return false;
			}
			if(upHeaderSent && upQueue.empty() && !upBusy){
				break;
			}
		}
		if(esp_timer_get_time() - t0 > 5000 * 1000LL){
			ESP_LOGW(TAG, "speech stream %s: last chunk didn't go out in 5 s", id.c_str());
			cancelSpeechStream();
			return false;
		}
		vTaskDelay(pdMS_TO_TICKS(5));
	}

	size_t bytes;
	{
		std::lock_guard lock(upMtx);
		bytes = upBytesSent;
	}
	{
		std::lock_guard lock(mtx);
		turnId = id;
		turnStatus = TurnStatus::Pending; // set before sending so a fast reply can't be dropped
		turnStream.reset();
		turnReplyStarted = false;
		turnToolInProgress = false;
	}
	const bool ok = sendText(std::string(R"({"type":"speech_stream_end","id":")") + id + R"("})");
	{
		std::lock_guard lock(upMtx);
		upState = UpState::None;
	}
	if(!ok){
		std::lock_guard lock(mtx);
		turnId.clear();
		turnStatus = TurnStatus::Idle;
		ESP_LOGW(TAG, "speech stream %s: end failed", id.c_str());
		return false;
	}
	ESP_LOGI(TAG, "speech stream %s: %u bytes (%.1fs), closed %lld ms after the end of speech", id.c_str(), (unsigned) bytes,
			 bytes / 32000.0f, (long long) ((esp_timer_get_time() - t0) / 1000));
	return true;
}

void NetService::cancelSpeechStream(){
	std::string id;
	bool headerSent;
	{
		std::lock_guard lock(upMtx);
		if(upState == UpState::None){
			return;
		}
		id = upId;
		headerSent = upHeaderSent;
		upState = UpState::None;
		upQueue.clear();
	}
	if(headerSent){
		sendText(std::string(R"({"type":"speech_stream_cancel","id":")") + id + R"("})");
	}
	ESP_LOGI(TAG, "speech stream %s: cancelled", id.c_str());
}

NetService::TurnStatus NetService::getTurnStatus() const{
	std::lock_guard lock(mtx);
	return turnStatus;
}

bool NetService::takeTurnStream(std::shared_ptr<AudioStream>& out){
	std::lock_guard lock(mtx);
	if(turnStatus != TurnStatus::Streaming || !turnStream){
		return false;
	}
	out = std::move(turnStream);
	turnStatus = TurnStatus::Idle;
	return true;
}

void NetService::resetRx(){
	if(rxStream){
		rxStream->fail();
		rxStream.reset();
	}
	rxText.clear();
	rxBin.clear();
	rxDropping = false;
}

void NetService::cancelTurn(){
	std::lock_guard lock(mtx);
	turnReplyStarted = false;
	turnId.clear();
	turnStream.reset();
	turnStatus = TurnStatus::Idle;
	if(expectBin == BinDest::Turn){
		expectBin = BinDest::Discard;
	}
}

void NetService::failTurnLocked(const char* reason){
	if(turnStatus == TurnStatus::Pending || turnStatus == TurnStatus::ErrorAwaiting){
		ESP_LOGW(TAG, "Turn failed: %s", reason ? reason : "?");
		turnStatus = TurnStatus::Failed;
		turnId.clear();
	}
}
