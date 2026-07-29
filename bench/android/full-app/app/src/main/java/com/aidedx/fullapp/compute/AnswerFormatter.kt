package com.aidedx.fullapp.compute

import com.aidedx.fullapp.nlu.MatchedIntent
import com.aidedx.fullapp.nlu.Quantity
import java.math.BigDecimal
import java.math.MathContext
import kotlin.math.abs

/**
 * issue #136 goal 5 — mimics `src/lib/nlg/render.ts`'s rounding/unit conventions (4 significant
 * figures, keV/µm for stopping power and an auto-scaled length unit for range when density is
 * known, native libdedx units as a fallback otherwise) without porting `renderAnswer()` itself —
 * this repo's own NLG stays single-sourced in TypeScript (see `docs/wasm.md`'s drift-risk
 * framing); this is a narrower "make the Android results screen readable" formatter only.
 */
object AnswerFormatter {

    fun formatSignificant(value: Double, sigFigs: Int = 4): String {
        if (value.isNaN() || value.isInfinite()) return "n/a"
        if (value == 0.0) return "0"
        val rounded = BigDecimal.valueOf(value).round(MathContext(sigFigs))
        return rounded.stripTrailingZeros().toPlainString()
    }

    private val LENGTH_UNITS_FROM_CM = listOf(
        "km" to 1e5,
        "m" to 1e2,
        "cm" to 1.0,
        "mm" to 1e-1,
        "µm" to 1e-4,
        "nm" to 1e-7,
    )

    private fun formatLengthCm(lengthCm: Double): String {
        for ((unit, factorCm) in LENGTH_UNITS_FROM_CM) {
            val scaled = lengthCm / factorCm
            if (abs(scaled) >= 1.0) return "${formatSignificant(scaled)} $unit"
        }
        val (unit, factorCm) = LENGTH_UNITS_FROM_CM.last()
        return "${formatSignificant(lengthCm / factorCm)} $unit"
    }

    /**
     * @param stoppingPowerMevCm2PerG native libdedx output (MeV·cm²/g), null if the query was a
     *   range query or the calculation failed.
     * @param csdaRangeGramPerCm2 native libdedx output (g/cm²), null if the query was a stopping-
     *   power query or the calculation failed.
     * @param densityGramPerCm3 target material density; when null, falls back to native units.
     */
    fun format(
        matched: MatchedIntent,
        stoppingPowerMevCm2PerG: Float?,
        csdaRangeGramPerCm2: Double?,
        densityGramPerCm3: Float?,
    ): String {
        val quantityPhrase = when (matched.quantity) {
            Quantity.STOPPING_POWER -> "stopping power"
            Quantity.CSDA_RANGE -> "CSDA range"
        }
        val energyText = "${formatSignificant(matched.energy.value)} ${matched.energy.unit}"

        val valueText = when (matched.quantity) {
            Quantity.STOPPING_POWER -> {
                val stp = stoppingPowerMevCm2PerG
                    ?: return "Couldn't compute the $quantityPhrase of $energyText " +
                        "${matched.particleMatch} in ${matched.materialMatch}: calculation failed"
                if (densityGramPerCm3 != null) {
                    val kevPerUm = stp * densityGramPerCm3 * 0.1
                    "${formatSignificant(kevPerUm.toDouble())} keV/µm"
                } else {
                    "${formatSignificant(stp.toDouble())} MeV·cm²/g"
                }
            }
            Quantity.CSDA_RANGE -> {
                val range = csdaRangeGramPerCm2
                    ?: return "Couldn't compute the $quantityPhrase of $energyText " +
                        "${matched.particleMatch} in ${matched.materialMatch}: calculation failed"
                if (densityGramPerCm3 != null) {
                    formatLengthCm(range / densityGramPerCm3)
                } else {
                    "${formatSignificant(range)} g/cm²"
                }
            }
        }

        return "The $quantityPhrase of $energyText ${matched.particleMatch} in " +
            "${matched.materialMatch} is $valueText (libdedx, auto-selected program)."
    }
}
