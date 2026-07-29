package com.aidedx.fullapp

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import com.aidedx.fullapp.asr.ParakeetTranscriber
import com.aidedx.fullapp.audio.AudioRecorder
import com.aidedx.fullapp.compute.AnswerFormatter
import com.aidedx.fullapp.compute.LibdedxBridge
import com.aidedx.fullapp.compute.LibdedxWasmBridge
import com.aidedx.fullapp.download.DownloadCancelledException
import com.aidedx.fullapp.download.ModelDownloadManager
import com.aidedx.fullapp.download.ModelEntry
import com.aidedx.fullapp.download.ParakeetModel
import com.aidedx.fullapp.nlu.AliasTables
import com.aidedx.fullapp.nlu.KotlinMatcher
import com.aidedx.fullapp.nlu.MatchedIntent
import com.aidedx.fullapp.nlu.Quantity
import java.io.File

/**
 * issue #136 — single-Activity product-shaped spike wiring all 5 goals together: model download
 * (goal 1) -> record/transcribe (goal 2) -> Kotlin NLU match (goal 4) -> libdedx compute (goal 3,
 * Approach B) -> results display (goal 5). Same single-`Activity` + plain-`Thread` + panel-
 * visibility-toggle shape as `DataGenActivity` (no Fragments/Compose/coroutines/ViewModel —
 * matches every other bench/android app's convention), not a new architecture pattern for
 * this one app.
 */
class MainActivity : Activity() {

    private lateinit var downloadManager: ModelDownloadManager
    private lateinit var aliases: AliasTables

    private var transcriber: ParakeetTranscriber? = null
    private var recorder: AudioRecorder? = null

    private lateinit var downloadPromptPanel: View
    private lateinit var downloadProgressPanel: View
    private lateinit var readyPanel: View
    private lateinit var modelInfoText: TextView
    private lateinit var downloadButton: Button
    private lateinit var progressBar: ProgressBar
    private lateinit var progressText: TextView
    private lateinit var cancelButton: Button
    private lateinit var statusText: TextView
    private lateinit var recordButton: Button
    private lateinit var transcriptText: TextView
    private lateinit var intentText: TextView
    private lateinit var resultText: TextView
    private lateinit var manageButton: Button
    private lateinit var wasmButton: Button
    private lateinit var wasmResultText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.main)

        downloadManager = ModelDownloadManager(filesDir)
        aliases = AliasTables.load(assets)

        downloadPromptPanel = findViewById(R.id.downloadPromptPanel)
        downloadProgressPanel = findViewById(R.id.downloadProgressPanel)
        readyPanel = findViewById(R.id.readyPanel)
        modelInfoText = findViewById(R.id.modelInfoText)
        downloadButton = findViewById(R.id.downloadButton)
        progressBar = findViewById(R.id.progressBar)
        progressText = findViewById(R.id.progressText)
        cancelButton = findViewById(R.id.cancelButton)
        statusText = findViewById(R.id.statusText)
        recordButton = findViewById(R.id.recordButton)
        transcriptText = findViewById(R.id.transcriptText)
        intentText = findViewById(R.id.intentText)
        resultText = findViewById(R.id.resultText)
        manageButton = findViewById(R.id.manageButton)
        wasmButton = findViewById(R.id.wasmSmokeTestButton)
        wasmResultText = findViewById(R.id.wasmSmokeTestResult)

        val entry = ParakeetModel.ENTRY
        modelInfoText.text = "${entry.displayName}\n" +
            "${formatMB(entry.totalSizeBytes)} MB from ${entry.sourceHost}"

        downloadButton.setOnClickListener { startDownload() }
        cancelButton.setOnClickListener { downloadManager.cancel() }
        manageButton.setOnClickListener {
            startActivity(Intent(this, ModelManagerActivity::class.java))
        }
        recordButton.setOnClickListener { onRecordTapped() }
        wasmButton.setOnClickListener { runWasmSmokeTest() }

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_RECORD_AUDIO)
        }
    }

    override fun onResume() {
        super.onResume()
        refreshState()
    }

    override fun onDestroy() {
        super.onDestroy()
        transcriber?.release()
    }

    private fun refreshState() {
        val entry = ParakeetModel.ENTRY
        if (downloadManager.isDownloaded(entry)) {
            downloadPromptPanel.visibility = View.GONE
            downloadProgressPanel.visibility = View.GONE
            readyPanel.visibility = View.VISIBLE
            if (transcriber == null) loadTranscriberInBackground(entry)
        } else {
            downloadPromptPanel.visibility = View.VISIBLE
            downloadProgressPanel.visibility = View.GONE
            readyPanel.visibility = View.GONE
        }
    }

    private fun loadTranscriberInBackground(entry: ModelEntry) {
        statusText.text = "Loading recognizer…"
        recordButton.isEnabled = false
        Thread {
            val modelDir = File(filesDir, entry.destDirName)
            val loaded = ParakeetTranscriber(modelDir)
            runOnUiThread {
                transcriber = loaded
                statusText.text = "Model ready"
                recordButton.isEnabled = true
            }
        }.start()
    }

    // ---- goal 1: download ----

    private fun startDownload() {
        downloadPromptPanel.visibility = View.GONE
        downloadProgressPanel.visibility = View.VISIBLE
        progressBar.progress = 0
        progressText.text = "Starting…"

        Thread {
            try {
                downloadManager.download(ParakeetModel.ENTRY) { progress ->
                    runOnUiThread {
                        val pct = if (progress.totalBytes > 0) {
                            (progress.loadedBytes * 100 / progress.totalBytes).toInt()
                        } else {
                            0
                        }
                        progressBar.progress = pct
                        progressText.text = "${formatMB(progress.loadedBytes)} / " +
                            "${formatMB(progress.totalBytes)} MB ($pct%) — ${progress.fileName}"
                    }
                }
                runOnUiThread { refreshState() }
            } catch (e: DownloadCancelledException) {
                downloadManager.delete(ParakeetModel.ENTRY)
                runOnUiThread { refreshState() }
            } catch (e: Exception) {
                downloadManager.delete(ParakeetModel.ENTRY)
                runOnUiThread {
                    downloadProgressPanel.visibility = View.GONE
                    downloadPromptPanel.visibility = View.VISIBLE
                    val entry = ParakeetModel.ENTRY
                    modelInfoText.text = "${entry.displayName}\n" +
                        "${formatMB(entry.totalSizeBytes)} MB from ${entry.sourceHost}\n\n" +
                        "Download failed: ${e.message}"
                }
            }
        }.start()
    }

    // ---- goal 2 + 4 + 3 + 5: record -> transcribe -> match -> compute -> display ----

    private fun onRecordTapped() {
        val currentRecorder = recorder
        if (currentRecorder == null) {
            recorder = AudioRecorder().also { it.start() }
            recordButton.text = "Tap to stop"
            transcriptText.text = ""
            intentText.text = ""
            resultText.text = ""
        } else {
            recordButton.isEnabled = false
            recordButton.text = "Processing…"
            val samples = currentRecorder.stop()
            recorder = null
            processRecordingInBackground(samples)
        }
    }

    private fun processRecordingInBackground(samples: ShortArray) {
        Thread {
            val floats = ParakeetTranscriber.shortsToFloats(samples)
            val transcript = transcriber?.transcribe(floats) ?: ""
            val matched = KotlinMatcher.match(transcript, aliases)

            var intentLine = "No match"
            var resultLine = ""
            if (matched != null) {
                intentLine = "${matched.quantity} | particle=${matched.particleMatch} " +
                    "(id=${matched.particleId}) | material=${matched.materialMatch} " +
                    "(id=${matched.materialId}) | energy=${matched.energy.value} ${matched.energy.unit}"

                val energyMevPerNucl = toMevPerNucl(matched)
                val density = LibdedxBridge.densityGramPerCm3(matched.materialId)
                val stp = if (matched.quantity == Quantity.STOPPING_POWER) {
                    LibdedxBridge.stoppingPowerMevCm2PerG(matched.particleId, matched.materialId, energyMevPerNucl)
                } else {
                    null
                }
                val csda = if (matched.quantity == Quantity.CSDA_RANGE) {
                    LibdedxBridge.csdaRangeGramPerCm2(matched.particleId, matched.materialId, energyMevPerNucl)
                } else {
                    null
                }
                resultLine = AnswerFormatter.format(matched, stp, csda, density)
            }

            runOnUiThread {
                transcriptText.text = transcript
                intentText.text = intentLine
                resultText.text = resultLine
                recordButton.isEnabled = true
                recordButton.text = "Tap to record"
            }
        }.start()
    }

    /** Simplified version of `src/lib/compute/compute.ts`'s `energyToMeVPerNucl()` — total-energy
     * units (MeV/keV/GeV) are divided by the assumed mass number; `MeV/nucl` passes through. */
    private fun toMevPerNucl(matched: MatchedIntent): Float {
        val totalMev = when (matched.energy.unit) {
            "keV" -> matched.energy.value / 1000.0
            "GeV" -> matched.energy.value * 1000.0
            else -> matched.energy.value
        }
        return if (matched.energy.unit == "MeV/nucl") {
            totalMev.toFloat()
        } else {
            (totalMev / matched.massNumber).toFloat()
        }
    }

    // ---- goal 3A spike ----

    private fun runWasmSmokeTest() {
        wasmResultText.text = "Running…"
        Thread {
            val result = try {
                LibdedxWasmBridge.runSmokeTest(assets)
            } catch (e: Exception) {
                "FAIL: ${e.message}"
            }
            runOnUiThread { wasmResultText.text = result }
        }.start()
    }

    private fun formatMB(bytes: Long): String = "%.1f".format(bytes / (1024.0 * 1024.0))

    companion object {
        private const val REQUEST_RECORD_AUDIO = 1
    }
}
