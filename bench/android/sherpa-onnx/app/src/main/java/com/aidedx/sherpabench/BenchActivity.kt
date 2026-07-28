package com.aidedx.sherpabench

import android.app.Activity
import android.os.Bundle
import android.text.method.ScrollingMovementMethod
import android.widget.Button
import android.widget.TextView
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineWhisperModelConfig
import com.k2fsa.sherpa.onnx.WaveReader
import java.io.File
import java.io.FileWriter
import java.io.PrintWriter
import java.io.StringWriter

/**
 * Not a product UI (issue #120's non-goal) - a bare launcher activity mirroring the Vosk bench
 * (bench/android/vosk): file-based recognition over every WAV pushed under
 * filesDir/audio/&lt;speaker&gt;/&lt;id&gt;.wav against a sherpa-onnx whisper-small int8 model
 * pushed to filesDir/&lt;modelDir&gt;, writing the same results JSON contract
 * scripts/asr-transcribe.mjs produces so it drops straight into
 * scripts/e2e-audio-intents.ts / scripts/asr-score-slots.mjs unmodified.
 *
 * Uses internal storage (filesDir) from the start, not external/adb-push-then-run-as - the
 * Vosk bench discovered adb push into Android/data/<pkg>/files isn't reliably readable by the
 * app itself under scoped storage (docs/android-asr-runtime-bench.md, S1). Same trick applies:
 * push to /data/local/tmp, then `adb shell run-as <pkg> cp -r ...` into filesDir.
 */
class BenchActivity : Activity() {

    private lateinit var logText: TextView
    private val log = StringBuilder()

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        setContentView(R.layout.main)
        logText = findViewById(R.id.log_text)
        logText.movementMethod = ScrollingMovementMethod()
        val runButton = findViewById<Button>(R.id.run_button)
        runButton.setOnClickListener { Thread { runBenchmark() }.start() }
        appendLog("Ready. Tap \"Run benchmark\".")
        if (intent.getBooleanExtra("autorun", false)) {
            Thread { runBenchmark() }.start()
        }
    }

    private fun appendLog(line: String) {
        log.append(line).append('\n')
        runOnUiThread { logText.text = log.toString() }
    }

    private fun runBenchmark() {
        val modelDir = intent.getStringExtra("model_dir") ?: "model-sherpa"
        val outName = intent.getStringExtra("out_name") ?: "results.json"
        val modelId = intent.getStringExtra("model_id") ?: "sherpa-onnx-$modelDir"
        val numThreads = intent.getIntExtra("num_threads", 4)

        val base = filesDir
        val modelPath = File(base, modelDir)
        val audioBase = File(base, "audio")
        val outFile = File(base, outName)

        appendLog("model: $modelPath")
        appendLog("audio: $audioBase")

        val config = OfflineRecognizerConfig(
            featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80),
            modelConfig = OfflineModelConfig(
                whisper = OfflineWhisperModelConfig(
                    encoder = File(modelPath, "small-encoder.int8.onnx").absolutePath,
                    decoder = File(modelPath, "small-decoder.int8.onnx").absolutePath,
                    language = "en",
                    task = "transcribe",
                ),
                tokens = File(modelPath, "small-tokens.txt").absolutePath,
                modelType = "whisper",
                numThreads = numThreads,
                provider = "cpu",
            ),
        )

        val loadStart = System.nanoTime()
        val recognizer: OfflineRecognizer
        try {
            recognizer = OfflineRecognizer(config = config)
        } catch (e: Exception) {
            val sw = StringWriter()
            e.printStackTrace(PrintWriter(sw))
            appendLog("FAILED to load model: $sw")
            return
        }
        val loadS = (System.nanoTime() - loadStart) / 1e9
        appendLog("loaded in ${"%.1f".format(loadS)}s")

        val records = mutableListOf<String>()
        val speakerDirs = (audioBase.listFiles { f -> f.isDirectory } ?: arrayOf()).sortedBy { it.name }

        for (speakerDir in speakerDirs) {
            val speaker = speakerDir.name
            val wavs = (speakerDir.listFiles { _, name -> name.endsWith(".wav") } ?: arrayOf()).sorted()
            for (wav in wavs) {
                val id = wav.name.removeSuffix(".wav")
                val t0 = System.nanoTime()
                var raw = ""
                var error: String? = null
                try {
                    val waveData = WaveReader.readWave(wav.absolutePath)
                    recognizer.createStream().use { stream ->
                        stream.acceptWaveform(waveData.samples, waveData.sampleRate)
                        recognizer.decode(stream)
                        raw = recognizer.getResult(stream).text.trim()
                    }
                } catch (e: Exception) {
                    error = e.message
                }
                val secs = (System.nanoTime() - t0) / 1e9
                records.add(jsonRecord(speaker, id, raw, secs, error))
                appendLog("$speaker/$id (${"%.2f".format(secs)}s): ${error?.let { "ERROR $it" } ?: raw}")
            }
        }
        recognizer.release()

        val json = "{\n" +
            "  \"modelId\": ${jsonStr(modelId)},\n" +
            "  \"dtype\": \"device\",\n" +
            "  \"withPrompt\": false,\n" +
            "  \"loadS\": $loadS,\n" +
            "  \"records\": [\n" +
            records.joinToString(",\n") +
            "\n  ]\n" +
            "}\n"
        try {
            FileWriter(outFile).use { it.write(json) }
        } catch (e: Exception) {
            appendLog("FAILED to write results: $e")
            return
        }
        appendLog("wrote $outFile (${records.size} records)")
    }

    private fun jsonStr(s: String): String =
        "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    private fun jsonRecord(speaker: String, id: String, raw: String, secs: Double, error: String?): String =
        "    {\"speaker\": ${jsonStr(speaker)}, \"id\": ${jsonStr(id)}, " +
            "\"raw\": ${jsonStr(raw)}, \"secs\": $secs, " +
            "\"error\": ${error?.let { jsonStr(it) } ?: "null"}}"
}
