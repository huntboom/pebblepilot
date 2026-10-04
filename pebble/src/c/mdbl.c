#include <pebble.h>

int main(void) {
  Window *w = window_create();
  window_stack_push(w, true);

  /*
   * Defaults are roughly: stack ~6KB, slot heap small, chunk 8KB.
   * This app needs more slot/chunk for fetch+JSON, and more stack for async/await.
   * Units are bytes.
   */
  ModdableCreationRecord cr = {
    .recordSize = sizeof(cr),
    .stack = 12288,  /* 12 KB — async/await + fetch need headroom */
    .slot = 40960,   /* ~40 KB */
    .chunk = 28672,  /* ~28 KB */
#ifdef PBL_DEBUG
    .flags = kModdableCreationFlagDebug,
#else
    .flags = 0,
#endif
  };
  moddable_createMachine(&cr);

  window_destroy(w);
}
