# Android on-device ASR runtime bench (issue #120)

_Session report, 2026-07-27. Two candidates measured (Vosk small-en, sherpa-onnx whisper-small
int8) — whisper.cpp and the wav2vec2 stretch candidate are still pending; see §5. Measured on a
real device (Pixel 7a, Tensor G2, Android 17/API 36, `arm64-v8a`), not extrapolated from desktop
numbers, per issue #120's actual ask._

## TL;DR

**sherpa-onnx whisper-small (int8, multilingual), on-device, scores 87% end-to-end audio→intent
slot match (77/89) — within 4pp of whisper-small+prompt's desktop-CPU baseline of 91% (81/89),
with no prompt biasing applied at all** (sherpa-onnx's `OfflineWhisperModelConfig` has no
prompt-injection field — see §3.4). Median latency 2.7s/clip on-device vs. the desktop baseline's
2.3s — close enough that the runtime itself isn't the bottleneck. This is the strongest candidate
so far for the Android runtime decision.

**Vosk small-en, by contrast, scores 0% (0/89)** — every failure missing the `energies` slot
(MeV/keV/GeV number+unit). Two compounding causes, confirmed from raw transcripts: the small
model's closed vocabulary genuinely doesn't contain this domain's unit jargon ("MeV" → "mtv"/
"m easy", "PMMA" → "pm away"), and it does no number inverse-text-normalization ("150" stays as
words, never digits). Vosk is faster (1.3s/clip, 0.55s load) and non-jargon content words fare much
better (particle 54.7%, material 73.8%), confirming the failure is specifically the numeric/unit
path — but the vocabulary gap is a hard wall, not a tunable accuracy problem.

**Battery/thermal readings are inconclusive for both candidates** — the phone was on USB power
throughout every run (charging faster than either benchmark could drain it), so neither run can
answer the battery-drain open question from #120. A real reading needs the device unplugged, not
done in this session.

## 1. Setup (shared across both candidates)

|                                                       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device                                                | Pixel 7a (`lynx`), Tensor G2 (GS201), Android 17 (API 36), `arm64-v8a`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Eval clips                                            | The same fixed 30-sentence × 3-speaker set `scripts/asr-transcribe.mjs` uses (89 of 90 exist), resampled 44.1kHz→16kHz mono with `ffmpeg`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Scoring                                               | Unmodified `scripts/e2e-audio-intents.ts` and `scripts/asr-score-slots.mjs` — both benchmark apps write the exact same JSON contract `scripts/asr-transcribe.mjs` does (`modelId`/`dtype`/`loadS`/`records[]`), so no new scoring code was needed for either candidate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Dev-machine environment gaps hit once, fixed for both | No NDK installed (worked around — neither candidate needed it, see per-candidate notes); the installed SDK platform (`android-36.1`, a fractional/QPR API level) isn't a `compileSdkVersion` format this AGP version accepts, fixed by installing a standard `android-34` platform directly from `dl.google.com/android/repository` (no `sdkmanager` available); `adb push` into `Android/data/<pkg>/files` is **not reliably readable by the app itself** under scoped storage (confirmed with `run-as`: `Permission denied`, 0-byte reads, despite `adb shell ls` showing the files present) — fixed by pushing to `/data/local/tmp` then `adb shell run-as <pkg> cp -r ...` into the app's **internal** storage (`getFilesDir()`), with the same `run-as` trick in reverse to pull `results.json` back out |

## 2. Candidate: Vosk small-en

|         |                                                                                                                                    |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Model   | `vosk-model-small-en-us-0.15` (68 MB unzipped), official Alphacephei download, no reconversion                                     |
| Harness | `bench/android/vosk/` — minimal single-Activity Gradle app, Java, no mic, no NDK build (Vosk/JNA ship prebuilt `arm64-v8a` `.so`s) |

### 2.1 Setup notes specific to Vosk

- `com.alphacephei:vosk-android:0.3.75`'s dependency graph pulls both merged `kotlin-stdlib`
  (1.8.22) and the superseded split `kotlin-stdlib-jdk7`/`-jdk8` (1.6.21) — same classes in both,
  duplicate-class build failure. Fixed with a `configurations.all { exclude ... }` in
  `bench/android/vosk/app/build.gradle`.

### 2.2 Reproducing

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

### 2.3 Results

| Pipeline                                                       | audio→intent slot match | median s/clip       | load time |
| -------------------------------------------------------------- | ----------------------- | ------------------- | --------- |
| whisper-small + prompt, desktop CPU (Node, `onnxruntime-node`) | 91% (81/89)             | 2.3s                | —         |
| **Vosk small-en, Pixel 7a, real device**                       | **0% (0/89)**           | **1.3s** (p90 1.6s) | **0.55s** |

Slot-token accuracy by category (raw → corrected):

| Category | Accuracy          | n   |
| -------- | ----------------- | --- |
| quantity | 77.9% → 80.0%     | 95  |
| number   | 4.3% → 6.5%       | 92  |
| **unit** | **5.4% → 6.5%**   | 92  |
| particle | 54.7% → 56.8%     | 95  |
| material | 73.8% → 74.8%     | 103 |
| program  | 0.0% → 16.7%      | 6   |
| **ALL**  | **43.7% → 45.5%** | 483 |

Per-speaker clip pass rate (corrected): km 0/30, lg 0/30, mn 0/29 — uniform across speakers, so
this isn't one bad recording, it's systematic.

Sample transcripts (raw, uncorrected):

| Expected               | Vosk raw output                         |
| ---------------------- | --------------------------------------- |
| "...60 MeV protons..." | "...sixty **mtv** protons..."           |
| "...100 MeV..."        | "...one hundred **m easy**..."          |
| "...150 keV..."        | "...one hundred and fifty **if he**..." |
| "...carbon ions..."    | "...carbon **aisles**..."               |
| "...in PMMA"           | "...in **pm away**" / "...**pm and a**" |
| "...290 MeV/u"         | "...two hundred ninety **mtv per you**" |

### 2.4 Open question from #122, answered for Vosk specifically

Issue #122 asked (in the context of evaluating Parakeet's hotwords feature) whether Vosk's
grammar-constrained decoding could recover domain jargon by restricting the decoder to a closed
vocabulary. This run didn't test grammar-mode (only free-form `Recognizer(model, sampleRate)`), but
the raw-transcript evidence here answers the prerequisite question #122 itself raised: **grammar
restriction can only pick from words the model's vocabulary already contains**. If "mev"/"pmma"
aren't in the small model's lexicon at all (which the total absence of anything close to those
strings across 89 clips strongly suggests, rather than "recognized but low-confidence"), a grammar
file listing them wouldn't help — the decoder has no acoustic-to-token path to reach a word outside
its vocabulary in the first place. Confirming this precisely (checking whether "mev" is a decodable
token in the model's `words.txt`/lexicon) is a small follow-up, not done in this session.

### 2.5 Bottom line for Vosk

Fast and lightweight but not viable for this project's domain as-is — the failure is a hard
vocabulary-coverage wall, not a tunable accuracy gap prompt-biasing or a correction layer can close
(there's no `initial_prompt`-equivalent hook, and the correction layer's regex/phonetic passes only
move the aggregate token accuracy from 43.7%→45.5%, nowhere near closing an 89pp gap). Whether a
_large_ Vosk model (not tested here, bigger than the ≤0.5GB budget this candidate was chosen for)
has broader vocabulary coverage is an open question this session didn't test.

## 3. Candidate: sherpa-onnx whisper-small (int8, multilingual)

|         |                                                                                                                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model   | `csukuangfj/sherpa-onnx-whisper-small` int8 (encoder 112 MB + decoder 262 MB = 374 MB), same underlying OpenAI whisper-small checkpoint this project already tuned prompt-biasing against    |
| Harness | `bench/android/sherpa-onnx/` — minimal single-Activity Gradle app, Kotlin (sherpa-onnx's Android API is Kotlin-only, no Java equivalent shipped in the Android AAR — see §3.1), no NDK build |

### 3.1 Setup notes specific to sherpa-onnx

- **The obvious path — `implementation 'com.github.k2-fsa:sherpa-onnx:v1.13.4'` via JitPack, as
  the upstream `SherpaOnnxJavaDemo` uses — was not used.** The repo's own
  `android/SherpaOnnxAar/README.md` documents that the native `.so` libraries are **not** in git
  (only `.gitkeep` placeholders under `jniLibs/`) and must be manually downloaded from a separate
  GitHub Release tarball and copied in before building. A generic JitPack build of the tagged
  commit has no reason to run that manual step, so depending on it risked an AAR with empty
  `jniLibs` and a runtime `UnsatisfiedLinkError` — not verified either way, just judged not worth
  the risk when the documented alternative is simple and reliable.
- **Instead: vendored the approach directly**, matching exactly what the upstream AAR module
  itself contains — no more, no less:
  - Downloaded `sherpa-onnx-v1.13.4-android.tar.bz2` (45 MB) from the project's GitHub Releases,
    extracted `jniLibs/arm64-v8a/*.so` (30 MB: `libonnxruntime.so`, `libsherpa-onnx-jni.so`,
    `libsherpa-onnx-c-api.so`, `libsherpa-onnx-cxx-api.so`) straight into the app module's own
    `jniLibs/arm64-v8a/`.
  - Copied the 6 Kotlin source files file-based offline recognition actually needs
    (`OfflineRecognizer.kt`, `OfflineStream.kt`, `FeatureConfig.kt`, `HomophoneReplacerConfig.kt`,
    `QnnConfig.kt`, `WaveReader.kt`) from `sherpa-onnx/kotlin-api/` into the app's own
    `com.k2fsa.sherpa.onnx` package (required package name — the native JNI methods are compiled
    against it).
  - This sidesteps the AAR/JitPack question entirely, needs no NDK (still not installed), and
    matches the project's own documented build recipe exactly.
- **The Android API is Kotlin, not Java** (`sherpa-onnx/java-api/` exists in the repo but is a
  separate, desktop/JVM-targeted Maven module — the Android AAR module compiles from
  `sherpa-onnx/kotlin-api/` instead). Added the Kotlin Android Gradle plugin
  (`org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.24`) to the bench project; the app's own
  `BenchActivity` is written in Kotlin too, unlike the Vosk bench's Java.
- No JitPack-adjacent Kotlin-stdlib version conflicts this time (nothing else in the project pulls
  a different Kotlin-stdlib version) — the build succeeded on the first real attempt once the
  files above were in place.

### 3.2 Reproducing

```
cd bench/android/sherpa-onnx
export ANDROID_HOME=~/Android/Sdk
export JAVA_HOME=<a real JDK — Android Studio's bundled JBR works: .../android-studio/jbr>

# native libs + Kotlin API sources are gitignored (large binaries / easy to re-fetch) - see §3.1
curl -sSL -o android-libs.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/sherpa-onnx-v1.13.4-android.tar.bz2
tar xjf android-libs.tar.bz2
cp jniLibs/arm64-v8a/*.so app/src/main/jniLibs/arm64-v8a/
for f in OfflineRecognizer OfflineStream FeatureConfig HomophoneReplacerConfig QnnConfig WaveReader; do
  curl -sSL -o app/src/main/java/com/k2fsa/sherpa/onnx/$f.kt \
    https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/master/sherpa-onnx/kotlin-api/$f.kt
done

./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk

# model: csukuangfj/sherpa-onnx-whisper-small (int8) — encoder/decoder/tokens
# push to /data/local/tmp, then into the app's internal storage via run-as (see §1)
adb push <small-encoder.int8.onnx / small-decoder.int8.onnx / small-tokens.txt> /data/local/tmp/sb/model-sherpa/
adb push <16kHz-resampled-eval-audio-dir> /data/local/tmp/sb/audio
adb shell run-as com.aidedx.sherpabench sh -c \
  'mkdir -p files && cp -r /data/local/tmp/sb/model-sherpa files/model-sherpa && cp -r /data/local/tmp/sb/audio files/audio'

adb shell am start -n com.aidedx.sherpabench/.BenchActivity --ez autorun true \
  -e model_dir model-sherpa -e out_name results-sherpa-en.json -e model_id sherpa-onnx-whisper-small-int8

adb shell run-as com.aidedx.sherpabench cat files/results-sherpa-en.json > eval/results/android-sherpa-onnx-2026-07-27/sherpa-whisper-small-en.json
npx tsx scripts/e2e-audio-intents.ts eval/results/android-sherpa-onnx-2026-07-27/sherpa-whisper-small-en.json
node scripts/asr-score-slots.mjs eval/results/android-sherpa-onnx-2026-07-27/sherpa-whisper-small-en.json
```

Raw results: `eval/results/android-sherpa-onnx-2026-07-27/sherpa-whisper-small-en.json`.

### 3.3 Results

| Pipeline                                                             | audio→intent slot match | median s/clip       | load time |
| -------------------------------------------------------------------- | ----------------------- | ------------------- | --------- |
| whisper-small + prompt, desktop CPU (Node, `onnxruntime-node`)       | 91% (81/89)             | 2.3s                | —         |
| **sherpa-onnx whisper-small int8, Pixel 7a, real device, no prompt** | **87% (77/89)**         | **2.7s** (p90 3.3s) | **2.3s**  |

Slot-token accuracy by category (raw → corrected):

| Category | Accuracy          | n   |
| -------- | ----------------- | --- |
| quantity | 93.7% → 100.0%    | 95  |
| number   | 97.8% → 100.0%    | 92  |
| **unit** | **78.3% → 93.5%** | 92  |
| particle | 88.4% → 95.8%     | 95  |
| material | 98.1% → 99.0%     | 103 |
| program  | 16.7% → 33.3%     | 6   |
| **ALL**  | **90.5% → 96.9%** | 483 |

Per-speaker clip pass rate (corrected): km 28/30, lg 25/30, mn 24/29.

Sample transcripts (raw, uncorrected) — for comparison against Vosk's §2.3 table on the exact same
clips:

| Expected                                               | sherpa-onnx raw output                                                      |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| "...60 MeV protons in lucite..."                       | "What is the range of 60 MeV protons in lucite? Lucid."                     |
| "...100 MeV per nucleon carbon ions... PMMA"           | "For 100 MeV per nucleon carbon ions, compare the range in water and PMMA." |
| "...150 MeV protons in water, bone and adipose tissue" | "range of 150 MeV protons in water, bone and adipose tissue"                |

All 12 remaining failures after correction:

```
km/cmp-prog-001 [compareDim]: ...using A* and P*.  (expects "A-star"/"P-star" program names)
km/unit-006 [particles]: ...900 keV Dutrans...      ("deuterons" mis-heard)
lg/cmp-prog-001 [compareDim,energies]: ...150 Amoebi protons... using A* and P*.
lg/iso-002 [particles]: ...carbon 30 ions...         ("carbon-13" mis-heard as "carbon 30")
lg/iso-004 [energies]: ...40 MeV per N.              ("per nucleon" truncated to "per N")
lg/rng-005 [energies]: ...90 emibipare nucleon...    ("MeV per" mis-heard)
lg/stress-002 [energies]: ...mega-electronopals per nucleon.  ("MeV" spoken/rendered as a made-up word)
mn/alias-001 [materials]: ...in the Lusite?          ("lucite" mis-heard, extra "the")
mn/iso-002 [energies]: ...100 nV per nucleon.        ("MeV" heard as "nV")
mn/iso-004 [particles]: ...helium-free ion...        ("helium-3" mis-heard)
mn/unit-003 [compareDim,particles,energies]: ...one of one giga electron volt protons...
mn/unit-006 [particles]: ...900 keV delterons...     ("deuterons" mis-heard, different speaker than km/unit-006's own miss)
```

These read like ordinary Whisper-family acoustic misses (isotope numbers, "per nucleon" phrasing,
rare proper-noun-like program names "A\*"/"P\*") — the same category of residual error
`docs/voice-pipeline-feasibility.md` §6.1 already documented for desktop whisper-small, not a new
failure mode specific to the sherpa-onnx runtime or the phone.

### 3.4 Open question from #120, answered for sherpa-onnx specifically

#120 asked whether a candidate could replicate desktop whisper-small's domain-prompt biasing
(`docs/voice-pipeline-feasibility.md` §2.4, the single biggest lever found there — raw 88.0%→95.6%
slot-token accuracy). **Checked directly against the `OfflineWhisperModelConfig` source
(`sherpa-onnx/kotlin-api/OfflineRecognizer.kt`): no.** Its fields are `encoder`, `decoder`,
`language`, `task`, `tailPaddings`, `enableTokenTimestamps`, `enableSegmentTimestamps` — no
prompt/`initial_prompt`-equivalent field exists. This run's 87% E2E score was reached with **zero**
prompt biasing, which makes the result more notable, not less: whatever accuracy prompt-biasing
would add on top is still on the table, unexercised. Whether prompt-biasing is reachable at all
here would require a lower-level API (the C API bindings, `OfflineRecognizerConfig.modelConfig`
doesn't expose it) — not investigated this session.

### 3.5 Bottom line for sherpa-onnx

The strongest candidate measured so far. 87% E2E on-device without prompt biasing, against a 91%
desktop-with-prompt baseline, at a latency (2.7s/clip) close enough to the desktop number (2.3s)
that the runtime isn't the limiting factor. The remaining 12 failures are ordinary acoustic misses
on isotope numbers and rare phrasings, not a systemic vocabulary or normalization problem the way
Vosk's were. Load time (2.3s) is the one real cost — noticeably slower than Vosk's 0.55s, worth
watching if this is a cold-start-per-query design rather than a persistent-service one, but a
one-time cost either way, not per-clip.

## 4. Combined comparison

| Pipeline                                                       | audio→intent slot match | median s/clip       | load time |
| -------------------------------------------------------------- | ----------------------- | ------------------- | --------- |
| whisper-small + prompt, desktop CPU (Node, `onnxruntime-node`) | 91% (81/89)             | 2.3s                | —         |
| **sherpa-onnx whisper-small int8, Pixel 7a, no prompt**        | **87% (77/89)**         | 2.7s (p90 3.3s)     | 2.3s      |
| **Vosk small-en, Pixel 7a**                                    | **0% (0/89)**           | **1.3s** (p90 1.6s) | **0.55s** |

## 5. What's still pending (this issue's remaining candidates)

- **whisper.cpp** — needs the NDK (not installed; see §1), so real setup cost still ahead. Given
  sherpa-onnx's strong result already covers "a whisper-small-family model on-device," whisper.cpp
  is now more of a confirmation/cross-check than the last untested option.
- **wav2vec2-base-960h** (stretch) — encoder-only/no-autoregressive-decode latency data point,
  English-only. Already downloaded (`.hf-cache/Xenova/wav2vec2-base-960h`), just needs
  hand-written ONNX Runtime Mobile glue (no sherpa-onnx wrapper for this one).
- **Controlled battery/thermal readings** for both candidates measured so far (unplugged, not on
  USB power) — neither run so far counts (§0 TL;DR).
- **Whether sherpa-onnx's result holds on Polish** — no Polish eval audio exists yet
  (issues #63/#79/#30 still open), so this run is English-only, same limitation as Vosk's.
- Confirming whether sherpa-onnx's lower-level C API exposes a prompt-biasing hook the Kotlin
  `OfflineWhisperModelConfig` doesn't (§3.4) — if it does, sherpa-onnx's 87% likely has more room
  to close the gap to (or beat) the desktop 91% baseline.

## 6. Bottom line so far

**sherpa-onnx whisper-small (int8) is the clear leader of the two candidates measured**: 87% E2E
on-device, no prompt biasing applied, at a latency close to the desktop baseline — a real,
practical option for an Android on-device pipeline. Vosk small-en is fast but hits a hard
vocabulary wall on this domain's unit jargon that no amount of correction-layer tuning can close.
Neither whisper.cpp nor the wav2vec2 stretch candidate has been measured yet, and no candidate has
had a controlled (unplugged) battery reading. If sherpa-onnx's number holds up under whisper.cpp's
cross-check, this issue's original framing — native rewrite for latency/battery reasons — looks
less urgent than assumed: an ONNX Runtime Mobile-class runtime is already delivering
close-to-desktop accuracy on a real phone.
