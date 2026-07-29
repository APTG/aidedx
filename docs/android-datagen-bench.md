# Android benchmark data generator (issue #130)

Status: **Part 1 (sentence set) done.** **Part 2 (the `DataGenActivity` app) is written,
compiles, and is now verified on real hardware** (Pixel 7a, over `adb connect` on the same
wifi network — see "Verified on real hardware" below) — the two biggest unverified risks
(dual eager model load fitting in RAM, real-mic transcription accuracy) both hold up. **Part 3
(PC-side import/scoring) is written and smoke-tested** with a synthetic session (see "Part 3"
below) — the scripts are proven correct on fabricated data, but a real full session hasn't been
imported/scored yet (only a single throwaway test clip exists so far, recorded under a
`tmp-test` speaker id specifically so it won't collide with the eventual real session). **Part 4
(findings) is not started** — there is no full recording session to draw findings from yet.
This doc will grow a "Results" section once one exists.

## Verified on real hardware (2026-07-29, Pixel 7a)

Ran the exact "Reproducing" steps below against a Pixel 7a connected over wifi
(`adb connect <phone-ip>:5555`, phone and dev machine on the same LAN — no USB needed). Both
items the "Known limitation" section below used to flag as unverified now check out:

- **Dual eager model load does not OOM.** Parakeet-v3 int8 loaded in 3.7s, Whisper-small int8
  loaded in 2.2s immediately after, both held in memory simultaneously, on an 8 GB device — the
  documented per-clip load/release fallback was never needed.
- **Real-mic transcription is accurate.** First real clip recorded (`dg-01-en`, "What is the
  CSDA range of a 150 MeV proton in water?"): both models transcribed it correctly (Parakeet in
  0.69s, Whisper in 2.52s; only a dropped "a" article, no slot-relevant difference), and the
  on-device slot check passed particle/material/energy on both models. WAV file writes and the
  resumable `session.json`/`results-*.json` contract all behave as designed — confirmed by
  killing and relaunching the activity mid-session (renaming the speaker id from `km` to
  `tmp-test` in between) and seeing it correctly resume at "1 already committed, 99 remaining."

Not yet done: a full 100-card (50×EN+PL) session — recording is inherently a human-in-the-loop
task (reading each prompt aloud), so it happens over multiple sessions rather than in one sitting.

### Recording without a computer, once the app is installed

`DataGenActivity` is deliberately not the launcher activity (`BenchActivity` keeps that, so
issue #120/#122's published numbers stay reproducible from the same icon) but it is
`android:exported="true"`, so a generic "activity launcher" app can start it directly without
`adb`:

1. Install **Activity Launcher** (Peter Kalauskas) from the Play Store.
2. Find **SherpaBench** → **DataGenActivity** in its activity list, no extras needed.
3. Save as a home-screen shortcut.

Launching with no intent extras (from that shortcut, or from the app's own recents-list re-open)
now shows an on-screen setup panel — speaker/lang/hotwords fields prefilled with sensible
defaults (`speaker="lgpixel"`, `lang="both"`, `hotwords_file="hotwords-v3.txt"`) — instead of the
old "missing required intent extra \"speaker\"" failure a no-extras launch used to hit. Tapping
**Start** resumes from that speaker's `session.json` exactly like the `adb`-launched path does,
so short recording sessions across many days, on the phone alone, work with no PC involved after
the initial install/push.

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

## Known limitation (historical — resolved, see "Verified on real hardware" above)

An earlier session's sandbox had Android SDK platform-tools installed but `adb`'s local
client/server protocol failed (`protocol fault: Connection reset by peer`) even after
`kill-server`/`start-server` and with the sandbox disabled for the command — most likely a
container-level restriction on raw local socket traffic, not something fixable from inside
that session. At the time:

- **Verified**: `./gradlew assembleDebug` succeeds (a portable JDK 21 had to be fetched
  user-locally too — no system JDK, no sudo — see below); the built APK's manifest has both
  `BenchActivity` (unchanged, still the launcher) and the new `DataGenActivity`; the
  `RECORD_AUDIO` permission is present.
- **Not verified**: anything requiring the phone itself — recording quality, whether the
  eager dual-model-load (Parakeet + Whisper simultaneously, see the class doc comment's RAM
  discussion) actually holds up without an OOM kill, real transcription output, WAV file
  correctness when played back, timing.

A later session had a phone reachable over `adb connect <phone-ip>:5555` on the same wifi
network — see "Verified on real hardware" above for what that resolved.

## Part 3 — PC-side import and scoring

Three new pieces, all smoke-tested against a **fabricated** session (fake WAVs, transcripts
copied from `eval/datagen-sentences.json` with a few words deliberately deleted) since no real
recording exists yet — proven mechanically correct, not proven accurate on real audio:

- **`scripts/import-datagen-session.sh <speaker>`** — pulls `filesDir/out/<speaker>/` off the
  device (`adb shell run-as com.aidedx.sherpabench sh -c 'cd files/out/<speaker> && tar cf - .'`
  piped into a local `tar xf -`, the same run-as pattern every other on-device doc in this repo
  already uses) into `eval/audio/<speaker>/` (WAVs) + `eval/results/datagen-<speaker>-<date>/`
  (`session.json` + `results-{parakeet,whisper}-<lang>.json`). Verifies each WAV is really 16 kHz
  mono `pcm_s16le` via `ffprobe` if available, rather than trusting the extension. `--from-dir
  <dir>` skips `adb` entirely (what the smoke test used, and useful for importing a session
  someone else already pulled by hand).
- **`scripts/datagen-to-manifest.mjs <en|pl>`** — flattens `eval/datagen-sentences.json`'s
  per-tuple `{id, en:{...}, pl:{...}}` shape into the flat per-clip `{id, text, quantity, multi,
slotTruth}` shape `scripts/asr-score-slots-generic.mjs` already expects (same shape
  `scripts/generate-1000-sentences.mjs`'s own output uses). **A real gap this caught**: issue
  #130's own Part 1 plan claimed `asr-score-slots-generic.mjs` "needs no change" for this set —
  true for its Polish-word regex support, false for the JSON shape, which it cannot read
  directly (it expects a flat manifest, not the nested en/pl shape this set is committed in).
  Output is derived and gitignored, like the 1000-sentence batches.
- **`scripts/e2e-audio-intents-datagen.ts <en|pl> <results.json>`** — the same E2E
  audio→intent metric `scripts/e2e-audio-intents.ts` computes for `eval/intents.jsonl`, adapted
  for two differences: ground truth is derived by re-matching each record's own `canonical` text
  (no hand-authored `expected` field exists here — `checkCandidate()` already proved every
  canonical sentence resolves to a complete, libdedx-computable intent, so that resolved intent
  IS the comparison target) rather than defaulted to English, `lang` is a required argument
  threaded through `matchIntent`. Also reports word error rate against `canonical`.

Smoke test (both scorers agree, and correctly flag exactly the clips a fabricated perturbation
touched — full command sequence in `scripts/import-datagen-session.sh`'s own usage comment):

```
node scripts/asr-score-slots-generic.mjs eval/datagen-manifest-en.json <results.json> --new
node scripts/e2e-audio-intents-datagen.ts en <results.json>
```

Ran against a synthetic 50-clip English session with `canonical` copied verbatim as the "raw"
transcript except 4 clips with one material word deleted: both scorers independently reported
**46/50**, both listed the same 4 failing ids, and the E2E scorer's mean WER (0.6%) was
consistent with "4 single-word deletions across ~50 clips." The Polish side, scored against an
unperturbed session, reported **50/50** on both scorers with 0.0% WER — confirms the `lang`
plumbing (matcher + manifest + slot regexes) works end to end for Polish, not just English.

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
adb push ../../../eval/hotwords-v3.txt /data/local/tmp/sb/hotwords-v3.txt   # committed file — same
                                                                             # v3 list docs/nemo-parakeet-comparison.md
                                                                             # §4.3 derived, no need to re-derive it

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

# import + score (see "Part 3" above) — replaces the manual run-as/tar pull this doc's earlier
# draft described
scripts/import-datagen-session.sh km
node scripts/datagen-to-manifest.mjs en
node scripts/datagen-to-manifest.mjs pl
node scripts/asr-score-slots-generic.mjs eval/datagen-manifest-en.json eval/results/datagen-km-<date>/results-parakeet-en.json --new
node scripts/e2e-audio-intents-datagen.ts en eval/results/datagen-km-<date>/results-parakeet-en.json
# repeat for results-whisper-en.json and the -pl.json pair
```
