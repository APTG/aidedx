package com.aidedx.fullapp.nlu

/**
 * issue #136 goal 4 — a Kotlin matcher "inspired by" `src/lib/intent/matcher.ts` +
 * `src/lib/intent/lang/en.ts`, deliberately NOT a port of the full 865-line pipeline (compareDim,
 * inverse queries, indirect idioms, fuzzy typo tolerance, spelled-out numbers, and coordinated
 * particle/material lists are all out of scope here — see the issue's goal 4 scoping note).
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
    // (mentionsStoppingPowerSynonym) — indirect idioms and fuzzy typo-tolerant matching are the
    // parts intentionally left out of this minimal port.
    private val STOPPING_POWER_RE = Regex(
        "stopping power|de/dx|dE/dx|energy loss|specific ionization|bethe-bloch|\\blet\\b|linear energy transfer",
        RegexOption.IGNORE_CASE,
    )
    private val RANGE_RE = Regex("\\bcsda\\b|\\brange\\b", RegexOption.IGNORE_CASE)

    private val ENERGY_RE = Regex(
        "(\\d+(?:\\.\\d+)?)\\s*(MeV/nucleon|MeV/nucl|MeV/u|MeV per nucleon|MeV|keV|GeV)\\b",
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

    private fun normalizeEnergyUnit(raw: String): Pair<String, Boolean> {
        val lower = raw.lowercase()
        return when {
            lower.contains("nucleon") || lower == "mev/nucl" || lower == "mev/u" -> "MeV/nucl" to true
            lower == "kev" -> "keV" to false
            lower == "gev" -> "GeV" to false
            else -> "MeV" to false
        }
    }

    private fun overlaps(range: IntRange, start: Int, end: Int): Boolean =
        range.first < end && start < range.last + 1

    fun match(text: String, aliases: AliasTables): MatchedIntent? {
        val quantity = when {
            STOPPING_POWER_RE.containsMatchIn(text) -> Quantity.STOPPING_POWER
            RANGE_RE.containsMatchIn(text) -> Quantity.CSDA_RANGE
            else -> return null
        }

        val energyMatch = ENERGY_RE.find(text) ?: return null
        val (unit, perNucleonAssumed) = normalizeEnergyUnit(energyMatch.groupValues[2])
        val energy = EnergyValue(energyMatch.groupValues[1].toDouble(), unit, perNucleonAssumed)

        val tokens = TOKEN_RE.findAll(text).map { it.value }.toList()

        var particleMatch: String? = null
        var particleAlias: ParticleAlias? = null
        var particleRange: IntRange? = null
        outerParticle@ for (windowSize in 2 downTo 1) {
            for (start in 0..tokens.size - windowSize) {
                val phrase = tokens.subList(start, start + windowSize).joinToString(" ")
                // Single-token candidates shorter than 3 chars are rejected — same guard
                // en.ts's material n-gram scan uses, applied here to particles too: without it, a
                // contraction fragment like the "s" in "What's" spuriously resolves to Sulfur's
                // one-letter alias before the real "protons" token is ever reached.
                if (windowSize == 1 && phrase.length < 3) continue
                val hit = aliases.resolveParticle(phrase) ?: continue
                particleMatch = phrase
                particleAlias = hit
                particleRange = start..(start + windowSize - 1)
                break@outerParticle
            }
        }
        if (particleMatch == null || particleAlias == null || particleRange == null) return null

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
