package com.aidedx.fullapp.compute

/**
 * issue #136 goal 3, Approach B — Kotlin surface over the JNI bridge
 * (`app/src/main/jni/dedx/dedx_jni.c`) to vendored APTG/libdedx C source
 * (`app/src/main/jni/../../../../vendor/libdedx`). This is the approach the app's actual query
 * pipeline uses (`MainActivity`) — `LibdedxWasmBridge` is the competing spike, kept side by side
 * for the goal-3 comparison in `docs/android-full-app-spike.md`, not wired into the live pipeline.
 *
 * Deliberately uses libdedx's own `DEDX_AUTO` program (auto-selects the best tabulated report for
 * the ion, falling back to Bethe-Bloch for elemental targets no report covers) rather than
 * replicating `src/lib/compute/compute.ts`'s more elaborate per-particle `AUTO_SELECT_CHAIN` +
 * material-availability probing — libdedx already ships an equivalent "best effort" auto mode
 * server-side, so there is no need for a second copy of that selection logic here for a spike
 * scoped to single-particle/material/energy queries (see `dedx.h`'s `DEDX_AUTO` doc comment).
 */
private const val DEDX_AUTO = 10

object LibdedxBridge {
    init {
        System.loadLibrary("dedx_jni")
    }

    private external fun nativeGetMinEnergy(program: Int, ion: Int): Float
    private external fun nativeGetMaxEnergy(program: Int, ion: Int): Float
    private external fun nativeGetDensity(material: Int): Float
    private external fun nativeGetNucleonNumber(ion: Int): Int
    private external fun nativeGetAtomMass(ion: Int): Float
    private external fun nativeGetStp(program: Int, ion: Int, material: Int, energyMevPerNucl: Float): Float
    private external fun nativeGetCsdaRange(program: Int, ion: Int, material: Int, energyMevPerNucl: Float): Double
    external fun nativeGetVersionString(): String

    fun minEnergyMevPerNucl(ion: Int): Float = nativeGetMinEnergy(DEDX_AUTO, ion)
    fun maxEnergyMevPerNucl(ion: Int): Float = nativeGetMaxEnergy(DEDX_AUTO, ion)
    fun densityGramPerCm3(material: Int): Float? =
        nativeGetDensity(material).let { if (it < 0f) null else it }
    fun nucleonNumber(ion: Int): Int? = nativeGetNucleonNumber(ion).let { if (it < 0) null else it }
    fun atomicMass(ion: Int): Float? = nativeGetAtomMass(ion).let { if (it < 0f) null else it }

    /** Mass stopping power in MeV·cm²/g, or null if the (ion, material) combination fails to
     * resolve under DEDX_AUTO. */
    fun stoppingPowerMevCm2PerG(ion: Int, material: Int, energyMevPerNucl: Float): Float? =
        nativeGetStp(DEDX_AUTO, ion, material, energyMevPerNucl).let { if (it.isNaN()) null else it }

    /** CSDA range in g/cm², or null if the (ion, material) combination fails to resolve under
     * DEDX_AUTO. */
    fun csdaRangeGramPerCm2(ion: Int, material: Int, energyMevPerNucl: Float): Double? =
        nativeGetCsdaRange(DEDX_AUTO, ion, material, energyMevPerNucl).let { if (it.isNaN()) null else it }
}
