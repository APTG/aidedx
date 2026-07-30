package com.aidedx.fullapp.nlu

/**
 * issue #136 goal 4 — a Kotlin matcher "inspired by" `src/lib/intent/matcher.ts` +
 * `src/lib/intent/lang/en.ts`, deliberately NOT a port of the full 865-line pipeline (compareDim,
 * inverse queries, fuzzy typo tolerance, and coordinated particle/material lists are still out of
 * scope — see the issue's goal 4 scoping note). issue #143 closed three of the originally-listed
 * gaps (indirect idioms, advanced stopping-power synonyms, explicit isotope notation), each
 * ported from the matching `en.ts`/`lookup.ts` logic named in the comments below, since the
 * measured agreement in `docs/android-full-app-spike.md` traced most of the disagreement to
 * exactly those three features being absent.
 *
 * Covers exactly the two shapes goal 4 requires: a single particle + single material + single
 * energy, asking for stopping power or CSDA range (`compareDim: "none"` in the TS schema's
 * terms — see `eval/intents.jsonl`'s `sp-*`/`rng-*` examples this was scoped against).
 *
 * This is a second implementation of matching logic against the *same* alias data
 * (`AliasTables`) — a real drift risk the TS matcher doesn't have to worry about alone.
 * `docs/android-full-app-spike.md` reports the measured agreement between this and
 * `matchIntent()` on a shared sentence set; don't assume parity without checking that number.
 */
enum class Quantity { STOPPING_POWER, CSDA_RANGE }

data class EnergyValue(val value: Double, val unit: String, val perNucleonAssumed: Boolean)

data class MatchedIntent(
    val quantity: Quantity,
    val particleMatch: String,
    val particleId: Int,
    val massNumber: Int,
    val materialMatch: String,
    val materialId: Int,
    val energy: EnergyValue,
)

object KotlinMatcher {

    // Same direct-keyword vocabulary as en.ts's DIRECT_STOPPING/DIRECT_RANGE + LET synonym check
    // (mentionsStoppingPowerSynonym) — fuzzy typo-tolerant matching is still out of scope.
    private val STOPPING_POWER_RE = Regex(
        "stopping power|de\\s*/\\s*dx|energy loss|specific ioni[sz]ation|bethe[\\s-]bloch|" +
            "retarding force|energy deposition(?:\\s+density)?|" +
            "dose per (?:micrometer|micrometre|micron|[uµ]m)|\\blet\\b|linear energy transfer",
        RegexOption.IGNORE_CASE,
    )
    private val RANGE_RE = Regex("\\bcsda\\b|\\brange\\b", RegexOption.IGNORE_CASE)

    // issue #143 — ported from en.ts's INDIRECT_IDIOMS. Only consulted when neither direct regex
    // above matches (see `detectQuantity()`), same fallback ordering `matcher.ts` uses.
    private val INDIRECT_IDIOMS: List<Pair<Regex, Quantity>> = listOf(
        "\\bhow far\\b" to Quantity.CSDA_RANGE,
        "\\bhow deep\\b" to Quantity.CSDA_RANGE,
        "\\bhow thick\\b" to Quantity.CSDA_RANGE,
        "\\bpenetration depth\\b" to Quantity.CSDA_RANGE,
        "\\bpenetrat(?:e|es|ing|ion)\\b" to Quantity.CSDA_RANGE,
        "\\bcome(?:s)? to rest\\b" to Quantity.CSDA_RANGE,
        "\\bbefore stopping\\b" to Quantity.CSDA_RANGE,
        "\\b(?:will|can|does|do)\\b[^.?!]*\\btravel\\b" to Quantity.CSDA_RANGE,
        "\\bshorter distance\\b" to Quantity.CSDA_RANGE,
        "\\bgo(?:es)? in\\b" to Quantity.CSDA_RANGE,
        "\\bget into\\b" to Quantity.CSDA_RANGE,
        "\\bmake it\\b" to Quantity.CSDA_RANGE,
        "\\b(?:lose[s]?|lost)\\s+energy\\b" to Quantity.STOPPING_POWER,
        "\\bshed[s]? energy\\b" to Quantity.STOPPING_POWER,
        "\\bslowed down\\b" to Quantity.STOPPING_POWER,
        "\\bat what rate\\b" to Quantity.STOPPING_POWER,
        "\\bhow quickly\\b" to Quantity.STOPPING_POWER,
        ("\\b(?:lose[s]?|lost)\\b[^.?!]*\\bper\\s+(?:centimeter|millimeter|cm|mm|unit length)\\b") to
            Quantity.STOPPING_POWER,
        ("\\b(?:per|after)\\s+(?:each\\s+)?(?:centimeter|millimeter|cm|mm|unit length)\\b") to
            Quantity.STOPPING_POWER,
        (
            "\\benergy\\b[^.?!]*\\bdeposited\\b[^.?!]*\\bper\\s+" +
                "(?:micrometer|micrometre|micron|[uµ]m)\\b"
            ) to Quantity.STOPPING_POWER,
    ).map { (pattern, quantity) -> Regex(pattern, RegexOption.IGNORE_CASE) to quantity }

    private fun detectQuantity(text: String): Quantity? = when {
        STOPPING_POWER_RE.containsMatchIn(text) -> Quantity.STOPPING_POWER
        RANGE_RE.containsMatchIn(text) -> Quantity.CSDA_RANGE
        else -> INDIRECT_IDIOMS.firstOrNull { (regex, _) -> regex.containsMatchIn(text) }?.second
    }

    private val ENERGY_RE = Regex(
        "(\\d+(?:\\.\\d+)?)\\s*(MeV/nucleon|MeV/nucl|MeV/u|MeV per nucleon|MeV|keV|GeV|TeV)\\b",
        RegexOption.IGNORE_CASE,
    )

    // Rejects bogus material n-gram windows — a small, narrowly-scoped subset of en.ts's much
    // larger MATERIAL_STOPWORDS, sufficient for the direct-phrasing sentences this targets.
    private val STOPWORDS = setOf(
        "the", "a", "an", "of", "in", "for", "is", "what", "and", "what's",
        "stopping", "power", "range", "csda", "energy", "loss",
        "proton", "protons", "ion", "ions", "particle", "particles",
    )

    private val TOKEN_RE = Regex("[\\p{L}][\\p{L}\\d-]*")

    // issue #136 goal 4 — added after an on-device test: sherpa-onnx/Parakeet-v3 spells energies
    // out as words ("40 MeV" -> "forty Mev"), same as most ASR models. The original minimal port
    // deliberately skipped en.ts's spelled-out-number handling as out of scope for a text-only
    // eval set; a *real* recorded voice query immediately hit this gap (ENERGY_RE requires
    // digits), producing a silent "No match" for an otherwise-perfectly-transcribed query. This is
    // a small subset of en.ts's NUMBER_WORDS (zero..nineteen, tens by ten, "hundred" composition)
    // — enough for spoken MeV/keV/GeV values in this domain, not a general number-word parser.
    private val ONES_WORDS = mapOf(
        "zero" to 0, "one" to 1, "two" to 2, "three" to 3, "four" to 4, "five" to 5,
        "six" to 6, "seven" to 7, "eight" to 8, "nine" to 9, "ten" to 10,
        "eleven" to 11, "twelve" to 12, "thirteen" to 13, "fourteen" to 14, "fifteen" to 15,
        "sixteen" to 16, "seventeen" to 17, "eighteen" to 18, "nineteen" to 19,
    )
    private val TENS_WORDS = mapOf(
        "twenty" to 20, "thirty" to 30, "forty" to 40, "fifty" to 50,
        "sixty" to 60, "seventy" to 70, "eighty" to 80, "ninety" to 90,
    )
    private val NUMBER_WORD_ALTERNATION =
        (ONES_WORDS.keys + TENS_WORDS.keys + setOf("hundred")).joinToString("|")
    // "and" may optionally join "hundred" to a remainder word ("two hundred and forty") without
    // itself being a number word — matches en.ts's `composeHundreds()`, which the same shape of
    // sentence exercises on the web side (correct.test.ts's "two hundred and forty MeV" case).
    // Without this, the run stops at "hundred" and "and forty" is left as a separate,
    // unconverted word, silently corrupting the value ("two hundred and forty" -> "200 and 40").
    private val NUMBER_WORD_RUN_RE = Regex(
        "\\b(?:$NUMBER_WORD_ALTERNATION)(?:[\\s-]+(?:and\\s+)?(?:$NUMBER_WORD_ALTERNATION))*\\b",
        RegexOption.IGNORE_CASE,
    )

    private fun wordsToNumber(phrase: String): Int {
        var total = 0
        var current = 0
        for (word in phrase.lowercase().split(Regex("[\\s-]+"))) {
            when {
                word == "hundred" -> current = (if (current == 0) 1 else current) * 100
                ONES_WORDS.containsKey(word) -> current += ONES_WORDS.getValue(word)
                TENS_WORDS.containsKey(word) -> current += TENS_WORDS.getValue(word)
            }
        }
        return total + current
    }

    // issue #156 — ASR spells a decimal energy value out fully too ("58.4 MeV" ->
    // "fifty eight point four MeV"), a gap this port's number-word support never covered (only
    // whole-number runs were composed; nothing joined a run to a trailing "point <digit>"
    // fraction). Mirrors matcher.ts's composeDecimals(): the whole-number part is any run
    // NUMBER_WORD_RUN_RE would compose, each digit after "point" is restricted to a single 0-9
    // word (decimal digits are read one at a time, not "point sixty"). Must run before
    // normalizeSpelledNumbers()'s whole-number pass, or that pass would independently convert
    // "fifty eight" and "four" into separate, unjoined "58" and "4" tokens, silently dropping the
    // decimal point (matcher.ts's composeDecimals()/composeTensOnes() has the same ordering
    // requirement, for the same reason).
    private val DECIMAL_DIGIT_WORDS = ONES_WORDS.filterValues { it in 0..9 }
    private val DECIMAL_RE = Regex(
        "\\b((?:$NUMBER_WORD_ALTERNATION)(?:[\\s-]+(?:and\\s+)?(?:$NUMBER_WORD_ALTERNATION))*)" +
            "\\s+point\\s+((?:(?:${DECIMAL_DIGIT_WORDS.keys.joinToString("|")})\\s*)+)\\b",
        RegexOption.IGNORE_CASE,
    )

    private fun normalizeSpelledDecimals(text: String): String =
        DECIMAL_RE.replace(text) { m ->
            val whole = wordsToNumber(m.groupValues[1])
            val digits = m.groupValues[2].trim().split(Regex("\\s+"))
                .joinToString("") { DECIMAL_DIGIT_WORDS.getValue(it.lowercase()).toString() }
            "$whole.$digits"
        }

    private fun normalizeSpelledNumbers(text: String): String {
        val withDecimals = normalizeSpelledDecimals(text)
        return NUMBER_WORD_RUN_RE.replace(withDecimals) { wordsToNumber(it.value).toString() }
    }

    private fun normalizeEnergyUnit(raw: String): Pair<String, Boolean> {
        val lower = raw.lowercase()
        return when {
            lower.contains("nucleon") || lower == "mev/nucl" || lower == "mev/u" -> "MeV/nucl" to true
            lower == "kev" -> "keV" to false
            lower == "gev" -> "GeV" to false
            lower == "tev" -> "TeV" to false
            else -> "MeV" to false
        }
    }

    private fun overlaps(range: IntRange, start: Int, end: Int): Boolean =
        range.first < end && start < range.last + 1

    private data class ParticleFind(val phrase: String, val alias: ParticleAlias, val range: IntRange)

    private fun findParticle(tokens: List<String>, aliases: AliasTables): ParticleFind? {
        for (windowSize in 2 downTo 1) {
            for (start in 0..tokens.size - windowSize) {
                val phrase = tokens.subList(start, start + windowSize).joinToString(" ")
                // Single-token candidates shorter than 3 chars are rejected — same guard
                // en.ts's material n-gram scan uses, applied here to particles too: without it, a
                // contraction fragment like the "s" in "What's" spuriously resolves to Sulfur's
                // one-letter alias before the real "protons" token is ever reached.
                if (windowSize == 1 && phrase.length < 3) continue
                val hit = aliases.resolveParticle(phrase) ?: continue
                return ParticleFind(phrase, hit, start..(start + windowSize - 1))
            }
        }
        return null
    }

    // issue #143 — matches lookup.ts's parseIsotope() input shape: an element name/symbol
    // directly adjacent to a 1-3 digit mass number, hyphenated in this port's tokenizer (which
    // keeps "-" inside a token) — "carbon-13", "he-3". lookup.ts also accepts the reverse order
    // ("13 c") and no separator at all; narrowed here to the hyphenated form since that is what
    // every isotope example in eval/intents.jsonl actually uses.
    private val ISOTOPE_TOKEN_RE = Regex("^([a-zA-Z]+)-([0-9]{1,3})$")
    private val ION_SUFFIX_WORDS = setOf("ion", "ions")

    private fun resolveIsotopeParticle(tokens: List<String>, aliases: AliasTables): ParticleFind? {
        for (i in tokens.indices) {
            val isotopeMatch = ISOTOPE_TOKEN_RE.find(tokens[i]) ?: continue
            val (elementWord, massNumberStr) = isotopeMatch.destructured
            val base = aliases.resolveParticle(elementWord) ?: continue
            val hasIonSuffix = i + 1 < tokens.size && tokens[i + 1].lowercase() in ION_SUFFIX_WORDS
            val range = if (hasIonSuffix) i..(i + 1) else i..i
            val phrase = tokens.subList(range.first, range.last + 1).joinToString(" ")
            val alias = ParticleAlias(id = base.id, name = base.name, massNumber = massNumberStr.toInt())
            return ParticleFind(phrase, alias, range)
        }
        return null
    }

    fun match(rawText: String, aliases: AliasTables): MatchedIntent? {
        // issue #147 — number normalization must run before the ASR correction rules, since
        // several of them (letter-spelled units, glued-unit-before-particle) are digit-gated;
        // see AsrCorrections.kt's header for why this ordering is itself part of the fix.
        val text = AsrCorrections.correct(normalizeSpelledNumbers(rawText))
        val quantity = detectQuantity(text) ?: return null

        val energyMatch = ENERGY_RE.find(text) ?: return null
        val (unit, perNucleonAssumed) = normalizeEnergyUnit(energyMatch.groupValues[2])
        val energy = EnergyValue(energyMatch.groupValues[1].toDouble(), unit, perNucleonAssumed)

        val tokens = TOKEN_RE.findAll(text).map { it.value }.toList()

        // issue #143 — explicit isotope notation ("carbon-13 ions", "helium-3 ion") never has a
        // literal alias-table entry (isotopes aren't enumerated per-element there), so the plain
        // window scan always misses them; `resolveIsotopeParticle()` ports lookup.ts's
        // `parseIsotope()`, which resolves the same shape (element name/symbol + mass number)
        // against the *same* alias data this port already loads, then overrides the resolved
        // entry's default mass number with the explicit one. Tried only as a fallback, after the
        // plain scan, since it's the rarer shape.
        val particleFind = findParticle(tokens, aliases) ?: resolveIsotopeParticle(tokens, aliases)
            ?: return null
        val (particleMatch, particleAlias, particleRange) = particleFind

        var materialMatch: String? = null
        var materialAlias: MaterialAlias? = null
        outerMaterial@ for (windowSize in 2 downTo 1) {
            for (start in 0..tokens.size - windowSize) {
                if (overlaps(particleRange, start, start + windowSize)) continue
                val phrase = tokens.subList(start, start + windowSize).joinToString(" ")
                if (windowSize == 1 && phrase.length < 3) continue
                if (phrase.lowercase() in STOPWORDS) continue
                val hit = aliases.resolveMaterial(phrase) ?: continue
                materialMatch = phrase
                materialAlias = hit
                break@outerMaterial
            }
        }
        if (materialMatch == null || materialAlias == null) return null

        return MatchedIntent(
            quantity = quantity,
            particleMatch = particleMatch,
            particleId = particleAlias.id,
            massNumber = particleAlias.massNumber,
            materialMatch = materialMatch,
            materialId = materialAlias.id,
            energy = energy,
        )
    }
}
