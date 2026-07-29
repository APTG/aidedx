package com.aidedx.fullapp

import android.app.Activity
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import com.aidedx.fullapp.download.ModelDownloadManager
import com.aidedx.fullapp.download.ParakeetModel

/**
 * issue #136 goal 1 — the offline-maps "downloaded regions" management screen equivalent: what's
 * on-device, its size, where it's stored (human terms, not a raw path), and a delete action that
 * lets the user re-download afterward (just returns to `MainActivity`'s download prompt, since
 * `isDownloaded()` re-checks on every `onResume()`).
 */
class ModelManagerActivity : Activity() {

    private lateinit var downloadManager: ModelDownloadManager

    private lateinit var entryNameText: TextView
    private lateinit var entrySizeText: TextView
    private lateinit var entryLocationText: TextView
    private lateinit var entryStatusText: TextView
    private lateinit var deleteButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.model_manager)

        downloadManager = ModelDownloadManager(filesDir)

        entryNameText = findViewById(R.id.entryNameText)
        entrySizeText = findViewById(R.id.entrySizeText)
        entryLocationText = findViewById(R.id.entryLocationText)
        entryStatusText = findViewById(R.id.entryStatusText)
        deleteButton = findViewById(R.id.deleteButton)

        deleteButton.setOnClickListener {
            downloadManager.delete(ParakeetModel.ENTRY)
            refresh()
        }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        val entry = ParakeetModel.ENTRY
        val downloaded = downloadManager.isDownloaded(entry)
        entryNameText.text = entry.displayName
        entrySizeText.text = "%.1f MB".format(
            downloadManager.sizeOnDiskBytes(entry) / (1024.0 * 1024.0),
        )
        entryLocationText.text = downloadManager.storageLocationLabel(entry)
        entryStatusText.text = if (downloaded) "Downloaded" else "Not downloaded"
        deleteButton.isEnabled = downloaded
    }
}
