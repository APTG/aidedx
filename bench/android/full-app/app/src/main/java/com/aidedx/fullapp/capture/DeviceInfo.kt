package com.aidedx.fullapp.capture

import android.app.ActivityManager
import android.content.Context
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * issue #161 — device/build context for a field capture. Thermal and battery state matter here in
 * a way they wouldn't for a lab benchmark: a throttled phone gives different ASR/compute latency,
 * and "it got slow" reports from a real field session are otherwise unfalsifiable without this.
 */
object DeviceInfo {

    fun collect(context: Context): JSONObject {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        am?.getMemoryInfo(memInfo)

        val batteryManager = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        val batteryPercent = batteryManager?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
            ?.takeIf { it in 0..100 }

        val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val thermalStatus = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            powerManager?.currentThermalStatus
        } else {
            null
        }

        return JSONObject().apply {
            put("manufacturer", Build.MANUFACTURER)
            put("model", Build.MODEL)
            put("hardware", Build.HARDWARE)
            put("androidRelease", Build.VERSION.RELEASE)
            put("sdkInt", Build.VERSION.SDK_INT)
            put("supportedAbis", JSONArray(Build.SUPPORTED_ABIS.toList()))
            put("locale", Locale.getDefault().toString())
            put("totalRamBytes", memInfo.totalMem)
            put("availRamBytes", memInfo.availMem)
            put("lowMemory", memInfo.lowMemory)
            put("batteryPercent", batteryPercent ?: JSONObject.NULL)
            put("thermalStatus", thermalStatus ?: JSONObject.NULL)
        }
    }

    /** Build/commit provenance — a capture from an unrecognized build is close to worthless once
     * a few fixes have landed since. Reads `BuildConfig` fields added for this issue. */
    fun collectBuildInfo(): JSONObject = JSONObject().apply {
        put("applicationId", com.aidedx.fullapp.BuildConfig.APPLICATION_ID)
        put("versionName", com.aidedx.fullapp.BuildConfig.VERSION_NAME)
        put("versionCode", com.aidedx.fullapp.BuildConfig.VERSION_CODE)
        put("buildType", com.aidedx.fullapp.BuildConfig.BUILD_TYPE)
        put("gitSha", com.aidedx.fullapp.BuildConfig.GIT_SHA)
        put("gitDirty", com.aidedx.fullapp.BuildConfig.GIT_DIRTY)
        put("buildTimeMs", com.aidedx.fullapp.BuildConfig.BUILD_TIME_MS)
    }
}
