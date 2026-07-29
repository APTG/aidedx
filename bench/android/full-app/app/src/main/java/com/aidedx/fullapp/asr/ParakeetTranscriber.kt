package com.aidedx.fullapp.asr

import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineTransducerModelConfig
import java.io.File

/**
 * issue #136 goal 2 — wraps the sherpa-onnx `OfflineRecognizer` loading for NeMo Parakeet-v3 the
 * same way `DataGenActivity.loadParakeet()` (issue #130) already proved works, extracted into a
 * reusable class instead of being copy-pasted inline into an Activity. `com.k2fsa.sherpa.onnx.*`
 * sources + the .so files under `jniLibs/arm64-v8a` are vendored the same way as `bench/android/sherpa-onnx`
 * (see docs/android-asr-runtime-bench.md §3.1) — not a Maven/JitPack dependency.
 */
class ParakeetTranscriber(modelDir: File, numThreads: Int = 2) {

    private val recognizer: OfflineRecognizer

    init {
        val config = OfflineRecognizerConfig(
            featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80),
            modelConfig = OfflineModelConfig(
                transducer = OfflineTransducerModelConfig(
                    encoder = File(modelDir, "encoder.int8.onnx").absolutePath,
                    decoder = File(modelDir, "decoder.int8.onnx").absolutePath,
                    joiner = File(modelDir, "joiner.int8.onnx").absolutePath,
                ),
                tokens = File(modelDir, "tokens.txt").absolutePath,
                modelType = "nemo_transducer",
                modelingUnit = "bpe",
                bpeVocab = ensureBpeVocab(modelDir).absolutePath,
                numThreads = numThreads,
                provider = "cpu",
            ),
            decodingMethod = "greedy_search",
        )
        recognizer = OfflineRecognizer(config = config)
    }

    /** `samples` are 16 kHz mono PCM converted to [-1, 1] floats. */
    fun transcribe(samples: FloatArray): String {
        val stream = recognizer.createStream()
        stream.acceptWaveform(samples, sampleRate = 16000)
        recognizer.decode(stream)
        val text = recognizer.getResult(stream).text
        stream.release()
        return text
    }

    fun release() {
        recognizer.release()
    }

    companion object {
        fun shortsToFloats(samples: ShortArray): FloatArray =
            FloatArray(samples.size) { samples[it] / 32768.0f }

        /**
         * This model's HF release ships `tokens.txt` but no separate `bpe.vocab` — same
         * derivation as `scripts/sherpa-onnx-transcribe.mjs`'s `ensureBpeVocab()` (equal -1.0
         * scores per token) and sherpa-onnx's own nodejs-addon-examples hotwords example.
         * Derived once on first use and cached alongside the other model files.
         */
        private fun ensureBpeVocab(modelDir: File): File {
            val bpeVocab = File(modelDir, "bpe.vocab")
            if (!bpeVocab.exists()) {
                val tokens = File(modelDir, "tokens.txt").readLines()
                val vocab = tokens
                    .filter { it.isNotBlank() }
                    .joinToString("\n") { "${it.split(" ")[0]}\t-1.0" }
                bpeVocab.writeText(vocab + "\n")
            }
            return bpeVocab
        }
    }
}
