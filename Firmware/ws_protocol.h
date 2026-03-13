/*
 * WebSocket protocol layer for Logic Analyzer firmware.
 * Handles handshake, frame building (outgoing), and frame parsing (incoming).
 */

#ifndef __WS_PROTOCOL_H__
#define __WS_PROTOCOL_H__

#include <stdint.h>
#include <stdbool.h>

/* ---- Frame parser ---- */

typedef enum {
    WS_PARSE_NEED_HEADER,
    WS_PARSE_NEED_EXT_LENGTH,
    WS_PARSE_NEED_MASK_KEY,
    WS_PARSE_NEED_PAYLOAD
} WS_PARSE_STATE;

#define WS_MAX_PAYLOAD 180

typedef struct {
    WS_PARSE_STATE state;
    uint8_t  opcode;
    bool     fin;
    bool     masked;
    uint16_t payload_len;
    uint16_t payload_received;
    uint8_t  header_pos;       /* bytes accumulated for multi-byte header fields */
    uint8_t  mask_key[4];
    uint8_t  payload[WS_MAX_PAYLOAD];
} WS_FRAME_PARSER;

void ws_parser_init(WS_FRAME_PARSER *parser);

/*
 * Feed raw TCP bytes into the parser.
 * Processes bytes one at a time. When a complete frame is ready,
 * sets *frame_ready = true. The payload in parser->payload is already unmasked.
 * Returns number of bytes consumed from data.
 * Call repeatedly until all bytes are consumed or frame_ready is set.
 */
uint16_t ws_parser_feed(WS_FRAME_PARSER *parser, const uint8_t *data, uint16_t len,
                        bool *frame_ready);

/* ---- Frame builder (outgoing, server-to-client, no masking) ---- */

/* WebSocket opcodes with FIN bit set */
#define WS_OP_BINARY  0x82
#define WS_OP_CLOSE   0x88
#define WS_OP_PONG    0x8A

/*
 * Build a WebSocket frame header for an outgoing message.
 * Writes to out_header (must be >= 4 bytes).
 * Returns header length: 2 for payloads <126, 4 for 126-65535.
 */
uint8_t ws_build_frame_header(uint8_t *out_header, uint8_t opcode, uint16_t payload_len);

/* ---- Handshake ---- */

/*
 * Parse an HTTP WebSocket upgrade request and build the 101 response.
 * request: NUL-terminated HTTP request string
 * response: output buffer (must be >= 256 bytes)
 * response_max: size of response buffer
 * Returns response length, or 0 on failure.
 */
uint16_t ws_build_handshake_response(const char *request, char *response, uint16_t response_max);

#endif
