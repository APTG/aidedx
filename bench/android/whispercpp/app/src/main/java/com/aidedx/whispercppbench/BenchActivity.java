package com.aidedx.whispercppbench;

import android.app.Activity;
import android.os.Bundle;
import android.text.method.ScrollingMovementMethod;
import android.widget.Button;
import android.widget.TextView;

import com.whispercpp.java.whisper.WhisperContext;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Not a product UI (issue #120's non-goal) - mirrors the other three benches
 * (bench/android/{vosk,sherpa-onnx,wav2vec2}): file-based recognition over every WAV pushed under
 * filesDir/audio/&lt;speaker&gt;/&lt;id&gt;.wav against a ggml whisper-small model, writing the
 * same results JSON contract scripts/asr-transcribe.mjs produces.
 *
 * Uses the JNI bridge vendored from whisper.cpp's own examples/whisper.android.java (issue #120's
 * "JNI already written" candidate) - see app/src/main/java/com/whispercpp/java/whisper/ and
 * app/src/main/jni/whisper/. WAV parsing uses the same RIFF chunk scanner the wav2vec2 bench
 * needed (docs/android-asr-runtime-bench.md S4.1) - a blind 44-byte header skip is wrong for these
 * resampled clips.
 */
public class BenchActivity extends Activity {

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
        appendLog("system info: " + WhisperContext.getSystemInfo());
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
        if (modelFile == null) modelFile = "ggml-small-q8_0.bin";
        String outName = getIntent().getStringExtra("out_name");
        if (outName == null) outName = "results.json";
        String modelId = getIntent().getStringExtra("model_id");
        if (modelId == null) modelId = "whisper.cpp-" + modelFile;

        File base = getFilesDir();
        File modelPath = new File(base, modelFile);
        File audioBase = new File(base, "audio");
        File outFile = new File(base, outName);

        appendLog("model: " + modelPath);
        appendLog("audio: " + audioBase);

        long loadStart = System.nanoTime();
        WhisperContext ctx;
        try {
            ctx = WhisperContext.createContextFromFile(modelPath.getAbsolutePath());
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
                    float[] samples = readWavAsFloats(wav);
                    raw = ctx.transcribeData(samples).trim();
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
            ctx.release();
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

    /** Locates the "data" chunk by scanning RIFF sub-chunks instead of assuming a fixed 44-byte
     * header - ffmpeg's pcm_s16le output embeds a LIST/INFO chunk pushing the real payload to
     * byte 78 for these clips (found and fixed in the wav2vec2 bench, same fix reused here). */
    private static int findDataChunkOffset(byte[] bytes) {
        ByteBuffer header = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        int pos = 12;
        while (pos + 8 <= bytes.length) {
            int id = header.getInt(pos);
            int size = header.getInt(pos + 4);
            if (id == 0x61746164) { // "data" little-endian
                return pos + 8;
            }
            pos += 8 + size + (size % 2);
        }
        throw new IllegalStateException("no \"data\" chunk found in " + bytes.length + " byte WAV");
    }

    /** WAV data chunk -> 16-bit PCM mono samples -> float [-1,1], the plain PCM float format
     * whisper.cpp's fullTranscribe() expects (no additional normalization, unlike wav2vec2's
     * zero-mean/unit-variance step). */
    private static float[] readWavAsFloats(File wav) throws IOException {
        byte[] bytes;
        try (InputStream in = new FileInputStream(wav)) {
            bytes = in.readAllBytes();
        }
        int dataOffset = findDataChunkOffset(bytes);
        ByteBuffer buf = ByteBuffer.wrap(bytes, dataOffset, bytes.length - dataOffset).order(ByteOrder.LITTLE_ENDIAN);
        int n = (bytes.length - dataOffset) / 2;
        float[] samples = new float[n];
        for (int i = 0; i < n; i++) {
            samples[i] = buf.getShort() / 32768.0f;
        }
        return samples;
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
