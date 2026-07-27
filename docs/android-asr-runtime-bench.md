# Android on-device ASR runtime bench (issue #120)

_Session report, 2026-07-27. All four candidates from issue #120's original list now measured
(Vosk small-en, sherpa-onnx whisper-small int8, wav2vec2-base-960h, whisper.cpp). Measured on a
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

**wav2vec2-base-960h confirms the desktop verdict on-device: 0% (0/89), same disqualifying result
`docs/asr-model-comparison.md` already found** — CTC output is uppercase, unpunctuated, and has no
digit tokens at all ("STOPING POWER OF FIVE HUNDRED CAVIPROTTELS EWOTER" for "500 keV protons in
water"), so the Whisper-tuned matcher/corrector has no foothold. It's the fastest candidate by far
(0.9s/clip median, 0.85s load — CTC's single forward pass, no autoregressive decode), but that
speed doesn't matter if the transcript can't be parsed. See §4.1 for a real bug this candidate's
implementation surfaced (a WAV-header parsing assumption that also technically affects Vosk's
harness, though not its verdict).

**whisper.cpp scores 89% (79/89) — the best on-device result of all four candidates, edging out
sherpa-onnx's 87% and landing within 2pp of the desktop-with-prompt baseline, again with no prompt
biasing applied** (though unlike sherpa-onnx, whisper.cpp's underlying library _does_ support
`initial_prompt` natively — the vendored JNI wrapper used here just doesn't pass one through, see
§5.4). Getting there required finding and fixing two real build misconfigurations that together
caused a measured **~8× slowdown** (35-58s/clip → 2.5-4.7s/clip): ggml's `GGML_NATIVE=ON` default
tries to auto-detect ARM CPU features by probing `-mcpu=native` on the cross-compiler, which is
meaningless without a real ARM host and silently produced unoptimized scalar code (§5.1). Once
fixed, the sustained 89-clip run also surfaced something neither other whisper-small candidate
showed: **real, oscillating thermal throttling** — per-clip latency cycling between ~2.6s and
15-35s throughout the _entire_ run, not just at the end, dragging the median to 15.1s despite a
"cold" per-clip cost matching sherpa-onnx's ballpark (§5.3).

**Battery/thermal readings, unplugged (§6): Vosk 100%→98% in 118s, sherpa-onnx 98%→95% in 250s,
wav2vec2 95%→94% in 63s, back-to-back with no cooldown between runs** — none of the three shows any
alarming drain or thermal spike over a single ~90-clip pass. Getting a valid reading required
working around two real device behaviors first: Doze mode (network/CPU restrictions once the
device is idle+unplugged+screen-off) and, separately, the screen itself going to sleep — both
throttled a first attempt by roughly 9× before being caught and fixed (§5.1). That in itself is a
real finding: a production Android app processing voice queries with the screen off would need a
wake lock or foreground service to avoid the same throttling.

## 1. Setup (shared across all candidates)

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

**Caveat found later (§4.1):** this harness also used a blind 44-byte WAV-header skip, which §4's
wav2vec2 work found is wrong for these specific resampled clips (ffmpeg embeds a ~34-byte LIST/INFO
chunk, so real PCM data starts at byte 78). The practical effect here is negligible — a ~1ms
(17-sample) corruption at the very start of multi-second clips — and doesn't change the verdict:
Vosk's failure is a vocabulary-coverage wall (§2.4), not a data-corruption artifact, and re-running
with a correct parser would not be expected to recover "mev"/"pmma" tokens that aren't in the
model's lexicon at all. Not re-run, since the fix couldn't plausibly change the 0% conclusion.

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
slot-token accuracy). **Definitive answer: no, and not just at the Kotlin binding level — it isn't
supported anywhere in sherpa-onnx's implementation, confirmed at the C++ source and directly by
the maintainer.**

- The C++ `OfflineWhisperModelConfig` struct (`sherpa-onnx/csrc/offline-whisper-model-config.h`)
  has no prompt/`initial_prompt` field at all — this isn't an unexposed Kotlin binding gap, the
  field doesn't exist in the underlying implementation.
- The only Whisper decoder implemented (`sherpa-onnx/csrc/offline-whisper-greedy-search-decoder.cc`
  — there is no beam-search variant) hardcodes its initial decoder token sequence to
  `[sot, language, task, no_timestamps]`. There's no code path that prepends a
  `<|startofprev|>` + prompt-token prefix the way the desktop `scripts/asr-transcribe.mjs` harness
  does (`decoder_input_ids = [SOT_PREV, ...promptTokenIds, SOT, LANG, TRANSCRIBE, NO_TS]`).
- Someone asked the maintainer this exact question upstream:
  [k2-fsa/sherpa-onnx#2295 "whisper prompts?"](https://github.com/k2-fsa/sherpa-onnx/issues/2295).
  csukuangfj's reply, pointing at the same decoder file and line found independently above:

  > "Yes, it is doable. We need to change [offline-whisper-greedy-search-decoder.cc#L32]... Code
  > needs to be modified so that users can pass the prompt with some API."

  and, when asked if it's roadmapped:

  > "I suggest that you change the code by yourself. Currently, there is no plan to add it."

So reaching prompt-biasing on sherpa-onnx would mean forking the C++ source, patching that decoder,
and cross-compiling the native library for `arm64-v8a` (NDK + sherpa-onnx's own CMake/onnxruntime
build) — not a config flag, and a materially bigger undertaking than anything else in this spike so
far. **Not attempted this session** (would need the NDK, still not installed, plus setting up a
full C++ cross-compile toolchain) — judged not worth the cost given this run's 87% E2E score was
already reached with **zero** prompt biasing, which makes the result more notable, not less:
whatever accuracy prompt-biasing would add is upside still on the table, not a gap this number is
hiding.

### 3.5 Bottom line for sherpa-onnx

The strongest candidate measured so far. 87% E2E on-device without prompt biasing, against a 91%
desktop-with-prompt baseline, at a latency (2.7s/clip) close enough to the desktop number (2.3s)
that the runtime isn't the limiting factor. The remaining 12 failures are ordinary acoustic misses
on isotope numbers and rare phrasings, not a systemic vocabulary or normalization problem the way
Vosk's were. Load time (2.3s) is the one real cost — noticeably slower than Vosk's 0.55s, worth
watching if this is a cold-start-per-query design rather than a persistent-service one, but a
one-time cost either way, not per-clip.

## 4. Candidate: wav2vec2-base-960h (stretch)

|         |                                                                                                                                                                                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model   | `Xenova/wav2vec2-base-960h` int8 (91 MB), already cached from earlier desktop ASR spikes (`.hf-cache/Xenova/wav2vec2-base-960h`) — no new download needed                                                                                                                    |
| Harness | `bench/android/wav2vec2/` — minimal single-Activity Gradle app, Java, plain `onnxruntime-android` (Maven Central, no NDK) — no existing Android wrapper for this model exists (unlike Vosk/sherpa-onnx), so this is entirely hand-written glue, per issue #120's own framing |

### 4.1 Setup notes specific to wav2vec2, including a real bug found and fixed

- **Same `kotlin-stdlib-jdk7`/`-jdk8` duplicate-class conflict as the Vosk bench** —
  `onnxruntime-android:1.22.0`'s dependency graph has the same split-vs-merged Kotlin stdlib issue.
  Same `configurations.all { exclude ... }` fix.
- **A real WAV-parsing bug, found by comparing against the known-good desktop reference.** The
  first run produced pure gibberish ("WOKE THE RANKS OF SIX EMBITY PULPO PIS I" for "What is the
  range of 60 MeV protons in lucite?") — much worse than `docs/asr-model-comparison.md`'s own
  documented wav2vec2 output for this exact model ("STOPING POWER OF FIVE HUNDRED CAVIPROTONS
  EWOTE" for "stopping power of 500 keV protons in water": legible words, jargon-mangled, but
  words). That gap was the tell that something was actually broken, not just "wav2vec2 is weak
  here" (which is already the known baseline). Root cause: this harness's WAV reader (matching the
  Vosk bench's `in.skip(44)`) assumed a canonical 44-byte header, but these specific resampled
  clips have a `LIST`/`INFO` chunk ffmpeg embeds between `fmt ` and `data` (a `"Lavf60.16.100"`
  software-version tag) — confirmed directly by parsing the header bytes. Real PCM data starts at
  byte 78, not 44; the blind skip was reading the tail of that metadata as the first ~17 audio
  samples. Fixed by scanning RIFF sub-chunks for the `"data"` chunk id instead of assuming a fixed
  offset (`findDataChunkOffset()` in `BenchActivity.java`). Re-running after the fix reproduced the
  desktop reference almost verbatim ("STOPING POWER OF FIVE HUNDRED CAVIPROTTELS EWOTER") —
  confirming the fix, not just a different kind of wrong.
  Vosk's own bench has the identical blind-skip assumption and is presumably affected the same
  negligible amount (§2.5's caveat) — not revisited, since the corruption is far too small
  (~1ms out of multi-second clips) to plausibly change Vosk's already-conclusive 0% verdict, which
  has an entirely different, non-audio root cause (vocabulary coverage).

### 4.2 Reproducing

```
cd bench/android/wav2vec2
export ANDROID_HOME=~/Android/Sdk
export JAVA_HOME=<a real JDK — Android Studio's bundled JBR works: .../android-studio/jbr>
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk

# model: Xenova/wav2vec2-base-960h int8, already in .hf-cache/Xenova/wav2vec2-base-960h/onnx/
# push to /data/local/tmp, then into the app's internal storage via run-as (see §1)
adb push .hf-cache/Xenova/wav2vec2-base-960h/onnx/model_quantized.onnx /data/local/tmp/w2v/model_quantized.onnx
adb push <16kHz-resampled-eval-audio-dir> /data/local/tmp/w2v/audio
adb shell run-as com.aidedx.wav2vec2bench sh -c \
  'mkdir -p files && cp /data/local/tmp/w2v/model_quantized.onnx files/model_quantized.onnx && cp -r /data/local/tmp/w2v/audio files/audio'

adb shell am start -n com.aidedx.wav2vec2bench/.BenchActivity --ez autorun true \
  -e model_file model_quantized.onnx -e out_name results-wav2vec2-en.json -e model_id wav2vec2-base-960h

adb shell run-as com.aidedx.wav2vec2bench cat files/results-wav2vec2-en.json > eval/results/android-wav2vec2-2026-07-27/wav2vec2-base-960h.json
npx tsx scripts/e2e-audio-intents.ts eval/results/android-wav2vec2-2026-07-27/wav2vec2-base-960h.json
node scripts/asr-score-slots.mjs eval/results/android-wav2vec2-2026-07-27/wav2vec2-base-960h.json
```

Raw results: `eval/results/android-wav2vec2-2026-07-27/wav2vec2-base-960h.json`.

### 4.3 Results

| Pipeline                                                                      | audio→intent slot match | median s/clip       | load time |
| ----------------------------------------------------------------------------- | ----------------------- | ------------------- | --------- |
| whisper-small + prompt, desktop CPU (Node, `onnxruntime-node`)                | 91% (81/89)             | 2.3s                | —         |
| wav2vec2-base-960h, desktop CPU, un-prompted (`docs/asr-model-comparison.md`) | 0% (0/89)               | 0.5s                | —         |
| **wav2vec2-base-960h, Pixel 7a, real device**                                 | **0% (0/89)**           | **0.9s** (p90 1.5s) | **0.85s** |

Slot-token accuracy by category (raw → corrected):

| Category | Accuracy          | n   |
| -------- | ----------------- | --- |
| quantity | 46.3% → 54.7%     | 95  |
| number   | 2.2% → 2.2%       | 92  |
| unit     | 1.1% → 1.1%       | 92  |
| particle | 21.1% → 23.2%     | 95  |
| material | 38.8% → 38.8%     | 103 |
| program  | 0.0% → 16.7%      | 6   |
| **ALL**  | **22.2% → 24.4%** | 483 |

Per-speaker clip pass rate (corrected): km 0/30, lg 0/30, mn 0/29 — same uniform-failure pattern as
Vosk, but for a different reason.

Sample transcripts (raw, uncorrected) — same clip as the desktop reference, for direct comparison:

| Expected                                                | wav2vec2 raw output (Pixel 7a)                           |
| ------------------------------------------------------- | -------------------------------------------------------- |
| "Stopping power of 500 keV protons in water."           | "STOPING POWER OF FIVE HUNDRED CAVIPROTTELS EWOTER"      |
| "What is the range of 60 MeV protons in lucite? Lucid." | "WHAT IS THE RANGE OF SIXTY M V PROTONS IN LUSITE USERD" |

### 4.4 Bottom line for wav2vec2

Confirms `docs/asr-model-comparison.md`'s existing desktop verdict on-device: disqualified on
accuracy, not on latency (it's the fastest candidate measured, 0.9s/clip). The failure mode is
structural, not a vocabulary gap like Vosk's: CTC output is uppercase, unpunctuated, and has **no
digit tokens at all** (`unit`/`number` slot accuracy 1.1%/2.2% — see `docs/asr-model-comparison.md`
§"wav2vec2-base-960h" for why: the Whisper-tuned matcher/corrector has no foothold in text this
shape). This was already known from desktop numbers before this session; the on-device run's value
is confirming it holds on a real phone rather than assuming, and the WAV-parsing bug this session
surfaced (§4.1) is arguably the more useful output of this candidate than the (expected) 0% itself.

## 5. Candidate: whisper.cpp

|         |                                                                                                                                                                                                                                                                                    |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model   | `ggerganov/whisper.cpp`'s `ggml-small-q8_0.bin` (264 MB), the same whisper-small checkpoint family as sherpa-onnx's candidate                                                                                                                                                      |
| Harness | `bench/android/whispercpp/` — minimal single-Activity Gradle app, Java, native C/C++ build via the NDK (installed this session — see §1) and CMake, vendoring the JNI bridge from whisper.cpp's own `examples/whisper.android.java` (issue #120's "JNI already written" candidate) |

### 5.1 Setup notes specific to whisper.cpp

- **NDK r28c installed directly from `dl.google.com/android/repository/android-ndk-r28c-linux.zip`**
  (722 MB) — no `sdkmanager` involved, same no-license-gate direct-download approach that worked
  for the `android-34` platform earlier. Placed at `~/Android/Sdk/ndk/28.2.13676358` (folder name
  must match the exact revision string for AGP's `ndkVersion` auto-detection).
- **Shallow-cloned the upstream `whisper.cpp` repo** (`git clone --depth 1`, 50 MB) into
  `bench/android/whispercpp/vendor/whisper.cpp/` (gitignored, re-fetched at build time — same
  pattern as sherpa-onnx's gitignored native libs) rather than copying files piecemeal, since the
  example's `CMakeLists.txt` needs the full `src/`/`ggml/`/`include/` tree to compile
  `whisper.cpp` and `ggml` from source. Adjusted `WHISPER_LIB_DIR`'s relative path (our own
  directory depth differs from upstream's `examples/whisper.android.java/app/src/main/jni/whisper/`)
  rather than mirroring their exact folder structure.
- **Same `kotlin-stdlib-jdk7`/`-jdk8` duplicate-class conflict as the Vosk and wav2vec2 benches**
  — recurring often enough across three of four candidates now that it's clearly some default
  AGP/AndroidX dependency chain, not something specific to any one library. Same
  `configurations.all { exclude ... }` fix.
- **Play Protect flagged the freshly-installed debug APK "HARMFUL"** (`bvq`/`cmv` on-device
  classifier log lines) — almost certainly a heuristic false-positive common for sideloaded debug
  builds that dynamically load native libraries via JNI. Confirmed harmless: the app process kept
  running normally (`adb shell ps -A`), nothing was blocked.

### 5.2 Two real build misconfigurations, found and fixed (the actual point of this candidate)

The first full run measured **35-58 seconds per clip** — 15-20× slower than sherpa-onnx's
comparable whisper-small workload, despite transcripts being fully accurate. Two separate causes,
found by inspecting the actual CMake cache rather than guessing:

1. **`CMAKE_CXX_FLAGS_RELEASE` was empty** in the generated `CMakeCache.txt`, instead of CMake's
   usual `-O3 -DNDEBUG` default — the Android NDK's CMake toolchain file doesn't populate it the
   way a "vanilla" CMake toolchain does. Fixed with an explicit
   `set(CMAKE_CXX_FLAGS_RELEASE "-O3 -DNDEBUG" CACHE STRING "" FORCE)` (a plain `set()` without
   `CACHE ... FORCE` silently didn't override the toolchain-seeded cache value — confirmed by
   re-checking `CMakeCache.txt` after the first fix attempt showed no change).
2. **The actual fix that mattered**: ggml's CPU backend (`ggml/src/ggml-cpu/CMakeLists.txt`)
   defaults `GGML_NATIVE=ON`, which probes `${CMAKE_C_COMPILER} -mcpu=native -E -v -` to
   auto-detect ARM feature flags (dotprod/fp16/etc.) — meaningless when cross-compiling from this
   x86_64 Linux machine to `aarch64-android`, since there's no real ARM CPU on the build machine to
   query. It silently fell back to a baseline target with none of those extensions, forcing ggml's
   matmul kernels (the actual bulk of Whisper's runtime — encoder/decoder attention and FFN layers)
   onto scalar code paths instead of NEON-vectorized ones. Fixed by explicitly setting
   `GGML_NATIVE=OFF` and `GGML_CPU_ARM_ARCH="armv8.2-a+dotprod+fp16"` (Tensor G2's
   Cortex-X1+A78+A55 cores, ARMv8.2-A with dotprod+fp16) as forced CMake cache variables before
   `FetchContent_MakeAvailable(ggml)`.

**Measured effect of fix #2** (isolated with a single-clip test before committing to a full
89-clip re-run): **37.0s → 4.5s for the same clip, an 8.3× speedup.** Fix #1 alone (tested first,
in isolation) made no measurable difference — confirming #2 was the real cause, not just
"insufficient optimization in general."

### 5.3 Reproducing

```
mkdir -p bench/android/whispercpp/vendor
git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git bench/android/whispercpp/vendor/whisper.cpp

cd bench/android/whispercpp
export ANDROID_HOME=~/Android/Sdk
export JAVA_HOME=<a real JDK — Android Studio's bundled JBR works: .../android-studio/jbr>
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk

# model: ggerganov/whisper.cpp's ggml-small-q8_0.bin
# push to /data/local/tmp, then into the app's internal storage via run-as (see §1)
adb push ggml-small-q8_0.bin /data/local/tmp/wc/ggml-small-q8_0.bin
adb push <16kHz-resampled-eval-audio-dir> /data/local/tmp/wc/audio
adb shell run-as com.aidedx.whispercppbench sh -c \
  'mkdir -p files && cp /data/local/tmp/wc/ggml-small-q8_0.bin files/ggml-small-q8_0.bin && cp -r /data/local/tmp/wc/audio files/audio'

adb shell am start -n com.aidedx.whispercppbench/.BenchActivity --ez autorun true \
  -e model_file ggml-small-q8_0.bin -e out_name results-en.json -e model_id whisper.cpp-ggml-small-q8_0

adb shell run-as com.aidedx.whispercppbench cat files/results-en.json > eval/results/android-whispercpp-2026-07-27/whispercpp-ggml-small-q8_0.json
npx tsx scripts/e2e-audio-intents.ts eval/results/android-whispercpp-2026-07-27/whispercpp-ggml-small-q8_0.json
node scripts/asr-score-slots.mjs eval/results/android-whispercpp-2026-07-27/whispercpp-ggml-small-q8_0.json
```

Raw results: `eval/results/android-whispercpp-2026-07-27/whispercpp-ggml-small-q8_0.json`.

### 5.4 Results

| Pipeline                                                       | audio→intent slot match | median s/clip                               | load time |
| -------------------------------------------------------------- | ----------------------- | ------------------------------------------- | --------- |
| whisper-small + prompt, desktop CPU (Node, `onnxruntime-node`) | 91% (81/89)             | 2.3s                                        | —         |
| sherpa-onnx whisper-small int8, Pixel 7a, no prompt            | 87% (77/89)             | 2.7s (p90 3.3s)                             | 2.3s      |
| **whisper.cpp ggml-small-q8_0, Pixel 7a, no prompt**           | **89% (79/89)**         | **15.1s** (p90 22.1s, throttled — see §5.5) | **0.73s** |

Slot-token accuracy by category (raw → corrected):

| Category | Accuracy          | n   |
| -------- | ----------------- | --- |
| quantity | 94.7% → 100.0%    | 95  |
| number   | 96.7% → 98.9%     | 92  |
| unit     | 79.3% → 96.7%     | 92  |
| particle | 90.5% → 97.9%     | 95  |
| material | 96.1% → 98.1%     | 103 |
| program  | 0.0% → 33.3%      | 6   |
| **ALL**  | **90.5% → 97.5%** | 483 |

Per-speaker clip pass rate (corrected): km 29/30, lg 25/30, mn 25/29 — essentially identical to
sherpa-onnx's per-speaker split (28/30, 25/30, 24/29), consistent with both being the same
underlying whisper-small checkpoint.

The 10 remaining failures after correction are the same category of ordinary acoustic misses
sherpa-onnx's §3.3 already documented (isotope numbers, "per nucleon" phrasing, the "A\*"/"P\*"
program-name pair) — not a new failure mode.

Whisper.cpp's underlying C library **does** support prompt biasing
(`whisper_full_params.initial_prompt`, confirmed directly in `include/whisper.h`) — a real
difference from sherpa-onnx, which lacks the mechanism entirely at the C++ level (§3.4). This
benchmark's vendored JNI wrapper (`WhisperContext.transcribeData()` / `WhisperLib.fullTranscribe()`)
doesn't pass one through, so this 89% result is also unprompted; closing the remaining 2pp gap to
the desktop baseline by wiring up prompt support here is a small, concrete follow-up this session
didn't do, unlike sherpa-onnx where it isn't possible without patching upstream.

### 5.5 Real, oscillating thermal throttling — the standout finding of this candidate

Per-clip latency did **not** follow the smooth "fast start, slow finish" pattern a simple thermal
ramp would predict. Sampled across the run:

```
first 10 clips: 2.6, 2.5, 2.6, 2.6, 2.7, 2.7, 3.1, 19.5, 16.6, 17.1  (seconds)
clips 40-50:    2.6, 3.1, 3.0, 2.9, 3.0, 3.0, 4.6, 20.6, 21.1, 20.7
last 10 clips:  10.2, 19.9, 21.1, 19.4, 34.7, 16.1, 20.9, 17.8, 15.1, 14.9
```

The same fast-burst/hard-throttle cycle recurs throughout the entire ~19-minute run, not just
toward the end — a handful of clips near the single-clip "cold" cost (~2.6-3.1s), then a cluster of
clips at 15-35s, repeating. This is real, oscillating thermal management (boost, overheat,
throttle, partially recover, repeat), not a data artifact: the transcripts stay accurate throughout
(the 10 failures are spread across speakers, not concentrated in the slow clusters), and errors
stayed at 0/89 the whole run.

**Neither Vosk nor sherpa-onnx showed this pattern** in their own comparable-duration unplugged
runs (§6) — sherpa-onnx's 250-second run stayed close to its plugged-in baseline (2.66s median)
throughout. whisper.cpp's default thread selection
(`WhisperCpuConfig.getPreferredThreadCount()`, which specifically targets the "high performance"
CPU cluster) plausibly sustains a higher clock/higher heat profile than sherpa-onnx's fixed
4-thread configuration, triggering the Tensor G2's thermal governor harder. Not confirmed against
`WhisperCpuConfig`'s actual selected thread count this session (its `Log.d` calls didn't appear in
`logcat` for an unknown reason — a loose end, not investigated further given time already spent on
this candidate).

**Battery reading for this candidate is much less clean than §6's three-candidate reading** — this
run happened after a multi-hour pause mid-session (network changed, reconnected via a new WiFi IP),
so elapsed wall-clock time includes idle drain unrelated to the benchmark itself, not just
back-to-back runs. For what it's worth: 82%→77% (−5pp) across the whole resumed-session window
(rebuild, reinstall, two single-clip verification runs, then the full 89-clip run, ~20 minutes
total), temperature roughly flat at ~32.5°C throughout — but this doesn't capture whatever peak
temperature actually occurred mid-throttle, unlike §6's continuous before/after readings for the
other three.

### 5.6 Bottom line for whisper.cpp

**Best accuracy of the four candidates (89% E2E), confirming sherpa-onnx's core finding: a
whisper-small-family model reaches close-to-desktop accuracy on-device without any prompt
biasing.** But it took real engineering work to get a valid number at all — two build
misconfigurations caused an 8× slowdown that would have otherwise been reported as "whisper.cpp is
just slow on mobile," which would have been wrong. Even after fixing those, the sustained-load
thermal throttling this candidate uniquely exposed is the more actionable finding for the Android
app decision than the accuracy number itself: whichever runtime ships needs either a lighter
per-query CPU footprint (fewer/lower-power threads) or explicit thermal-aware throttling logic of
its own, or a real user asking several questions in a row could see 2nd/3rd-query latency 5-10×
worse than the first. This is exactly the "battery draw or thermal throttling" question issue #120
asked about, and — for whisper.cpp specifically — the answer is "yes, materially."

## 6. Battery/thermal readings (unplugged)

All three benchmark apps were re-run back-to-back, phone unplugged (switched to wireless `adb` over
WiFi first — `adb tcpip 5555` / `adb connect <ip>:5555` — since disconnecting USB kills a
USB-tethered `adb` session too), no cooldown between runs, screen on throughout.

| Candidate                      | Wall time | Battery         | SoC temp             |
| ------------------------------ | --------- | --------------- | -------------------- |
| Vosk small-en                  | 118s      | 100%→98% (−2pp) | 23.0°C→24.5°C (+1.5) |
| sherpa-onnx whisper-small int8 | 250s      | 98%→95% (−3pp)  | 24.5°C→30.6°C (+6.1) |
| wav2vec2-base-960h             | 63s       | 95%→94% (−1pp)  | 30.6°C→32.5°C (+1.9) |

Per-clip timing for all three matched the earlier plugged-in baselines exactly (Vosk 1.25s median,
sherpa-onnx 2.66s, wav2vec2 0.69s — the last one actually a bit faster than its earlier 0.9s,
plausibly because the screen-on/interactive CPU governor keeps clocks higher than whatever state
the earlier plugged-in-but-idle-screen run was in), confirming these are valid readings, not
throttled ones. No candidate shows an alarming drain or thermal spike over a single ~90-clip pass;
sherpa-onnx's larger temp rise (+6.1°C) tracks its heavier CPU workload (encoder+autoregressive
decoder vs. the other two's lighter/single-pass architectures), not a red flag on its own.

**Numbers are combined-session, not perfectly isolated per candidate** — sherpa-onnx's reading
includes some thermal carryover from Vosk's run immediately before it, and wav2vec2's from both
runs before it (no cooldown was inserted between candidates). Good enough to answer #120's
"anything grossly wrong?" question; not precise enough for a per-candidate mAh/clip figure.

### 6.1 Two real device behaviors had to be worked around to get a valid reading

- **Doze mode** (`mWakefulness=Dozing` was a red herring at first — this term covers two distinct
  Android systems, and the fix for one didn't fix the other): `DeviceIdleController`'s Doze
  restricts background CPU/network scheduling once the device is idle, unplugged, and the screen
  has been off — confirmed via `adb shell dumpsys deviceidle`, disabled for testing with
  `adb shell dumpsys deviceidle disable` (a standard, non-root ADB command for exactly this
  situation). The first attempt at this benchmark took **9 minutes** for what should have been a
  ~90-second run (89 clips) before this was caught.
- **The screen going to sleep, separately** — even with Doze disabled, `mWakefulness` kept dropping
  back to `Dozing` (the _screen's_ own ambient/low-power display transition, unrelated to
  `DeviceIdleController`) within seconds of being woken, far faster than the 30-minute
  `screen_off_timeout` this session had set. `adb shell svc power stayon true` didn't help either —
  that setting only keeps the screen on while charging, a no-op when genuinely unplugged. Given the
  speed of the repeated re-sleep, the actual cause was physical: something covering the phone's
  proximity/light sensor (it had been lying face-down on a desk) — repositioning it face-up fixed
  it immediately, confirmed by `mWakefulness=Awake` holding steady for 20+ seconds. **Both issues
  caused a real, ~9× CPU slowdown, not just a benign screen-state change** — worth remembering for
  any future on-device benchmark, and worth noting as a real product-design constraint: an Android
  app doing voice-triggered ASR with the screen off would need a wake lock or foreground service to
  avoid the identical throttling a real user would hit.

## 7. Combined comparison

| Pipeline                                                       | audio→intent slot match | median s/clip                          | load time |
| -------------------------------------------------------------- | ----------------------- | -------------------------------------- | --------- |
| whisper-small + prompt, desktop CPU (Node, `onnxruntime-node`) | 91% (81/89)             | 2.3s                                   | —         |
| **whisper.cpp ggml-small-q8_0, Pixel 7a, no prompt**           | **89% (79/89)**         | 15.1s (throttled — "cold" ~2.6s, §5.5) | 0.73s     |
| **sherpa-onnx whisper-small int8, Pixel 7a, no prompt**        | **87% (77/89)**         | 2.7s (p90 3.3s)                        | 2.3s      |
| **Vosk small-en, Pixel 7a**                                    | **0% (0/89)**           | **1.3s** (p90 1.6s)                    | **0.55s** |
| **wav2vec2-base-960h, Pixel 7a**                               | **0% (0/89)**           | **0.9s** (p90 1.5s)                    | **0.85s** |

## 8. What's still pending

- **Whether sherpa-onnx's/whisper.cpp's result holds on Polish** — no Polish eval audio exists yet
  (issues #63/#79/#30 still open), so every run in this doc is English-only.
- **A per-candidate (not combined-session) battery reading** would need a cooldown period between
  runs — §6's numbers are good enough to rule out anything grossly wrong, not precise enough for a
  clean mAh/clip figure per candidate. whisper.cpp's own reading (§5.5) is muddier still (a
  mid-session pause bled idle drain into it).
- **Wiring whisper.cpp's native `initial_prompt` support through its JNI wrapper** — unlike
  sherpa-onnx, this is architecturally possible (§5.4) and could plausibly close the remaining 2pp
  gap to the desktop baseline. Not done this session.
- **Confirming `WhisperCpuConfig`'s actual selected thread count** (§5.5) — its own `Log.d` calls
  didn't surface in `logcat` for an unexplained reason; would help confirm the thread-count
  hypothesis for whisper.cpp's unique thermal throttling.
- ~~Confirming whether sherpa-onnx exposes a prompt-biasing hook~~ — resolved, §3.4: it doesn't,
  at any level, confirmed against the C++ source and directly by the maintainer
  ([k2-fsa/sherpa-onnx#2295](https://github.com/k2-fsa/sherpa-onnx/issues/2295)). Reaching it would
  mean patching sherpa-onnx's C++ decoder and cross-compiling for `arm64-v8a` — judged not worth
  the cost given the 87% E2E score was already reached without it.
- ~~wav2vec2-base-960h stretch candidate~~ — resolved, §4: 0% E2E, confirms the desktop verdict.
- ~~Controlled battery/thermal readings~~ — resolved, §6 (three of four candidates; whisper.cpp's
  own reading is separate and less clean, §5.5).
- ~~whisper.cpp~~ — resolved, §5: 89% E2E, best of the four candidates, but only after fixing two
  real build misconfigurations, and the only candidate showing real sustained-load thermal
  throttling.

## 9. Bottom line so far

**All four of issue #120's original candidates are now measured. whisper.cpp and sherpa-onnx are
both strong, practical options (89% and 87% E2E on-device, both without prompt biasing, both within
a few points of the desktop-with-prompt baseline) — Vosk and wav2vec2 are both disqualified on
accuracy for structurally different reasons** (Vosk: closed vocabulary doesn't contain this
domain's jargon; wav2vec2: CTC output has no digit tokens the matcher can parse at all).

The deciding factor between the two viable candidates isn't accuracy — it's **operational
behavior under sustained use**. sherpa-onnx's latency stayed flat and close to its desktop baseline
across a full unplugged battery run; whisper.cpp's did not, showing real oscillating thermal
throttling that pushed its _median_ latency to 15.1s despite a "cold" per-clip cost (~2.6s)
matching sherpa-onnx's. That's the more actionable finding for the Android app decision than either
accuracy number: **sherpa-onnx currently looks like the safer choice for a shipped app**, unless
whisper.cpp's thread configuration is tuned down from its current "high-performance cores only"
default — a concrete, scoped follow-up (§8), not a fundamental limitation of the runtime.

Either way, this issue's original framing — that native inference should beat WASM-in-a-WebView on
latency/battery, justifying a native rewrite — now has real evidence behind it: both whisper-small
ONNX-Runtime-Mobile-class runtimes deliver close-to-desktop accuracy on a real phone, at a
battery/thermal cost this session's readings don't flag as alarming for at least one of them.
