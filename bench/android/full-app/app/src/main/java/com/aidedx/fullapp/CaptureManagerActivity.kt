package com.aidedx.fullapp

import android.app.Activity
import android.app.AlertDialog
import android.media.MediaPlayer
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CompoundButton
import android.widget.EditText
import android.widget.ListView
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import android.widget.Toolbar
import com.aidedx.fullapp.capture.CapturePrefs
import com.aidedx.fullapp.capture.CaptureStore
import com.aidedx.fullapp.capture.DownloadsExporter
import java.text.SimpleDateFormat
import java.util.Locale

/**
 * issue #161 — the "Debug captures" screen: what's been captured (across every session, not just
 * today's), the "Capture everything" toggle + session tag `CapturePrefs` controls, and the escape
 * hatches (export to Downloads, delete all) the field-capture design calls for. Same plain-
 * `Activity` + framework-widgets convention as `ModelManagerActivity`, opened from the same
 * toolbar-overflow affordance in `MainActivity`.
 */
class CaptureManagerActivity : Activity() {

    private lateinit var prefs: CapturePrefs

    private lateinit var countText: TextView
    private lateinit var sizeText: TextView
    private lateinit var captureEverythingSwitch: Switch
    private lateinit var sessionTagInput: EditText
    private lateinit var deleteAllButton: Button
    private lateinit var exportButton: Button
    private lateinit var exportResultText: TextView
    private lateinit var listView: ListView
    private lateinit var emptyText: TextView

    private var mediaPlayer: MediaPlayer? = null
    private var suppressSessionTagWatcher = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.capture_manager)

        prefs = CapturePrefs(this)

        findViewById<Toolbar>(R.id.toolbar).setNavigationOnClickListener { finish() }

        countText = findViewById(R.id.captureCountText)
        sizeText = findViewById(R.id.captureSizeText)
        captureEverythingSwitch = findViewById(R.id.captureEverythingSwitch)
        sessionTagInput = findViewById(R.id.sessionTagInput)
        deleteAllButton = findViewById(R.id.deleteAllButton)
        exportButton = findViewById(R.id.exportButton)
        exportResultText = findViewById(R.id.exportResultText)
        listView = findViewById(R.id.captureListView)
        emptyText = findViewById(R.id.captureEmptyText)

        captureEverythingSwitch.setOnCheckedChangeListener { _, isChecked ->
            prefs.captureEverything = isChecked
        }
        sessionTagInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                // Guards against the programmatic `setText()` in refresh() itself round-tripping
                // back through this listener and re-persisting the same value on every refresh.
                if (suppressSessionTagWatcher) return
                val tag = s?.toString()?.trim().orEmpty()
                if (tag.isNotEmpty()) prefs.sessionTag = tag
            }
        })

        deleteAllButton.setOnClickListener { confirmDeleteAll() }
        exportButton.setOnClickListener { exportToDownloads() }

        listView.setOnItemClickListener { _, _, position, _ ->
            (listView.adapter as? CaptureRowAdapter)?.getRow(position)?.let(::showCaptureDetail)
        }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    override fun onPause() {
        super.onPause()
        stopPlayback()
    }

    private fun refresh() {
        val rows = CaptureStore.listAll(this)
        countText.text = "${rows.size} capture${if (rows.size == 1) "" else "s"}"
        sizeText.text = "%.1f MB on disk".format(CaptureStore.totalSizeBytes(this) / (1024.0 * 1024.0))
        captureEverythingSwitch.isChecked = prefs.captureEverything

        suppressSessionTagWatcher = true
        if (sessionTagInput.text.toString() != prefs.sessionTag) {
            sessionTagInput.setText(prefs.sessionTag)
        }
        suppressSessionTagWatcher = false

        emptyText.visibility = if (rows.isEmpty()) View.VISIBLE else View.GONE
        listView.visibility = if (rows.isEmpty()) View.GONE else View.VISIBLE
        listView.adapter = CaptureRowAdapter(this, rows)
    }

    private fun confirmDeleteAll() {
        AlertDialog.Builder(this)
            .setTitle("Delete all captures?")
            .setMessage("Removes every recording and envelope under all sessions. This can't be undone.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Delete all") { _, _ ->
                CaptureStore.deleteAll(this)
                refresh()
            }
            .show()
    }

    private fun exportToDownloads() {
        exportButton.isEnabled = false
        exportResultText.text = "Exporting…"
        Thread {
            val fileName = DownloadsExporter.export(this)
            runOnUiThread {
                exportButton.isEnabled = true
                exportResultText.text = if (fileName != null) {
                    "Saved to Downloads/$fileName"
                } else {
                    "Nothing to export, or export failed"
                }
            }
        }.start()
    }

    private fun showCaptureDetail(row: CaptureStore.CaptureRow) {
        stopPlayback()

        val scroll = ScrollView(this)
        val detailText = TextView(this).apply {
            text = row.envelope.toString(2)
            setPadding(24, 24, 24, 24)
            setTextIsSelectable(true)
        }
        scroll.addView(detailText)

        val playButton = Button(this).apply {
            text = if (row.wavFile.exists()) "▶ Play" else "No WAV on disk"
            isEnabled = row.wavFile.exists()
        }

        val container = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            addView(playButton)
            addView(
                scroll,
                ViewGroup.LayoutParams.MATCH_PARENT,
                resources.displayMetrics.heightPixels / 2,
            )
        }

        val dialog = AlertDialog.Builder(this)
            .setTitle(row.envelope.optString("captureId"))
            .setView(container)
            .setPositiveButton("Close", null)
            .setOnDismissListener { stopPlayback() }
            .create()

        playButton.setOnClickListener {
            if (mediaPlayer != null) {
                stopPlayback()
                playButton.text = "▶ Play"
            } else {
                playButton.text = "⏹ Stop"
                playCapture(row.wavFile) { playButton.text = "▶ Play" }
            }
        }

        dialog.show()
    }

    private fun playCapture(wavFile: java.io.File, onFinished: () -> Unit) {
        try {
            mediaPlayer = MediaPlayer().apply {
                setDataSource(wavFile.absolutePath)
                setOnCompletionListener {
                    stopPlayback()
                    onFinished()
                }
                prepare()
                start()
            }
        } catch (e: Exception) {
            Toast.makeText(this, "Couldn't play: ${e.message}", Toast.LENGTH_SHORT).show()
            stopPlayback()
            onFinished()
        }
    }

    private fun stopPlayback() {
        mediaPlayer?.let {
            try {
                if (it.isPlaying) it.stop()
            } catch (e: Exception) {
                // release() below still runs regardless — a mid-teardown IllegalStateException
                // from isPlaying/stop() on an already-erroring player isn't worth surfacing here.
            }
            it.release()
        }
        mediaPlayer = null
    }

    /** One row: timestamp + verdict/error marker, a one-line summary of what was heard/matched,
     * and a muted session/duration/status line. */
    private class CaptureRowAdapter(
        context: Activity,
        private val rows: List<CaptureStore.CaptureRow>,
    ) : ArrayAdapter<CaptureStore.CaptureRow>(context, 0, rows) {

        fun getRow(position: Int): CaptureStore.CaptureRow? = rows.getOrNull(position)

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val view = convertView
                ?: android.view.LayoutInflater.from(context)
                    .inflate(R.layout.capture_list_item, parent, false)
            val row = rows[position]
            val envelope = row.envelope
            val nlu = envelope.optJSONObject("nlu")
            val failure = envelope.optJSONObject("failure")
            val annotation = envelope.optJSONObject("annotation")

            val timeMs = envelope.optLong("capturedAtEpochMs")
            val timestamp = SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(java.util.Date(timeMs))
            val flag = when {
                annotation?.optBoolean("automatic", true) == false -> "🚩 "
                else -> ""
            }
            view.findViewById<TextView>(R.id.rowTimestamp).text = "$flag$timestamp"

            val summary = when {
                failure != null -> "⚠ error in ${failure.optString("stage")}"
                nlu?.optBoolean("matched") == true -> {
                    val intent = nlu.optJSONObject("intent")
                    val particle = intent?.optJSONArray("particles")?.optJSONObject(0)?.optString("match")
                    val material = intent?.optJSONArray("materials")?.optJSONObject(0)?.optString("match")
                    "${intent?.optString("quantity")} — $particle in $material"
                }
                nlu?.optString("rawTranscript").isNullOrBlank() -> "No speech detected"
                else -> "No match: \"${nlu?.optString("rawTranscript")}\""
            }
            view.findViewById<TextView>(R.id.rowSummary).text = summary

            val durationMs = envelope.optJSONObject("audio")?.optLong("durationMs") ?: 0L
            view.findViewById<TextView>(R.id.rowMeta).text =
                "${row.sessionTag} · ${durationMs}ms"

            return view
        }
    }
}
