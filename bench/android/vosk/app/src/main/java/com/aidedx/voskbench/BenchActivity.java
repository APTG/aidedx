package com.aidedx.voskbench;

import android.app.Activity;
import android.os.Bundle;
import android.text.method.ScrollingMovementMethod;
import android.widget.Button;
import android.widget.TextView;

import org.vosk.LibVosk;
import org.vosk.LogLevel;
import org.vosk.Model;
import org.vosk.Recognizer;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileWriter;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Not a product UI (issue #120's non-goal) - a bare launcher activity that runs Vosk
 * file-based recognition over every WAV pushed under
 * getExternalFilesDir(null)/audio/&lt;speaker&gt;/&lt;id&gt;.wav against a model pushed to
 * getExternalFilesDir(null)/&lt;modelDir&gt;, and writes a results JSON in the same shape
 * scripts/asr-transcribe.mjs already produces (modelId/dtype/withPrompt/loadS/records[]) so
 * it drops straight into scripts/e2e-audio-intents.ts and scripts/asr-score-slots.mjs
 * unmodified.
 *
 * modelDir/outName/modelId come from Intent string extras (adb shell am start -e ...) so the
 * same APK benchmarks the EN and PL models without a rebuild.
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
        // DEBUG (not INFO) so any "word not in vocabulary" grammar-compilation diagnostics
        // surface in logcat - issue #122's open question about OOV words in grammar mode.
        LibVosk.setLogLevel(LogLevel.DEBUG);
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
        String modelDir = getIntent().getStringExtra("model_dir");
        if (modelDir == null) modelDir = "model-en";
        String outName = getIntent().getStringExtra("out_name");
        if (outName == null) outName = "results.json";
        String modelId = getIntent().getStringExtra("model_id");
        if (modelId == null) modelId = "vosk-" + modelDir;
        // Issue #122's open question: does restricting the decoder to a closed domain
        // vocabulary (Recognizer's grammar mode) recover jargon a free-form small model
        // mangles? grammarFile is a JSON word-list file already pushed into filesDir (same
        // way model/audio are), not an intent extra, since JSON needs no shell-escaping this way.
        String grammarFile = getIntent().getStringExtra("grammar_file");

        File base = getFilesDir();
        File modelPath = new File(base, modelDir);
        File audioBase = new File(base, "audio");
        File outFile = new File(base, outName);

        String grammarJson = null;
        int grammarWords = 0;
        if (grammarFile != null) {
            try {
                grammarJson = new String(java.nio.file.Files.readAllBytes(new File(base, grammarFile).toPath()));
                for (int i = 0; i < grammarJson.length(); i++) {
                    if (grammarJson.charAt(i) == ',') grammarWords++;
                }
                grammarWords++;
                appendLog("grammar: " + grammarFile + " (" + grammarWords + " words)");
            } catch (Exception e) {
                appendLog("FAILED to read grammar file " + grammarFile + ": " + e);
                return;
            }
        } else {
            appendLog("no grammar (free-form decoding)");
        }

        appendLog("model: " + modelPath);
        appendLog("audio: " + audioBase);

        long loadStart = System.nanoTime();
        Model model;
        try {
            model = new Model(modelPath.getAbsolutePath());
        } catch (Exception e) {
            java.io.StringWriter sw = new java.io.StringWriter();
            e.printStackTrace(new java.io.PrintWriter(sw));
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
                    raw = recognizeFile(model, wav, grammarJson);
                } catch (Exception e) {
                    error = String.valueOf(e.getMessage());
                }
                double secs = (System.nanoTime() - t0) / 1e9;
                records.add(jsonRecord(speaker, id, raw, secs, error));
                appendLog(String.format("%s/%s (%.2fs): %s", speaker, id,
                        secs, error != null ? "ERROR " + error : raw));
            }
        }
        model.close();

        String json = "{\n"
                + "  \"modelId\": " + jsonStr(modelId) + ",\n"
                + "  \"dtype\": \"device\",\n"
                + "  \"withPrompt\": false,\n"
                + "  \"grammar\": " + (grammarJson != null) + ",\n"
                + "  \"grammarWords\": " + grammarWords + ",\n"
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

    /** Feeds raw PCM16LE mono 16kHz bytes to a fresh Recognizer, chunked the same way the
     * upstream vosk-android demo does. When grammarJson is non-null, uses Recognizer's
     * grammar-mode constructor to restrict decoding to that closed word list instead of
     * free-form decoding. */
    private String recognizeFile(Model model, File wav, String grammarJson) throws Exception {
        Recognizer rec = grammarJson != null
                ? new Recognizer(model, 16000.f, grammarJson)
                : new Recognizer(model, 16000.f);
        byte[] bytes;
        try (InputStream in = new FileInputStream(wav)) {
            bytes = in.readAllBytes();
        }
        int dataOffset = findDataChunkOffset(bytes);
        byte[] buf = new byte[4096];
        for (int pos = dataOffset; pos < bytes.length; pos += buf.length) {
            int n = Math.min(buf.length, bytes.length - pos);
            System.arraycopy(bytes, pos, buf, 0, n);
            rec.acceptWaveForm(buf, n);
        }
        String finalJson = rec.getFinalResult();
        rec.close();
        return extractText(finalJson);
    }

    /** Locates the "data" chunk by scanning RIFF sub-chunks instead of assuming a fixed 44-byte
     * header - ffmpeg's pcm_s16le output embeds a LIST/INFO chunk pushing the real payload past
     * byte 44 for these resampled clips (same fix already used in the wav2vec2/whisper.cpp
     * benches, docs/android-asr-runtime-bench.md S4.1). */
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

    /** Vosk returns {"text": "..."} (or {"text": ""} on silence) - avoid a JSON library
     * dependency for one field. */
    private static String extractText(String resultJson) {
        int i = resultJson.indexOf("\"text\"");
        if (i < 0) return "";
        int colon = resultJson.indexOf(':', i);
        int q1 = resultJson.indexOf('"', colon + 1);
        int q2 = resultJson.indexOf('"', q1 + 1);
        if (q1 < 0 || q2 < 0) return "";
        return resultJson.substring(q1 + 1, q2);
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
