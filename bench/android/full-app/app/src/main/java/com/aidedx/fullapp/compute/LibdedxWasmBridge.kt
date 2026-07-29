package com.aidedx.fullapp.compute

import android.content.res.AssetManager

/**
 * issue #136 goal 3, Approach A spike — loads the same prebuilt `static/wasm/libdedx.wasm` the
 * web app ships (bundled here as an Android asset, `assets/wasm/libdedx.wasm`) and runs it inside
 * a vendored wasm3 interpreter via `app/src/main/jni/wasm3_bridge/dedx_wasm_jni.c`. Not wired into
 * the app's live query pipeline — `LibdedxBridge` (Approach B) does that — but no longer only a
 * smoke test either.
 *
 * issue #143 — `init()`/`stoppingPowerMevCm2PerG()`/`csdaRangeGramPerCm2()`/`release()` parse+link
 * the wasm module exactly once (mirroring how `LibdedxBridge`'s native library is loaded once via
 * `System.loadLibrary()`) and reuse the resulting runtime across calls, closing the "Approach A's
 * measured latency includes cold module parse+link every call" gap `docs/android-full-app-
 * spike.md` §3.3 flagged. `runSmokeTest()` (the original per-call-reparse smoke test) is kept
 * alongside for direct comparison in the benchmark — see `MainActivity.runLatencyBenchmark()`.
 */
object LibdedxWasmBridge {
    init {
        System.loadLibrary("dedx_wasm_jni")
    }

    private external fun nativeSmokeTest(wasmBytes: ByteArray): String
    private external fun nativeInit(wasmBytes: ByteArray): Long
    private external fun nativeStoppingPower(handle: Long, ion: Int, material: Int, energyMevPerNucl: Float): Float
    private external fun nativeCsdaRange(handle: Long, ion: Int, material: Int, energyMevPerNucl: Float): Double
    private external fun nativeRelease(handle: Long)

    /** Reads `assets/wasm/libdedx.wasm` and runs the native smoke test against it — parses+links
     * the module fresh on every call (see file header). Returns a human-readable "OK: ..." or
     * "FAIL: ..." string — never throws on a wasm-side failure, so callers can surface it directly
     * without their own try/catch. */
    fun runSmokeTest(assets: AssetManager): String {
        val bytes = assets.open("wasm/libdedx.wasm").use { it.readBytes() }
        return nativeSmokeTest(bytes)
    }

    /** Opaque handle to a parsed+linked wasm3 runtime, reused across [stoppingPowerMevCm2PerG] /
     * [csdaRangeGramPerCm2] calls. `0` means initialization failed. Call [release] when done. */
    class Session internal constructor(private val handle: Long) {
        val isValid: Boolean get() = handle != 0L

        fun stoppingPowerMevCm2PerG(ion: Int, material: Int, energyMevPerNucl: Float): Float? =
            nativeStoppingPower(handle, ion, material, energyMevPerNucl).let { if (it.isNaN()) null else it }

        fun csdaRangeGramPerCm2(ion: Int, material: Int, energyMevPerNucl: Float): Double? =
            nativeCsdaRange(handle, ion, material, energyMevPerNucl).let { if (it.isNaN()) null else it }

        fun release() = nativeRelease(handle)
    }

    /** Parses and links `assets/wasm/libdedx.wasm` once, returning a [Session] whose calculate
     * methods reuse that same runtime — the load-once-call-many shape issue #143 asked for. */
    fun init(assets: AssetManager): Session {
        val bytes = assets.open("wasm/libdedx.wasm").use { it.readBytes() }
        return Session(nativeInit(bytes))
    }
}
