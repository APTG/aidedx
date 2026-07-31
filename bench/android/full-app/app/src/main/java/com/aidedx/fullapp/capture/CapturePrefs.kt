package com.aidedx.fullapp.capture

import android.content.Context
import android.content.SharedPreferences

/**
 * issue #161 — persisted capture settings: whether every query is captured automatically
 * ("Capture everything", **default OFF**) and which session directory new captures land in.
 * Default-off is deliberate — silently recording every utterance by default would be a privacy
 * footgun; the "Debug captures" screen's toggle is the explicit, visible opt-in (see the issue's
 * own "Privacy and honesty" section). Backed by plain `SharedPreferences` — no new dependency,
 * consistent with every other piece of this feature.
 */
class CapturePrefs(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("capture_prefs", Context.MODE_PRIVATE)

    var captureEverything: Boolean
        get() = prefs.getBoolean(KEY_CAPTURE_EVERYTHING, false)
        set(value) = prefs.edit().putBoolean(KEY_CAPTURE_EVERYTHING, value).apply()

    var sessionTag: String
        get() = prefs.getString(KEY_SESSION_TAG, null) ?: CaptureWriter.defaultSessionTag()
        set(value) {
            prefs.edit().putString(KEY_SESSION_TAG, sanitizeSessionTag(value)).apply()
        }

    companion object {
        private const val KEY_CAPTURE_EVERYTHING = "capture_everything"
        private const val KEY_SESSION_TAG = "session_tag"
        private const val MAX_SESSION_TAG_LENGTH = 64

        /**
         * issue #161 review feedback — this value is used directly as a directory name under
         * `filesDir/captures/` (`CaptureWriter`) and later as zip entry path prefixes
         * (`DownloadsExporter`); unsanitized free-text input (a path separator, a `..` segment)
         * could escape the intended captures root or produce a broken zip entry. Restricted to a
         * plain filename-safe subset — every "/", ".", and other punctuation becomes "-", which
         * also flattens a `..` segment into a harmless "--" rather than leaving it recognizable.
         * Falls back to the default tag if that empties the string out entirely (e.g. the input
         * was pure whitespace or punctuation).
         */
        private fun sanitizeSessionTag(raw: String): String {
            val sanitized = raw.trim().replace(Regex("[^A-Za-z0-9_-]"), "-").take(MAX_SESSION_TAG_LENGTH)
            return sanitized.ifEmpty { CaptureWriter.defaultSessionTag() }
        }
    }
}
