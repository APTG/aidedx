package com.aidedx.fullapp.nlu

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * issue #147 — mirrors `src/lib/asr/correct/correct.test.ts`'s cases for the rule subset ported
 * here, plus the two exact issue #147 sentences (OCR'd from the reporting screenshots) run
 * end-to-end through `KotlinMatcher.match()`.
 */
class AsrCorrectionsTest {

    @Test
    fun `fixes a letter-spelled unit once the number is already digits`() {
        // AsrCorrections.correct() is designed to run *after* KotlinMatcher's
        // normalizeSpelledNumbers() (see KotlinMatcher.match()) — every digit-gated rule assumes
        // that already happened, same as the "20 Me V" shape "twenty Me V" normalizes to.
        assertEquals(
            "Range of 20 MeV proton in silicon.",
            AsrCorrections.correct("Range of 20 Me V proton in silicon."),
        )
        assertEquals(
            "Stopping power of 20 MeV proton in silicon.",
            AsrCorrections.correct("Stopping power of 20 Me V proton in silicon."),
        )
    }

    @Test
    fun `end-to-end KotlinMatcher now resolves both issue 147 sentences`() {
        val aliases = AliasTables.fromJson(
            repoRoot().resolve("static/aliases/materials.json").readText(),
            repoRoot().resolve("static/aliases/particles.json").readText(),
        )

        val rangeMatch = KotlinMatcher.match("Range of twenty Me V proton in silicon.", aliases)
        assertEquals(Quantity.CSDA_RANGE, rangeMatch?.quantity)
        assertEquals(20.0, rangeMatch?.energy?.value)
        assertEquals("MeV", rangeMatch?.energy?.unit)

        val stoppingPowerMatch =
            KotlinMatcher.match("Stopping power of twenty Me V proton in silicon.", aliases)
        assertEquals(Quantity.STOPPING_POWER, stoppingPowerMatch?.quantity)
        assertEquals(20.0, stoppingPowerMatch?.energy?.value)
        assertEquals("MeV", stoppingPowerMatch?.energy?.unit)
    }

    @Test
    fun `fixes hyphenated and fully-spelled letter-spellings, same shapes en ts covers`() {
        assertEquals("500 keV protons in silicon", AsrCorrections.correct("500 K-E-V protons in silicon"))
        assertEquals("3 GeV protons in air", AsrCorrections.correct("3 G-E-V protons in air"))
        assertEquals(
            "150 MeV protons in water",
            AsrCorrections.correct("150 em e v protons in water"),
        )
    }

    @Test
    fun `fixes glued mm slash ml before a particle word to MeV`() {
        assertEquals(
            "how far will a 60 MeV proton go",
            AsrCorrections.correct("how far will a 60mm proton go"),
        )
    }

    @Test
    fun `does not treat ion as a match inside a longer word`() {
        assertEquals("10mm ionization observed", AsrCorrections.correct("10mm ionization observed"))
    }

    @Test
    fun `fixes spelled-out hundreds joined with and, matching composeHundreds on the web side`() {
        val aliases = AliasTables.fromJson(
            repoRoot().resolve("static/aliases/materials.json").readText(),
            repoRoot().resolve("static/aliases/particles.json").readText(),
        )
        val match = KotlinMatcher.match(
            "Range of two hundred and forty MeV protons in silicon.",
            aliases,
        )
        assertEquals(240.0, match?.energy?.value)
    }

    @Test
    fun `normalizes particle and material phonetic variants`() {
        assertEquals("deuterons in water", AsrCorrections.correct("dutrons in water"))
        assertEquals("PMMA target", AsrCorrections.correct("pmmea target"))
        assertEquals("silicon target", AsrCorrections.correct("silicone target"))
        assertEquals("Lucite target", AsrCorrections.correct("loose site target"))
    }

    @Test
    fun `normalizes quantity phonetic variants`() {
        assertEquals("range of protons", AsrCorrections.correct("rains of protons"))
        assertEquals("stopping power of protons", AsrCorrections.correct("stop in power of protons"))
        assertEquals("dE/dx of protons", AsrCorrections.correct("de slash dx of protons"))
    }

    private fun repoRoot(): java.io.File {
        var dir = java.io.File(".").absoluteFile
        while (!java.io.File(dir, "eval/intents.jsonl").exists()) {
            dir = dir.parentFile ?: error("Could not locate repo root (eval/intents.jsonl not found)")
        }
        return dir
    }
}
