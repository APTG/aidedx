/*
 * issue #136 goal 3, Approach A spike — runs the *exact same* prebuilt static/wasm/libdedx.wasm
 * this repo's web app ships (bundled as an Android asset, bytes handed in from Kotlin) inside a
 * vendored wasm3 interpreter (../../../../vendor/wasm3), instead of vendoring libdedx's C source
 * a second time. Deliberately scoped to a smoke test — parse the module, satisfy its two host
 * imports, call one real exported function, read the result back out of wasm linear memory —
 * not a full port of every dedx_wrappers.h call the JNI approach (dedx_jni.c) implements. See
 * docs/android-full-app-spike.md for why: the two approaches were compared on this narrower
 * basis (does it load + run at all, and at what binary-size/complexity cost), not on parity.
 *
 * The module's only two host imports (confirmed via `WebAssembly.Module.imports()` under Node
 * before writing a single line of native code — see the spike doc). Both are linked by hand via
 * `m3_LinkRawFunction` rather than wasm3's own `m3_LinkWASI()` — see this directory's
 * `CMakeLists.txt` for why (wasm3's WASI layer needs `getentropy()`, unavailable below API 28):
 *   wasi_snapshot_preview1.fd_write     — stubbed to report "0 bytes written, success" without
 *                                        touching the output buffer; libdedx never actually
 *                                        performs I/O, so this is dead code from the module's
 *                                        own perspective, only present to satisfy the linker.
 *   env.emscripten_resize_heap         — Emscripten's own JS-side heap-growth shim; not a real
 *                                        wasm instruction (the actual `memory.grow` op is
 *                                        interpreted by wasm3 internally and needs no import).
 *                                        Stubbed here to report success without truly resizing —
 *                                        fine for this smoke test's tiny, allocation-free calls,
 *                                        not sufficient for arbitrary libdedx calls that might
 *                                        need to grow the heap (documented limitation, not a bug
 *                                        this file tries to hide).
 */
#include <jni.h>
#include <string.h>

#include "wasm3.h"

#define WASM3_STACK_SIZE (64 * 1024)

static const void *emscripten_resize_heap_stub(IM3Runtime runtime, IM3ImportContext ctx,
                                                uint64_t *sp, void *mem) {
  (void)runtime;
  (void)ctx;
  (void)mem;
  sp[0] = 1; /* report success without actually growing — see file header */
  return NULL;
}

/* WASI fd_write(fd: i32, iovs: i32 ptr, iovs_len: i32, nwritten: i32 ptr) -> i32 errno.
 * _sp[0] is the return-value slot; _sp[1.._sp[4] are the four arguments, in order. */
static const void *fd_write_stub(IM3Runtime runtime, IM3ImportContext ctx, uint64_t *sp,
                                  void *mem) {
  (void)runtime;
  (void)ctx;
  uint32_t nwrittenPtr = (uint32_t)sp[4];
  if (nwrittenPtr != 0) {
    *(uint32_t *)((uint8_t *)mem + nwrittenPtr) = 0;
  }
  sp[0] = 0; /* __WASI_ERRNO_SUCCESS */
  return NULL;
}

JNIEXPORT jstring JNICALL
Java_com_aidedx_fullapp_compute_LibdedxWasmBridge_nativeSmokeTest(JNIEnv *env, jobject thiz,
                                                                   jbyteArray wasmBytes) {
  (void)thiz;
  char resultBuf[256];
  jsize len = (*env)->GetArrayLength(env, wasmBytes);
  jbyte *bytes = (*env)->GetByteArrayElements(env, wasmBytes, NULL);

  IM3Environment m3env = m3_NewEnvironment();
  if (!m3env) {
    (*env)->ReleaseByteArrayElements(env, wasmBytes, bytes, JNI_ABORT);
    return (*env)->NewStringUTF(env, "FAIL: m3_NewEnvironment");
  }

  IM3Runtime runtime = m3_NewRuntime(m3env, WASM3_STACK_SIZE, NULL);
  if (!runtime) {
    (*env)->ReleaseByteArrayElements(env, wasmBytes, bytes, JNI_ABORT);
    return (*env)->NewStringUTF(env, "FAIL: m3_NewRuntime");
  }

  IM3Module module;
  M3Result result = m3_ParseModule(m3env, &module, (const uint8_t *)bytes, (uint32_t)len);
  (*env)->ReleaseByteArrayElements(env, wasmBytes, bytes, JNI_ABORT);
  if (result) {
    snprintf(resultBuf, sizeof(resultBuf), "FAIL: m3_ParseModule: %s", result);
    return (*env)->NewStringUTF(env, resultBuf);
  }

  result = m3_LoadModule(runtime, module);
  if (result) {
    snprintf(resultBuf, sizeof(resultBuf), "FAIL: m3_LoadModule: %s", result);
    return (*env)->NewStringUTF(env, resultBuf);
  }

  result = m3_LinkRawFunction(module, "wasi_snapshot_preview1", "fd_write", "i(iiii)",
                               &fd_write_stub);
  if (result && result != m3Err_functionLookupFailed) {
    snprintf(resultBuf, sizeof(resultBuf), "FAIL: link fd_write: %s", result);
    return (*env)->NewStringUTF(env, resultBuf);
  }

  result = m3_LinkRawFunction(module, "env", "emscripten_resize_heap", "i(i)",
                               &emscripten_resize_heap_stub);
  if (result && result != m3Err_functionLookupFailed) {
    snprintf(resultBuf, sizeof(resultBuf), "FAIL: link emscripten_resize_heap: %s", result);
    return (*env)->NewStringUTF(env, resultBuf);
  }

  IM3Function versionFn;
  result = m3_FindFunction(&versionFn, runtime, "dedx_get_version_string");
  if (result) {
    snprintf(resultBuf, sizeof(resultBuf), "FAIL: m3_FindFunction(dedx_get_version_string): %s",
             result);
    return (*env)->NewStringUTF(env, resultBuf);
  }

  result = m3_CallV(versionFn);
  if (result) {
    snprintf(resultBuf, sizeof(resultBuf), "FAIL: m3_CallV(dedx_get_version_string): %s", result);
    return (*env)->NewStringUTF(env, resultBuf);
  }

  uint32_t versionPtr = 0;
  result = m3_GetResultsV(versionFn, &versionPtr);
  if (result) {
    snprintf(resultBuf, sizeof(resultBuf), "FAIL: m3_GetResultsV: %s", result);
    return (*env)->NewStringUTF(env, resultBuf);
  }

  uint8_t *wasmMemory = m3_GetMemory(runtime, NULL, 0);
  if (!wasmMemory) {
    return (*env)->NewStringUTF(env, "FAIL: m3_GetMemory returned NULL");
  }

  snprintf(resultBuf, sizeof(resultBuf), "OK: dedx_get_version_string() = \"%.*s\"",
           (int)sizeof(resultBuf) - 40, (const char *)(wasmMemory + versionPtr));
  return (*env)->NewStringUTF(env, resultBuf);
}
