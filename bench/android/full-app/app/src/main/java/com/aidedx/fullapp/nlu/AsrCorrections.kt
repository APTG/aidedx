package com.aidedx.fullapp.nlu

/**
 * issue #147 — Kotlin mirror of a curated subset of `src/lib/asr/correct/en.ts`'s `EN_RULES`
 * (the web app's ASR domain-vocabulary correction layer), restricted to the mishearing classes
 * that matter for what `KotlinMatcher` actually supports: a single particle + single material +
 * single energy, stopping-power/CSDA-range queries (`compareDim: "none"` in the TS schema's
 * terms — see `KotlinMatcher`'s own scoping note). Rules for features this port doesn't have
 * (ASTAR/PSTAR program names, the "compare" quantity, inverse cm/mm-target queries) are
 * deliberately not ported — they would be dead code here, same reasoning `KotlinMatcher` already
 * uses for its own scoping decisions.
 *
 * Applied in `KotlinMatcher.match()` right after `normalizeSpelledNumbers()`, so every digit-
 * gated rule below can assume a number, if any, is already digits — unlike `en.ts`, whose
 * correction layer runs *before* the web matcher's own number-word conversion and therefore has
 * to separately widen its digit-only patterns to also accept a spelled-out number run (see that
 * file's `NUMBER_PREFIX_SRC`). This port's number normalization already runs first, so no such
 * widening is needed here — the *absence* of any letter-spelled-unit rule at all, not the
 * ordering, was the actual gap: an on-device ASR model (sherpa-onnx/Parakeet-v3, no ASR inverse-
 * text-normalization) spoke "MeV" as two separate words, surfacing as literal "Me V" in the
 * transcript, which `ENERGY_RE` requires as one unbroken token and so silently produced
 * "No match" (reported in issue #147 as "twenty Me V proton in silicon").
 */
data class AsrCorrectionRule(val label: String, val pattern: Regex, val replacement: String)

// Particles that follow an energy value — used to detect MeV→mm/ml/etc. acoustic confusion.
// Mirrors en.ts's PARTICLE_WORDS constant.
private const val PARTICLE_WORDS =
    "proton|protons|deuteron|deuterons|alpha|alphas|carbon|neon|oxygen|helium|" +
        "lithium|nitrogen|argon|iron|ion|ions"

object AsrCorrections {

    private val RULES: List<AsrCorrectionRule> = listOf(
        // --- energy-unit mishearings (issue #147) ---
        AsrCorrectionRule(
            "free-as-three",
            Regex("\\bfree (mev|kev|gev)\\b", RegexOption.IGNORE_CASE),
            "3 \$1",
        ),
        AsrCorrectionRule(
            "glued-unit-before-particle",
            Regex(
                "(\\d+(?:\\.\\d+)?)\\s*(?:mm|ml|mv|ma|mb|mhz|mev)\\s*[,.]?\\s+(?:a\\s+)?" +
                    "($PARTICLE_WORDS)\\b",
                RegexOption.IGNORE_CASE,
            ),
            "\$1 MeV \$2",
        ),
        AsrCorrectionRule(
            "bare-mev-mishearing",
            Regex("(\\d+(?:\\.\\d+)?)\\s*m[e]?v\\b", RegexOption.IGNORE_CASE),
            "\$1 MeV",
        ),
        AsrCorrectionRule(
            "kev-mishearing",
            Regex("(\\d+(?:\\.\\d+)?)\\s*k\\s*[e]?v\\b", RegexOption.IGNORE_CASE),
            "\$1 keV",
        ),
        AsrCorrectionRule(
            "atmev",
            Regex("\\batmev\\b", RegexOption.IGNORE_CASE),
            "80 MeV",
        ),
        // The main issue #147 fix — a letter-spelled unit ("em ee vee", hyphenated "M-E-V", or
        // split-with-space "Me V") was never recognized at all before this rule existed.
        // `[\s.,-]*` between letters (not just whitespace) absorbs spaces, hyphens, and stray
        // punctuation between spelled-out letters alike.
        AsrCorrectionRule(
            "mev-letter-spelled",
            Regex(
                "(\\d+(?:\\.\\d+)?)\\s*(?:em|m)[\\s.,-]*(?:ee|e)[\\s.,-]*(?:vee|v)\\b",
                RegexOption.IGNORE_CASE,
            ),
            "\$1 MeV",
        ),
        AsrCorrectionRule(
            "kev-letter-spelled",
            Regex(
                "(\\d+(?:\\.\\d+)?)\\s*(?:kay|k)[\\s.,-]*(?:ee|e)[\\s.,-]*(?:vee|v)\\b",
                RegexOption.IGNORE_CASE,
            ),
            "\$1 keV",
        ),
        AsrCorrectionRule(
            "gev-letter-spelled",
            Regex(
                "(\\d+(?:\\.\\d+)?)\\s*(?:gee|jee|g)[\\s.,-]*(?:ee|e)[\\s.,-]*(?:vee|v)\\b",
                RegexOption.IGNORE_CASE,
            ),
            "\$1 GeV",
        ),

        // --- per-nucleon phonetic variants (ENERGY_RE supports MeV/nucleon, MeV/nucl, MeV/u) ---
        AsrCorrectionRule(
            "per-nucleon-phonetic",
            Regex(
                "\\bper\\s+(?:napelion|nutlion|nuklion|nukleon|nuclei|nucleons?|nucle\\w*|napoleon)\\b",
                RegexOption.IGNORE_CASE,
            ),
            "per nucleon",
        ),
        AsrCorrectionRule(
            "pernucleon-glued",
            Regex("\\bpernucleon\\b", RegexOption.IGNORE_CASE),
            "per nucleon",
        ),
        AsrCorrectionRule(
            "per-nucleon-base",
            Regex("\\bper\\s+(?:nuclear\\s+ion|knockdown|nuclear)\\b", RegexOption.IGNORE_CASE),
            "per nucleon",
        ),
        AsrCorrectionRule(
            "megaelectron-per-nucleon",
            Regex("\\bmegaelectron\\w*\\s+per\\s+nuclear?\\b", RegexOption.IGNORE_CASE),
            "MeV per nucleon",
        ),
        // Leaves the preceding space before "/u" — a known quirk ported verbatim from en.ts
        // (see correct.test.ts's "leaves the preceding space" case); ENERGY_RE still resolves
        // it, just as a bare "MeV" rather than the per-nucleon form.
        AsrCorrectionRule(
            "per-u",
            Regex("\\bper\\s+u\\b", RegexOption.IGNORE_CASE),
            "/u",
        ),
        AsrCorrectionRule(
            "mev-per-u-mishearing",
            Regex("\\bMeV\\s+per\\s+(?:year|you)\\b", RegexOption.IGNORE_CASE),
            "MeV/u",
        ),
        AsrCorrectionRule(
            "tamiya-per-nucleon",
            Regex("(\\d+(?:\\.\\d+)?)\\s+tamiya\\s+per\\s+nucleon", RegexOption.IGNORE_CASE),
            "\$1 MeV per nucleon",
        ),

        // --- particle-name phonetic variants — no fuzzy particle fallback in this port, so a
        // mishearing the alias table doesn't literally contain always misses. ---
        AsrCorrectionRule(
            "deuteron-phonetic",
            Regex(
                "\\b(?:dutrons?|deuterans?|deuterines?|diuterons?|dealt\\s*t-?rons?|deutrons?)\\b",
                RegexOption.IGNORE_CASE,
            ),
            "deuterons",
        ),
        AsrCorrectionRule(
            "aproton",
            Regex("\\baproton\\b", RegexOption.IGNORE_CASE),
            "a proton",
        ),
        AsrCorrectionRule(
            "amoebiprotons",
            Regex("\\bamoebiprotons?\\b", RegexOption.IGNORE_CASE),
            "MeV protons",
        ),
        AsrCorrectionRule(
            "amoebic-protons",
            Regex("\\bamoebic protons?\\b", RegexOption.IGNORE_CASE),
            "MeV protons",
        ),
        AsrCorrectionRule(
            "products-as-protons",
            Regex(
                "\\b(?:products|proteins)\\b(?=[^.?!]*\\b(?:in water|in pmma|in bone|range|" +
                    "stopping)\\b)",
                RegexOption.IGNORE_CASE,
            ),
            "protons",
        ),
        AsrCorrectionRule(
            "carbon-ion-phonetic",
            Regex("\\bcarbon (?:isle|aisle|i\\.?on)\\b", RegexOption.IGNORE_CASE),
            "carbon ion",
        ),

        // --- material-name phonetic variants — same no-fuzzy-fallback reasoning as particles ---
        AsrCorrectionRule("pmmea", Regex("\\bpmmea\\b", RegexOption.IGNORE_CASE), "PMMA"),
        AsrCorrectionRule(
            "silicone-as-silicon",
            Regex("\\bsilicone\\b", RegexOption.IGNORE_CASE),
            "silicon",
        ),
        AsrCorrectionRule(
            "lucite-phonetic",
            Regex("\\b(?:loose site|lou site|luxite|lucid)\\b", RegexOption.IGNORE_CASE),
            "Lucite",
        ),

        // --- quantity phonetic variants (helps detectQuantity()'s STOPPING_POWER_RE/RANGE_RE) ---
        AsrCorrectionRule(
            "range-of-phonetic",
            Regex("\\brains of\\b", RegexOption.IGNORE_CASE),
            "range of",
        ),
        AsrCorrectionRule(
            "stopping-power-phonetic",
            Regex("\\bstop in power\\b", RegexOption.IGNORE_CASE),
            "stopping power",
        ),
        AsrCorrectionRule(
            "dedx-spoken-letters",
            Regex("\\b(?:de|da|d)\\s*(?:slash|over|-)\\s*dx\\b", RegexOption.IGNORE_CASE),
            "dE/dx",
        ),
        AsrCorrectionRule(
            "the-edx",
            Regex("\\bthe\\s+edx\\b", RegexOption.IGNORE_CASE),
            "dE/dx",
        ),
        AsrCorrectionRule("edx", Regex("\\bedx\\b", RegexOption.IGNORE_CASE), "dE/dx"),
        AsrCorrectionRule(
            "de-dx-punctuation",
            Regex("\\bde\\s*[-/,]?\\s*dx\\b", RegexOption.IGNORE_CASE),
            "dE/dx",
        ),
    )

    /** Apply every rule in order, each seeing the previous rule's output — mirrors en.ts's `applyRules()`. */
    fun correct(text: String): String =
        RULES.fold(text) { acc, rule -> acc.replace(rule.pattern, rule.replacement) }
}
