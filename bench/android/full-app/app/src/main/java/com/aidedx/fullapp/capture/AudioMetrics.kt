package com.aidedx.fullapp.capture

import kotlin.math.abs
import kotlin.math.sqrt

/**
 * issue #161 — cheap, pure-function audio quality signals for a captured recording: peak/RMS
 * amplitude, clipped-sample count, and leading/trailing silence. These are what let a labeler (or
 * a future automated check) tell "the mic heard nothing" apart from "the mic heard something but
 * the matcher/ASR got it wrong" without listening to every WAV by hand — see the "Audio" field
 * group in the issue's capture-envelope design.
 *
 * Deliberately a plain object over `ShortArray`, not an Android class — keeps this JVM-unit-
 * testable with no device/emulator, same reasoning `KotlinMatcher`'s own JVM tests already use.
 */
object AudioMetrics {

    data class Result(
        /** Max absolute sample value, 0..32767. */
        val peakAmplitude: Int,
        val rmsAmplitude: Double,
        val clippedSampleCount: Int,
        val leadingSilenceMs: Long,
        val trailingSilenceMs: Long,
        val durationMs: Long,
    )

    /**
     * A sample below this magnitude counts as "silence" for the leading/trailing-silence scan.
     * ~-38 dBFS relative to full scale (32767) — a heuristic threshold, not a calibrated VAD; good
     * enough to distinguish "recorded before/after the user actually spoke" from real speech, not
     * meant to detect quiet speech itself.
     */
    private const val SILENCE_THRESHOLD = 400

    fun analyze(samples: ShortArray, sampleRateHz: Int = 16_000): Result {
        if (samples.isEmpty() || sampleRateHz <= 0) {
            return Result(0, 0.0, 0, 0, 0, 0)
        }

        var peak = 0
        var sumSquares = 0.0
        var clipped = 0
        for (s in samples) {
            val magnitude = abs(s.toInt())
            if (magnitude > peak) peak = magnitude
            if (magnitude >= Short.MAX_VALUE) clipped++
            sumSquares += s.toDouble() * s.toDouble()
        }
        val rms = sqrt(sumSquares / samples.size)

        var leadingSilentSamples = 0
        while (
            leadingSilentSamples < samples.size &&
            abs(samples[leadingSilentSamples].toInt()) < SILENCE_THRESHOLD
        ) {
            leadingSilentSamples++
        }
        var trailingSilentSamples = 0
        while (
            trailingSilentSamples < samples.size - leadingSilentSamples &&
            abs(samples[samples.size - 1 - trailingSilentSamples].toInt()) < SILENCE_THRESHOLD
        ) {
            trailingSilentSamples++
        }

        fun samplesToMs(n: Int) = (n.toLong() * 1000L) / sampleRateHz

        return Result(
            peakAmplitude = peak,
            rmsAmplitude = rms,
            clippedSampleCount = clipped,
            leadingSilenceMs = samplesToMs(leadingSilentSamples),
            trailingSilenceMs = samplesToMs(trailingSilentSamples),
            durationMs = samplesToMs(samples.size),
        )
    }
}
