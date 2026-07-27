# Android on-device ASR runtime bench (issue #120)

_Session report, 2026-07-27. First candidate only (Vosk small EN) — whisper.cpp, sherpa-onnx, and
the wav2vec2 stretch candidate are still pending; see §5. Measured on a real device
(Pixel 7a, Tensor G2, Android 17/API 36, `arm64-v8a`), not extrapolated from desktop numbers, per
issue #120's actual ask._

## TL;DR

**Vosk small-en, on-device, scores 0% end-to-end audio→intent slot match (0/89) against this
project's eval set — down from whisper-small+prompt's desktop-CPU baseline of 91% (81/89).** Every
one of the 89 failures is missing the `energies` slot (the MeV/keV/GeV/keV-per-nucleon number+unit
pair). Two independent, compounding causes, both confirmed from the raw transcripts, not assumed:

1. **The small model's closed vocabulary genuinely doesn't contain the domain's unit jargon** —
   "MeV" comes back as "mtv"/"m easy"/"am eighty", "keV" as "key even"/"if he", "PMMA" as "pm away"/
   "pm and a", "ions" as "aisles"/"i'll weave". This is exactly the failure mode
   [#122's maintainer comment](https://github.com/APTG/aidedx/issues/120#issuecomment-5073021059)
   predicted and the reason that issue exists.
2. **Vosk's small model does no inverse-text-normalization on numbers** — "150" is transcribed as
   the words "one hundred and fifty", never as digits. Even where the acoustic recognition of a
   number is essentially correct, the matcher (which expects digit form) still misses it. This
   compounds with (1): the `number` slot-token accuracy is 4.3% raw, barely better than the `unit`
   slot's 5.4% — both collapse for the same underlying reason (jargon aside, Vosk just doesn't
   normalize).

Non-jargon content words fare far better: `material` 73.8%, `quantity` 77.9%, `particle` 54.7%
raw slot-token accuracy (see §3 table) — confirming the failure is specifically the numeric/unit
path, not general transcription quality.

**Where Vosk does win: latency and load time.** Median 1.3s/clip on-device (Pixel 7a) vs.
whisper-small+prompt's 2.3s/clip on a 12-thread desktop CPU (`docs/voice-pipeline-feasibility.md`
§2), and the model loads in 0.55s. If the vocabulary problem can be solved (§4 discusses whether
Vosk's grammar-constrained mode could do it; short answer: only partially, see below), the runtime
itself is fast enough.

**Battery/thermal reading is inconclusive** — the phone was on USB power throughout the run
(charging faster than the benchmark could drain it: battery level actually rose 97%→98%), so this
run cannot answer the battery-drain open question. SoC temperature rose slightly (29.1°C→30.5°C),
not evidence of throttling but not a controlled reading either. A real reading needs the device
unplugged, which wasn't done for this first pass.

## 1. Setup

| | |
|---|---|
| Device | Pixel 7a (`lynx`), Tensor G2 (GS201), Android 17 (API 36), `arm64-v8a` |
| Model | `vosk-model-small-en-us-0.15` (68 MB unzipped), official Alphacephei download, no reconversion |
| Harness | `bench/android/vosk/` (new, this session) — minimal single-Activity Gradle app, no mic, no NDK build (Vosk/JNA ship prebuilt `arm64-v8a` `.so`s) |
| Eval clips | The same fixed 30-sentence × 3-speaker set `scripts/asr-transcribe.mjs` uses (89 of 90 exist), resampled 44.1kHz→16kHz mono for Vosk with `ffmpeg` |
| Scoring | Unmodified `scripts/e2e-audio-intents.ts` and `scripts/asr-score-slots.mjs` — the on-device run writes the exact same JSON contract `scripts/asr-transcribe.mjs` does (`modelId`/`dtype`/`loadS`/`records[]`), so no new scoring code was needed |

### Why this took real setup work, not just a download

Two environment gaps had to be worked around, worth recording so the next candidate (sherpa-onnx)
doesn't hit them blind:

- **No NDK installed**, only Android Studio's NDK *plugin* (UI integration, not the toolchain). Not
  needed for Vosk/JNA (prebuilt AARs), but will matter for whisper.cpp, which builds its JNI bridge
  from source.
- **The installed SDK platform (`android-36.1`, a fractional/QPR API level) isn't a format this
  AGP version's `compileSdkVersion` accepts** (`Unsupported value: android-36.1`). Installed a
  standard `android-34` platform directly from Google's repository (`dl.google.com/android/repository`,
  no `sdkmanager` available either) instead of chasing preview-API-level compileSdk syntax.
- **`adb push` into `Android/data/<pkg>/files` is not reliably readable by the app itself** under
  scoped storage — confirmed directly with `run-as`: `Permission denied`, 0-byte reads, despite
  `adb shell ls` showing the files present. The fix: push to `/data/local/tmp` (world-accessible),
  then `adb shell run-as <pkg> cp -r /data/local/tmp/... files/...` into the app's **internal**
  storage (`getFilesDir()`), which the app's own UID actually owns. Same `run-as` trick needed in
  reverse to pull `results.json` back out (`adb shell run-as <pkg> cat files/results.json`) since
  internal storage isn't `adb pull`-able directly either.
- `com.alphacephei:vosk-android:0.3.75`'s dependency graph pulls both merged `kotlin-stdlib`
  (1.8.22) and the superseded split `kotlin-stdlib-jdk7`/`-jdk8` (1.6.21) — same classes in both,
  duplicate-class build failure. Fixed with a `configurations.all { exclude ... }` in
  `bench/android/vosk/app/build.gradle`.

## 2. Reproducing

```
cd bench/android/vosk
export ANDROID_HOME=~/Android/Sdk
export JAVA_HOME=<a real JDK — Android Studio's bundled JBR works: .../android-studio/jbr>
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk

# push model + resampled (16kHz mono) audio to /data/local/tmp, then into the app's
# internal storage via run-as (see §1 for why not a direct adb push)
adb push <unzipped-vosk-model-dir> /data/local/tmp/vb/model-en
adb push <16kHz-resampled-eval-audio-dir> /data/local/tmp/vb/audio
adb shell run-as com.aidedx.voskbench sh -c \
  'mkdir -p files && cp -r /data/local/tmp/vb/model-en files/model-en && cp -r /data/local/tmp/vb/audio files/audio'

adb shell am start -n com.aidedx.voskbench/.BenchActivity --ez autorun true \
  -e model_dir model-en -e out_name results-en.json -e model_id vosk-model-small-en-us-0.15
# (--ez, not -e, for the boolean extra — `-e` sets a String extra and autorun silently never fires)

adb shell run-as com.aidedx.voskbench cat files/results-en.json > eval/results/android-vosk-2026-07-27/vosk-small-en.json
npx tsx scripts/e2e-audio-intents.ts eval/results/android-vosk-2026-07-27/vosk-small-en.json
node scripts/asr-score-slots.mjs eval/results/android-vosk-2026-07-27/vosk-small-en.json
```

Raw results: `eval/results/android-vosk-2026-07-27/vosk-small-en.json`.

## 3. Results

### 3.1 Headline, vs. the existing baseline

| Pipeline | audio→intent slot match | median s/clip | load time |
|---|---|---|---|
| whisper-small + prompt, desktop CPU (Node, `onnxruntime-node`) | 91% (81/89) | 2.3s | — |
| **Vosk small-en, Pixel 7a, real device** | **0% (0/89)** | **1.3s** (p90 1.6s) | **0.55s** |

### 3.2 Slot-token accuracy by category (raw → corrected)

| Category | Accuracy | n |
|---|---|---|
| quantity | 77.9% → 80.0% | 95 |
| number | 4.3% → 6.5% | 92 |
| **unit** | **5.4% → 6.5%** | 92 |
| particle | 54.7% → 56.8% | 95 |
| material | 73.8% → 74.8% | 103 |
| program | 0.0% → 16.7% | 6 |
| **ALL** | **43.7% → 45.5%** | 483 |

Per-speaker clip pass rate (corrected): km 0/30, lg 0/30, mn 0/29 — uniform across speakers, so
this isn't one bad recording, it's systematic.

### 3.3 Sample transcripts (raw, uncorrected)

| Expected | Vosk raw output |
|---|---|
| "...60 MeV protons..." | "...sixty **mtv** protons..." |
| "...100 MeV..." | "...one hundred **m easy**..." |
| "...150 keV..." | "...one hundred and fifty **if he**..." |
| "...carbon ions..." | "...carbon **aisles**..." |
| "...in PMMA" | "...in **pm away**" / "...**pm and a**" |
| "...290 MeV/u" | "...two hundred ninety **mtv per you**" |

## 4. Open questions from #122, answered for Vosk specifically

Issue #122 asked (in the context of evaluating Parakeet's hotwords feature) whether Vosk's
grammar-constrained decoding could recover domain jargon by restricting the decoder to a closed
vocabulary. This run didn't test grammar-mode (only free-form `Recognizer(model, sampleRate)`), but
the raw-transcript evidence here answers the prerequisite question §122 itself raised: **grammar
restriction can only pick from words the model's vocabulary already contains**. If "mev"/"pmma"
aren't in the small model's lexicon at all (which the total absence of anything close to those
strings across 89 clips strongly suggests, rather than "recognized but low-confidence"), a grammar
file listing them wouldn't help — the decoder has no acoustic-to-token path to reach a word outside
its vocabulary in the first place. Confirming this precisely (checking whether "mev" is a decodable
token in the model's `words.txt`/lexicon) is a small follow-up, not done in this session, before
fully closing this question.

## 5. What's still pending (this issue's remaining candidates)

- **sherpa-onnx** (whisper-small) — shares infrastructure with #122's Parakeet desktop comparison;
  doing the desktop-first check #122 recommends before device time makes sense to schedule next.
- **whisper.cpp** — needs the NDK (not installed; see §1), so real setup cost still ahead.
- **wav2vec2-base-960h** (stretch) — encoder-only/no-autoregressive-decode latency data point,
  English-only.
- **A controlled battery/thermal reading** for Vosk (unplugged, not on USB power this time) — this
  run's reading (§0 TL;DR) doesn't count.

## 6. Bottom line so far

Vosk small-en is fast and lightweight but not viable for this project's domain as-is — the failure
is a hard vocabulary-coverage wall, not a tunable accuracy gap prompt-biasing or a correction layer
can close (there's no `initial_prompt`-equivalent hook, and the correction layer's regex/phonetic
passes only move the aggregate token accuracy from 43.7%→45.5%, nowhere near closing an 89pp gap).
Whether a *large* Vosk model (not tested here, bigger than the ≤0.5GB budget this candidate was
chosen for) has broader vocabulary coverage is an open question this session didn't test. For the
Android runtime decision this issue is ultimately about, sherpa-onnx and whisper.cpp — both
whisper-small-family models this project already tuned prompt-biasing against — remain the more
promising candidates.
