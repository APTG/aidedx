package com.aidedx.fullapp.capture

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import java.io.File
import java.io.OutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * issue #161 — zips every capture session under `filesDir/captures/` and lands it in the shared
 * Downloads collection: the "Export to Downloads" action on the Debug Captures screen, and the
 * fallback for a non-debuggable build where `adb`'s `run-as` pull doesn't work at all. MediaStore's
 * `Downloads` collection (API 29+) needs no permission; API 26-28 falls back to the legacy public
 * Downloads directory + `WRITE_EXTERNAL_STORAGE` (declared `maxSdkVersion="28"` in the manifest —
 * meaningless, and not requested, above that). This app's one real test device is API 37, so the
 * legacy branch is unverified — if the permission isn't granted there, this fails silently
 * (`null`) rather than crashing; a real permission-request flow is future work if this app is ever
 * run on API <29 hardware.
 */
object DownloadsExporter {

    /** Zips and exports; returns the exported file's display name, or `null` if there was
     * nothing to export or the export failed. */
    fun export(context: Context): String? {
        val root = File(context.filesDir, "captures")
        if (!root.exists() || root.listFiles().isNullOrEmpty()) return null

        val fileName =
            "aidedx-captures-${SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())}.zip"

        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                exportViaMediaStore(context, root, fileName)
            } else {
                exportLegacy(context, root, fileName)
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun exportViaMediaStore(context: Context, root: File, fileName: String): String? {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, fileName)
            put(MediaStore.Downloads.MIME_TYPE, "application/zip")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return null
        // issue #161 review feedback — a failure anywhere below (no output stream, zipInto()
        // throwing mid-write) must not leave the just-inserted row behind as an orphaned,
        // permanently-IS_PENDING entry Downloads can't show and this app has no other reference
        // to; delete it on any failure path instead of only handling the happy path.
        try {
            val stream = resolver.openOutputStream(uri) ?: throw java.io.IOException("openOutputStream returned null")
            stream.use { zipInto(it, root) }
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            return fileName
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            return null
        }
    }

    @Suppress("DEPRECATION")
    private fun exportLegacy(context: Context, root: File, fileName: String): String? {
        val granted = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.WRITE_EXTERNAL_STORAGE,
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) return null
        val downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        downloadsDir.mkdirs()
        File(downloadsDir, fileName).outputStream().use { zipInto(it, root) }
        return fileName
    }

    private fun zipInto(out: OutputStream, root: File) {
        ZipOutputStream(out).use { zip ->
            root.walkTopDown().filter { it.isFile }.forEach { file ->
                zip.putNextEntry(ZipEntry(file.relativeTo(root).path))
                file.inputStream().use { it.copyTo(zip) }
                zip.closeEntry()
            }
        }
    }
}
