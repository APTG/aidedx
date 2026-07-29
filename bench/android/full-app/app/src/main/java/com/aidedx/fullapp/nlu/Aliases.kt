package com.aidedx.fullapp.nlu

import android.content.res.AssetManager
import org.json.JSONArray

/**
 * issue #136 goal 4 — loads the *same* generated alias artifacts the web app ships
 * (`static/aliases/{materials,particles}.json`, bundled here as Android assets rather than
 * re-authored — see `scripts/generate-aliases.ts`), so this Kotlin matcher's particle/material
 * vocabulary never drifts from `src/lib/aliases/`'s source of truth. Only the *matching logic*
 * (`KotlinMatcher`) is a second implementation; the data it matches against is shared.
 *
 * Each JSON alias string maps to a canonical entity id equal to the libdedx ion/material
 * identifier `LibdedxBridge`/`LibdedxWasmBridge` already expect (see `docs/wasm.md` +
 * `APTG/libdedx`'s `dedx_elements.h`) — no separate id-remapping layer needed between "what the
 * matcher resolved" and "what libdedx wants".
 */
data class MaterialAlias(val id: Int, val name: String)

data class ParticleAlias(val id: Int, val name: String, val massNumber: Int)

class AliasTables private constructor(
    private val materialByAlias: Map<String, MaterialAlias>,
    private val particleByAlias: Map<String, ParticleAlias>,
) {
    fun resolveMaterial(phrase: String): MaterialAlias? = materialByAlias[phrase.lowercase()]

    fun resolveParticle(phrase: String): ParticleAlias? = particleByAlias[phrase.lowercase()]

    companion object {
        fun load(assets: AssetManager): AliasTables =
            fromJson(
                assets.open("aliases/materials.json").bufferedReader().readText(),
                assets.open("aliases/particles.json").bufferedReader().readText(),
            )

        /** Split out from `load()` so `KotlinMatcherAgreementTest` (a plain JVM unit test, no
         * `AssetManager` available) can parse the exact same static/aliases JSON content by
         * reading the files directly instead — same parsing logic either way. */
        fun fromJson(materialsJson: String, particlesJson: String): AliasTables {
            val materials = mutableMapOf<String, MaterialAlias>()
            val materialsArr = JSONArray(materialsJson)
            for (i in 0 until materialsArr.length()) {
                val obj = materialsArr.getJSONObject(i)
                val entity = MaterialAlias(id = obj.getInt("id"), name = obj.getString("name"))
                val aliasesArr = obj.getJSONArray("aliases")
                for (j in 0 until aliasesArr.length()) {
                    materials[aliasesArr.getString(j).lowercase()] = entity
                }
            }

            val particles = mutableMapOf<String, ParticleAlias>()
            val particlesArr = JSONArray(particlesJson)
            for (i in 0 until particlesArr.length()) {
                val obj = particlesArr.getJSONObject(i)
                val entity = ParticleAlias(
                    id = obj.getInt("id"),
                    name = obj.getString("name"),
                    massNumber = obj.optInt("defaultMassNumber", 1),
                )
                val aliasesArr = obj.getJSONArray("aliases")
                for (j in 0 until aliasesArr.length()) {
                    particles[aliasesArr.getString(j).lowercase()] = entity
                }
            }

            return AliasTables(materials, particles)
        }
    }
}
