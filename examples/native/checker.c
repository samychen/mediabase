/* avstudio / examples / native / checker.c
 *
 * Sample native source plugin for the engine's C-ABI loader (D3): a checker
 * board with a moving diagonal. Third-party plugins implement the same three
 * exports from engine/src/avplugin.h and ship a shared library — no engine
 * rebuild needed.
 *
 * Build (wired into engine/build.sh): gcc -dynamiclib -shared ... -o checker
 */
#include <stdint.h>
#include <stddef.h>
#include "avplugin.h" /* compiled with -I engine/src */

uint32_t avplugin_magic(void) {
    return AVPLUGIN_ABI;
}

const char* avplugin_name(void) {
    return "checker";
}

/* tick advances a phase per render call so frames differ over time */
static unsigned int tick = 0;

int avplugin_render(int w, int h, uint8_t* out) {
    if (w <= 0 || h <= 0 || out == NULL) return 1;
    int cell = (w / 8) > 0 ? (w / 8) : 1;
    tick = (tick + 1) % 256;
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            int checker = (((x / cell) + (y / cell)) & 1) ? 200 : 40;
            int diag = ((x + y + (int)tick) % 32 < 4) ? 255 : 0;
            uint8_t r = (uint8_t)(checker + diag);
            uint8_t g = (uint8_t)((x * 255) / (w > 1 ? w - 1 : 1) / 3);
            uint8_t b = (uint8_t)((y * 255) / (h > 1 ? h - 1 : 1) / 3 + (diag ? 0 : 30));
            *out++ = r;
            *out++ = g;
            *out++ = b;
        }
    }
    return 0;
}
