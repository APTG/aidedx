package com.aidedx.fullapp.compute

import android.content.res.AssetManager

/**
 * issue #136 goal 3, Approach A spike — loads the same prebuilt `static/wasm/libdedx.wasm` the
 * web app ships (bundled here as an Android asset, `assets/wasm/libdedx.wasm`) and runs it inside
 * a vendored wasm3 interpreter via `app/src/main/jni/wasm3_bridge/dedx_wasm_jni.c`. Scoped to a
 * smoke test (parses the module, links its two host imports, calls `dedx_get_version_string()`)
 * to establish real evidence for the goal-3 comparison, not to drive the app's query pipeline —
 * `LibdedxBridge` (Approach B) does that. See `docs/android-full-app-spike.md`.
 */
object LibdedxWasmBridge {
    init {
        System.loadLibrary("dedx_wasm_jni")
    }

    private external fun nativeSmokeTest(wasmBytes: ByteArray): String

    /** Reads `assets/wasm/libdedx.wasm` and runs the native smoke test against it. Returns a
     * human-readable "OK: ..." or "FAIL: ..." string — never throws on a wasm-side failure, so
     * callers can surface it directly without their own try/catch. */
    fun runSmokeTest(assets: AssetManager): String {
        val bytes = assets.open("wasm/libdedx.wasm").use { it.readBytes() }
        return nativeSmokeTest(bytes)
    }
}
