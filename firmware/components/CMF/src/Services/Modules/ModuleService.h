#ifndef CMF_MODULESERVICE_H
#define CMF_MODULESERVICE_H

#include <map>
#include "Entity/AsyncEntity.h"
#include "Log/Log.h"
#include "ModuleType.h"
#include "Event/EventBroadcaster.h"
#include "Drivers/Interface/InputDriver.h"
#include "Drivers/Interface/OutputDriver.h"
#include "ModuleDevice.h"
#include "ModuleDefs.h"
#include "Event/EventDelegate.h"
#include <esp_timer.h>

DEFINE_LOG(ModuleService)

/**
* Service for managing UMAX modules (https://www.lcsc.com/datasheet/C404108.pdf)
 *
 * Its job is to detect and manage instances of plugged-in modules.
 * Number of buses is set via CONFIG_CMF_MODULESERVICE_NUM_BUSES (KConfig, range 1–16, default 1).
*/


class ModuleService : public AsyncEntity {
	GENERATED_BODY(ModuleService, AsyncEntity, CONSTRUCTOR_PACK(std::array<Modules::BusPins, CONFIG_CMF_MODULESERVICE_NUM_BUSES>));
public:

	enum class Action : uint8_t {
		Insert, Remove
	};

#if CONFIG_CMF_MODULESERVICE_NUM_BUSES == 1
	ModuleService(const Modules::BusPins& busPins, bool internalStack = true) : ModuleService(std::array{ busPins }, internalStack){}
#endif

	ModuleService(std::array<Modules::BusPins, CONFIG_CMF_MODULESERVICE_NUM_BUSES> busPins, bool internalStack = true) :
			Super(CONFIG_CMF_MODULESERVICE_TICK_INTERVAL / portTICK_PERIOD_MS, CONFIG_CMF_MODULESERVICE_STACK_SIZE, CONFIG_CMF_MODULESERVICE_THREAD_PRIORITY, CONFIG_CMF_MODULESERVICE_CPU_CORE, internalStack), busPins(std::move(busPins)){
		populateInputDrivers();

		for(uint8_t i = 0; i < CONFIG_CMF_MODULESERVICE_NUM_BUSES; i++){
			registerSubAddressPinsInput(i);
		}
	}

	/**
	 * uint8_t - busID
	 * Type - type of module
	 * Action - Insert or Remove
	 */
	DECLARE_EVENT(ModulesEvent, ModuleService, uint8_t, Modules::Type, Action)
	ModulesEvent ModulesEvent{ this };

	StrongObjectPtr<ModuleDevice> getDevice(uint8_t bus = 0){
		if(bus >= CONFIG_CMF_MODULESERVICE_NUM_BUSES) return nullptr;

		return busContexts[bus].instance;
	}

	Modules::Type getInserted(uint8_t bus = 0){
		if(bus >= CONFIG_CMF_MODULESERVICE_NUM_BUSES) return Modules::Type::Unknown;

		if(!busContexts[bus].inserted){
			return Modules::Type::Unknown;
		}

		return busContexts[bus].type;
	}


#ifdef CONFIG_RM_Motion
	/**
	 * bool state - true = motion started, false = motion stopped
	 */
	DECLARE_DELEGATE(RM_MotionEvent, bool);
	RM_MotionEvent OnRM_Motion;
#endif

private:
	const std::array<Modules::BusPins, CONFIG_CMF_MODULESERVICE_NUM_BUSES> busPins;

	// Normal: det1 low, det2 high, the board's address on the address pins.
	// LEDQuirk: the official LED boards (two, both the same) sit loose: their address (16) reads while the
	// detect pins often never do, so stock firmware rarely detects them. The detect pins alone can't be
	// trusted (an empty slot reads det1 high and either det2), but an empty slot always reads address 63.
	enum class Detect : uint8_t { Empty, Normal, LEDQuirk };
	static constexpr int64_t DetectSettleUs = 300000; // a board sliding in passes through other readings
	static constexpr uint8_t LEDAddress = 16;
	static constexpr uint8_t EmptyAddress = 63; // an empty slot: every address pin pulled high

	struct BusContext {
		bool inserted;
		Modules::Type type;
		StrongObjectPtr<ModuleDevice> instance;
		int8_t lastDet = -1; // det1/det2 bits last seen, to log changes
		uint8_t lastAddr = EmptyAddress; // address pins at the last reading
		Detect current = Detect::Empty; // what the slot is treated as holding
		Detect pending = Detect::Empty; // latest reading, accepted once steady for DetectSettleUs
		int64_t pendingSinceUs = 0;
	} busContexts[CONFIG_CMF_MODULESERVICE_NUM_BUSES];


	void tick(float deltaTime) noexcept override{
		Super::tick(deltaTime);

		scanAllInputs();

		for(uint8_t i = 0; i < CONFIG_CMF_MODULESERVICE_NUM_BUSES; i++){
			loopCheck(i);
		}
	}

	void loopCheck(uint8_t bus){
		BusContext& ctx = busContexts[bus];
		Detect reading = checkInserted(bus);
		// A loose board (the LED ones) loses a detect contact when the robot moves while its address pins
		// still read it: only count it removed once the address pins read an empty slot too.
		if(reading == Detect::Empty && ctx.current != Detect::Empty && ctx.lastAddr != EmptyAddress){
			reading = ctx.current;
		}
		const int64_t now = esp_timer_get_time();
		if(reading != ctx.pending){
			ctx.pending = reading;
			ctx.pendingSinceUs = now;
		}
		if(ctx.pending == ctx.current || now - ctx.pendingSinceUs < DetectSettleUs){
			return;
		}
		if(ctx.pending != Detect::Empty && ctx.current != Detect::Empty){
			ctx.current = ctx.pending; // the same board, its detect pins seating or slipping
			return;
		}

		if(ctx.current != Detect::Empty){
			removeModule(bus);
		}
		ctx.current = ctx.pending;
		if(ctx.current != Detect::Empty){
			if(ctx.current == Detect::LEDQuirk){
				CMF_LOG(ModuleService, LogLevel::Info, "address 16 without the detect pins: treating as an LED board");
			}
			insertModule(bus, ctx.current == Detect::LEDQuirk ? Modules::Type::RM_LED : checkAddr(bus));
		}
	}

	void removeModule(uint8_t bus){
		busContexts[bus].inserted = false;
		const auto removed = busContexts[bus].type;

		busContexts[bus].type = Modules::Type::Unknown;

		CMF_LOG(ModuleService, LogLevel::Info, "Module %d removed from bus %d", (int) removed, bus);
		ModulesEvent.broadcast(bus, removed, Action::Remove);

		if(busContexts[bus].instance.isValid()){
			delete *busContexts[bus].instance;
		}
		busContexts[bus].instance = nullptr;

		registerSubAddressPinsInput(bus);
	}

	void insertModule(uint8_t bus, Modules::Type type){
		busContexts[bus].type = type;
		busContexts[bus].inserted = true;

		CMF_LOG(ModuleService, LogLevel::Info, "Module %d inserted into bus %d", (int) type, bus);
		ModulesEvent.broadcast(bus, type, Action::Insert);

		if(type != Modules::Type::Unknown){
			registerSubAddressPinsModule(bus, type);
			busContexts[bus].instance = CreateModuleDevice(this, type, busPins[bus]);
		}
	}

	Detect checkInserted(uint8_t bus){
		//TODO - make DET pin reading interrupt driven instead of polling

		const auto pin1 = busPins[bus].detPins[0];
		const auto pin2 = busPins[bus].detPins[1];

		const bool det1 = pin1.driver->read(pin1.port);
		const bool det2 = pin2.driver->read(pin2.port);

		CMF_LOG(ModuleService, Debug, "det1: %d, det2: %d", det1, det2);
		// A board that never registers: show what it does to the detect pins (and the address pins).
		uint8_t addr = 0;
		for(uint8_t i = 0; i < 6; i++){
			const InputPin pin = busPins[bus].addr[i];
			if(pin.driver->read(pin.port) > 0.0f){
				addr |= 1 << i;
			}
		}
		const int8_t det = (det1 ? 1 : 0) | (det2 ? 2 : 0);
		busContexts[bus].lastAddr = addr;
		if(det != busContexts[bus].lastDet){
			CMF_LOG(ModuleService, LogLevel::Info, "bus %d det1 %d det2 %d, address pins %d", bus, det1, det2, addr);
			busContexts[bus].lastDet = det;
		}
		if(det1 == 0 && det2 == 1) return Detect::Normal;
#ifdef CONFIG_RM_LED
		// Its address pins seat before its detect pins (if they ever do), and an empty slot reads 63.
		if(addr == LEDAddress) return Detect::LEDQuirk;
#endif
		return Detect::Empty;
	}

	Modules::Type checkAddr(uint8_t bus){
		Modules::Address readAddress{};

		uint8_t addr = 0;
		for(uint8_t i = 0; i < 6; i++){
			const InputPin pin = busPins[bus].addr[i];

			if(pin.driver->read(pin.port) > 0.0f){
				addr |= 1 << i;
			}
		}

		CMF_LOG(ModuleService, LogLevel::Info, "primary address %d", addr);

		readAddress.mainAddress = addr;


		if(!SubAddressMap.contains(addr)){
			if(AddressMap.contains(readAddress)){
				return AddressMap.at(readAddress);
			}else{
				CMF_LOG(ModuleService, LogLevel::Warning, "Unknown primary address");
				return Modules::Type::Unknown;
			}
		}

		const std::set<Modules::SubAddress>& subAddressSet = SubAddressMap.at(addr);
		Modules::SubAddress readSubAddress{};
		readSubAddress.type = Modules::SubAddress::Type::None;
		/*
		 * Caching read values to std::optional of each subAddress type.
		 *
		 * I2C values don't make sense to cache here, since every possible I2C address needs to be probed individually
		 * (instead of being read once and then compared multiple times)
		 */
#ifdef CONFIG_CMF_MODULES_RM
		std::optional<uint8_t> ReadRMAddress;
#endif
#ifdef CONFIG_CMF_MODULES_TOKEN
		std::optional<uint8_t> ReadTokenAddress;
#endif

		//Check every possible subAddress for this mainAddress, stop when match is found
		//Each branch is compiled in only if the corresponding Module set is enabled,
		//so sub-address pins / I2C probes for un-selected sets are never touched.
		for(const Modules::SubAddress& subAddress : subAddressSet){
			if(subAddress.type == Modules::SubAddress::Type::RM){
#ifdef CONFIG_CMF_MODULES_RM
				/* RM non-I2C modules are sub-addressed using subAddr pins 4 - 6 (3 bits)  */
				if(!ReadRMAddress){
					uint8_t RMAddr = 0;
					for(uint8_t i = 0; i < 3; i++){
						const Modules::IOPin pin = busPins[bus].subAddressPins[i + 3];

						if(pin.inputDriver->read(pin.inputPort) > 0.0f){
							RMAddr |= 1 << i;
						}
					}
					ReadRMAddress = RMAddr;
				}

				if(subAddress.RMAddress == ReadRMAddress){
					readSubAddress = subAddress;
					break;
				}
#endif
			}else if(subAddress.type == Modules::SubAddress::Type::RM_I2C){
#ifdef CONFIG_CMF_MODULES_RM
				/* RM I2C addresses determined by probing */
				if(busPins[bus].i2c->probe(subAddress.I2CAddress) == ESP_OK){
					readSubAddress = subAddress;
					break;
				}
#endif
			}else if(subAddress.type == Modules::SubAddress::Type::Rover_I2C){
#ifdef CONFIG_CMF_MODULES_ROVER_I2C
				/* Rover I2C addresses determined by probing */
				if(busPins[bus].i2c->probe(subAddress.I2CAddress) == ESP_OK){
					readSubAddress = subAddress;
					break;
				}
#endif
			}else if(subAddress.type == Modules::SubAddress::Type::Token){
#ifdef CONFIG_CMF_MODULES_TOKEN
				/* Bit/Wacky robots are sub-addressed using all 6 SubAddress pins */
				if(!ReadTokenAddress){
					uint8_t tokenAddr = 0;
					for(uint8_t i = 0; i < 6; i++){
						const Modules::IOPin pin = busPins[bus].subAddressPins[i];

						if(pin.inputDriver->read(pin.inputPort) > 0.0f){
							tokenAddr |= 1 << i;
						}
					}
					ReadTokenAddress = tokenAddr;
				}

				if(subAddress.tokenAddress == ReadTokenAddress){
					readSubAddress = subAddress;
					break;
				}
#endif
			}
		}

		if(readSubAddress.type == Modules::SubAddress::Type::None){
			CMF_LOG(ModuleService, LogLevel::Warning, "Unknown main-sub address combination");
			return Modules::Type::Unknown;
		}

		readAddress.subAddress = readSubAddress;

		if(!AddressMap.contains(readAddress)){
			CMF_LOG(ModuleService, LogLevel::Error, "Error in main/sub address mapping (internal error)");
			return Modules::Type::Unknown;
		}

		return AddressMap.at(readAddress);
	}

	/**
	 * Mapping the whole Address to a specific Type.
	 */
	inline static const std::map<Modules::Address, Modules::Type> AddressMap = Modules::GetAddressMap();

	/**
	 * Mapping the main address to all available SubAddresses. Does not include modules with no SubAddress.
	 * Populated in the constructor using data from AddressMap
	 * Used for module detection.
	 */
	inline static const std::map<uint8_t, std::set<Modules::SubAddress>> SubAddressMap = Modules::GetSubAddressMap();

	//Set of inputDrivers prevents unnecessary polling of the same InputDriver multiple times.
	std::set<InputDriver*> inputDriverSet;

	/**
	 * Populates the inputDriverSets with their respective inputDrivers
	 */
	void populateInputDrivers(){
		for(uint8_t bus = 0; bus < CONFIG_CMF_MODULESERVICE_NUM_BUSES; ++bus){
			auto& pins = busPins[bus];

			// Address pins
			for(const auto& pin : pins.addr){
				if(pin.driver) inputDriverSet.insert(pin.driver);
			}
			// Detection pins
			for(const auto& pin : pins.detPins){
				if(pin.driver) inputDriverSet.insert(pin.driver);
			}
			// SubAddress pins
			for(const auto& ioPin : pins.subAddressPins){
				if(ioPin.inputDriver) inputDriverSet.insert(ioPin.inputDriver);
			}
		}
	}

	/**
	 * Calls scan on every InputDriver across all registered buses.
	 */
	void scanAllInputs() const {
		for(InputDriver* driver : inputDriverSet){
			driver->scan();
		}
	}

	/**
	 * Registers the subAddress pins needed to detect modules of the selected
	 * Module sets to their InputDrivers, so they can be sampled during detection.
	 *
	 * Pins which no enabled Module set relies on are deliberately left unregistered
	 * so they aren't touched during detection; the corresponding InputDriver entry
	 * is added later by registerSubAddressPinsModule() if (and only if) a detected
	 * Module requires that pin as an input.
	 *
	 * Pin layout per set (see checkAddr):
	 *  - Wacky robot tokens (CMF_MODULES_TOKEN): all 6 sub-address pins
	 *  - Rick and Morty non-I2C (CMF_MODULES_RM): sub-address pins 3..5
	 *  - I2C-only sets (RM_I2C, Rover_I2C): no sub-address pins used at all
	 *
	 * @param bus
	 */
	void registerSubAddressPinsInput(uint8_t bus){
#if defined(CONFIG_CMF_MODULES_TOKEN)
		// Tokens use all 6 sub-address pins; this is a strict superset of the RM pin set.
		for(const auto& pin : busPins[bus].subAddressPins){
			if(pin.inputDriver) pin.inputDriver->registerInput({ pin.inputPort });
		}
#elif defined(CONFIG_CMF_MODULES_RM)
		// RM non-I2C modules only use sub-address pins 3..5.
		for(uint8_t i = 3; i < 6; i++){
			const auto& pin = busPins[bus].subAddressPins[i];
			if(pin.inputDriver) pin.inputDriver->registerInput({ pin.inputPort });
		}
#else
		// No selected Module set needs sub-address pins for detection.
		(void) bus;
#endif
	}

	void registerSubAddressPinsModule(uint8_t bus, Modules::Type type){
		const auto& pinModes = Modules::GetPinModeMap().at(type);
		for(uint8_t i = 0; i < pinModes.size(); i++){
			const auto& pin = busPins[bus].subAddressPins[i];
			if(pinModes[i] == Modules::PinMode::Input){
				pin.inputDriver->registerInput({ pin.inputPort });
			}else if(pinModes[i] == Modules::PinMode::Output){
				pin.outputDriver->registerOutput({ pin.outputPort });
			}
		}
	}
};


#endif //CMF_MODULESERVICE_H
