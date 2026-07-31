package com.aidedx.fullapp

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
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
import com.aidedx.fullapp.capture.AudioMetrics
import com.aidedx.fullapp.capture.CaptureEnvelope
import com.aidedx.fullapp.capture.CaptureWriter
import com.aidedx.fullapp.capture.DeviceInfo
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
import com.aidedx.fullapp.nlu.MatcherTrace
import com.aidedx.fullapp.nlu.Quantity
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * issue #136 — single-Activity product-shaped spike wiring all 5 goals together: model download
 * (goal 1) -> record/transcribe (goal 2) -> Kotlin NLU match (goal 4) -> libdedx compute (goal 3,
 * Approach B) -> results display (goal 5). Same single-`Activity` + plain-`Thread` + panel-
 * visibility-toggle shape as `DataGenActivity` (no Fragments/Compose/coroutines/ViewModel —
 * matches every other bench/android app's convention), not a new architecture pattern for
 * this one app.
 *
 * issue #161 — this app turned out to be the fastest way to *find* real NLU/ASR failures (talk to
 * it, notice a wrong answer), which makes it a field-testing tool, not just a benchmark spike —
 * and a field-testing tool that loses its in-progress recording (and reloads a ~639 MB model) on
 * every rotation is actively hostile to that use. `AndroidManifest.xml` now declares
 * `android:configChanges` for `MainActivity` so a rotation no longer destroys/recreates it;
 * `transcriber`/`recorder`/every in-flight background `Thread` survive unchanged. The system
 * still discards and re-inflates the view tree on a config change (picking `res/layout-land/`
 * over `res/layout/` as appropriate), so every value currently shown has to be tracked in a
 * plain field, not just left on the (now-detached) old views — that's what the
 * `DownloadPanel`/`RecordUiState` enums and the `*Line` fields below are for, reapplied by
 * `restoreUiState()` (called from `bindViews()`, called from both `onCreate()` and
 * `onConfigurationChanged()`).
 */
class MainActivity : Activity() {

    private lateinit var downloadManager: ModelDownloadManager
    private lateinit var aliases: AliasTables
    private lateinit var captureWriter: CaptureWriter

    private var transcriber: ParakeetTranscriber? = null
    private var recorder: AudioRecorder? = null
    private val autoStopHandler = Handler(Looper.getMainLooper())
    // issue #161 — set right before the auto-stop path re-enters onRecordTapped(), so the stop
    // branch below can tell "the cap fired" apart from "the user tapped Stop", and a capture can
    // record which one actually happened for this recording.
    private var autoStopFiredForCurrentRecording = false
    private val autoStopRunnable = Runnable {
        autoStopFiredForCurrentRecording = true
        onRecordTapped()
    }

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

    // issue #161 — the persisted UI snapshot `restoreUiState()` reapplies after every
    // `bindViews()` call (initial creation, and again after every configuration change).
    private enum class DownloadPanel { PROMPT, DOWNLOADING, READY }
    private enum class RecordUiState { IDLE, RECORDING, TRANSCRIBING }

    private var downloadPanel = DownloadPanel.PROMPT
    private var promptInfoLine = ""
    private var downloadErrorLine: String? = null
    private var downloadPct = 0
    private var downloadProgressLine = ""

    private var recordUiState = RecordUiState.IDLE
    private var modelReady = false

    private var statusLine = ""
    private var transcriptLine = ""
    private var intentLine = ""
    private var resultLine = ""
    private var wasmResultLine = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        downloadManager = ModelDownloadManager(filesDir)
        aliases = AliasTables.load(assets)
        // Constructed once here, not in bindViews() — #162 already made this Activity instance
        // (and every plain field on it) survive rotation, so there's no reason to reopen/reload
        // the session's captures.json on every config change the way loadTranscriberInBackground()
        // must for the ASR model.
        captureWriter = CaptureWriter(this)

        val entry = ParakeetModel.ENTRY
        promptInfoLine = "${entry.displayName}\n" +
            "${formatMB(entry.totalSizeBytes)} MB from ${entry.sourceHost}"

        // Belt-and-braces beyond `configChanges` (which only covers a live rotation): a real
        // process death — backgrounded, memory reclaimed — still fully destroys and recreates
        // the Activity. `transcriber`/`recorder` can't survive that regardless (not parcelable,
        // and reloading a live recording mid-flight makes no sense), but the last visible answer
        // can, so it isn't just gone when the user switches back.
        savedInstanceState?.let {
            transcriptLine = it.getString(STATE_TRANSCRIPT, "")
            intentLine = it.getString(STATE_INTENT, "")
            resultLine = it.getString(STATE_RESULT, "")
        }

        bindViews()

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
        // issue #161 — an in-progress recording used to leak here: `AudioRecorder`'s reader
        // thread loops on its own `recording` flag, which only `stop()` ever clears, so a
        // destroy that skipped calling it left the thread — and the `AudioRecord` itself, mic
        // still hot — running forever. Discarding the returned samples is fine; with the
        // Activity gone there's no UI left to show them on anyway.
        recorder?.stop()
        recorder = null
        transcriber?.release()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(STATE_TRANSCRIPT, transcriptLine)
        outState.putString(STATE_INTENT, intentLine)
        outState.putString(STATE_RESULT, resultLine)
    }

    /**
     * issue #161 — `configChanges` in the manifest keeps this Activity instance (and therefore
     * every field above) alive across a rotation instead of destroying and recreating it; only
     * this callback fires, and only the view tree needs rebuilding.
     */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        bindViews()
    }

    /**
     * Finds every view and (re)wires every click listener, then reapplies the tracked UI state.
     * Called from `onCreate()` and again from `onConfigurationChanged()` — `setContentView()`
     * always throws away the previous view tree (and re-resolves `R.layout.main` against
     * whichever of `res/layout/` / `res/layout-land/` matches the current orientation), so this
     * has to fully re-run rather than being an onCreate-only setup step.
     */
    private fun bindViews() {
        setContentView(R.layout.main)

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

        downloadButton.setOnClickListener { startDownload() }
        cancelButton.setOnClickListener { downloadManager.cancel() }
        recordButton.setOnClickListener { onRecordTapped() }
        wasmButton.setOnClickListener { runLatencyBenchmark() }

        restoreUiState()
    }

    /** The counterpart to every `xxxLine = "..."` / `xxxPanel = ...` assignment below: reapplies
     * every tracked value to the views `bindViews()` just (re)found. */
    private fun restoreUiState() {
        when (downloadPanel) {
            DownloadPanel.PROMPT -> {
                downloadPromptPanel.visibility = View.VISIBLE
                downloadProgressPanel.visibility = View.GONE
                readyPanel.visibility = View.GONE
                modelInfoText.text = downloadErrorLine?.let { "$promptInfoLine\n\nDownload failed: $it" }
                    ?: promptInfoLine
            }
            DownloadPanel.DOWNLOADING -> {
                downloadPromptPanel.visibility = View.GONE
                downloadProgressPanel.visibility = View.VISIBLE
                readyPanel.visibility = View.GONE
                progressBar.progress = downloadPct
                progressText.text = downloadProgressLine
            }
            DownloadPanel.READY -> {
                downloadPromptPanel.visibility = View.GONE
                downloadProgressPanel.visibility = View.GONE
                readyPanel.visibility = View.VISIBLE
            }
        }

        statusText.text = statusLine
        when (recordUiState) {
            RecordUiState.IDLE -> {
                setRecordButtonIdle()
                // setRecordButtonIdle() always enables the button (correct for its other two call
                // sites — model-load-complete, transcription-complete); restoring mid-load (model
                // requested but not ready yet) must not enable it just because it's visually idle.
                recordButton.isEnabled = modelReady
            }
            RecordUiState.RECORDING -> setRecordButtonRecording()
            RecordUiState.TRANSCRIBING -> setRecordButtonTranscribing()
        }
        transcriptText.text = transcriptLine
        intentText.text = intentLine
        resultText.text = resultLine
        wasmResultText.text = wasmResultLine
    }

    private fun refreshState() {
        val entry = ParakeetModel.ENTRY
        downloadPanel = if (downloadManager.isDownloaded(entry)) DownloadPanel.READY else DownloadPanel.PROMPT
        restoreUiState()
        if (downloadPanel == DownloadPanel.READY && transcriber == null) loadTranscriberInBackground(entry)
    }

    private fun loadTranscriberInBackground(entry: ModelEntry) {
        statusLine = "Loading recognizer…"
        statusText.text = statusLine
        recordButton.isEnabled = false
        Thread {
            val modelDir = File(filesDir, entry.destDirName)
            val loaded = ParakeetTranscriber(modelDir)
            runOnUiThread {
                transcriber = loaded
                modelReady = true
                statusLine = "Model ready"
                statusText.text = statusLine
                setRecordButtonIdle()
            }
        }.start()
    }

    // ---- goal 1: download ----

    private fun startDownload() {
        downloadPanel = DownloadPanel.DOWNLOADING
        // A retry after a prior failure must not carry that failure's message forward — left
        // uncleared, it would reappear later on any unrelated return to the PROMPT panel (e.g.
        // this download succeeds, then the model is deleted via ModelManagerActivity) even though
        // that state has nothing to do with the old failure.
        downloadErrorLine = null
        downloadPct = 0
        downloadProgressLine = "Starting…"
        restoreUiState()

        Thread {
            try {
                downloadManager.download(ParakeetModel.ENTRY) { progress ->
                    runOnUiThread {
                        val pct = if (progress.totalBytes > 0) {
                            (progress.loadedBytes * 100 / progress.totalBytes).toInt()
                        } else {
                            0
                        }
                        downloadPct = pct
                        downloadProgressLine = "${formatMB(progress.loadedBytes)} / " +
                            "${formatMB(progress.totalBytes)} MB ($pct%) — ${progress.fileName}"
                        progressBar.progress = downloadPct
                        progressText.text = downloadProgressLine
                    }
                }
                runOnUiThread { refreshState() }
            } catch (e: DownloadCancelledException) {
                downloadManager.delete(ParakeetModel.ENTRY)
                runOnUiThread { refreshState() }
            } catch (e: Exception) {
                downloadManager.delete(ParakeetModel.ENTRY)
                runOnUiThread {
                    downloadPanel = DownloadPanel.PROMPT
                    // e.message can be null (some exception types carry none) — restoreUiState()
                    // treats a null downloadErrorLine as "no error", which would silently drop the
                    // failure notice entirely instead of just losing detail.
                    downloadErrorLine = e.message ?: e.toString()
                    restoreUiState()
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
            autoStopFiredForCurrentRecording = false
            recordUiState = RecordUiState.RECORDING
            setRecordButtonRecording()
            transcriptLine = ""
            intentLine = ""
            resultLine = ""
            transcriptText.text = ""
            intentText.text = ""
            resultText.text = ""
            // issue #143 — sherpa-onnx's non-streaming OfflineRecognizer is built for short
            // clips; a recording left running for minutes (observed during #136's on-device
            // testing, from a missed Stop tap) came back with a silently empty transcript rather
            // than a partial/garbled one. Auto-stop instead of leaving that failure mode open —
            // this fires `onRecordTapped()` again exactly as if the user had tapped Stop, so it
            // goes through the identical stop -> transcribe -> match -> compute -> display path.
            // issue #161: this `Handler`/`Runnable` pair is a plain instance field, unaffected by
            // `configChanges` no longer destroying the Activity on rotation — no re-arming logic
            // needed, it simply keeps running.
            autoStopHandler.postDelayed(autoStopRunnable, MAX_RECORDING_MS)
        } else {
            autoStopHandler.removeCallbacks(autoStopRunnable)
            recordUiState = RecordUiState.TRANSCRIBING
            setRecordButtonTranscribing()
            val samples = currentRecorder.stop()
            recorder = null
            processRecordingInBackground(samples, autoStopFiredForCurrentRecording)
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

    /**
     * issue #161 — same transcribe -> match -> compute -> display pipeline as before, now also
     * timed per stage, exception-attributed per stage (an uncaught exception here used to crash
     * the whole app on a single bad query; each stage below is now caught and recorded instead),
     * and written out as a field capture at the end. There is no dedicated capture UI yet (see
     * `CaptureWriter`'s own doc comment) — every query is captured automatically for now, purely
     * to exercise the data layer end to end.
     */
    private fun processRecordingInBackground(samples: ShortArray, autoStopFired: Boolean) {
        Thread {
            val captureId = captureWriter.newCaptureId()
            val capturedAtEpochMs = System.currentTimeMillis()
            var failure: JSONObject? = null

            val transcribeStartNs = System.nanoTime()
            val transcript = try {
                val floats = ParakeetTranscriber.shortsToFloats(samples)
                transcriber?.transcribe(floats) ?: ""
            } catch (e: Exception) {
                failure = CaptureEnvelope.buildFailureBlock("transcribe", e)
                ""
            }
            val transcribeMs = (System.nanoTime() - transcribeStartNs) / 1_000_000.0

            val matchStartNs = System.nanoTime()
            val trace: MatcherTrace? = if (transcript.isBlank() || failure != null) {
                null
            } else {
                try {
                    KotlinMatcher.matchWithTrace(transcript, aliases)
                } catch (e: Exception) {
                    failure = CaptureEnvelope.buildFailureBlock("match", e)
                    null
                }
            }
            val matchMs = (System.nanoTime() - matchStartNs) / 1_000_000.0
            val matched = trace?.intent

            // issue #143 — distinguish "heard nothing at all" from "heard something but couldn't
            // match it" instead of both silently reading as the same "No match" — the ambiguity
            // is exactly what made the long-recording empty-transcript failure mode confusing to
            // diagnose on-device (see the auto-stop cap above and docs/android-full-app-spike.md).
            var matchedIntentSummary = if (transcript.isBlank()) "No speech detected — try again" else "No match"
            var matchedResultText = ""
            var computeJson: JSONObject? = null
            val computeStartNs = System.nanoTime()
            if (matched != null) {
                matchedIntentSummary = "${matched.quantity} | particle=${matched.particleMatch} " +
                    "(id=${matched.particleId}) | material=${matched.materialMatch} " +
                    "(id=${matched.materialId}) | energy=${matched.energy.value} ${matched.energy.unit}"
                try {
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
                    matchedResultText = AnswerFormatter.format(matched, stp, csda, density)
                    computeJson = JSONObject().apply {
                        put("energyMevPerNucl", energyMevPerNucl)
                        put("densityGramPerCm3", density?.toDouble() ?: JSONObject.NULL)
                        put("stoppingPowerMevCm2PerG", stp?.toDouble() ?: JSONObject.NULL)
                        put("csdaRangeGramPerCm2", csda ?: JSONObject.NULL)
                        put("formattedAnswer", matchedResultText)
                    }
                } catch (e: Exception) {
                    failure = CaptureEnvelope.buildFailureBlock("compute", e)
                    matchedResultText = "Couldn't compute an answer: ${e.message}"
                }
            }
            val computeMs = (System.nanoTime() - computeStartNs) / 1_000_000.0

            // Best-effort: a capture-writing problem must never crash the app or block showing the
            // answer the user is actually waiting on.
            try {
                val nluBlock = trace?.let { CaptureEnvelope.buildNluBlock(it) } ?: JSONObject().apply {
                    put("rawTranscript", transcript)
                    put("correctedTranscript", transcript)
                    put("firedCorrectionRules", JSONArray())
                    put("matched", false)
                    put("intent", JSONObject.NULL)
                    put("resolvedIds", JSONObject.NULL)
                }
                val envelope = CaptureEnvelope.build(
                    captureId = captureId,
                    capturedAtEpochMs = capturedAtEpochMs,
                    device = DeviceInfo.collect(this),
                    build = DeviceInfo.collectBuildInfo(),
                    audio = CaptureEnvelope.buildAudioBlock(
                        sampleRateHz = AudioRecorder.SAMPLE_RATE,
                        sampleCount = samples.size,
                        metrics = AudioMetrics.analyze(samples, AudioRecorder.SAMPLE_RATE),
                        autoStopFired = autoStopFired,
                    ),
                    asr = JSONObject().apply {
                        put("modelId", ParakeetModel.ENTRY.id)
                        put("numThreads", transcriber?.numThreads ?: JSONObject.NULL)
                        put("decodingMethod", transcriber?.decodingMethod ?: JSONObject.NULL)
                    },
                    nlu = nluBlock,
                    compute = computeJson,
                    timingsMs = JSONObject().apply {
                        put("transcribe", transcribeMs)
                        put("match", matchMs)
                        put("compute", computeMs)
                    },
                    failure = failure,
                )
                captureWriter.write(envelope, samples, AudioRecorder.SAMPLE_RATE)
            } catch (e: Exception) {
                android.util.Log.w("CaptureWriter", "Failed to write capture", e)
            }

            runOnUiThread {
                recordUiState = RecordUiState.IDLE
                transcriptLine = transcript
                intentLine = matchedIntentSummary
                resultLine = matchedResultText
                transcriptText.text = transcriptLine
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
                wasmResultLine = "B (JNI): ${"%.3f".format(bAvgMs)} ms/call | " +
                    "A cold (wasm3): ${"%.3f".format(coldAvgMs)} ms/call | " +
                    "A warm (wasm3): ${"%.3f".format(warmAvgMs)} ms/call"
                wasmResultText.text = wasmResultLine
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

        private const val STATE_TRANSCRIPT = "transcript"
        private const val STATE_INTENT = "intent"
        private const val STATE_RESULT = "result"
    }
}
