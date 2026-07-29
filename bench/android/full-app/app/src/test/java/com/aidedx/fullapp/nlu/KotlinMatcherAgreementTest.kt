package com.aidedx.fullapp.nlu

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import java.io.File

/**
 * issue #136 goal 4 — "measure the drift risk, don't just accept it". A local JVM unit test
 * (`./gradlew testDebugUnitTest`, no device/emulator needed) that runs the real `KotlinMatcher`
 * against every `eval/intents.jsonl` example scoped to this port's shape (`single` +
 * `quantity-stopping-power`/`quantity-csda-range`) and diffs its output against that example's
 * hand-labeled `expected` QueryIntent — the same ground truth `matchIntent()` (the TypeScript
 * matcher) is itself graded against elsewhere in this repo (`query-intent.test.ts`,
 * `coverage-intents.ts`). Reports agreement as a number rather than assuming parity; see
 * `docs/android-full-app-spike.md` for the result and how it's interpreted.
 */
class KotlinMatcherAgreementTest {

    private fun repoRoot(): File {
        // Gradle unit tests run with the module dir as CWD: bench/android/full-app/app.
        var dir = File(".").absoluteFile
        while (!File(dir, "eval/intents.jsonl").exists()) {
            dir = dir.parentFile ?: error("Could not locate repo root (eval/intents.jsonl not found)")
        }
        return dir
    }

    @Test
    fun reportAgreementWithTsMatcherExpectations() {
        val root = repoRoot()
        val aliases = AliasTables.fromJson(
            File(root, "static/aliases/materials.json").readText(),
            File(root, "static/aliases/particles.json").readText(),
        )

        val lines = File(root, "eval/intents.jsonl").readLines()
            .filter { it.isNotBlank() && !it.trim().startsWith("//") && !it.trim().startsWith("#") }

        var total = 0
        var exactMatch = 0
        var semanticMatch = 0
        val mismatches = mutableListOf<String>()

        for (line in lines) {
            val rec = JSONObject(line)
            val tags = rec.getJSONArray("tags").let { arr -> (0 until arr.length()).map { arr.getString(it) } }
            if (!tags.contains("single")) continue
            if (!tags.contains("quantity-stopping-power") && !tags.contains("quantity-csda-range")) continue

            total++
            val id = rec.getString("id")
            val text = rec.getString("text")
            val expected = rec.getJSONObject("expected")
            val expectedQuantity = expected.getString("quantity")
            val expectedParticlePhrase = expected.getJSONArray("particles").getJSONObject(0).getString("match")
            val expectedMaterialPhrase = expected.getJSONArray("materials").getJSONObject(0).getString("match")
            val expectedEnergy = expected.getJSONArray("energies").getJSONObject(0)
            val expectedEnergyValue = expectedEnergy.getDouble("value")
            val expectedEnergyUnit = expectedEnergy.getString("unit")
            // Resolve the *expected* phrases through the same alias table, so "carbon ions" vs
            // this port's "carbon" echo doesn't count as disagreement when both resolve to the
            // same libdedx entity id — the number that actually determines the computed answer.
            // The TS matcher's own PARTICLE_HEAD_RE resolves "<element> ion(s)" by stripping that
            // exact suffix before alias lookup (see matcher.ts) — this port's alias table has no
            // literal "carbon ions" entry either, so the same suffix strip is applied here before
            // resolving, or every compound-phrase example would wrongly count as a real
            // disagreement instead of a cosmetic match-string difference.
            val strippedParticlePhrase = expectedParticlePhrase
                .replace(Regex("\\s+ions?$", RegexOption.IGNORE_CASE), "")
            // issue #143 — same treatment for isotope notation ("carbon-13 ions" -> "carbon-13"
            // -> "carbon"): KotlinMatcher now resolves these (resolveIsotopeParticle), but the
            // alias table has no literal "carbon-13" entry, so the *expected*-side id computation
            // needs the same element-name extraction or every isotope example would wrongly count
            // as a disagreement despite KotlinMatcher now resolving them correctly.
            val isotopeElement = Regex("^([a-zA-Z]+)-[0-9]{1,3}$").find(strippedParticlePhrase)
                ?.groupValues?.get(1)
            val expectedParticleId = aliases.resolveParticle(expectedParticlePhrase)?.id
                ?: aliases.resolveParticle(strippedParticlePhrase)?.id
                ?: isotopeElement?.let { aliases.resolveParticle(it)?.id }
            val expectedMaterialId = aliases.resolveMaterial(expectedMaterialPhrase)?.id

            val actual = KotlinMatcher.match(text, aliases)
            val actualQuantity = when (actual?.quantity) {
                Quantity.STOPPING_POWER -> "stoppingPower"
                Quantity.CSDA_RANGE -> "csdaRange"
                null -> null
            }
            val energyOk = actual != null &&
                actual.energy.value == expectedEnergyValue &&
                normalizeUnit(actual.energy.unit) == normalizeUnit(expectedEnergyUnit)

            val exactOk = actual != null &&
                actualQuantity == expectedQuantity &&
                actual.particleMatch.equals(expectedParticlePhrase, ignoreCase = true) &&
                actual.materialMatch.equals(expectedMaterialPhrase, ignoreCase = true) &&
                energyOk
            val semanticOk = actual != null &&
                actualQuantity == expectedQuantity &&
                actual.particleId == expectedParticleId &&
                actual.materialId == expectedMaterialId &&
                energyOk

            if (exactOk) exactMatch++
            if (semanticOk) semanticMatch++
            if (!semanticOk) {
                mismatches.add(
                    "$id: \"$text\" -> got=$actual expected=(quantity=$expectedQuantity, " +
                        "particle=$expectedParticlePhrase [id=$expectedParticleId], " +
                        "material=$expectedMaterialPhrase [id=$expectedMaterialId], " +
                        "energy=$expectedEnergyValue $expectedEnergyUnit)",
                )
            }
        }

        println("=== KotlinMatcher vs eval/intents.jsonl `expected` agreement ===")
        println(
            "exact (quantity + echoed phrase text + energy): $exactMatch / $total " +
                "(${"%.1f".format(100.0 * exactMatch / total)}%)",
        )
        println(
            "semantic (quantity + resolved particle/material id + energy): $semanticMatch / $total " +
                "(${"%.1f".format(100.0 * semanticMatch / total)}%)",
        )
        if (mismatches.isNotEmpty()) {
            println("--- semantic mismatches ---")
            mismatches.forEach(::println)
        }
    }

    private fun normalizeUnit(unit: String): String =
        if (unit == "MeV/u") "MeV/nucl" else unit
}
