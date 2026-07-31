package com.aidedx.fullapp.capture

import com.aidedx.fullapp.nlu.EnergyValue
import com.aidedx.fullapp.nlu.MatchedIntent
import com.aidedx.fullapp.nlu.MatcherTrace
import com.aidedx.fullapp.nlu.Quantity
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #161 — the matched-intent path (`CaptureEnvelope.matchedIntentToQueryIntentJson()` /
 * `buildNluBlock()`) can't be exercised on-device by literally speaking into the mic over adb the
 * way the no-match path was (docs/android-full-app-spike.md's #161 update covers that manual
 * verification) — a synthetic `MatchedIntent` here is the next best thing, and a real JVM unit
 * test besides.
 */
class CaptureEnvelopeTest {

    private val intent = MatchedIntent(
        quantity = Quantity.STOPPING_POWER,
        particleMatch = "protons",
        particleId = 1,
        massNumber = 1,
        materialMatch = "water",
        materialId = 276,
        energy = EnergyValue(value = 150.0, unit = "MeV", perNucleonAssumed = false),
    )

    @Test
    fun `matched intent maps onto the QueryIntent shape`() {
        val json = CaptureEnvelope.matchedIntentToQueryIntentJson(intent)!!
        assertEquals("stoppingPower", json.getString("quantity"))
        assertEquals("none", json.getString("compareDim"))
        assertEquals("protons", json.getJSONArray("particles").getJSONObject(0).getString("match"))
        assertEquals("water", json.getJSONArray("materials").getJSONObject(0).getString("match"))
        val energyJson = json.getJSONArray("energies").getJSONObject(0)
        assertEquals(150.0, energyJson.getDouble("value"), 0.0)
        assertEquals("MeV", energyJson.getString("unit"))
        assertFalse(energyJson.getBoolean("perNucleonAssumed"))
        assertEquals(0, json.getJSONArray("assumptions").length())
        assertTrue(json.isNull("confidence"))
    }

    @Test
    fun `csda range intent maps to csdaRange, not stoppingPower`() {
        val json = CaptureEnvelope.matchedIntentToQueryIntentJson(intent.copy(quantity = Quantity.CSDA_RANGE))!!
        assertEquals("csdaRange", json.getString("quantity"))
    }

    @Test
    fun `null intent maps to null`() {
        assertEquals(null, CaptureEnvelope.matchedIntentToQueryIntentJson(null))
    }

    @Test
    fun `nlu block carries resolved ids alongside the QueryIntent mirror`() {
        val trace = MatcherTrace(
            rawText = "150 Me V protons in water",
            correctedText = "150 MeV protons in water",
            firedCorrectionRules = listOf("mev-letter-spelled"),
            intent = intent,
        )
        val block = CaptureEnvelope.buildNluBlock(trace)
        assertEquals("150 Me V protons in water", block.getString("rawTranscript"))
        assertEquals("150 MeV protons in water", block.getString("correctedTranscript"))
        assertEquals("mev-letter-spelled", block.getJSONArray("firedCorrectionRules").getString(0))
        assertTrue(block.getBoolean("matched"))
        assertFalse(block.isNull("intent"))
        val resolvedIds = block.getJSONObject("resolvedIds")
        assertEquals(1, resolvedIds.getInt("particleId"))
        assertEquals(1, resolvedIds.getInt("massNumber"))
        assertEquals(276, resolvedIds.getInt("materialId"))
    }

    @Test
    fun `nlu block for a no-match trace carries null intent and resolvedIds`() {
        val trace = MatcherTrace(
            rawText = "asdf qwerty",
            correctedText = "asdf qwerty",
            firedCorrectionRules = emptyList(),
            intent = null,
        )
        val block = CaptureEnvelope.buildNluBlock(trace)
        assertFalse(block.getBoolean("matched"))
        assertTrue(block.isNull("intent"))
        assertTrue(block.isNull("resolvedIds"))
    }

    @Test
    fun `failure block records stage, exception type, message, and a stack trace`() {
        val block = CaptureEnvelope.buildFailureBlock("compute", IllegalStateException("boom"))
        assertEquals("compute", block.getString("stage"))
        assertEquals("java.lang.IllegalStateException", block.getString("exceptionType"))
        assertEquals("boom", block.getString("message"))
        assertTrue(block.getString("stackTrace").contains("IllegalStateException"))
    }

    @Test
    fun `envelope build round-trips through JSON with the expected top-level fields`() {
        val envelope = CaptureEnvelope.build(
            captureId = "abc-123",
            capturedAtEpochMs = 42L,
            device = JSONObject(),
            build = JSONObject(),
            audio = JSONObject(),
            asr = JSONObject(),
            nlu = JSONObject(),
            compute = null,
            timingsMs = JSONObject(),
            failure = null,
        )
        val reparsed = JSONObject(envelope.toString())
        assertEquals(CaptureEnvelope.SCHEMA_VERSION, reparsed.getInt("schemaVersion"))
        assertEquals("abc-123", reparsed.getString("captureId"))
        assertEquals("android", reparsed.getString("runtime"))
        assertTrue(reparsed.isNull("compute"))
        assertTrue(reparsed.isNull("failure"))
        assertTrue(reparsed.getJSONObject("annotation").getBoolean("automatic"))
    }
}
