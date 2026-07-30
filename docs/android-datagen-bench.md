# Android benchmark data generator (issue #130)

Status: **Parts 1–4 done.** A real 100-prompt (50×EN+PL) session (speaker `lgpixel`, #149) has
been recorded, imported, and scored across all four ASR pipelines this project tracks: on-device
Parakeet-v3, on-device Whisper-small (sherpa-onnx), desktop Whisper-small+prompt, and on-device
whisper.cpp — see "Part 4 — Results" below. The whisper.cpp leg surfaced and fixed a real bug in
the bench harness itself (§4.4a): the JNI bridge hardcoded English decoding regardless of the
clip's actual language, silently mangling every Polish clip into English-shaped text instead of a
real transcript.

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

## Part 4 — Results (real session, speaker `lgpixel`, 2026-07-30)

Session recorded on the Pixel 7a via wifi adb (30.30.30.19), all 100 prompts (50×EN + 50×PL),
imported with `scripts/import-datagen-session.sh lgpixel` and landed in #149. Single speaker —
per the caveats below, treat everything here as anecdote, not a statistic, until a second
speaker exists.

**Repeat-check before scoring:** every WAV verified 4.1s–9.2s (consistent with sentence length,
no truncation/silence), and no take produced near-garbage transcripts on _both_ on-device models
simultaneously (the signal of a misread/corrupted take vs. an expected ASR miss). No retakes were
needed.

### 4.1 Cross-runtime headline numbers

Audio→intent slot-match (`scripts/e2e-audio-intents-datagen.ts`, corrected, n=50 per cell):

| Pipeline                                               | EN              | PL              |
| ------------------------------------------------------ | --------------- | --------------- |
| Parakeet-v3 int8, on-device (Pixel 7a, no prompt)      | **82%** (41/50) | 6% (3/50)       |
| Whisper-small int8, on-device (Pixel 7a, no prompt)    | 64% (32/50)     | 32% (16/50)     |
| Whisper-small q8, desktop CPU (Node, +`DOMAIN_PROMPT`) | 76% (38/50)     | **52%** (26/50) |
| whisper.cpp ggml-small-q8_0, on-device (Pixel 7a)      | 72% (36/50)     | 36% (18/50)     |

**Parakeet vs. Whisper is not a single winner — it depends on language.** Parakeet-v3 is the
clear best English pipeline (82%, no prompt needed) but is close to unusable on Polish (6%):
inspecting its raw Polish transcripts shows it isn't failing gracefully, it's mostly
_transliterating_ Polish speech into garbled English-shaped tokens ("zasięgion", "nucleon" for
"nukleon"), consistent with a model that was never meaningfully multilingual-tuned for this
domain despite loading a shared checkpoint for both languages. Every Whisper variant (sherpa-onnx
on-device, whisper.cpp on-device, desktop) is the more balanced choice — weaker than Parakeet on
English, but the only family usable on Polish at all, and desktop Whisper+prompt is a further
~16-20 point jump over both unprompted on-device Whisper runtimes on both languages, isolating the
domain-prompt's contribution independent of the on-device/desktop runtime split. whisper.cpp and
sherpa-onnx land within a few points of each other on both languages — consistent with both
wrapping the same underlying whisper-small checkpoint (`docs/android-asr-runtime-bench.md` §5.4
already found this for the fixed 30×3-speaker set; it holds here too).

### 4.2 Abbreviated vs. expanded energy rendering (n=5, directional only)

The 5 `energyRendering: "expanded"` records (`dg-04`, `dg-11`, `dg-22`, `dg-43`, `dg-44` — the
only `keV` and `GeV` instances in the set, plus 3 spelled-out `MeV` cases) missed the energy slot
on **every single on-device run**: 0/10 (5 ids × 2 languages) across both Parakeet and
Whisper-small, on-device. Sample raw transcripts: "500 kilo electron-a-volt" (`dg-04` EN,
Whisper), "1 giga electron of volt" (`dg-22` EN, Whisper), "1 GV" (`dg-22` EN, desktop Whisper —
closer, but still not a unit token any parser recognizes). This is n=5 by design (see
`eval/RECORDING.datagen.md`), so read the ratio as directional, not a percentage — but the signal
is unusually clean for that sample size, and it matches `docs/nemo-parakeet-comparison.md` §4.3's
finding that biasing toward a non-abbreviated energy reading hurts unit-slot accuracy (there,
90.2% → 66.3%). Real human speakers reading a spelled-out energy unit produce exactly the audio
that pipeline already knows it handles badly — this is not a synthesized-TTS-only artifact.

### 4.3 Residual #122 failure modes on human audio

- **`GeV` mishearing survives.** The sole `GeV` instance (`dg-22`) is also the sole `keV`
  instance's sibling in the expanded-energy group above — 0/10 energy-slot hits. Confirms #122's
  original synthetic-TTS concern reproduces on real human speech, not just TTS artifacts (n=1,
  noted as such).
- **"deuteron" is a Whisper-specific miss, not a universal one.** Whisper mis-transcribed
  "deuteron" in **all 3** English occurrences (`dg-05`/`dg-30`/`dg-46`): "dual-terron",
  "deuterine", "dewateron". Parakeet got all 3 right, in both languages. Not the "both models
  struggle equally" pattern the isotope-number and GeV findings show — a genuinely
  Whisper-specific gap.
- **"triton" is hard for both models, in both languages at times.** `dg-06` EN: Parakeet →
  "treeton", Whisper → "3 ton" (both wrong). `dg-06` PL: Parakeet correctly transcribes
  "trytonu"; Whisper still says "3 ton" (wrong even in Polish). The rarer light-ion names remain
  a weak spot regardless of model.
- **Isotope numbers are a Polish-specific failure, not an English one.** `dg-08` (helium-3) and
  `dg-34` (carbon-14): both models get the particle slot right in **English** ("helium three",
  "Helium-3", "carbon-14 ion") but **both fail in Polish** ("Janhew trzy", "jon hellu 3" for
  "jon helu-3"; "węgla czternaście"/"węgla 14" not resolving against "węgla-14"). A clean
  bilingual asymmetry — isotope numbers aren't inherently hard to hear, but the Polish rendering
  of them is currently harder for both ASR models than the English one.

### 4.4 Letter-spelled unit forms — already resolved, and this data confirms it wasn't needed here

`docs/unit-pronunciation-asr.md` had already added letter-spelled-unit rules
(`mev-letter-spelled`/`kev-letter-spelled`/`gev-letter-spelled`) to `EN_RULES` in
`src/lib/asr/correct/en.ts` (2026-07-26, its Recommendations §2) — not to `LEXICON`, because
`LEXICON`'s single-token fuzzy pass can't reach a multi-token escape like "M E V" from "MeV".
That closed the synthesized-TTS letter-spelling escape (`M-E-V`, `docs/unit-pronunciation-asr.md`
§1's `rng-0573`). This session's real human audio gives a fresh, independent check: searching
every Parakeet/Whisper raw transcript in `lgpixel`'s `session.json` for a letter-spelled-MeV/keV/GeV
pattern (`(?:em|m)[\s.,-]*(?:ee|e)[\s.,-]*(?:vee|v)`) finds **zero matches** across all 200
transcripts (100 clips × 2 models). Consistent with `docs/unit-pronunciation-asr.md` §8's lecture-clip
finding: on real speech, Whisper-family models either hear the unit token or drop it silently —
they don't tend to mis-spell it into a letter-by-letter escape the way synthesized "M E V" probe
audio does. **Conclusion: the letter-spelled corrector rule remains correctly scoped to the
synthesized-TTS failure mode it was built for; this real-audio session found no new evidence it's
needed more broadly, and the dominant real-audio failure mode (§4.2) is the unit token being
dropped/garbled, which no LEXICON- or regex-based post-ASR fix can recover — the token isn't in
the transcript to correct.**

### 4.4a A real bug found running whisper.cpp on Polish audio: hardcoded English decoding

The first whisper.cpp run against `lgpixel`'s Polish clips scored **0% raw / 2% corrected** —
wildly out of line with every other Polish number in §4.1 (6–52%). Raw transcripts showed why:
real Polish audio came back as English-shaped text — `"Jaki jest zasięg CSDA protonu..."` (actual
Polish, correctly read aloud) transcribed as `"What is the range of C-SDA proton of 150 MF in
water?"` — not garbled Polish, coherent (if wrong) **English**. Root cause, found in
`bench/android/whispercpp/app/src/main/jni/whisper/jni.c`: `params.language` was hardcoded to
`"en"` regardless of which clip was being transcribed, forcing whisper.cpp's language token
regardless of the actual spoken language. This bug predates this session — every prior use of
`BenchActivity` only ever benchmarked the fixed English-only `km`/`lg`/`mn` set
(`docs/android-asr-runtime-bench.md`), so it never had a Polish clip to expose this on.

**Fixed** (this session): threaded an explicit `language` parameter through the full call chain —
`BenchActivity.java` (derives `"pl"` from clip ids ending in `-pl`, `"en"` otherwise, matching
`scripts/import-datagen-session.sh`'s id convention) → `WhisperContext.transcribeData()`'s new
4-arg overload (3-arg overload kept, now defaulting to `"en"` for source compatibility) →
`WhisperLib.fullTranscribe()`'s native declaration → `jni.c`'s `params.language`. Rebuilt
(`./gradlew assembleDebug`), reinstalled, re-ran the 50 Polish clips only (English clips are
unaffected by this bug, since `"en"` was already the correct forced language for them — not
re-run). Result: **0% → 36%** (raw 8% → corrected 42% clip-level; 8% → 36% audio→intent,
§4.1's table) — now a real, sensible number in line with the other Polish scores, not an
artifact.

### 4.5 Caveats (carried over from #130, reaffirmed)

- **Phone mic ≠ Brio USB mic** — not directly comparable to `eval/audio/{km,lg,mn}` numbers.
- **Single speaker.** Every number above is one person's voice; treat as anecdote until a second
  speaker's session exists.
- **The phone dropping off wifi adb mid-run is a recurring hazard**, not a one-off — it happened
  twice in this session (once losing the connection entirely, once losing foreground focus and
  freezing the benchmark's background thread — Android suspends CPU work for backgrounded apps).
  Recovering from the second case: `adb shell input keyevent KEYCODE_WAKEUP`,
  `adb shell wm dismiss-keyguard`, then `adb shell am start -n <package>/.<Activity>` on the
  _same_ already-running activity resumes it in place ("its current task has been brought to the
  front") rather than restarting the benchmark from scratch — this bench has no per-clip
  resumability, so restarting from scratch would have re-transcribed everything already done.
- **Latency numbers throughout are not benchmark-grade** — live mic + UI + arbitrary thermal
  state, same caveat #130 always carried.

### 4.6 Unblocks

Answers #122 §7's Polish open question (isotope-number handling is the concrete residual gap,
§4.3 above) and gives #127 (Polish on-device validation) real numbers to validate against instead
of TTS-only data.

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
