/*
 * WebSocket protocol layer for Logic Analyzer firmware.
 */

#include "ws_protocol.h"
#include "ws_crypto.h"
#include <string.h>
#include <stdio.h>

/* ---- Frame parser ---- */

void ws_parser_init(WS_FRAME_PARSER *parser)
{
    parser->state = WS_PARSE_NEED_HEADER;
    parser->opcode = 0;
    parser->fin = false;
    parser->masked = false;
    parser->payload_len = 0;
    parser->payload_received = 0;
    parser->header_pos = 0;
}

uint16_t ws_parser_feed(WS_FRAME_PARSER *parser, const uint8_t *data, uint16_t len,
                        bool *frame_ready)
{
    *frame_ready = false;
    uint16_t consumed = 0;

    while (consumed < len)
    {
        uint8_t b = data[consumed++];

        switch (parser->state)
        {
        case WS_PARSE_NEED_HEADER:
            if (parser->header_pos == 0)
            {
                /* First byte: FIN + opcode */
                parser->fin = (b & 0x80) != 0;
                parser->opcode = b & 0x0F;
                parser->header_pos = 1;
            }
            else
            {
                /* Second byte: MASK + payload length */
                parser->masked = (b & 0x80) != 0;
                uint8_t plen = b & 0x7F;

                if (plen == 126)
                {
                    /* Extended 16-bit length follows */
                    parser->payload_len = 0;
                    parser->header_pos = 0;
                    parser->state = WS_PARSE_NEED_EXT_LENGTH;
                }
                else if (plen == 127)
                {
                    /* 64-bit length — not supported, reject */
                    ws_parser_init(parser);
                    return consumed;
                }
                else
                {
                    parser->payload_len = plen;
                    parser->header_pos = 0;
                    parser->payload_received = 0;

                    if (parser->masked)
                        parser->state = WS_PARSE_NEED_MASK_KEY;
                    else if (parser->payload_len == 0)
                    {
                        *frame_ready = true;
                        return consumed;
                    }
                    else
                        parser->state = WS_PARSE_NEED_PAYLOAD;
                }
            }
            break;

        case WS_PARSE_NEED_EXT_LENGTH:
            if (parser->header_pos == 0)
            {
                parser->payload_len = (uint16_t)b << 8;
                parser->header_pos = 1;
            }
            else
            {
                parser->payload_len |= b;
                parser->header_pos = 0;
                parser->payload_received = 0;

                if (parser->payload_len > WS_MAX_PAYLOAD)
                {
                    /* Payload too large for our buffer — reject */
                    ws_parser_init(parser);
                    return consumed;
                }

                if (parser->masked)
                    parser->state = WS_PARSE_NEED_MASK_KEY;
                else if (parser->payload_len == 0)
                {
                    *frame_ready = true;
                    return consumed;
                }
                else
                    parser->state = WS_PARSE_NEED_PAYLOAD;
            }
            break;

        case WS_PARSE_NEED_MASK_KEY:
            parser->mask_key[parser->header_pos++] = b;
            if (parser->header_pos == 4)
            {
                parser->header_pos = 0;
                if (parser->payload_len == 0)
                {
                    *frame_ready = true;
                    return consumed;
                }
                parser->state = WS_PARSE_NEED_PAYLOAD;
            }
            break;

        case WS_PARSE_NEED_PAYLOAD:
        {
            /* Fast path: copy and unmask remaining bytes in bulk */
            uint16_t need = parser->payload_len - parser->payload_received;
            uint16_t avail = len - consumed + 1;  /* +1 because we already read 'b' */
            uint16_t chunk = (need < avail) ? need : avail;

            /* Put back the byte we already consumed */
            consumed--;

            /* Bounds check against our payload buffer */
            if (parser->payload_received + chunk > WS_MAX_PAYLOAD)
                chunk = WS_MAX_PAYLOAD - parser->payload_received;

            if (parser->masked)
            {
                /* Unmask while copying */
                uint16_t dst = parser->payload_received;
                for (uint16_t i = 0; i < chunk; i++)
                {
                    parser->payload[dst + i] = data[consumed + i] ^ parser->mask_key[(dst + i) & 3];
                }
            }
            else
            {
                memcpy(parser->payload + parser->payload_received, data + consumed, chunk);
            }

            consumed += chunk;
            parser->payload_received += chunk;

            if (parser->payload_received >= parser->payload_len)
            {
                *frame_ready = true;
                return consumed;
            }
            break;
        }
        }
    }

    return consumed;
}

/* ---- Frame builder ---- */

uint8_t ws_build_frame_header(uint8_t *out_header, uint8_t opcode, uint16_t payload_len)
{
    out_header[0] = opcode;

    if (payload_len < 126)
    {
        out_header[1] = (uint8_t)payload_len;
        return 2;
    }
    else
    {
        out_header[1] = 126;
        out_header[2] = (uint8_t)(payload_len >> 8);   /* big-endian high */
        out_header[3] = (uint8_t)(payload_len & 0xFF);  /* big-endian low */
        return 4;
    }
}

/* ---- Handshake ---- */

static const char WS_GUID[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
static const char WS_KEY_HEADER[] = "Sec-WebSocket-Key: ";
#define WS_KEY_HEADER_LEN 19
#define WS_CLIENT_KEY_LEN 24
#define WS_GUID_LEN 36

uint16_t ws_build_handshake_response(const char *request, char *response, uint16_t response_max)
{
    /* Find Sec-WebSocket-Key header */
    const char *key_start = strstr(request, WS_KEY_HEADER);
    if (!key_start)
        return 0;

    key_start += WS_KEY_HEADER_LEN;

    /* Extract the 24-char base64 key (ends at \r\n or any whitespace) */
    char client_key[WS_CLIENT_KEY_LEN + 1];
    for (int i = 0; i < WS_CLIENT_KEY_LEN; i++)
    {
        if (key_start[i] == '\r' || key_start[i] == '\n' || key_start[i] == '\0')
            return 0;  /* Key too short */
        client_key[i] = key_start[i];
    }
    client_key[WS_CLIENT_KEY_LEN] = '\0';

    /* Concatenate key + GUID */
    char concat[WS_CLIENT_KEY_LEN + WS_GUID_LEN + 1];
    memcpy(concat, client_key, WS_CLIENT_KEY_LEN);
    memcpy(concat + WS_CLIENT_KEY_LEN, WS_GUID, WS_GUID_LEN);
    concat[WS_CLIENT_KEY_LEN + WS_GUID_LEN] = '\0';

    /* SHA-1 hash */
    unsigned char hash[20];
    ws_sha1((const unsigned char *)concat, WS_CLIENT_KEY_LEN + WS_GUID_LEN, hash);

    /* Base64 encode */
    char accept_value[29];
    ws_base64_encode(hash, accept_value);

    /* Build HTTP 101 response */
    int len = snprintf(response, response_max,
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: %s\r\n"
        "\r\n",
        accept_value);

    if (len <= 0 || len >= response_max)
        return 0;

    return (uint16_t)len;
}
