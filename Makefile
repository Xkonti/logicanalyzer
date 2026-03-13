FIRMWARE_DIR := Firmware
BUILD_DIR := $(FIRMWARE_DIR)/build
UF2 := $(BUILD_DIR)/LogicAnalyzer.uf2
FLASH_TARGET := /run/media/xkonti/RP2350

.PHONY: firmware flash clean

firmware:
	@if [ ! -f "$(BUILD_DIR)/CMakeCache.txt" ]; then \
		mkdir -p $(BUILD_DIR) && cmake -S $(FIRMWARE_DIR) -B $(BUILD_DIR) -DCMAKE_BUILD_TYPE=Release; \
	fi
	cmake --build $(BUILD_DIR)

clean:
	rm -rf $(BUILD_DIR)

flash: firmware
	@if [ ! -d "$(FLASH_TARGET)" ]; then \
		echo "Error: $(FLASH_TARGET) not mounted. Hold BOOTSEL and plug in the Pico."; \
		exit 1; \
	fi
	cp $(UF2) $(FLASH_TARGET)/
	@echo "Flashed $(UF2) to $(FLASH_TARGET)"
