package com.aidedx.fullapp.capture

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * issue #161 — read-side, cross-session view over everything `CaptureWriter` has written under
 * `filesDir/captures/`, for the "Debug captures" screen. `CaptureWriter` itself only ever knows
 * about its own one session; this answers "how many captures exist, in total, across every day
 * the app has been used" and backs the list/delete-all actions.
 */
object CaptureStore {

    data class CaptureRow(val sessionTag: String, val envelope: JSONObject, val wavFile: File)

    private fun capturesRoot(context: Context): File = File(context.filesDir, "captures")

    /** Every capture across every session directory, newest first. */
    fun listAll(context: Context): List<CaptureRow> {
        val sessionDirs = capturesRoot(context).listFiles { f -> f.isDirectory } ?: return emptyList()
        val rows = mutableListOf<CaptureRow>()
        for (sessionDir in sessionDirs) {
            val capturesFile = File(sessionDir, "captures.json")
            if (!capturesFile.exists()) continue
            try {
                val arr = JSONArray(capturesFile.readText())
                for (i in 0 until arr.length()) {
                    val envelope = arr.getJSONObject(i)
                    val captureId = envelope.optString("captureId")
                    rows.add(CaptureRow(sessionDir.name, envelope, File(sessionDir, "$captureId.wav")))
                }
            } catch (e: Exception) {
                // Same "a corrupt file must not block the rest" posture as
                // CaptureWriter.loadExisting() — skip this session, keep the others.
            }
        }
        return rows.sortedByDescending { it.envelope.optLong("capturedAtEpochMs") }
    }

    fun totalSizeBytes(context: Context): Long {
        val root = capturesRoot(context)
        if (!root.exists()) return 0L
        return root.walkTopDown().filter { it.isFile }.sumOf { it.length() }
    }

    /** Deletes every session directory under `filesDir/captures/`. Any `CaptureWriter` already
     * holding an in-memory session (`MainActivity`'s, most likely) won't see this until it's
     * reconstructed — `MainActivity.onResume()` does that unconditionally, matching Android's own
     * "you'll be resumed after returning from another Activity" lifecycle guarantee. */
    fun deleteAll(context: Context) {
        capturesRoot(context).deleteRecursively()
    }
}
