package com.aidedx.fullapp

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toolbar
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
import androidx.core.content.ContextCompat
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
    private val autoStopHandler = Handler(Looper.getMainLooper())
    private val autoStopRunnable = Runnable { onRecordTapped() }

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
    private lateinit var recordProgressBar: ProgressBar
    private lateinit var transcriptText: TextView
    private lateinit var intentText: TextView
    private lateinit var resultText: TextView
    private lateinit var wasmButton: Button
    private lateinit var wasmResultText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.main)

        downloadManager = ModelDownloadManager(filesDir)
        aliases = AliasTables.load(assets)

        val toolbar = findViewById<Toolbar>(R.id.toolbar)
        toolbar.inflateMenu(R.menu.main_menu)
        toolbar.setOnMenuItemClickListener { item ->
            if (item.itemId == R.id.action_manage_downloads) {
                startActivity(Intent(this, ModelManagerActivity::class.java))
                true
            } else {
                false
            }
        }

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
        recordProgressBar = findViewById(R.id.recordProgressBar)
        transcriptText = findViewById(R.id.transcriptText)
        intentText = findViewById(R.id.intentText)
        resultText = findViewById(R.id.resultText)
        wasmButton = findViewById(R.id.wasmSmokeTestButton)
        wasmResultText = findViewById(R.id.wasmSmokeTestResult)

        val entry = ParakeetModel.ENTRY
        modelInfoText.text = "${entry.displayName}\n" +
            "${formatMB(entry.totalSizeBytes)} MB from ${entry.sourceHost}"

        downloadButton.setOnClickListener { startDownload() }
        cancelButton.setOnClickListener { downloadManager.cancel() }
        recordButton.setOnClickListener { onRecordTapped() }
        wasmButton.setOnClickListener { runLatencyBenchmark() }

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
        autoStopHandler.removeCallbacks(autoStopRunnable)
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
                setRecordButtonIdle()
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
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_RECORD_AUDIO)
                return
            }
            recorder = AudioRecorder().also { it.start() }
            setRecordButtonRecording()
            transcriptText.text = ""
            intentText.text = ""
            resultText.text = ""
            // issue #143 — sherpa-onnx's non-streaming OfflineRecognizer is built for short
            // clips; a recording left running for minutes (observed during #136's on-device
            // testing, from a missed Stop tap) came back with a silently empty transcript rather
            // than a partial/garbled one. Auto-stop instead of leaving that failure mode open —
            // this fires `onRecordTapped()` again exactly as if the user had tapped Stop, so it
            // goes through the identical stop -> transcribe -> match -> compute -> display path.
            autoStopHandler.postDelayed(autoStopRunnable, MAX_RECORDING_MS)
        } else {
            autoStopHandler.removeCallbacks(autoStopRunnable)
            setRecordButtonTranscribing()
            val samples = currentRecorder.stop()
            recorder = null
            processRecordingInBackground(samples)
        }
    }

    /** issue #144 — mirrors MicButton.svelte's idle/recording/transcribing visual states
     * (background shape + text color + label + progress indicator), not just functional state. */
    private fun setRecordButtonIdle() {
        recordButton.isEnabled = true
        recordButton.setBackgroundResource(R.drawable.bg_button_outline)
        recordButton.setTextColor(ContextCompat.getColor(this, R.color.foreground))
        recordButton.text = "🎤  Tap to record"
        recordProgressBar.visibility = View.GONE
    }

    private fun setRecordButtonRecording() {
        recordButton.setBackgroundResource(R.drawable.bg_button_danger)
        recordButton.setTextColor(ContextCompat.getColor(this, R.color.danger_foreground))
        recordButton.text = "⏹  Tap to stop"
        recordProgressBar.visibility = View.GONE
    }

    private fun setRecordButtonTranscribing() {
        recordButton.isEnabled = false
        recordButton.setBackgroundResource(R.drawable.bg_button_muted)
        recordButton.setTextColor(ContextCompat.getColor(this, R.color.muted_foreground))
        recordButton.text = "Processing…"
        recordProgressBar.visibility = View.VISIBLE
    }

    private fun processRecordingInBackground(samples: ShortArray) {
        Thread {
            val floats = ParakeetTranscriber.shortsToFloats(samples)
            val transcript = transcriber?.transcribe(floats) ?: ""
            val matched = if (transcript.isBlank()) null else KotlinMatcher.match(transcript, aliases)

            // issue #143 — distinguish "heard nothing at all" from "heard something but couldn't
            // match it" instead of both silently reading as the same "No match" — the ambiguity
            // is exactly what made the long-recording empty-transcript failure mode confusing to
            // diagnose on-device (see the auto-stop cap above and docs/android-full-app-spike.md).
            var intentLine = if (transcript.isBlank()) "No speech detected — try again" else "No match"
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
                setRecordButtonIdle()
            }
        }.start()
    }

    /** Simplified version of `src/lib/compute/compute.ts`'s `energyToMeVPerNucl()` — total-energy
     * units (MeV/keV/GeV) are divided by the assumed mass number; `MeV/nucl` passes through. */
    private fun toMevPerNucl(matched: MatchedIntent): Float {
        val totalMev = when (matched.energy.unit) {
            "keV" -> matched.energy.value / 1000.0
            "GeV" -> matched.energy.value * 1000.0
            "TeV" -> matched.energy.value * 1_000_000.0
            else -> matched.energy.value
        }
        // massNumber is 0 for particles libdedx doesn't treat as nucleon-composed (e.g. the
        // electron alias entry) — per-nucleon division would divide by zero, so fall back to
        // treating the energy as already-total, same as the explicit MeV/nucl case.
        return if (matched.energy.unit == "MeV/nucl" || matched.massNumber <= 0) {
            totalMev.toFloat()
        } else {
            (totalMev / matched.massNumber).toFloat()
        }
    }

    // ---- goal 3A spike ----

    /**
     * issue #136 goal 3 — real per-call latency for the findings doc, not a guess. Approach B
     * (`LibdedxBridge`) is a bare flat JNI call into an already-loaded native library — no
     * per-call setup.
     *
     * issue #143 — Approach A is now measured two ways so the comparison is fair. "Cold"
     * (`runSmokeTest`, unchanged) re-parses and re-links the whole wasm module on every call —
     * #136's original 15.671 ms/call number. "Warm" (`LibdedxWasmBridge.init()`'s `Session`,
     * added for #143) parses+links once and reuses that runtime for every calculate call, the
     * same load-once-call-many shape Approach B's `System.loadLibrary()` already has — this is the
     * number that's actually comparable to Approach B's.
     */
    private fun runLatencyBenchmark() {
        Thread {
            val bWarmup = LibdedxBridge.stoppingPowerMevCm2PerG(1, 276, 40f)
            val bStart = System.nanoTime()
            repeat(50) { LibdedxBridge.stoppingPowerMevCm2PerG(1, 276, 40f) }
            val bAvgMs = (System.nanoTime() - bStart) / 50 / 1_000_000.0
            android.util.Log.d("LatencyBench", "Approach B (JNI) warmup=$bWarmup avg=${bAvgMs}ms over 50 calls")

            val coldRuns = 10
            val coldStart = System.nanoTime()
            repeat(coldRuns) { LibdedxWasmBridge.runSmokeTest(assets) }
            val coldAvgMs = (System.nanoTime() - coldStart) / coldRuns / 1_000_000.0
            android.util.Log.d(
                "LatencyBench",
                "Approach A cold (wasm3, incl. parse+link) avg=${coldAvgMs}ms over $coldRuns calls",
            )

            val session = LibdedxWasmBridge.init(assets)
            var warmAvgMs = Double.NaN
            if (session.isValid) {
                val warmWarmup = session.stoppingPowerMevCm2PerG(1, 276, 40f)
                val warmStart = System.nanoTime()
                repeat(50) { session.stoppingPowerMevCm2PerG(1, 276, 40f) }
                warmAvgMs = (System.nanoTime() - warmStart) / 50 / 1_000_000.0
                android.util.Log.d(
                    "LatencyBench",
                    "Approach A warm (wasm3, parsed once) warmup=$warmWarmup avg=${warmAvgMs}ms over 50 calls",
                )
                session.release()
            } else {
                android.util.Log.d("LatencyBench", "Approach A warm: session init failed")
            }

            runOnUiThread {
                wasmResultText.text = "B (JNI): ${"%.3f".format(bAvgMs)} ms/call | " +
                    "A cold (wasm3): ${"%.3f".format(coldAvgMs)} ms/call | " +
                    "A warm (wasm3): ${"%.3f".format(warmAvgMs)} ms/call"
            }
        }.start()
    }

    private fun formatMB(bytes: Long): String = "%.1f".format(bytes / (1024.0 * 1024.0))

    companion object {
        private const val REQUEST_RECORD_AUDIO = 1

        // issue #143 — sherpa-onnx's OfflineRecognizer is a non-streaming, whole-clip decoder;
        // every hand-picked test sentence in this app's own test set (docs/android-full-app-
        // spike.md) is well under 10s spoken, so 15s leaves comfortable margin for a real query
        // without leaving the door open to the multi-minute silent-empty-transcript failure mode
        // #136 hit on-device.
        private const val MAX_RECORDING_MS = 15_000L
    }
}
