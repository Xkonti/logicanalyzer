Quick project reference:

- `.ai` directory - AI generated documentation and notes
- `Firmware/LogicAnalyzer_V2` - the firmware targeting Raspberry Pico 2W
- `Software/Web` - the current web-based client application for controlling and viewing data from the hardware
- `Software/LogicAnalyzer` - the old C# client (not supported anymore) acting as a reference to port features into the web client

The logic analyzer works in 2 modes:

- capture mode - trigger-based high frequency mode (up to 100MHz) that captures all data on-hardware and after it's done doing that it just transfers it to the software client to view
- streaming mode - realtime mode that captures and streams data continuously to the software client - either to treat it as a tiny "logic oscilloscope" or to manually pause the capture or capture data over longer periods of time, but at a cost of lower frequency 1-3MHz

There are 2 ways the firmware can connect and send data to the software client - either via USB connection (serial) or via WiFi.
