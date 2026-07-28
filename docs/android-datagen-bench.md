# Android benchmark data generator (issue #130)

Status: **Part 1 (sentence set) done and merged-ready** (`eval/datagen-sentences.json`,
`eval/RECORDING.datagen.md`). **Part 2 (the `DataGenActivity` app) is written and compiles**
(`./gradlew assembleDebug` succeeds, manifest confirmed via `aapt dump xmltree`) but **has not
been run on a real device yet** — this session had no working `adb` (see "Known limitation"
below). Parts 3 (PC-side import/scoring) and 4 (findings) are not started. This doc will grow
a "Results" section once a real recording session exists.

## What `DataGenActivity` does

Extends `bench/android/sherpa-onnx` (reuses the vendored `com.k2fsa.sherpa.onnx` Kotlin
wrapper and `jniLibs` already there — no second model copy, no new Gradle dependency).
`BenchActivity` is untouched, so #120/#122's published numbers stay reproducible.

Per prompt (from `eval/datagen-sentences.json`, pushed to the device): shows the `display`
text, records from the mic (16 kHz mono PCM via `AudioRecord`), transcribes with **both** NeMo
Parakeet-v3 and Whisper-small, shows each model's raw transcript + a fast on-device slot check
(literal token containment against `slotTruth` — not the real matcher, which stays
TypeScript-only), and on "Keep" writes the WAV + appends to a resumable `session.json` plus
per-language `results-{parakeet,whisper}-<lang>.json` in the existing
`{modelId, dtype, withPrompt, loadS, records[]}` contract `scripts/e2e-audio-intents.ts` /
`scripts/asr-score-slots-generic.mjs` already consume.

Full field-by-field intent-extra and output-format reference: the doc comment at the top of
`bench/android/sherpa-onnx/app/src/main/java/com/aidedx/sherpabench/DataGenActivity.kt`.

## Known limitation: not verified on real hardware this session

This session's sandbox has Android SDK platform-tools installed but `adb`'s local
client/server protocol fails (`protocol fault: Connection reset by peer`) even after
`kill-server`/`start-server` and with the sandbox disabled for the command — most likely a
container-level restriction on raw local socket traffic, not something fixable from inside
this session. Consequently:

- **Verified**: `./gradlew assembleDebug` succeeds (a portable JDK 21 had to be fetched
  user-locally too — no system JDK, no sudo — see below); the built APK's manifest has both
  `BenchActivity` (unchanged, still the launcher) and the new `DataGenActivity`; the
  `RECORD_AUDIO` permission is present.
- **Not verified**: anything requiring the phone itself — recording quality, whether the
  eager dual-model-load (Parakeet + Whisper simultaneously, see the class doc comment's RAM
  discussion) actually holds up without an OOM kill, real transcription output, WAV file
  correctness when played back, timing.

**Next step, on a machine with working `adb`**: run the reproducing steps below, and if
anything breaks, it breaks in exactly the areas listed as unverified above — check there
first.

## Reproducing

```bash
cd bench/android/sherpa-onnx
export ANDROID_HOME=~/Android/Sdk
export JAVA_HOME=<a real JDK — Android Studio's bundled JBR works: .../android-studio/jbr>

# native libs are gitignored (docs/android-asr-runtime-bench.md §3.1) - re-fetch
curl -sSL -o android-libs.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/sherpa-onnx-v1.13.4-android.tar.bz2
tar xjf android-libs.tar.bz2
cp jniLibs/arm64-v8a/*.so app/src/main/jniLibs/arm64-v8a/

./gradlew assembleDebug
adb connect <phone-ip>:5555   # or plain USB — either way, `adb devices` must show it first
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell pm grant com.aidedx.sherpabench android.permission.RECORD_AUDIO   # skips the runtime dialog

# Parakeet-v3 model (same as docs/nemo-parakeet-comparison.md §10)
mkdir -p .hf-cache/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8
cd .hf-cache/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8
BASE=https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main
curl -sSL -o tokens.txt "$BASE/tokens.txt"
curl -sSL -o decoder.int8.onnx "$BASE/decoder.int8.onnx"
curl -sSL -o joiner.int8.onnx "$BASE/joiner.int8.onnx"
curl -sSL -o encoder.int8.onnx "$BASE/encoder.int8.onnx"   # ~652 MB
# bpe.vocab: derive as docs/nemo-parakeet-comparison.md §4.1 describes (equal per-token
# scores — this model ships tokens.txt but no bpe.vocab)
cd -

# Whisper-small (int8, multilingual — same model docs/android-asr-runtime-bench.md §3 used)
mkdir -p .hf-cache/csukuangfj/sherpa-onnx-whisper-small
cd .hf-cache/csukuangfj/sherpa-onnx-whisper-small
BASE=https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small/resolve/main
curl -sSL -o small-tokens.txt "$BASE/small-tokens.txt"
curl -sSL -o small-encoder.int8.onnx "$BASE/small-encoder.int8.onnx"
curl -sSL -o small-decoder.int8.onnx "$BASE/small-decoder.int8.onnx"
cd -

# push the sentence set + both models + hotwords to the device's internal storage, same
# push-to-/data/local/tmp-then-run-as pattern docs/android-asr-runtime-bench.md §1 established
adb push ../../../eval/datagen-sentences.json /data/local/tmp/sb/datagen-sentences.json
adb push .hf-cache/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8 /data/local/tmp/sb/model-parakeet
adb push .hf-cache/csukuangfj/sherpa-onnx-whisper-small /data/local/tmp/sb/model-whisper
adb push <hotwords-v3.txt> /data/local/tmp/sb/hotwords-v3.txt   # see docs/nemo-parakeet-comparison.md §4.3

adb shell run-as com.aidedx.sherpabench sh -c '
  mkdir -p files &&
  cp /data/local/tmp/sb/datagen-sentences.json files/datagen-sentences.json &&
  cp -r /data/local/tmp/sb/model-parakeet files/model-parakeet &&
  cp -r /data/local/tmp/sb/model-whisper files/model-whisper &&
  cp /data/local/tmp/sb/hotwords-v3.txt files/hotwords-v3.txt
'

adb shell am start -n com.aidedx.sherpabench/.DataGenActivity \
  -e speaker km -e lang both -e hotwords_file hotwords-v3.txt

# ... record through the deck on the phone (interactive — Record/Stop, then Keep/Re-record/Skip
# per card) ...

# pull results back
adb shell run-as com.aidedx.sherpabench sh -c 'cd files/out/km && tar cf - .' | tar xf - -C eval/results/datagen-km-<date>/
```

Once results exist, Part 3's PC-side import/scoring picks up from
`eval/results/datagen-<speaker>-<date>/` — not built yet.
