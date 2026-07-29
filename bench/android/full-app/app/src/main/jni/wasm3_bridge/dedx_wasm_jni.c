/*
 * issue #136 goal 3, Approach A spike — runs the *exact same* prebuilt static/wasm/libdedx.wasm
 * this repo's web app ships (bundled as an Android asset, bytes handed in from Kotlin) inside a
 * vendored wasm3 interpreter (../../../../vendor/wasm3), instead of vendoring libdedx's C source
 * a second time. See docs/android-full-app-spike.md for why the two approaches were compared and
 * the recommendation (ship Approach B / dedx_jni.c) — this file exists to make that comparison
 * fair and the Approach A path actually usable, not just a proof-of-concept.
 *
 * issue #143 — the original version of this file only exposed `nativeSmokeTest()`, which
 * re-parsed and re-linked the whole module on every call; #136's own latency measurement (15.671
 * ms/call) was explicit that this included that cold-start cost, not a fair per-call number.
 * `nativeInit()`/`nativeStoppingPower()`/`nativeCsdaRange()`/`nativeRelease()` below parse+link
 * the module exactly once and reuse the resulting `IM3Runtime` across calls — the same
 * load-once-call-many shape `LibdedxBridge`'s `System.loadLibrary()` already has. Each calculate
 * call still crosses the wasm ABI boundary properly: linear-memory scratch buffers are allocated
 * via the module's own exported `malloc`/`free` (confirmed exported alongside the physics
 * functions — see docs/android-full-app-spike.md §3.2's `WebAssembly.Module.exports()` dump), the
 * float energy is written into wasm memory, `dedx_get_stp_table`/`dedx_get_csda_range_table` are
 * called with those linear-memory pointers, and the result is read back out the same way — this
 * is the real per-call cost, not a repeated cold load.
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
 *                                        the DEDX_AUTO single-energy calls this bridge makes stay
 *                                        well within the module's initial linear memory, but an
 *                                        arbitrary future caller that legitimately needs more heap
 *                                        would still need a real implementation here (documented
 *                                        limitation, not fixed by #143 — out of that issue's
 *                                        scope, which was the persistent-runtime API itself).
 */
#include <jni.h>
#include <stdlib.h>
#include <string.h>

#include "wasm3.h"

#define WASM3_STACK_SIZE (64 * 1024)
#define DEDX_AUTO 10

typedef struct {
  IM3Environment env;
  IM3Runtime runtime;
  IM3Function mallocFn;
  IM3Function freeFn;
  IM3Function stpTableFn;
  IM3Function csdaRangeTableFn;
} DedxWasmContext;

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

/* Returns 0 on success, leaving *outCtx set; non-zero (with *outError set to a static or
 * caller-owned message) on failure. Frees any partially-constructed environment/runtime itself. */
static int initContext(const uint8_t *bytes, uint32_t len, DedxWasmContext **outCtx,
                        char *errBuf, size_t errBufSize) {
  IM3Environment m3env = m3_NewEnvironment();
  if (!m3env) {
    snprintf(errBuf, errBufSize, "m3_NewEnvironment failed");
    return -1;
  }
  IM3Runtime runtime = m3_NewRuntime(m3env, WASM3_STACK_SIZE, NULL);
  if (!runtime) {
    snprintf(errBuf, errBufSize, "m3_NewRuntime failed");
    return -1;
  }
  IM3Module module;
  M3Result result = m3_ParseModule(m3env, &module, bytes, len);
  if (result) {
    snprintf(errBuf, errBufSize, "m3_ParseModule: %s", result);
    return -1;
  }
  result = m3_LoadModule(runtime, module);
  if (result) {
    snprintf(errBuf, errBufSize, "m3_LoadModule: %s", result);
    return -1;
  }
  result = m3_LinkRawFunction(module, "wasi_snapshot_preview1", "fd_write", "i(iiii)",
                               &fd_write_stub);
  if (result && result != m3Err_functionLookupFailed) {
    snprintf(errBuf, errBufSize, "link fd_write: %s", result);
    return -1;
  }
  result = m3_LinkRawFunction(module, "env", "emscripten_resize_heap", "i(i)",
                               &emscripten_resize_heap_stub);
  if (result && result != m3Err_functionLookupFailed) {
    snprintf(errBuf, errBufSize, "link emscripten_resize_heap: %s", result);
    return -1;
  }

  DedxWasmContext *ctx = calloc(1, sizeof(DedxWasmContext));
  ctx->env = m3env;
  ctx->runtime = runtime;

  if (m3_FindFunction(&ctx->mallocFn, runtime, "malloc") ||
      m3_FindFunction(&ctx->freeFn, runtime, "free") ||
      m3_FindFunction(&ctx->stpTableFn, runtime, "dedx_get_stp_table") ||
      m3_FindFunction(&ctx->csdaRangeTableFn, runtime, "dedx_get_csda_range_table")) {
    snprintf(errBuf, errBufSize, "m3_FindFunction: one or more exports missing");
    free(ctx);
    return -1;
  }

  *outCtx = ctx;
  return 0;
}

JNIEXPORT jlong JNICALL
Java_com_aidedx_fullapp_compute_LibdedxWasmBridge_nativeInit(JNIEnv *env, jobject thiz,
                                                              jbyteArray wasmBytes) {
  (void)thiz;
  jsize len = (*env)->GetArrayLength(env, wasmBytes);
  jbyte *bytes = (*env)->GetByteArrayElements(env, wasmBytes, NULL);

  DedxWasmContext *ctx = NULL;
  char errBuf[128] = {0};
  int rc = initContext((const uint8_t *)bytes, (uint32_t)len, &ctx, errBuf, sizeof(errBuf));
  (*env)->ReleaseByteArrayElements(env, wasmBytes, bytes, JNI_ABORT);
  /* rc != 0 -> ctx is NULL; the calculate methods below already treat a NULL/0 handle as "not
   * initialized" and return NaN, so no separate error channel is needed for init failures. */
  if (rc != 0) return 0;
  return (jlong)(intptr_t)ctx;
}

/* Allocates `size` bytes in the module's own linear memory via its exported malloc(), returning
 * the wasm-side pointer (an offset into linear memory, NOT a host pointer) or 0 on failure. */
static uint32_t wasmMalloc(DedxWasmContext *ctx, uint32_t size) {
  if (m3_CallV(ctx->mallocFn, (int32_t)size)) return 0;
  uint32_t ptr = 0;
  if (m3_GetResultsV(ctx->mallocFn, &ptr)) return 0;
  return ptr;
}

static void wasmFree(DedxWasmContext *ctx, uint32_t ptr) {
  if (ptr != 0) m3_CallV(ctx->freeFn, (int32_t)ptr);
}

JNIEXPORT jfloat JNICALL
Java_com_aidedx_fullapp_compute_LibdedxWasmBridge_nativeStoppingPower(JNIEnv *env, jobject thiz,
                                                                       jlong handle, jint ion,
                                                                       jint material,
                                                                       jfloat energyMevPerNucl) {
  (void)env;
  (void)thiz;
  DedxWasmContext *ctx = (DedxWasmContext *)(intptr_t)handle;
  if (!ctx) return (jfloat)(0.0 / 0.0);

  uint32_t energiesPtr = wasmMalloc(ctx, 4);
  uint32_t stpsPtr = wasmMalloc(ctx, 4);
  if (!energiesPtr || !stpsPtr) {
    wasmFree(ctx, energiesPtr);
    wasmFree(ctx, stpsPtr);
    return (jfloat)(0.0 / 0.0);
  }

  uint8_t *mem = m3_GetMemory(ctx->runtime, NULL, 0);
  float energy = energyMevPerNucl;
  memcpy(mem + energiesPtr, &energy, sizeof(float));

  jfloat stp = (jfloat)(0.0 / 0.0);
  M3Result result = m3_CallV(ctx->stpTableFn, (int32_t)DEDX_AUTO, (int32_t)ion, (int32_t)material,
                              (int32_t)1, (int32_t)energiesPtr, (int32_t)stpsPtr);
  if (!result) {
    int32_t rc = -1;
    if (!m3_GetResultsV(ctx->stpTableFn, &rc) && rc == 0) {
      float stpValue;
      memcpy(&stpValue, mem + stpsPtr, sizeof(float));
      stp = stpValue;
    }
  }

  wasmFree(ctx, energiesPtr);
  wasmFree(ctx, stpsPtr);
  return stp;
}

JNIEXPORT jdouble JNICALL
Java_com_aidedx_fullapp_compute_LibdedxWasmBridge_nativeCsdaRange(JNIEnv *env, jobject thiz,
                                                                   jlong handle, jint ion,
                                                                   jint material,
                                                                   jfloat energyMevPerNucl) {
  (void)env;
  (void)thiz;
  DedxWasmContext *ctx = (DedxWasmContext *)(intptr_t)handle;
  if (!ctx) return (jdouble)(0.0 / 0.0);

  uint32_t energiesPtr = wasmMalloc(ctx, 4);
  uint32_t csdaPtr = wasmMalloc(ctx, 8); /* dedx_get_csda_range_table writes double[] */
  if (!energiesPtr || !csdaPtr) {
    wasmFree(ctx, energiesPtr);
    wasmFree(ctx, csdaPtr);
    return (jdouble)(0.0 / 0.0);
  }

  uint8_t *mem = m3_GetMemory(ctx->runtime, NULL, 0);
  float energy = energyMevPerNucl;
  memcpy(mem + energiesPtr, &energy, sizeof(float));

  jdouble csda = (jdouble)(0.0 / 0.0);
  M3Result result = m3_CallV(ctx->csdaRangeTableFn, (int32_t)DEDX_AUTO, (int32_t)ion,
                             (int32_t)material, (int32_t)1, (int32_t)energiesPtr, (int32_t)csdaPtr);
  if (!result) {
    int32_t rc = -1;
    if (!m3_GetResultsV(ctx->csdaRangeTableFn, &rc) && rc == 0) {
      double csdaValue;
      memcpy(&csdaValue, mem + csdaPtr, sizeof(double));
      csda = csdaValue;
    }
  }

  wasmFree(ctx, energiesPtr);
  wasmFree(ctx, csdaPtr);
  return csda;
}

JNIEXPORT void JNICALL
Java_com_aidedx_fullapp_compute_LibdedxWasmBridge_nativeRelease(JNIEnv *env, jobject thiz,
                                                                 jlong handle) {
  (void)env;
  (void)thiz;
  DedxWasmContext *ctx = (DedxWasmContext *)(intptr_t)handle;
  if (!ctx) return;
  if (ctx->runtime) m3_FreeRuntime(ctx->runtime);
  if (ctx->env) m3_FreeEnvironment(ctx->env);
  free(ctx);
}
