package com.aidedx.fullapp.capture

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.random.Random

/**
 * issue #161 — writes one capture (a WAV + an entry in `captures.json`) per query under
 * `filesDir/captures/<session>/`. Rewrites the whole `captures.json` after every capture — same
 * crash-safety convention `DataGenActivity`'s `session.json` already uses (issue #130,
 * `bench/android/sherpa-onnx`), so a killed/backgrounded app never loses more than the one
 * in-flight capture. `manifest.json` is written once, on session start.
 *
 * Held as a plain field on `MainActivity` (constructed once in `onCreate()`, reused across
 * `onConfigurationChanged()`) rather than a separate `Application`-scoped singleton — #162 already
 * made the Activity instance itself survive rotation, which is the only in-app lifecycle event
 * that would otherwise threaten an in-flight write; `CaptureManagerActivity` (the "Debug captures"
 * screen) only ever *reads* across sessions via `CaptureStore`, it never appends to this one, so a
 * cross-Activity singleton still isn't needed.
 *
 * Whether a query is captured automatically is `CapturePrefs.captureEverything` (default off) —
 * `MainActivity` decides that, not this class; `write()` here is unconditional, callable either
 * from the auto-capture path or from a person tapping Save/Flag on the result row.
 */
class CaptureWriter(context: Context, val sessionTag: String = defaultSessionTag()) {

    private val sessionDir: File = File(File(context.filesDir, "captures"), sessionTag)
    private val capturesFile: File = File(sessionDir, "captures.json")
    private val captures = mutableListOf<JSONObject>()

    val captureCount: Int get() = captures.size

    init {
        sessionDir.mkdirs()
        loadExisting()
        writeManifestIfAbsent(sessionTag)
    }

    private fun loadExisting() {
        if (!capturesFile.exists()) return
        try {
            val arr = JSONArray(capturesFile.readText())
            for (i in 0 until arr.length()) captures.add(arr.getJSONObject(i))
        } catch (e: Exception) {
            // A corrupt captures.json from a prior crash mid-write must not block new captures —
            // start this session's in-memory list fresh; the next write() below overwrites the
            // file with a well-formed one again.
        }
    }

    private fun writeManifestIfAbsent(sessionTag: String) {
        val manifestFile = File(sessionDir, "manifest.json")
        if (manifestFile.exists()) return
        val manifest = JSONObject().apply {
            put("schemaVersion", CaptureEnvelope.SCHEMA_VERSION)
            put("sessionTag", sessionTag)
            put("sessionStartedAtEpochMs", System.currentTimeMillis())
            put("build", DeviceInfo.collectBuildInfo())
        }
        manifestFile.writeText(manifest.toString())
    }

    /** A capture's id is minted before its envelope is built (the envelope carries it as
     * `captureId`), so `write()` below can just read it back rather than taking it twice. */
    fun newCaptureId(): String {
        val ts = SimpleDateFormat("yyyyMMdd-HHmmss-SSS", Locale.US)
            .apply { timeZone = TimeZone.getTimeZone("UTC") }
            .format(Date())
        return "$ts-${Random.nextInt(1000, 9999)}"
    }

    @Synchronized
    fun write(envelope: JSONObject, pcm: ShortArray, sampleRateHz: Int = 16_000) {
        val captureId = envelope.getString("captureId")
        writeWavFile(File(sessionDir, "$captureId.wav"), pcm, sampleRateHz)
        captures.add(envelope)
        writeCapturesFileAtomically()
    }

    /** Patches an existing capture's `annotation` block in place — the "⌄ details" dialog's Save
     * action, for a capture "Capture everything" already auto-wrote. No-op if `captureId` isn't
     * in this session (shouldn't happen; `MainActivity` only ever annotates its own last write). */
    @Synchronized
    fun updateAnnotation(captureId: String, annotation: JSONObject) {
        val index = captures.indexOfFirst { it.optString("captureId") == captureId }
        if (index < 0) return
        captures[index].put("annotation", annotation)
        writeCapturesFileAtomically()
    }

    /** Removes one capture (its `captures.json` entry and its `.wav`) — the result row's "Undo"
     * on a just-Saved/Flagged capture. Deliberately removes the whole capture rather than just
     * reverting the annotation: "Undo" reads as "I didn't mean to keep this one", not "un-flag
     * it but keep the recording" — a simplification worth stating plainly rather than leaving
     * implicit. */
    @Synchronized
    fun deleteCapture(captureId: String) {
        val index = captures.indexOfFirst { it.optString("captureId") == captureId }
        if (index < 0) return
        captures.removeAt(index)
        writeCapturesFileAtomically()
        File(sessionDir, "$captureId.wav").delete()
    }

    /**
     * issue #161 review feedback — a direct `capturesFile.writeText(...)` is not atomic: a
     * process kill mid-write (exactly the scenario this crash-safety convention exists for) can
     * leave a truncated/corrupt `captures.json`, and `loadExisting()` recovering from that by
     * starting fresh silently drops *every* prior capture in the session, not just the in-flight
     * one. Writing to a same-directory temp file first and renaming over the target uses the
     * filesystem's atomic `rename()` — a crash mid-write leaves either the old, still-valid file
     * or a still-unreferenced `.tmp`, never a half-written `captures.json`.
     */
    private fun writeCapturesFileAtomically() {
        val tmp = File(sessionDir, "captures.json.tmp")
        tmp.writeText(JSONArray(captures).toString())
        if (!tmp.renameTo(capturesFile)) {
            // renameTo() is platform-dependent and can fail even same-directory/same-volume —
            // fall back to a plain overwrite rather than silently losing this capture.
            capturesFile.writeText(tmp.readText())
            tmp.delete()
        }
    }

    /** Same RIFF/WAVE writer as `DataGenActivity.writeWavFile()` (issue #130) — 16-bit mono PCM. */
    private fun writeWavFile(file: File, pcm: ShortArray, sampleRate: Int) {
        val dataLen = pcm.size * 2
        RandomAccessFile(file, "rw").use { raf ->
            raf.setLength(0)
            fun writeIntLE(v: Int) {
                raf.write(
                    byteArrayOf(
                        (v and 0xff).toByte(),
                        ((v shr 8) and 0xff).toByte(),
                        ((v shr 16) and 0xff).toByte(),
                        ((v shr 24) and 0xff).toByte(),
                    ),
                )
            }
            fun writeShortLE(v: Int) {
                raf.write(byteArrayOf((v and 0xff).toByte(), ((v shr 8) and 0xff).toByte()))
            }
            raf.writeBytes("RIFF")
            writeIntLE(36 + dataLen)
            raf.writeBytes("WAVE")
            raf.writeBytes("fmt ")
            writeIntLE(16)
            writeShortLE(1) // PCM
            writeShortLE(1) // mono
            writeIntLE(sampleRate)
            writeIntLE(sampleRate * 2) // byte rate = sampleRate * channels * bytesPerSample
            writeShortLE(2) // block align
            writeShortLE(16) // bits per sample
            raf.writeBytes("data")
            writeIntLE(dataLen)
            val bytes = ByteArray(dataLen)
            for (i in pcm.indices) {
                val v = pcm[i].toInt()
                bytes[i * 2] = (v and 0xff).toByte()
                bytes[i * 2 + 1] = ((v shr 8) and 0xff).toByte()
            }
            raf.write(bytes)
        }
    }

    companion object {
        /** One session per UTC calendar day until the "Capture everything" UI (with a real
         * session-tag field) exists — good enough for capture-core verification. */
        fun defaultSessionTag(): String {
            val date = SimpleDateFormat("yyyy-MM-dd", Locale.US)
                .apply { timeZone = TimeZone.getTimeZone("UTC") }
                .format(Date())
            return "auto-$date"
        }
    }
}
