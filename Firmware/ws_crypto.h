/*
 * Minimal SHA-1 + Base64 for WebSocket handshake.
 * SHA-1 adapted from PolarSSL (lwIP bundled copy, BSD licensed).
 */

#ifndef __WS_CRYPTO_H__
#define __WS_CRYPTO_H__

#include <stdint.h>

typedef struct {
    unsigned long total[2];
    unsigned long state[5];
    unsigned char buffer[64];
} ws_sha1_context;

void ws_sha1_starts(ws_sha1_context *ctx);
void ws_sha1_update(ws_sha1_context *ctx, const unsigned char *input, int ilen);
void ws_sha1_finish(ws_sha1_context *ctx, unsigned char output[20]);
void ws_sha1(const unsigned char *input, int ilen, unsigned char output[20]);

/* Encode exactly 20 bytes to 28 base64 chars + NUL terminator. */
void ws_base64_encode(const unsigned char input[20], char output[29]);

#endif
