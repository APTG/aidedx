package com.aidedx.fullapp.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioMetricsTest {

    @Test
    fun `empty array returns all zeros without crashing`() {
        val r = AudioMetrics.analyze(ShortArray(0))
        assertEquals(0, r.peakAmplitude)
        assertEquals(0.0, r.rmsAmplitude, 0.0)
        assertEquals(0, r.clippedSampleCount)
        assertEquals(0L, r.leadingSilenceMs)
        assertEquals(0L, r.trailingSilenceMs)
        assertEquals(0L, r.durationMs)
    }

    @Test
    fun `fully silent buffer reports full leading silence, no trailing double-count`() {
        val samples = ShortArray(16_000) { 0 } // 1s at 16kHz
        val r = AudioMetrics.analyze(samples, sampleRateHz = 16_000)
        assertEquals(1000L, r.durationMs)
        assertEquals(1000L, r.leadingSilenceMs)
        // The whole buffer is already accounted for by leading silence — a fully-silent clip has
        // no separate "trailing" region left to scan without double-counting the same samples.
        assertEquals(0L, r.trailingSilenceMs)
        assertEquals(0, r.peakAmplitude)
        assertEquals(0, r.clippedSampleCount)
    }

    @Test
    fun `full-scale samples are counted as clipped and set the peak`() {
        val samples = ShortArray(100) { Short.MAX_VALUE }
        val r = AudioMetrics.analyze(samples)
        assertEquals(100, r.clippedSampleCount)
        assertEquals(Short.MAX_VALUE.toInt(), r.peakAmplitude)
        assertTrue(r.rmsAmplitude > 30_000.0)
    }

    @Test
    fun `silence-speech-silence detects leading and trailing separately`() {
        val silence = ShortArray(1600) { 0 } // 100ms each side at 16kHz
        val speech = ShortArray(3200) { i -> if (i % 2 == 0) 5000 else -5000 }
        val samples = silence + speech + silence
        val r = AudioMetrics.analyze(samples, sampleRateHz = 16_000)
        assertEquals(100L, r.leadingSilenceMs)
        assertEquals(100L, r.trailingSilenceMs)
        assertEquals(5000, r.peakAmplitude)
        assertEquals(0, r.clippedSampleCount)
    }
}
