// Command IDs — first payload byte in an OutputPacket
// Derived from LogicAnalyzerDriver.cs command usage sites
export const CMD_DEVICE_INIT = 0x00
export const CMD_START_CAPTURE = 0x01
export const CMD_NETWORK_CONFIG = 0x02
export const CMD_VOLTAGE_STATUS = 0x03
export const CMD_ENTER_BOOTLOADER = 0x04
export const CMD_BLINK_LED_ON = 0x05
export const CMD_BLINK_LED_OFF = 0x06
export const CMD_START_PREVIEW = 0x07
export const CMD_STOP_PREVIEW = 0x08
export const CMD_COMPRESSION_TEST = 0x09
export const CMD_START_STREAM = 0x0a
export const CMD_STOP_STREAM = 0x0b
export const CMD_STOP_CAPTURE = 0xff // raw byte, NOT framed in an OutputPacket

// Packet framing bytes (AnalyzerDriverBase.cs OutputPacket.Serialize)
export const FRAME_HEADER_0 = 0x55
export const FRAME_HEADER_1 = 0xaa
export const FRAME_FOOTER_0 = 0xaa
export const FRAME_FOOTER_1 = 0x55
export const ESCAPE_BYTE = 0xf0

// Trigger types (CaptureSession.cs)
export const TRIGGER_EDGE = 0
export const TRIGGER_COMPLEX = 1
export const TRIGGER_FAST = 2
export const TRIGGER_BLAST = 3

// Capture modes (CaptureModes.cs)
export const CAPTURE_MODE_8CH = 0
export const CAPTURE_MODE_16CH = 1
export const CAPTURE_MODE_24CH = 2

// Serial port defaults (LogicAnalyzerDriver.cs)
export const DEFAULT_BAUD_RATE = 115200
export const DEFAULT_BUFFER_SIZE = 1048576 // 1MB — Web Serial default is 255, MUST override
export const DEFAULT_VENDOR_ID = 0x1209
export const DEFAULT_PRODUCT_ID = 0x3020

// Minimum device version (VersionValidator.cs)
export const MIN_MAJOR_VERSION = 6
export const MIN_MINOR_VERSION = 5

// Trigger delay constants (CaptureModes.cs TriggerDelays)
export const COMPLEX_TRIGGER_DELAY = 5
export const FAST_TRIGGER_DELAY = 3
