package com.aidedx.fullapp.nlu

import android.content.res.AssetManager
import org.json.JSONArray
import org.json.JSONObject

/**
 * issue #160 §9a — loads the *same* generated lexicon artifact the web app ships
 * (`static/lexicon/quantity-en.json`, bundled here as an Android asset rather than re-authored —
 * see `scripts/generate-lexicon.ts`), so this Kotlin matcher's stopping-power/range keyword
 * vocabulary never drifts from `src/lib/intent/lexicon/quantity-en.ts`'s source of truth. Mirrors
 * `Aliases.kt`'s TS-source -> JSON-artifact -> Android-asset pattern exactly, including the
 * `fromJson`/`load` split so `KotlinMatcherAgreementTest` (a plain JVM unit test, no
 * `AssetManager`) can parse the exact same static/lexicon JSON content by reading the file
 * directly instead — same parsing logic either way.
 *
 * Loading from this artifact (rather than the previous hand-inlined `STOPPING_POWER_RE`) fixes
 * two behavior gaps this port had silently drifted from `en.ts`'s tested vocabulary: it now
 * recognizes the "mass/electronic stopping power" qualifier, and the "LET" acronym is matched
 * case-sensitively (`stoppingPowerAcronymRe`, no `IGNORE_CASE`) instead of the previous combined
 * regex's case-insensitive `\blet\b`, which could misread the ordinary verb "let" ("let me know
 * the range") as the physics term — the same false-positive `en.ts`'s
 * `mentionsStoppingPowerSynonym` was written to avoid.
 */
data class QuantityLexicon(
    val stoppingPowerRe: Regex,
    val rangeRe: Regex,
    val stoppingPowerAcronymRe: Regex,
    val stoppingPowerSynonymPhraseRe: Regex,
    val indirectIdioms: List<Pair<Regex, Quantity>>,
) {
    /** True for any of `stoppingPowerRe`'s direct keywords or the LET/linear-energy-transfer
     * synonyms — mirrors `en.ts`'s `DIRECT_STOPPING.test(lower) || mentionsStoppingPowerSynonym(lower, text)`. */
    fun matchesStoppingPower(text: String): Boolean =
        stoppingPowerRe.containsMatchIn(text) ||
            stoppingPowerAcronymRe.containsMatchIn(text) ||
            stoppingPowerSynonymPhraseRe.containsMatchIn(text)

    companion object {
        fun load(assets: AssetManager): QuantityLexicon =
            fromJson(assets.open("lexicon/quantity-en.json").bufferedReader().readText())

        /** Split out from `load()` so tests with no `AssetManager` can read the committed
         * static/lexicon/quantity-en.json directly instead — same parsing code path either way. */
        fun fromJson(json: String): QuantityLexicon {
            val obj = JSONObject(json)

            fun alternation(arr: JSONArray): String =
                (0 until arr.length()).joinToString("|") { i -> "\\b${arr.getString(i)}\\b" }

            val stoppingPowerRe = Regex(
                alternation(obj.getJSONArray("stoppingPowerDirectPatterns")),
                RegexOption.IGNORE_CASE,
            )
            val rangeRe = Regex(
                alternation(obj.getJSONArray("rangeDirectPatterns")),
                RegexOption.IGNORE_CASE,
            )
            val stoppingPowerAcronymRe =
                Regex("\\b${obj.getString("stoppingPowerSynonymAcronym")}\\b")
            val stoppingPowerSynonymPhraseRe = Regex(
                "\\b${obj.getString("stoppingPowerSynonymPhrase")}\\b",
                RegexOption.IGNORE_CASE,
            )

            val idiomsArr = obj.getJSONArray("indirectIdioms")
            val indirectIdioms = (0 until idiomsArr.length()).map { i ->
                val entry = idiomsArr.getJSONObject(i)
                val quantity = when (entry.getString("quantity")) {
                    "stoppingPower" -> Quantity.STOPPING_POWER
                    "csdaRange" -> Quantity.CSDA_RANGE
                    else -> error(
                        "unknown quantity in quantity-en.json: ${entry.getString("quantity")}",
                    )
                }
                Regex(entry.getString("source"), RegexOption.IGNORE_CASE) to quantity
            }

            return QuantityLexicon(
                stoppingPowerRe,
                rangeRe,
                stoppingPowerAcronymRe,
                stoppingPowerSynonymPhraseRe,
                indirectIdioms,
            )
        }
    }
}
