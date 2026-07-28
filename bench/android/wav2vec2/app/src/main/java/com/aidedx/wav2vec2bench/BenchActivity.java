package com.aidedx.wav2vec2bench;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;
import android.app.Activity;
import android.os.Bundle;
import android.text.method.ScrollingMovementMethod;
import android.widget.Button;
import android.widget.TextView;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Not a product UI (issue #120's non-goal) - a bare launcher activity mirroring the Vosk and
 * sherpa-onnx benches (bench/android/vosk, bench/android/sherpa-onnx): file-based recognition
 * over every WAV pushed under filesDir/audio/&lt;speaker&gt;/&lt;id&gt;.wav, writing the same
 * results JSON contract scripts/asr-transcribe.mjs produces.
 *
 * Unlike Vosk/sherpa-onnx, wav2vec2 has no Android runtime wrapper at all (issue #120's own
 * framing: "hand-write the ONNX Runtime Mobile glue"), so this benchmark implements the whole
 * pipeline by hand against plain onnxruntime-android (Maven Central, no NDK):
 * Wav2Vec2FeatureExtractor's zero-mean/unit-variance normalization (do_normalize=true in
 * .hf-cache/Xenova/wav2vec2-base-960h/preprocessor_config.json), a single encoder forward pass
 * (CTC head, no autoregressive decode loop unlike Whisper), and greedy CTC decoding against the
 * 32-token vocab in tokenizer.json (blank=0, word-delimiter "|"=4=space).
 */
public class BenchActivity extends Activity {

    // tokenizer.json's model.vocab, ids 4..31 (0-3 are pad/bos/eos/unk, handled separately in
    // decode()) - see .hf-cache/Xenova/wav2vec2-base-960h/tokenizer.json
    private static final String[] VOCAB = {
            "|", "E", "T", "A", "O", "N", "I", "H", "S", "R", "D", "L", "U", "M", "W", "C",
            "F", "G", "Y", "P", "B", "V", "K", "'", "X", "J", "Q", "Z"
    };
    private static final int VOCAB_OFFSET = 4;
    private static final int BLANK_ID = 0;

    private TextView logText;
    private final StringBuilder log = new StringBuilder();

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.main);
        logText = findViewById(R.id.log_text);
        logText.setMovementMethod(new ScrollingMovementMethod());
        Button runButton = findViewById(R.id.run_button);
        runButton.setOnClickListener(v -> new Thread(this::runBenchmark).start());
        appendLog("Ready. Tap \"Run benchmark\".");
        if (getIntent().getBooleanExtra("autorun", false)) {
            new Thread(this::runBenchmark).start();
        }
    }

    private void appendLog(String line) {
        log.append(line).append('\n');
        runOnUiThread(() -> logText.setText(log.toString()));
    }

    private void runBenchmark() {
        String modelFile = getIntent().getStringExtra("model_file");
        if (modelFile == null) modelFile = "model_quantized.onnx";
        String outName = getIntent().getStringExtra("out_name");
        if (outName == null) outName = "results.json";
        String modelId = getIntent().getStringExtra("model_id");
        if (modelId == null) modelId = "wav2vec2-base-960h";

        File base = getFilesDir();
        File modelPath = new File(base, modelFile);
        File audioBase = new File(base, "audio");
        File outFile = new File(base, outName);

        appendLog("model: " + modelPath);
        appendLog("audio: " + audioBase);

        OrtEnvironment env = OrtEnvironment.getEnvironment();
        OrtSession session;
        long loadStart = System.nanoTime();
        try {
            session = env.createSession(modelPath.getAbsolutePath(), new OrtSession.SessionOptions());
        } catch (Exception e) {
            StringWriter sw = new StringWriter();
            e.printStackTrace(new PrintWriter(sw));
            appendLog("FAILED to load model: " + sw);
            return;
        }
        double loadS = (System.nanoTime() - loadStart) / 1e9;
        appendLog(String.format("loaded in %.1fs", loadS));

        List<String> records = new ArrayList<>();
        File[] speakerDirs = audioBase.listFiles(File::isDirectory);
        if (speakerDirs == null) speakerDirs = new File[0];
        Arrays.sort(speakerDirs);

        for (File speakerDir : speakerDirs) {
            String speaker = speakerDir.getName();
            File[] wavs = speakerDir.listFiles((d, name) -> name.endsWith(".wav"));
            if (wavs == null) continue;
            Arrays.sort(wavs);
            for (File wav : wavs) {
                String id = wav.getName().substring(0, wav.getName().length() - 4);
                long t0 = System.nanoTime();
                String raw = "";
                String error = null;
                try {
                    raw = recognizeFile(env, session, wav);
                } catch (Exception e) {
                    error = String.valueOf(e.getMessage());
                }
                double secs = (System.nanoTime() - t0) / 1e9;
                records.add(jsonRecord(speaker, id, raw, secs, error));
                appendLog(String.format("%s/%s (%.2fs): %s", speaker, id,
                        secs, error != null ? "ERROR " + error : raw));
            }
        }
        try {
            session.close();
        } catch (Exception ignored) {
        }

        String json = "{\n"
                + "  \"modelId\": " + jsonStr(modelId) + ",\n"
                + "  \"dtype\": \"device\",\n"
                + "  \"withPrompt\": false,\n"
                + "  \"loadS\": " + loadS + ",\n"
                + "  \"records\": [\n"
                + String.join(",\n", records)
                + "\n  ]\n"
                + "}\n";
        try (FileWriter w = new FileWriter(outFile)) {
            w.write(json);
        } catch (Exception e) {
            appendLog("FAILED to write results: " + e);
            return;
        }
        appendLog("wrote " + outFile + " (" + records.size() + " records)");
    }

    private String recognizeFile(OrtEnvironment env, OrtSession session, File wav) throws Exception {
        float[] samples = readWavAsNormalizedFloats(wav);
        long[] shape = {1, samples.length};
        try (OnnxTensor input = OnnxTensor.createTensor(env, FloatBuffer.wrap(samples), shape)) {
            Map<String, OnnxTensor> inputs = Collections.singletonMap("input_values", input);
            try (OrtSession.Result result = session.run(inputs)) {
                float[][][] logits = (float[][][]) result.get(0).getValue();
                return ctcGreedyDecode(logits[0]);
            }
        }
    }

    /** Locates the "data" chunk by scanning the RIFF chunk list (offset 12 onward) instead of
     * assuming a fixed 44-byte canonical header - ffmpeg's pcm_s16le output embeds a LIST/INFO
     * chunk (a "Lavf..." software tag) between "fmt " and "data", pushing the real PCM payload
     * to byte 78 for these clips. A blind 44-byte skip silently reads the tail of that metadata
     * as audio, corrupting the start of every clip. */
    private static int findDataChunkOffset(byte[] bytes) {
        ByteBuffer header = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        int pos = 12; // past "RIFF" + size (4) + "WAVE" (4)
        while (pos + 8 <= bytes.length) {
            int id = header.getInt(pos);
            int size = header.getInt(pos + 4);
            if (id == 0x61746164) { // "data" little-endian
                return pos + 8;
            }
            pos += 8 + size + (size % 2); // chunks are padded to an even byte count
        }
        throw new IllegalStateException("no \"data\" chunk found in " + bytes.length + " byte WAV");
    }

    /** WAV data chunk -> 16-bit PCM mono samples -> float [-1,1] -> zero-mean/unit-variance
     * normalization, matching Wav2Vec2FeatureExtractor's do_normalize=true behavior (population
     * variance, epsilon 1e-7) - see preprocessor_config.json in the cached HF model. */
    private static float[] readWavAsNormalizedFloats(File wav) throws IOException {
        byte[] bytes;
        try (InputStream in = new FileInputStream(wav)) {
            bytes = in.readAllBytes();
        }
        int dataOffset = findDataChunkOffset(bytes);
        ByteBuffer buf = ByteBuffer.wrap(bytes, dataOffset, bytes.length - dataOffset).order(ByteOrder.LITTLE_ENDIAN);
        int n = (bytes.length - dataOffset) / 2;
        float[] samples = new float[n];
        double sum = 0;
        for (int i = 0; i < n; i++) {
            float s = buf.getShort() / 32768.0f;
            samples[i] = s;
            sum += s;
        }
        double mean = sum / n;
        double varSum = 0;
        for (float s : samples) {
            double d = s - mean;
            varSum += d * d;
        }
        double std = Math.sqrt(varSum / n + 1e-7);
        for (int i = 0; i < n; i++) {
            samples[i] = (float) ((samples[i] - mean) / std);
        }
        return samples;
    }

    /** Greedy CTC: argmax per frame, collapse consecutive duplicate ids, drop the blank (0) and
     * bos/eos/unk (1-3) ids, map the rest through VOCAB, "|" (word delimiter) -> space. */
    private static String ctcGreedyDecode(float[][] logits) {
        StringBuilder sb = new StringBuilder();
        int prev = -1;
        for (float[] frame : logits) {
            int argmax = 0;
            float best = frame[0];
            for (int k = 1; k < frame.length; k++) {
                if (frame[k] > best) {
                    best = frame[k];
                    argmax = k;
                }
            }
            if (argmax != prev) {
                if (argmax >= VOCAB_OFFSET && argmax - VOCAB_OFFSET < VOCAB.length) {
                    String tok = VOCAB[argmax - VOCAB_OFFSET];
                    sb.append(tok.equals("|") ? " " : tok);
                }
                // ids 0 (blank), 1 (<s>), 2 (</s>), 3 (<unk>) are non-emitting for this decode
            }
            prev = argmax;
        }
        return sb.toString().trim();
    }

    private static String jsonStr(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    private static String jsonRecord(String speaker, String id, String raw, double secs, String error) {
        return "    {\"speaker\": " + jsonStr(speaker) + ", \"id\": " + jsonStr(id)
                + ", \"raw\": " + jsonStr(raw) + ", \"secs\": " + secs
                + ", \"error\": " + (error == null ? "null" : jsonStr(error)) + "}";
    }
}
