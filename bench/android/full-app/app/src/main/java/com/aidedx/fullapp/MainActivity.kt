package com.aidedx.fullapp

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import android.widget.Toolbar
import com.aidedx.fullapp.asr.ParakeetTranscriber
import com.aidedx.fullapp.audio.AudioRecorder
import com.aidedx.fullapp.capture.AudioMetrics
import com.aidedx.fullapp.capture.CaptureEnvelope
import com.aidedx.fullapp.capture.CapturePrefs
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
 *
 * Field-capture UI (also #161): `CapturePrefs.captureEverything` (default off) decides whether a
 * query is captured automatically; either way, the result row's Save/Details buttons let a person
 * keep — or annotate — the one they just heard. `CaptureManagerActivity` ("Debug captures", off
 * the toolbar overflow) is where that toggle, the session tag, and the capture list itself live.
 */
class MainActivity : Activity() {

    private lateinit var downloadManager: ModelDownloadManager
    private lateinit var aliases: AliasTables
    private lateinit var capturePrefs: CapturePrefs
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
    private val captureUndoHandler = Handler(Looper.getMainLooper())
    private var captureUndoRunnable: Runnable? = null

    private lateinit var downloadPromptPanel: View
    private lateinit var downloadProgressPanel: View
    private lateinit var readyPanel: View
    private lateinit var modelInfoText: TextView
    private lateinit var downloadButton: Button
    private lateinit var progressBar: ProgressBar
    private lateinit var progressText: TextView
    private lateinit var cancelButton: Button
    private lateinit var statusText: TextView
    private lateinit var captureIndicatorText: TextView
    private lateinit var recordButton: Button
    private lateinit var recordProgressBar: ProgressBar
    private lateinit var transcriptText: TextView
    private lateinit var intentText: TextView
    private lateinit var resultText: TextView
    private lateinit var saveCaptureButton: Button
    private lateinit var captureDetailsButton: Button
    private lateinit var captureUndoButton: Button

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

    // The most recent query's not-yet-finalized capture — survives rotation like everything else
    // tracked here. `pendingCaptureSamples` is only kept in memory while the capture *isn't* on
    // disk yet (captureEverything off); once written, the raw PCM is dropped and Save/Flag act via
    // `captureWriter.updateAnnotation()` instead of a second write.
    private var pendingCaptureId: String? = null
    private var pendingCaptureEnvelope: JSONObject? = null
    private var pendingCaptureSamples: ShortArray? = null
    private var pendingCaptureWrittenToDisk = false
    private var pendingCaptureUserActed = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        downloadManager = ModelDownloadManager(filesDir)
        aliases = AliasTables.load(assets)
        capturePrefs = CapturePrefs(this)
        // Constructed once here, not in bindViews() — #162 already made this Activity instance
        // survive rotation, so there's no reason to reopen/reload captures.json on every config
        // change the way loadTranscriberInBackground() must for the ASR model. onResume() rebuilds
        // it (cheap) to pick up a session-tag change made on the Debug Captures screen.
        captureWriter = CaptureWriter(this, capturePrefs.sessionTag)

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
        // Cheap (a small mkdirs + JSON read), and the only way this Activity — which #162 already
        // keeps alive across a rotation, and which never gets destroyed just by navigating to
        // CaptureManagerActivity and back — finds out about a session-tag change or a Delete All
        // that happened on that other screen while this one was paused.
        captureWriter = CaptureWriter(this, capturePrefs.sessionTag)
        refreshState()
    }

    override fun onDestroy() {
        super.onDestroy()
        autoStopHandler.removeCallbacks(autoStopRunnable)
        captureUndoHandler.removeCallbacksAndMessages(null)
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
            when (item.itemId) {
                R.id.action_manage_downloads -> {
                    startActivity(Intent(this, ModelManagerActivity::class.java))
                    true
                }
                R.id.action_debug_captures -> {
                    startActivity(Intent(this, CaptureManagerActivity::class.java))
                    true
                }
                R.id.action_latency_benchmark -> {
                    runLatencyBenchmark()
                    true
                }
                else -> false
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
        captureIndicatorText = findViewById(R.id.captureIndicatorText)
        recordButton = findViewById(R.id.recordButton)
        recordProgressBar = findViewById(R.id.recordProgressBar)
        transcriptText = findViewById(R.id.transcriptText)
        intentText = findViewById(R.id.intentText)
        resultText = findViewById(R.id.resultText)
        saveCaptureButton = findViewById(R.id.saveCaptureButton)
        captureDetailsButton = findViewById(R.id.captureDetailsButton)
        captureUndoButton = findViewById(R.id.captureUndoButton)

        downloadButton.setOnClickListener { startDownload() }
        cancelButton.setOnClickListener { downloadManager.cancel() }
        recordButton.setOnClickListener { onRecordTapped() }
        saveCaptureButton.setOnClickListener { onSaveCaptureTapped() }
        captureDetailsButton.setOnClickListener { showCaptureAnnotateDialog() }
        captureUndoButton.setOnClickListener { onUndoCaptureTapped() }

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

        restoreCaptureButtonsState()
    }

    /** issue #161 — the toolbar's "capture everything is on" flag, and the result row's
     * Save/Details buttons for whatever `pendingCapture*` state the last query left behind. Split
     * out of `restoreUiState()` only because it's the one piece with its own non-trivial branch
     * (written-to-disk vs. not) rather than a flat field-to-view copy. */
    private fun restoreCaptureButtonsState() {
        if (capturePrefs.captureEverything) {
            captureIndicatorText.visibility = View.VISIBLE
            captureIndicatorText.text = "⚑ ${captureWriter.captureCount}"
        } else {
            captureIndicatorText.visibility = View.GONE
        }

        if (pendingCaptureId == null || pendingCaptureUserActed) {
            saveCaptureButton.visibility = View.GONE
            captureDetailsButton.visibility = View.GONE
        } else {
            saveCaptureButton.visibility = View.VISIBLE
            captureDetailsButton.visibility = View.VISIBLE
            saveCaptureButton.text = if (pendingCaptureWrittenToDisk) "⚑ Flag this one" else "⚑ Save capture"
        }
        // The Undo grace-period button is driven by captureUndoHandler's delayed hide, not by
        // this restore pass — a rotation landing mid-grace-period just loses the Undo offer a
        // little early, an acceptable simplification rather than resurrecting a countdown.
        captureUndoButton.visibility = View.GONE
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
            // A fresh recording retires whatever the previous query's capture buttons were
            // offering — there's a new query now, and its own capture (if any) starts clean.
            captureUndoRunnable?.let { captureUndoHandler.removeCallbacks(it) }
            pendingCaptureId = null
            pendingCaptureEnvelope = null
            pendingCaptureSamples = null
            pendingCaptureWrittenToDisk = false
            pendingCaptureUserActed = false
            restoreCaptureButtonsState()
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
     * issue #161 — same transcribe -> match -> compute -> display pipeline as before, timed per
     * stage and exception-attributed per stage (an uncaught exception here used to crash the
     * whole app on a single bad query; each stage below is now caught and recorded instead).
     * Whether the resulting capture is written immediately is `capturePrefs.captureEverything`;
     * either way it's kept in `pendingCapture*` so the result row's Save/Flag/Details buttons
     * (wired in `bindViews()`) have something to act on.
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
            // A transcribe/match-stage exception must not fall into either bucket, though — it
            // used to read as "No speech detected", which is actively misleading about what
            // actually happened (issue #161 review feedback).
            var matchedIntentSummary = when {
                failure != null -> {
                    val stage = failure.getString("stage")
                    val detail = if (failure.isNull("message")) failure.getString("exceptionType") else failure.getString("message")
                    "Error during $stage: $detail"
                }
                transcript.isBlank() -> "No speech detected — try again"
                else -> "No match"
            }
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
            val autoCapture = capturePrefs.captureEverything

            runOnUiThread {
                recordUiState = RecordUiState.IDLE
                transcriptLine = transcript
                intentLine = matchedIntentSummary
                resultLine = matchedResultText
                transcriptText.text = transcriptLine
                intentText.text = intentLine
                resultText.text = resultLine
                setRecordButtonIdle()

                pendingCaptureId = captureId
                pendingCaptureEnvelope = envelope
                pendingCaptureSamples = if (autoCapture) null else samples
                pendingCaptureWrittenToDisk = autoCapture
                pendingCaptureUserActed = false
                restoreCaptureButtonsState()
            }

            // Posted after the UI update above (issue #161 review feedback) — WAV + JSON disk I/O
            // must never delay the answer the user is actually waiting on. Still on this same
            // background Thread, so it costs nothing to do it last; best-effort otherwise, a
            // capture-writing problem must never crash the app either. Only "Capture everything"
            // writes unconditionally here — with it off, this capture stays in-memory
            // (`pendingCapture*` above) until/unless a person taps Save/Flag/Details.
            if (autoCapture) {
                try {
                    captureWriter.write(envelope, samples, AudioRecorder.SAMPLE_RATE)
                } catch (e: Exception) {
                    android.util.Log.w("CaptureWriter", "Failed to write capture", e)
                }
                // The toolbar's "⚑ N" count would otherwise stay one behind until some later,
                // unrelated UI refresh — the write above only finishes after the main UI update
                // was already posted, by design (the comment above this block).
                runOnUiThread {
                    if (pendingCaptureId == captureId) restoreCaptureButtonsState()
                }
            }
        }.start()
    }

    // ---- field-capture Save / Flag / Details / Undo ----

    private fun onSaveCaptureTapped() {
        val captureId = pendingCaptureId ?: return
        commitCapture(captureId, CaptureEnvelope.manualAnnotation(verdict = null, note = null))
    }

    /** issue #161 — the "⌄ details" dialog: single-select verdict chips + an optional free-text
     * note. "Skip" commits with no annotation detail (same as tapping Save directly); "Save"
     * commits with whatever was picked/typed. Either button is a valid, independent way to
     * finalize this capture — this dialog doesn't require the quick Save button to have run first. */
    private fun showCaptureAnnotateDialog() {
        val captureId = pendingCaptureId ?: return
        val view = layoutInflater.inflate(R.layout.capture_annotate_dialog, null)
        val noteInput = view.findViewById<EditText>(R.id.captureNoteInput)
        val chips = linkedMapOf(
            "asr" to view.findViewById<Button>(R.id.verdictAsr),
            "intent" to view.findViewById<Button>(R.id.verdictIntent),
            "number" to view.findViewById<Button>(R.id.verdictNumber),
            "slow" to view.findViewById<Button>(R.id.verdictSlow),
            "other" to view.findViewById<Button>(R.id.verdictOther),
        )
        var selectedVerdict: String? = null
        fun applyChipStyle() {
            for ((key, button) in chips) {
                val selected = key == selectedVerdict
                button.setBackgroundResource(if (selected) R.drawable.bg_button_accent else R.drawable.bg_button_outline)
                button.setTextColor(
                    ContextCompat.getColor(this, if (selected) R.color.accent_foreground else R.color.foreground),
                )
            }
        }
        for ((key, button) in chips) {
            button.setOnClickListener {
                selectedVerdict = if (selectedVerdict == key) null else key
                applyChipStyle()
            }
        }

        AlertDialog.Builder(this)
            .setTitle("Save capture")
            .setView(view)
            .setNegativeButton("Skip") { _, _ ->
                commitCapture(captureId, CaptureEnvelope.manualAnnotation(null, null))
            }
            .setPositiveButton("Save") { _, _ ->
                val note = noteInput.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }
                commitCapture(captureId, CaptureEnvelope.manualAnnotation(selectedVerdict, note))
            }
            .show()
    }

    /** Writes (if not already on disk) or patches (if "Capture everything" already wrote it) the
     * annotation for `captureId`, off the main thread — same "disk I/O must not stall the UI"
     * reasoning as `processRecordingInBackground()`'s own write. */
    private fun commitCapture(captureId: String, annotation: JSONObject) {
        val alreadyWritten = pendingCaptureWrittenToDisk
        val envelope = pendingCaptureEnvelope
        val samples = pendingCaptureSamples
        Thread {
            try {
                if (alreadyWritten) {
                    captureWriter.updateAnnotation(captureId, annotation)
                } else if (envelope != null && samples != null) {
                    envelope.put("annotation", annotation)
                    captureWriter.write(envelope, samples, AudioRecorder.SAMPLE_RATE)
                }
            } catch (e: Exception) {
                android.util.Log.w("CaptureWriter", "Failed to save/flag capture", e)
            }
            runOnUiThread {
                // Only apply if this is still the query the user was looking at — a new recording
                // started (and reset pendingCaptureId) while this write was in flight otherwise.
                if (pendingCaptureId == captureId) {
                    pendingCaptureWrittenToDisk = true
                    pendingCaptureUserActed = true
                    restoreCaptureButtonsState()
                    Toast.makeText(this, "Capture saved", Toast.LENGTH_SHORT).show()
                    showUndoAffordance()
                }
            }
        }.start()
    }

    private fun showUndoAffordance() {
        captureUndoRunnable?.let { captureUndoHandler.removeCallbacks(it) }
        captureUndoButton.visibility = View.VISIBLE
        val runnable = Runnable { captureUndoButton.visibility = View.GONE }
        captureUndoRunnable = runnable
        captureUndoHandler.postDelayed(runnable, UNDO_WINDOW_MS)
    }

    /** Removes the whole capture just Saved/Flagged, not just its annotation — "Undo" reads as "I
     * didn't mean to keep this one", not "keep the recording but un-flag it" (same simplification
     * `CaptureWriter.deleteCapture()`'s own doc comment states). */
    private fun onUndoCaptureTapped() {
        val captureId = pendingCaptureId ?: return
        captureUndoRunnable?.let { captureUndoHandler.removeCallbacks(it) }
        captureUndoButton.visibility = View.GONE
        Thread {
            try {
                captureWriter.deleteCapture(captureId)
            } catch (e: Exception) {
                android.util.Log.w("CaptureWriter", "Failed to undo capture", e)
            }
            runOnUiThread {
                if (pendingCaptureId == captureId) {
                    Toast.makeText(this, "Capture removed", Toast.LENGTH_SHORT).show()
                }
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

            val resultText = "B (JNI): ${"%.3f".format(bAvgMs)} ms/call\n" +
                "A cold (wasm3): ${"%.3f".format(coldAvgMs)} ms/call\n" +
                "A warm (wasm3): ${"%.3f".format(warmAvgMs)} ms/call"
            // issue #161 — used to persist to an always-visible TextView on the main screen;
            // moved into the toolbar overflow (this is one-off dev/spike tooling, issue #136/#143
            // goal 3, not a product feature), so the result is now a one-shot dialog instead.
            runOnUiThread {
                AlertDialog.Builder(this)
                    .setTitle("Latency benchmark")
                    .setMessage(resultText)
                    .setPositiveButton("OK", null)
                    .show()
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

        // issue #161 — how long the result row's "Undo" stays available after a Save/Flag.
        private const val UNDO_WINDOW_MS = 6_000L

        private const val STATE_TRANSCRIPT = "transcript"
        private const val STATE_INTENT = "intent"
        private const val STATE_RESULT = "result"
    }
}
