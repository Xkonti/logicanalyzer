# Generated Cmake Pico project file

cmake_minimum_required(VERSION 3.13)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Initialise pico_sdk from installed location
# (note this can come from environment, CMake cache etc)

# == DO NOT EDIT THE FOLLOWING LINES for the Raspberry Pi Pico VS Code Extension to work ==
if(WIN32)
    set(USERHOME $ENV{USERPROFILE})
else()
    set(USERHOME $ENV{HOME})
endif()
set(sdkVersion 2.1.1)
set(toolchainVersion 14_2_Rel1)
set(picotoolVersion 2.1.1)
set(picoVscode ${USERHOME}/.pico-sdk/cmake/pico-vscode.cmake)
if (EXISTS ${picoVscode})
    include(${picoVscode})
endif()
# ====================================================================================

set(PICO_BOARD pico2_w CACHE STRING "Board type")
set(CMAKE_BUILD_TYPE Release)


# Pull in Raspberry Pi Pico SDK (must be before project)
include(pico_sdk_import.cmake)

project(LogicAnalyzer C CXX ASM)

# Initialise the Raspberry Pi Pico SDK
pico_sdk_init()

# Add executable. Default name is the project name, version 0.1

FILE(GLOB CSources *.c)
ADD_EXECUTABLE(LogicAnalyzer ${CSources})

# Create C header file with the name <pio program>.pio.h
pico_generate_pio_header(${PROJECT_NAME}  
        ${CMAKE_CURRENT_LIST_DIR}/LogicAnalyzer.pio
)

pico_set_program_name(LogicAnalyzer "LogicAnalyzer")
pico_set_program_version(LogicAnalyzer "7.0.0")
add_compile_definitions(FIRMWARE_VERSION="7.0.0")

pico_enable_stdio_uart(LogicAnalyzer 0)
pico_enable_stdio_usb(LogicAnalyzer 1)

add_compile_definitions(PICO_STDIO_USB_ENABLE_IRQ_BACKGROUND_TASK=0)
set(CYW_LIB pico_cyw43_arch_lwip_poll)

# Add any user requested librariesUna pregu
target_link_libraries(LogicAnalyzer
        pico_stdlib
        hardware_dma
        hardware_pio
        hardware_clocks
        hardware_flash
        hardware_adc
        hardware_exception
        pico_multicore
        pico_base_headers
        pico_multicore
        cmsis_core
        ${CYW_LIB}
        )

pico_add_extra_outputs(LogicAnalyzer)

target_include_directories(LogicAnalyzer PRIVATE ${CMAKE_CURRENT_LIST_DIR} )

target_compile_definitions(LogicAnalyzer PUBLIC USBD_MANUFACTURER="Dr. Gusman" USBD_PRODUCT="LogicAnalyzer" USBD_VID=0x1209 USBD_PID=0x3020)