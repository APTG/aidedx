package com.aidedx.fullapp.capture

import com.aidedx.fullapp.nlu.MatchedIntent
import com.aidedx.fullapp.nlu.MatcherTrace
import com.aidedx.fullapp.nlu.Quantity
import org.json.JSONArray
import org.json.JSONObject

/**
 * issue #161 — assembles one capture envelope. Runtime-agnostic and generically-shaped by design
 * (see `matchedIntentToQueryIntentJson()`'s doc comment) rather than a fixed set of named columns,
 * so a schema change on the TS side (#159's `densityOverride`, #160's `alsoReport`) doesn't force
 * a capture-format bump — the importer preserves whatever fields are actually present.
 */
object CaptureEnvelope {

    const val SCHEMA_VERSION = 1

    fun build(
        captureId: String,
        capturedAtEpochMs: Long,
        device: JSONObject,
        build: JSONObject,
        audio: JSONObject,
        asr: JSONObject,
        nlu: JSONObject,
        compute: JSONObject?,
        timingsMs: JSONObject,
        failure: JSONObject?,
        runtime: String = "android",
    ): JSONObject = JSONObject().apply {
        put("schemaVersion", SCHEMA_VERSION)
        put("captureId", captureId)
        put("capturedAtEpochMs", capturedAtEpochMs)
        put("runtime", runtime)
        put("device", device)
        put("build", build)
        put("audio", audio)
        put("asr", asr)
        put("nlu", nlu)
        put("compute", compute ?: JSONObject.NULL)
        put("timingsMs", timingsMs)
        put("failure", failure ?: JSONObject.NULL)
        // User annotation (verdict chips, free-text note) has no UI yet — issue #161's separate
        // "UI" checklist item — but the field exists now so a later PATCH-in-place edit doesn't
        // need a schema change, only a value change.
        put(
            "annotation",
            JSONObject().apply {
                put("verdict", JSONObject.NULL)
                put("note", JSONObject.NULL)
                put("automatic", true)
            },
        )
    }

    /**
     * Mirrors the TS `QueryIntent` shape (`src/lib/intent/query-intent.ts`) field-for-field, even
     * though `KotlinMatcher`'s own `MatchedIntent` is a narrower single-particle/material/energy,
     * `stoppingPower`/`csdaRange`-only subset — see that class's own scoping note. Building the
     * full shape now (single-element arrays, no `assumptions`/`confidence` since this matcher
     * computes neither) means #159/#160 landing on the TS side doesn't force a capture-format
     * bump, and a capture's `nlu.intent` block is directly diffable against the real matcher's
     * output for the same transcript — exactly what a real-speech Kotlin↔TS agreement check needs.
     * `null` when nothing matched.
     */
    fun matchedIntentToQueryIntentJson(intent: MatchedIntent?): JSONObject? {
        if (intent == null) return null
        val quantity = when (intent.quantity) {
            Quantity.STOPPING_POWER -> "stoppingPower"
            Quantity.CSDA_RANGE -> "csdaRange"
        }
        return JSONObject().apply {
            put("quantity", quantity)
            put("compareDim", "none")
            put("particles", JSONArray().put(JSONObject().put("match", intent.particleMatch)))
            put("materials", JSONArray().put(JSONObject().put("match", intent.materialMatch)))
            put(
                "energies",
                JSONArray().put(
                    JSONObject()
                        .put("value", intent.energy.value)
                        .put("unit", intent.energy.unit)
                        .put("perNucleonAssumed", intent.energy.perNucleonAssumed),
                ),
            )
            put("assumptions", JSONArray())
            put("confidence", JSONObject.NULL)
        }
    }

    /** The `nlu` envelope block: the QueryIntent-shaped mirror above, plus the resolved libdedx
     * entity ids and correction/detector provenance that aren't part of that schema. */
    fun buildNluBlock(trace: MatcherTrace): JSONObject = JSONObject().apply {
        put("rawTranscript", trace.rawText)
        put("correctedTranscript", trace.correctedText)
        put("firedCorrectionRules", JSONArray(trace.firedCorrectionRules))
        put("matched", trace.intent != null)
        put("intent", matchedIntentToQueryIntentJson(trace.intent) ?: JSONObject.NULL)
        val resolvedIds = trace.intent?.let {
            JSONObject().apply {
                put("particleId", it.particleId)
                put("massNumber", it.massNumber)
                put("materialId", it.materialId)
            }
        }
        put("resolvedIds", resolvedIds ?: JSONObject.NULL)
    }

    /** The `audio` envelope block. */
    fun buildAudioBlock(
        sampleRateHz: Int,
        sampleCount: Int,
        metrics: AudioMetrics.Result,
        autoStopFired: Boolean,
    ): JSONObject = JSONObject().apply {
        put("sampleRateHz", sampleRateHz)
        put("sampleCount", sampleCount)
        put("durationMs", metrics.durationMs)
        put("peakAmplitude", metrics.peakAmplitude)
        put("rmsAmplitude", metrics.rmsAmplitude)
        put("clippedSampleCount", metrics.clippedSampleCount)
        put("leadingSilenceMs", metrics.leadingSilenceMs)
        put("trailingSilenceMs", metrics.trailingSilenceMs)
        put("autoStopFired", autoStopFired)
    }

    /** The `failure` envelope block for an exception caught during one pipeline stage. */
    fun buildFailureBlock(stage: String, t: Throwable): JSONObject = JSONObject().apply {
        put("stage", stage)
        put("exceptionType", t.javaClass.name)
        put("message", t.message ?: JSONObject.NULL)
        put("stackTrace", t.stackTraceToString())
    }
}
