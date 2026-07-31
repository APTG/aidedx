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
        set(value) = prefs.edit().putString(KEY_SESSION_TAG, value).apply()

    companion object {
        private const val KEY_CAPTURE_EVERYTHING = "capture_everything"
        private const val KEY_SESSION_TAG = "session_tag"
    }
}
