package com.aidedx.fullapp.nlu

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import java.io.File

/**
 * issue #156 — "fifty eight point four MeV protons in water" matched energy=4.0 MeV instead of
 * 58.4 MeV: KotlinMatcher had no "point" decimal support at all (unlike matcher.ts), so
 * `ENERGY_RE` picked up whichever single digit word ("four") ended up adjacent to the unit and
 * silently dropped the rest of the phrase. These tests cover the fix directly, the same shape
 * `matcher.test.ts`'s "issue #122" describe block covers on the TS side.
 */
class KotlinMatcherTest {

    private fun repoRoot(): File {
        var dir = File(".").absoluteFile
        while (!File(dir, "eval/intents.jsonl").exists()) {
            dir = dir.parentFile ?: error("Could not locate repo root (eval/intents.jsonl not found)")
        }
        return dir
    }

    private fun aliases(): AliasTables {
        val root = repoRoot()
        return AliasTables.fromJson(
            File(root, "static/aliases/materials.json").readText(),
            File(root, "static/aliases/particles.json").readText(),
        )
    }

    private fun lexicon(): QuantityLexicon {
        val root = repoRoot()
        return QuantityLexicon.fromJson(File(root, "static/lexicon/quantity-en.json").readText())
    }

    @Test
    fun composesTensOnesCompound() {
        val result = KotlinMatcher.match(
            "What is the range of fifty eight MeV protons in water?",
            aliases(),
            lexicon(),
        )
        assertNotNull(result)
        assertEquals(58.0, result!!.energy.value, 0.0)
        assertEquals("MeV", result.energy.unit)
    }

    @Test
    fun composesSpelledOutDecimalWithTensOnesWholePart() {
        val result = KotlinMatcher.match(
            "What is the range of fifty eight point four MeV protons in water?",
            aliases(),
            lexicon(),
        )
        assertNotNull(result)
        assertEquals(58.4, result!!.energy.value, 0.0)
        assertEquals("MeV", result.energy.unit)
    }

    @Test
    fun composesSpelledOutDecimalWithSingleWordWholePart() {
        val result = KotlinMatcher.match(
            "What is the range of three point six GeV carbon ions in water?",
            aliases(),
            lexicon(),
        )
        assertNotNull(result)
        assertEquals(3.6, result!!.energy.value, 0.0)
        assertEquals("GeV", result.energy.unit)
    }

    @Test
    fun acceptsDotAsDecimalConnector() {
        val result = KotlinMatcher.match(
            "What is the range of fifty eight dot four MeV protons in water?",
            aliases(),
            lexicon(),
        )
        assertNotNull(result)
        assertEquals(58.4, result!!.energy.value, 0.0)
        assertEquals("MeV", result.energy.unit)
    }

    @Test
    fun composesLeadingSpelledOutDecimalWithNoWholePart() {
        val point = KotlinMatcher.match(
            "What is the range of point five MeV protons in water?",
            aliases(),
            lexicon(),
        )
        assertNotNull(point)
        assertEquals(0.5, point!!.energy.value, 0.0)

        val dot = KotlinMatcher.match(
            "What is the range of dot five MeV protons in water?",
            aliases(),
            lexicon(),
        )
        assertNotNull(dot)
        assertEquals(0.5, dot!!.energy.value, 0.0)
    }

    @Test
    fun composesDecimalMixingSpelledPointWithLiteralDigitFraction() {
        val result = KotlinMatcher.match(
            "What is the range of point 5 MeV protons in water?",
            aliases(),
            lexicon(),
        )
        assertNotNull(result)
        assertEquals(0.5, result!!.energy.value, 0.0)
        assertEquals("MeV", result.energy.unit)
    }

    @Test
    fun `matchWithTrace exposes the corrected text and fired rules, matching match() intent-for-intent`() {
        val text = "What is the range of 20 Me V protons in silicone?"
        val trace = KotlinMatcher.matchWithTrace(text, aliases(), lexicon())
        assertEquals(text, trace.rawText)
        assertEquals(
            "What is the range of 20 MeV protons in silicon?",
            trace.correctedText,
        )
        assertEquals(listOf("mev-letter-spelled", "silicone-as-silicon"), trace.firedCorrectionRules)
        assertEquals(KotlinMatcher.match(text, aliases(), lexicon()), trace.intent)
        assertNotNull(trace.intent)
    }

    @Test
    fun `matchWithTrace on unmatchable text returns a null intent with the trace still populated`() {
        val trace = KotlinMatcher.matchWithTrace("asdf qwerty zxcv", aliases(), lexicon())
        assertEquals(null, trace.intent)
        assertEquals("asdf qwerty zxcv", trace.correctedText)
    }
}
