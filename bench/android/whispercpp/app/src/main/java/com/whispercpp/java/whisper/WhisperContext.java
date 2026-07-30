package com.whispercpp.java.whisper;

import android.os.Build;
import android.util.Log;

import androidx.annotation.RequiresApi;

import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Vendored from ggml-org/whisper.cpp's examples/whisper.android.java (the "JNI already written"
 * example issue #120 pointed at), trimmed to the file-based transcription path this benchmark
 * needs - the upstream transcribeDataWithTime() method pulled in a WhisperSegment bean class from
 * their example app's own package that isn't needed here.
 */
public class WhisperContext {

  private static final String LOG_TAG = "LibWhisper";
  private long ptr;
  private final ExecutorService executorService;

  private WhisperContext(long ptr) {
    this.ptr = ptr;
    this.executorService = Executors.newSingleThreadExecutor();
  }

  public String transcribeData(float[] data) throws ExecutionException, InterruptedException {
    return transcribeData(data, WhisperCpuConfig.getPreferredThreadCount(), null);
  }

  /** numThreads override added for issue #120's thread-tuning experiment
   * (docs/android-asr-runtime-bench.md S5.5's thermal-throttling finding) - upstream's
   * WhisperCpuConfig.getPreferredThreadCount() auto-detection is otherwise the only path. */
  public String transcribeData(float[] data, int numThreads) throws ExecutionException, InterruptedException {
    return transcribeData(data, numThreads, null);
  }

  /** prompt wires whisper.cpp's native initial_prompt support through to whisper_full_params
   * (jni.c) - the domain-prompt biasing lever docs/voice-pipeline-feasibility.md S2.4 found to be
   * the single biggest desktop accuracy lever, and which sherpa-onnx has no equivalent for at all
   * (docs/android-asr-runtime-bench.md S3.4). Pass null/empty for no prompt (matches the prior
   * unprompted 89% E2E result). Defaults language to "en" - see the 4-arg overload below for why
   * that default exists and when it stops being correct. */
  public String transcribeData(float[] data, int numThreads, String prompt) throws ExecutionException, InterruptedException {
    return transcribeData(data, numThreads, prompt, "en");
  }

  /** language selects whisper.cpp's forced decoding language (jni.c's params.language) - was
   * hardcoded "en" natively regardless of caller, confirmed to silently mangle non-English audio
   * into English-shaped text instead of a real transcript (issue #134 follow-up,
   * docs/android-datagen-bench.md: 0% audio->intent match on 50 real Polish clips scored against
   * that hardcoded default). Pass the real BCP-47-ish code ("en"/"pl") for each clip's actual
   * spoken language; this class's own 3-arg overload above keeps defaulting to "en" for any
   * caller that hasn't been updated to pass one explicitly. */
  public String transcribeData(float[] data, int numThreads, String prompt, String language) throws ExecutionException, InterruptedException {
    return executorService.submit(new Callable<String>() {
      @RequiresApi(api = Build.VERSION_CODES.O)
      @Override
      public String call() {
        if (ptr == 0L) {
          throw new IllegalStateException();
        }
        Log.d(LOG_TAG, "Selecting " + numThreads + " threads");

        StringBuilder result = new StringBuilder();
        synchronized (this) {
          WhisperLib.fullTranscribe(ptr, numThreads, data, prompt, language);
          int textCount = WhisperLib.getTextSegmentCount(ptr);
          for (int i = 0; i < textCount; i++) {
            String sentence = WhisperLib.getTextSegment(ptr, i);
            result.append(sentence);
          }
        }
        return result.toString();
      }
    }).get();
  }

  @RequiresApi(api = Build.VERSION_CODES.O)
  public void release() throws ExecutionException, InterruptedException {
    executorService.submit(() -> {
      if (ptr != 0L) {
        WhisperLib.freeContext(ptr);
        ptr = 0;
      }
    }).get();
  }

  @RequiresApi(api = Build.VERSION_CODES.O)
  public static WhisperContext createContextFromFile(String filePath) {
    long ptr = WhisperLib.initContext(filePath);
    if (ptr == 0L) {
      throw new RuntimeException("Couldn't create context with path " + filePath);
    }
    return new WhisperContext(ptr);
  }

  @RequiresApi(api = Build.VERSION_CODES.O)
  public static String getSystemInfo() {
    return WhisperLib.getSystemInfo();
  }
}
