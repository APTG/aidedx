# Android ASR runtime bench (issue #120) — session scoping report + runbook

_Session report, 2026-07-23 (cloud). Cloud/remote Claude Code session (no physical machine, no
Android device). This pass could **not** produce the on-device latency/battery/accuracy numbers
issue #120 asks for — that requires a real Android phone, an Android SDK/NDK toolchain, and network
access to Hugging Face / GitHub release assets, none of which this environment has (confirmed
empirically in §0, not assumed). **Issue #120 stays open and unresolved; §6's results table is a
template with every cell unfilled**, to be completed on a local machine per this repo's
continuation._

**Update, same day, local machine session**: network access to Hugging Face/GitHub/alphacephei.com
turned out to be unrestricted here, and there's enough disk (400+ GB free) to build and run all
three CLI-level runtimes directly — still **no Android device, SDK, or `adb`** on this machine, so
§6's real-device table is still unfilled, but §3 (new) adds real **desktop CPU** numbers for
whisper.cpp, sherpa-onnx, and Vosk against the same 89-clip eval set, which meaningfully de-risks
the Android runbook (confirms the exact model files download and run correctly, confirms
whisper.cpp's `--prompt` mechanism works cleanly, and — the most consequential finding — confirms
Vosk's grammar-constrained mode has a hard blocker the issue didn't anticipate, see §3.4).

What this pass did do, so the local continuation starts from further along than the issue text
alone:

- Confirmed candidate details — file sizes, licenses, Android integration paths, and (critically)
  whether each candidate can replicate this project's domain-prompt biasing — via web research that
  doesn't require downloading any model weights (§1).
- Answered the issue's three open questions as far as documentation allows (§2) — one of them
  (sherpa-onnx's prompt support) turned up a real, citable negative finding, not just a gap.
- **(added this session)** Built/ran all three CLI runtimes on desktop CPU against the real 89-clip
  eval set — real E2E accuracy and latency numbers, not just desk research (§3). This also directly
  answers Open Question 2 (§2), which desk research explicitly could not.
- Designed a JSON output contract so on-device results, once produced, score with this repo's
  **existing, unmodified** `scripts/e2e-audio-intents.ts` / `scripts/asr-score-slots.mjs` — no new
  scoring code needed (§4, was §3).
- Wrote a step-by-step runbook (§5, was §4) and two helper scripts
  (`scripts/android-asr-fetch-models.sh`, `scripts/android-asr-battery-bench.sh`) for the parts that
  need a real device/network/SDK, plus three new desktop-benchmark scripts added this session
  (§3, §7).

## 0. What this session could and couldn't do (environment audit)

| Requirement                                                              | Status in this session                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android SDK / NDK / `adb` / emulator                                     | Not installed (`ANDROID_HOME`/`ANDROID_SDK_ROOT` both unset, no `sdkmanager` on `PATH`). `gradle` (`/opt/gradle/bin/gradle`) and JDK 21 are present but cannot build an Android module without the SDK platform + NDK — confirmed there's no path to a working build here regardless of what source files exist. |
| Network to `huggingface.co`                                              | Blocked — `curl -I` on a `ggerganov/whisper.cpp` model file returned `403 Forbidden` **from this environment's own outbound proxy**, not from Hugging Face itself (i.e. this container's network policy rejects the CONNECT tunnel to that host). `WebFetch` on the same domain also returned 403.               |
| Network to `alphacephei.com` (Vosk's official model host)                | Also blocked via `WebFetch` (403).                                                                                                                                                                                                                                                                               |
| General web search, GitHub, some doc sites (`k2-fsa.github.io`, in part) | Reachable — all research in §1–§2 came from these.                                                                                                                                                                                                                                                               |
| A real Android phone                                                     | Not available in a cloud container — never in scope for this environment.                                                                                                                                                                                                                                        |

This matches the issue's own `needs-local-machine` label and the task author's stated expectation
going in ("I know that working in claude code you may face some limits in downloading model weights
due to their size or firewall protections") — a confirmation, not a surprise.

## 1. Candidate research confirmed this session

### 1.1 whisper.cpp

- **License**: MIT (confirmed from the repo page).
- **Android example**: `examples/whisper.android` (Kotlin, JNI bindings to the C++ library) and a
  separate `whisper.android.java` community fork/example — confirmed. Setup is: copy a `.bin` model
  into `app/src/main/assets/models`, copy a sample `.wav` into `app/src/main/assets/samples`, select
  the **release** build variant in Android Studio, deploy. The upstream README explicitly recommends
  tiny/base for on-device use, not small — worth re-checking device headroom before committing to
  small as the like-for-like comparison point.
- **Runtime RAM** (not the same thing as the ≤0.5 GB _download_ budget the issue sets): tiny
  ≈273 MB, base ≈388 MB, **small ≈852 MB** resident at inference time, per the project's own memory
  table. This is a real risk worth flagging before the local run: a phone that's fine with a 190–264 MB
  _file_ can still struggle if inference alone wants ~850 MB of RAM alongside the rest of Android. Not
  disqualifying, but budget it into which test device gets used.
- **Model file sizes** — the issue body states `ggml-small-q5_1.bin` (190 MB) and `ggml-small-q8_0.bin`
  (264 MB) from `ggerganov/whisper.cpp` on Hugging Face. **Not independently re-confirmed this
  session** (huggingface.co is blocked here, §0) — relayed from the issue text, verify the actual
  file size after downloading (`scripts/android-asr-fetch-models.sh` prints it).
- **Domain-prompt biasing**: `whisper_full_params` has an `initial_prompt` field, and the CLI
  (`main`/`whisper-cli`) exposes it as `--prompt "..."` — confirmed via secondary sources (Ruby
  bindings docs, DeepWiki), consistent with well-documented whisper.cpp behavior. **Not confirmed
  this session**: whether the packaged `whisper.android` example's JNI wrapper actually surfaces
  `initial_prompt` as a settable option, or whether that's a small patch the local run needs to add.
  This is the first concrete local-verification task in §5.
  **Update (desktop session)**: the underlying mechanism itself is confirmed clean — `whisper-cli
--prompt "..."` does not echo the prompt text into the output transcript (unlike this project's
  own `asr-transcribe.mjs`, which has to strip a prompt-prefix as a workaround for
  `@huggingface/transformers` lacking a direct `initial_prompt` param, see §3.1). What's still
  unconfirmed is only whether the packaged Android example's Kotlin/JNI wrapper exposes this same
  CLI flag as a UI-settable option — the desktop session couldn't test that (no Android build
  here), so it remains the local Android TODO.

### 1.2 sherpa-onnx

- **Whisper-small int8 ONNX size**: **≈239 MB** (encoder+decoder combined; fp32 is ≈783 MB), per
  sherpa-onnx's own "Export Whisper to ONNX" docs page.
  **Correction (desktop session)**: the actual downloaded bundle
  (`sherpa-onnx-whisper-small.tar.bz2` from the URL §5.1's fetch script uses) measures
  **108 MB (encoder) + 251 MB (decoder) = 359 MB combined int8** — noticeably more than the ≈239 MB
  the docs page estimate suggested, though still comfortably under the 0.5 GB budget. Use 359 MB as
  the real number going forward; see §3.2. This directly answers the issue's **Open
  Question 3** — well under the 0.5 GB budget, not just an extrapolation from the tiny.en numbers as
  the issue worried. Re-confirm against the live docs page before relying on it for a final go/no-go
  (a second fetch of the same page 403'd later in this session — plausibly a rate limit, not a
  retraction, but re-check).
- **Android**: sherpa-onnx ships a Kotlin API (small surface — data classes + config objects, e.g.
  `OfflineRecognizer`/`OfflineTts`-style wrappers) and an Android AAR. The repo is large and ships
  demo apps per model family; this session did not get a direct, pinned citation to a
  **whisper-specific** Android demo app (only general confirmation that the Android/Kotlin
  integration exists and that at least one third-party app — `phone-whisper` — already wraps
  sherpa-onnx's Whisper on Android). Check `android/` in `k2-fsa/sherpa-onnx` directly once GitHub
  access is unconstrained (works fine on a normal machine).
- **Domain-prompt biasing — real finding, not just unconfirmed**: sherpa-onnx has **no
  `initial_prompt` mechanism for its Whisper models**. GitHub issue
  [k2-fsa/sherpa-onnx#2295](https://github.com/k2-fsa/sherpa-onnx/issues/2295) ("whisper prompts?"),
  opened June 2025, was still open with no maintainer response as of this session. This answers the
  issue's **Open Question 1** for candidate 2 directly: **no**, domain-prompt biasing has no
  equivalent hook in sherpa-onnx today. Per the issue's own framing, that's "a real accuracy cost to
  weigh against any latency win, not just an integration inconvenience" — worth weighting sherpa-onnx's
  results accordingly once measured, the same way `docs/asr-model-comparison.md` treats un-promptable
  candidates (moonshine, wav2vec2) as scored on their un-prompted best case.

### 1.3 Vosk

- **Model sizes**: `vosk-model-small-en-us-0.15` ≈ 40 MB, `vosk-model-small-pl-0.22` ≈ 40.4 MB (via
  secondary sources mirroring alphacephei's official models page, which itself 403'd directly in this
  session, §0) — both comfortably under the issue's ~50 MB-each estimate.
  `scripts/android-asr-fetch-models.sh` re-confirms the real size on download.
- **Android**: official demo at `alphacep/vosk-android-demo`, confirmed to exist; "near-zero JNI
  work" per the issue's framing matches what's findable — Vosk ships ready Kotlin/Java bindings.
- **Grammar-constrained decoding — mechanism confirmed**, answering part of **Open Question 2**:
  `Recognizer.setGrammar(grammar: String)` takes a JSON array of allowed phrases (or `"[]"` for the
  default open-vocabulary graph) and replaces the WFST decoding graph with a subgraph restricted to
  just those words — narrowing candidates from tens of thousands to a few dozen. This is the concrete
  API for "restrict the decoder to a closed physics-jargon word list" the issue proposes. **What's
  still unmeasured** (needs the real device run): whether that restriction actually beats
  prompt-biased whisper-small on this vocabulary, or just narrows the failure mode differently. No
  equivalent of Whisper's free-text `initial_prompt` exists in Vosk beyond the grammar mechanism —
  consistent with, not contradicting, the issue's own statement.
- **Output-shape concern in the issue text turns out to be already handled** — see §3.

### 1.4 wav2vec2-base-960h (stretch candidate)

- sherpa-onnx's own docs list a `wav2vec2_asr` CTC model category — this **contradicts** the issue's
  hedge that wav2vec2 "isn't in sherpa-onnx's supported set (confirm)": sherpa-onnx does have some
  wav2vec2 support. What's **not** confirmed this session: whether that support extends to an
  arbitrary Hugging Face checkpoint like `Xenova/wav2vec2-base-960h` specifically, or only to
  sherpa-onnx's own separately-exported wav2vec2 models (sherpa-onnx generally needs its own export
  format, not just any ONNX file with the right op set). Needs a direct check of sherpa-onnx's
  wav2vec2 docs/scripts once network access allows it — a five-minute check, not a re-run of this
  whole research pass.
- Given this is already the stretch/time-permitting candidate in the issue, and the desktop numbers
  (`docs/asr-model-comparison.md`) already show wav2vec2-base-960h scoring **0% E2E** on this app's
  closed-vocabulary corrector/matcher (CTC output has no digits, no punctuation, and the corrector's
  Whisper-shaped rules can't parse it), it's reasonable to deprioritize this one further if device
  time runs short — the desktop result is a strong prior that the mobile result won't differ in kind.

## 2. The issue's open questions — answered as far as desk research allows

1. **Does domain-prompt biasing have an equivalent hook in whisper.cpp or sherpa-onnx?**
   whisper.cpp: **yes**, `initial_prompt`/`--prompt` (mechanism confirmed; whether the Android
   example exposes it is a local TODO, §5.2). sherpa-onnx: **no** — confirmed absent, open unanswered
   upstream issue (§1.2). This is a real, asymmetric finding: if sherpa-onnx's raw accuracy without
   prompting can't close the gap to prompted whisper-small's 91% E2E baseline
   (`docs/voice-pipeline-feasibility.md` §2.4.1), sherpa-onnx starts the comparison behind on
   mechanism, not just on measurement not yet taken.
2. **Does Vosk's grammar-constrained mode meaningfully outperform prompt-biased Whisper on this
   vocabulary?** **Answered on desktop CPU (§3.4), and the answer is no — decisively, and for a
   reason the issue didn't anticipate.** It's not that grammar restriction narrows the failure mode
   differently than hoped; Vosk's small English model's fixed lexicon simply doesn't contain "mev"
   (nor "pmma", "csda", "astar", "pstar", "nucleon", "deuteron", "kapton") at all, so no grammar —
   however tightly restricted — can make the recognizer emit these tokens. Grammar-constrained Vosk
   scored **0% E2E** on the desktop eval set (§3.2), the same as plain dictation, because the single
   most frequent slot in this domain (the energy unit) is structurally unrecoverable without adding
   custom lexicon/pronunciation entries — real extra engineering, not "near-zero JNI work." Still
   worth re-confirming on-device (a phone's grammar compile could behave differently), but this is a
   strong prior, not an open question anymore.
3. **Confirm sherpa-onnx's actual whisper-small int8 file size before treating it as budget-safe.**
   **Answered, and corrected**: measured directly this session at **359 MB combined**
   (108 MB encoder + 251 MB decoder int8), not the ≈239 MB estimated from the docs page — see §1.2
   and §3.2. Still comfortably under the 0.5 GB budget, just a different real number than previously
   cited.

## 3. Desktop CPU benchmark (this session) — pre-Android sanity check

_Added in the same-day local-machine continuation of this session (see the "Update" callout at the
top of this doc). Linux x86_64, 14-core desktop CPU, no GPU — **not** an Android device, so these
are not the numbers §6 still needs. What they're good for: confirming all three runtimes actually
build/run against the real 89-clip eval set, getting a relative accuracy/latency ranking before
investing Android build-system time, and — for Vosk — a decisive answer to Open Question 2 above
that the real-device run doesn't need to re-derive from scratch._

### 3.1 Method

Same eval set as everywhere else in this repo (`eval/audio/{km,lg,mn}/`, 89 clips), same
`scripts/e2e-audio-intents.ts` / `scripts/asr-score-slots.mjs` scoring, same §4 JSON contract —
three new harness scripts (§7) produce it from each runtime's native CLI/API instead of
`@huggingface/transformers`:

- **whisper.cpp**: cloned `ggml-org/whisper.cpp` and built `whisper-cli` locally with `cmake`
  (`.android-asr-cache/src/whisper.cpp/`, gitignored) — a genuine x86 `-march=native` Release build,
  no Android toolchain involved. `scripts/whispercpp-transcribe.mjs` drives it: one `whisper-cli`
  process for the whole 89-clip batch (single model load), timed by watching stdout for each file's
  `read_audio_data` marker rather than spawning per-clip (which would fold reload cost into every
  clip's timing — whisper-cli has no batch JSON-with-per-file-timings mode as shipped).
- **sherpa-onnx**: `pip install sherpa-onnx` into a project-local venv (`.venv-asr-bench/`,
  gitignored) — the same PyPI package whose Kotlin/JNI Android bindings wrap the identical
  `OfflineRecognizer.from_whisper` C++ core, so this exercises the real decode path, not a
  reimplementation. `scripts/sherpa-onnx-transcribe.py` loads the model once and loops the 89 clips.
- **Vosk**: `pip install vosk` into the same venv. `scripts/vosk-transcribe.py` supports both plain
  dictation (default) and `--grammar` mode (Kaldi grammar-FST restriction, §3.4).

All model weights fetched via the existing `scripts/android-asr-fetch-models.sh` (unmodified) —
confirms that script's URLs are correct as a side effect (§1's file-size figures below are measured
directly, not relayed from the issue text).

### 3.2 Results table

| Pipeline                                                                    | E2E audio→intent (raw→corrected) | median s/clip       | load  | measured size                    |
| --------------------------------------------------------------------------- | -------------------------------- | ------------------- | ----- | -------------------------------- |
| whisper.cpp ggml-small-**q8_0** + prompt                                    | 80%→**89%** (79/89)              | 3.7 s               | 0.2 s | 253 MiB (≈265 MB)                |
| whisper.cpp ggml-small-**q8_0**, un-prompted                                | 58%→85% (76/89)                  | 3.4 s               | 0.1 s | (same file)                      |
| whisper.cpp ggml-small-**q5_1** + prompt                                    | 76%→85% (76/89)                  | 5.1 s               | 0.2 s | 182 MiB (≈191 MB)                |
| **sherpa-onnx** whisper-small int8, un-prompted (only mode)                 | 60%→**87%** (77/89)              | **1.5 s**           | 1.0 s | 359 MB (108 MB enc + 251 MB dec) |
| Vosk small en-us, plain dictation                                           | 0%→0% (0/89)                     | 0.8 s               | 0.2 s | 68 MB extracted (40 MB zip)      |
| Vosk small en-us, **grammar**-constrained (246-word grammar)                | 0%→0% (0/89)                     | **0.1 s**           | 0.2 s | (same model)                     |
| _reference_ whisper-small q8, desktop Node (`docs/asr-model-comparison.md`) | 77%→89% (78/88)                  | 2.7 s (un-prompted) | —     | 240 MB                           |

Raw JSON results committed at `eval/results/android-desktop-precheck-2026-07-23/`.

### 3.3 whisper.cpp and sherpa-onnx — the encouraging half

- **whisper.cpp q8_0+prompt lands within noise of this repo's existing desktop Node baseline**
  (89% vs 89% E2E, `docs/asr-model-comparison.md`'s reference row) at a comparable median latency
  (3.7 s vs 2.7 s, both CPU, different runtimes/thread counts — not a controlled comparison, just a
  sanity check that whisper.cpp's own decode isn't leaving accuracy on the table). Confirms
  `--prompt` is a clean `initial_prompt` implementation (§1.1 update) with no output contamination.
- **Prompting only bought +4pp here** (85%→89%), smaller than this project's other prompting results
  (`docs/asr-model-comparison.md` shows prompting closing bigger gaps for whisper-base/tiny) — the
  desktop q8_0 run's un-prompted number (85%) was already close to its prompted ceiling, so the
  prompt has less headroom to help against this specific runtime/quantization pairing. Not a
  contradiction of the earlier prompting research, just a smaller effect size at the top end.
- **Quantization surprise**: q5_1 (182 MiB, smaller file) was **slower** than q8_0 (253 MiB) on this
  x86_64 desktop — 5.1 s vs 3.7 s median — and less accurate (85% vs 89%). Likely explanation:
  whisper.cpp's `cmake` output logged "Adding CPU backend variant ggml-cpu: -march=native" with a
  `GGML_SYSTEM_ARCH: x86` "REPACK" SIMD path that may specifically target q8_0's packing layout,
  leaving q5_1 on a slower generic kernel on this arch. **Worth re-testing on the actual Android ARM
  target** — NEON kernel coverage per quantization may differ from x86, so q8_0's win here is not
  guaranteed to hold on-device; don't skip q5_1 in the real Android run on the strength of this
  desktop number alone.
- **sherpa-onnx un-prompted (87%) actually beats whisper.cpp un-prompted (85%) and nearly matches
  whisper.cpp prompted (89%), at under half the latency** (1.5 s vs 3.7 s median). This is a better
  outcome for sherpa-onnx than §1.2/§2's original concern that lacking a prompt mechanism would be
  "a real accuracy cost to weigh against any latency win" — on this desktop run, the shipped
  corrector (issue #28) absorbs most of the gap a domain prompt would otherwise close. Still worth
  confirming on-device (mobile ONNX Runtime execution provider differences could shift this), but
  it's now the strongest latency/accuracy combination measured in this doc, not just the
  "integration-solved" candidate §1.2 described it as.

### 3.4 Vosk — the decisive negative result

Plain dictation output is exactly as expected from §1.3/§2: fluent-sounding but numerically useless
("what's the the east less the x of two hundred and fifty mtv protons in pm and a" for "What's the
dE/dx of 250 MeV protons in PMMA?") — 0% E2E, every energy unit and most numbers wrong.

The grammar-constrained run (§5.4's own proposed word list, built from every word in
`eval/intents.jsonl`'s gold sentences plus spelled-out English numbers — 246 words total) was
expected to do much better. It didn't: **also 0% E2E**. The reason is a real, previously-unknown
finding, not a tuning miss:

```
WARNING (VoskAPI:UpdateGrammarFst) Ignoring word missing in vocabulary: 'mev'
WARNING (VoskAPI:UpdateGrammarFst) Ignoring word missing in vocabulary: 'pmma'
WARNING (VoskAPI:UpdateGrammarFst) Ignoring word missing in vocabulary: 'nucleon'
WARNING (VoskAPI:UpdateGrammarFst) Ignoring word missing in vocabulary: 'csda'
WARNING (VoskAPI:UpdateGrammarFst) Ignoring word missing in vocabulary: 'astar'
WARNING (VoskAPI:UpdateGrammarFst) Ignoring word missing in vocabulary: 'pstar'
WARNING (VoskAPI:UpdateGrammarFst) Ignoring word missing in vocabulary: 'deuteron'
WARNING (VoskAPI:UpdateGrammarFst) Ignoring word missing in vocabulary: 'kapton'
```

**Vosk's `setGrammar` can only _restrict_ the model's existing fixed lexicon to a subset — it cannot
inject a new word's pronunciation.** The small English model's base dictionary was never compiled
with an entry for "MeV" (or PMMA, CSDA, ASTAR/PSTAR, nucleon, deuteron, Kapton) at all, so however
tightly the grammar is scoped, the recognizer structurally cannot output these tokens — confirmed by
testing each word individually before building the full grammar (`kev` and `gev` **are** in the base
lexicon; `mev` is not, an odd and very consequential gap since MeV is the most frequent unit in this
entire domain). The slot-token breakdown makes the shape of the failure precise:

| category | raw→corrected |
| -------- | ------------- |
| particle | 89.5%→89.5%   |
| material | 88.3%→88.3%   |
| quantity | 82.1%→82.1%   |
| **unit** | **6.5%→6.5%** |
| number   | 6.5%→8.7%     |

Grammar-constrained Vosk is genuinely good at the words it does know (particles, materials,
question-shape phrases) — the failure is concentrated entirely in units and the numbers that get
mis-parsed alongside them once the unit token derails. **This closes Open Question 2 (§2)**: Vosk's
grammar mode is not a viable path to competitive accuracy on this vocabulary without first adding
custom lexicon/pronunciation entries for the missing jargon (a real, nontrivial engineering task —
Kaldi/Vosk lexicon extension, not a JSON grammar tweak), materially changing the "near-zero JNI
work" framing §1.3 originally gave this candidate. Vosk's genuine advantage confirmed here: it's
extremely fast (0.1–0.8 s median, 5–35× faster than the other two candidates) — worth remembering if
a future spike wants to revisit it after a lexicon-extension investment, just not as a drop-in this
session's evidence supports today.

## 4. Output contract — so the local run needs zero new scoring code

This repo already has two scoring scripts (`scripts/e2e-audio-intents.ts`, `scripts/asr-score-slots.mjs`)
that consume a specific JSON shape, produced today by `scripts/asr-transcribe.mjs`:

```json
{
  "modelId": "whispercpp/ggml-small-q5_1",
  "dtype": "q5_1",
  "withPrompt": true,
  "loadS": 1.8,
  "records": [
    {
      "speaker": "km",
      "id": "stress-001",
      "raw": "...transcript text...",
      "secs": 2.1,
      "error": null
    }
  ]
}
```

Field notes for an Android harness targeting this contract:

- `modelId` / `dtype` — free-form labels (e.g. `"sherpa-onnx/whisper-small-int8"`,
  `"vosk/small-en-us+small-pl"`); the scoring scripts only echo these for display, never branch on
  their value.
- `withPrompt` / `loadS` — read by `asr-score-slots.mjs`'s label line. Set `withPrompt: false` for
  candidates with no prompt mechanism (sherpa-onnx, Vosk) rather than omitting the field.
- `records[].speaker` + `.id` — **must** match the eval set's `{speaker}/{id}.wav` naming
  (`eval/audio/{km,lg,mn}/<id>.wav`) so `e2e-audio-intents.ts`'s lookup against `eval/intents.jsonl`
  and `asr-score-slots.mjs`'s hand-written slot table both resolve. `id` is one of the 30 fixed IDs in
  `scripts/asr-transcribe.mjs`'s `IDS` array — only emit a record for ids that actually have a `.wav`
  file for that speaker (some speakers are missing a few of the 30, hence 89 total clips, not 90).
- `records[].raw` — plain-text transcript, **no post-processing**. The correction layer
  (`src/lib/asr/correct/core.ts`) and matcher (`src/lib/intent/matcher.ts`) already operate on raw
  text architecture-agnostically — proven by this repo's own moonshine/wav2vec2 rows in
  `docs/asr-model-comparison.md`, which scored non-Whisper free-text transcripts through these exact
  unmodified scripts. **The issue's own caution that "Vosk may need a stubbed adapter since its
  output shape differs from Whisper's" turns out to be unnecessary** — Vosk's plain-text output
  (lowercase, unpunctuated, like Moonshine's) fits the same `raw` field and needs no adapter, only the
  same awareness the existing docs already have that a corrector tuned on Whisper's error shapes may
  help CTC/Vosk-style output less well.
- `records[].secs` — wall-clock seconds for that clip's inference. If a runtime exposes a
  prefill/decode split (the issue explicitly wants this where available), add optional
  `prefillSecs`/`decodeSecs` fields — neither scoring script reads them today, but record them in the
  raw JSON for the write-up in §6 regardless.
- `records[].error` — `null` on success, else the runtime's error string; both scoring scripts skip
  any record with `error` set, matching how `asr-transcribe.mjs` itself handles decode failures.

Once a candidate's harness writes one such JSON file per model/config (e.g. to
`/sdcard/Android/data/<package>/files/`), pull it back and score it with the **exact commands already
used for every other model in this repo**:

```bash
adb pull /sdcard/Android/data/<package>/files/whisper-small-q5_1.json eval/results/android-2026-xx-xx/
pnpm eval:e2e  eval/results/android-2026-xx-xx/whisper-small-q5_1.json
pnpm asr:score eval/results/android-2026-xx-xx/whisper-small-q5_1.json
```

Both scripts default to the shipped corrector (`src/lib/asr/correct/core.ts`, issue #28) — the same
one the live app runs — so the numbers are directly comparable to every existing row in
`docs/voice-pipeline-feasibility.md` and `docs/asr-model-comparison.md` with no extra flags needed.

### Reference result-writer (Kotlin, untested in this session)

Not compiled or run anywhere this session (no Android SDK, §0) — a starting point to adapt into
whichever candidate's example app, using `org.json` (ships with the Android platform, no extra Gradle
dependency needed):

```kotlin
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

data class ClipResult(
    val speaker: String,
    val id: String,
    val raw: String,
    val secs: Double,
    val error: String? = null,
)

fun writeResults(
    outFile: File,
    modelId: String,
    dtype: String,
    withPrompt: Boolean,
    loadS: Double,
    records: List<ClipResult>,
) {
    val root = JSONObject()
    root.put("modelId", modelId)
    root.put("dtype", dtype)
    root.put("withPrompt", withPrompt)
    root.put("loadS", loadS)
    val recordsArr = JSONArray()
    for (r in records) {
        val rec = JSONObject()
        rec.put("speaker", r.speaker)
        rec.put("id", r.id)
        rec.put("raw", r.raw)
        rec.put("secs", r.secs)
        rec.put("error", r.error) // JSONObject.put(String, null) writes JSON null, not absent
        recordsArr.put(rec)
    }
    root.put("records", recordsArr)
    outFile.writeText(root.toString(2))
}
```

## 5. Runbook for the local continuation

### 5.1 Fetch models

Run `scripts/android-asr-fetch-models.sh` (added this session) on a machine with normal network
access. It downloads into `.android-asr-cache/` (gitignored, same convention as `.hf-cache/`),
verifies each file actually landed, and prints its size so you can sanity-check against §1's figures
before copying anything onto a device. The sherpa-onnx URL in particular is a best-guess from the
well-known k2-fsa GitHub-releases convention — **confirmed correct this session (§3.1)**, no need to
re-derive it; if it ever 404s again, get the real URL from
<https://k2-fsa.github.io/sherpa/onnx/pretrained_models/whisper/> and
<https://github.com/k2-fsa/sherpa-onnx/releases>.

### 5.2 whisper.cpp

1. `git clone https://github.com/ggml-org/whisper.cpp` and open `examples/whisper.android` in
   Android Studio.
2. Copy `ggml-small-q8_0.bin` (start with q8_0 — this project's existing desktop numbers are all q8,
   §1.1's RAM note says budget for the larger of the two regardless, **and §3.3's desktop run found
   q8_0 both faster and more accurate than q5_1 on x86_64** — re-verify that holds on ARM before
   dropping q5_1 entirely) into `app/src/main/assets/models/`.
3. Copy the eval clips as `.wav` samples (16 kHz mono — same format `loadAudio()` in
   `scripts/asr-transcribe.mjs` already converts to via ffmpeg, so no re-encoding needed if you reuse
   the same files) into `app/src/main/assets/samples/`.
4. **§1.1's mechanism-level TODO is resolved (§3.3)**: `--prompt` is confirmed clean at the C++/CLI
   level. What's left is Android-specific only: check whether `examples/whisper.android`'s Kotlin/JNI
   wrapper exposes `initial_prompt` as a settable option. If not, that's a small patch (the C++ side
   already supports it) before this candidate can be compared on equal footing with this project's
   prompted whisper-small baseline — worth doing since un-prompted whisper-small underperforms its
   own prompted numbers by a wide margin (§2.4 of `docs/voice-pipeline-feasibility.md`: 88.0% vs
   95.6% raw slot tokens).
5. Wire the app to loop over all 89 sample clips, capture wall-clock per clip, and emit the §4 JSON
   contract instead of (or alongside) whatever the example's UI shows.
6. Run the **release** build variant on-device (debug builds skip compiler optimizations whisper.cpp
   relies on for real-world latency).

### 5.3 sherpa-onnx

1. Get the whisper-small int8 model (§5.1 — **359 MB combined, not ≈239 MB**, §1.2/§3.2) and the
   sherpa-onnx Android AAR/demo per `k2-fsa/sherpa-onnx`'s `android/` directory.
2. Since there's no `initial_prompt` hook (§1.2, §2), this candidate runs **un-prompted only** — score
   it against this project's own un-prompted whisper-small numbers
   (`docs/asr-model-comparison.md`'s "Un-prompted" table) as the fairer comparison, and separately
   against the prompted numbers to be explicit about the mechanism gap, the same way that doc already
   handles moonshine/wav2vec2. **§3.3's desktop run found this candidate the strongest
   accuracy/latency combination measured so far (87% E2E at 1.5 s median, un-prompted)** — worth
   prioritizing this candidate's on-device run if time is short.
3. Same loop-over-clips-and-emit-JSON approach as whisper.cpp.

### 5.4 Vosk

1. Get both `vosk-model-small-en-us-0.15` and `vosk-model-small-pl-0.22` (§5.1).
2. Start from `alphacep/vosk-android-demo`.
3. For the plain (non-grammar) baseline run, use the model matching each clip's language as normal
   dictation. **§3.4's desktop run scored this 0% E2E** — expect the same on-device; run it anyway
   for the record, but don't spend extra time on it.
4. For the grammar-constrained variant (§1.3, §2), build the closed vocabulary list from this
   project's own alias tables (`src/lib/aliases/`) plus unit/quantity keywords — that's the actual
   "physics-jargon word list" the issue proposes constraining Vosk's decoder to, and it already exists
   in this repo rather than needing to be authored from scratch. **§3.4 found this scores 0% E2E too
   on desktop**, for a specific, confirmed reason: Vosk's base lexicon has no entry for "MeV" (nor
   several other jargon terms) at all, so no grammar restriction can recover it without first adding
   custom pronunciation entries to the model — a real lexicon-extension task, out of scope for this
   spike. Run the on-device confirmation for completeness, but budget device time elsewhere first.
5. Emit both runs (plain and grammar-constrained) as separate JSON files per the §4 contract so
   they show up as distinct rows in §6.

### 5.5 wav2vec2 (stretch, only if time allows)

Confirm the sherpa-onnx-vs-Xenova-checkpoint compatibility question from §1.4 first — five minutes of
checking sherpa-onnx's wav2vec2 export docs — before investing in a build. Given the 0% desktop E2E
result already on record, treat this strictly as a latency/RAM data point (per the issue's own
framing: "include only for the encoder-only/no-autoregressive-decode latency data point"), not an
accuracy comparison.

### 5.6 Battery / thermal capture

Run `scripts/android-asr-battery-bench.sh` (added this session) around each candidate's full 89-clip
batch run:

```bash
scripts/android-asr-battery-bench.sh snapshot before-whisper-cpp
# ... run the whisper.cpp benchmark on-device ...
scripts/android-asr-battery-bench.sh snapshot after-whisper-cpp
scripts/android-asr-battery-bench.sh diff before-whisper-cpp after-whisper-cpp
```

It wraps `adb shell dumpsys battery` (level/temperature) and `adb shell dumpsys thermalservice`
(throttling status enum: NONE/LIGHT/MODERATE/SEVERE/CRITICAL/EMERGENCY/SHUTDOWN) — exactly the
"rough before/after battery-percentage reading" the issue asks for, no more, no less.

### 5.7 Scoring

Per candidate/config, `adb pull` the JSON (§4) into a new `eval/results/android-2026-xx-xx/`
directory and run `pnpm eval:e2e` + `pnpm asr:score` against it (§4's exact commands). Commit the raw
JSONs (text only, same convention as every existing `eval/results/*` directory) alongside the filled-in
§6 table.

## 6. Results — template, unfilled

No cell below has been measured. Filling this in (replacing every `?`) is what actually resolves
issue #120 — everything above is groundwork, not a substitute for it. (§3's desktop CPU numbers are
a useful prior for prioritizing device time, but are **not** a substitute for these rows — different
hardware entirely.)

| Pipeline                                                                | audio→intent slot match | median s/clip | p90 s/clip | battery/thermal note |
| ----------------------------------------------------------------------- | ----------------------- | ------------- | ---------- | -------------------- |
| whisper-small + prompt, desktop CPU (Node, baseline)                    | 91% (81/89)             | 2.3 s         | —          | n/a (desktop)        |
| candidate 1 — whisper.cpp ggml-small-q8_0, real device                  | ?                       | ?             | ?          | ?                    |
| candidate 1b — whisper.cpp ggml-small-q5_1, real device                 | ?                       | ?             | ?          | ?                    |
| candidate 2 — sherpa-onnx whisper-small int8, real device (un-prompted) | ?                       | ?             | ?          | ?                    |
| candidate 3 — Vosk small EN+PL, plain, real device                      | ?                       | ?             | ?          | ?                    |
| candidate 3b — Vosk small EN+PL, grammar-constrained, real device       | ?                       | ?             | ?          | ?                    |
| _(stretch)_ candidate 4 — wav2vec2-base-960h, real device               | ?                       | ?             | ?          | ?                    |

## 7. Files added this session

Cloud session:

- `docs/android-asr-runtime-bench.md` — this file.
- `scripts/android-asr-fetch-models.sh` — downloads the model weights for all candidates; run
  locally, not runnable in that session (§0).
- `scripts/android-asr-battery-bench.sh` — `adb`-based before/after battery + thermal snapshot
  helper; needs a connected device, not runnable in that session.
- `.gitignore` — added `/.android-asr-cache/`, mirroring the existing `/.hf-cache/` entry.

Local desktop-precheck session (§3):

- `scripts/whispercpp-transcribe.mjs` — drives a locally-built `whisper-cli` over the eval set,
  emits the §4 JSON contract.
- `scripts/sherpa-onnx-transcribe.py` — drives sherpa-onnx's `OfflineRecognizer.from_whisper` over
  the eval set, same contract.
- `scripts/vosk-transcribe.py` — drives Vosk (plain or `--grammar`) over the eval set, same
  contract.
- `eval/results/android-desktop-precheck-2026-07-23/` — the six raw JSON result files behind §3.2's
  table.
- `.gitignore` — added `/.venv-asr-bench/` (project-local venv for `sherpa-onnx`/`vosk`, mirroring
  the existing `.venv-*` entries); extended the `/.android-asr-cache/` comment to note it also holds
  the locally-built whisper.cpp source/binaries.

## 8. Device-build handoff, 2026-07-24 — blocked by managed endpoint security, moving machines

_Same continuation as §3, one day later, same physical machine, now attempting the actual
on-device build. Recorded here so the next session (a different, unmanaged machine) doesn't have
to rediscover any of this._

**What this machine got done before hitting the blocker**: Android Studio installed
(`~/Applications/android-studio/`, extracted from the official tarball) with the SDK at
`~/Android/Sdk` (Standard install: `platform-tools`, a current platform, `build-tools`) plus the
NDK ("side by side") added via the SDK Manager. On the Pixel 7A: Developer Options enabled, USB
debugging turned on, "Stay awake while charging" turned on. **This phone-side state persists across
computers** — reconnecting to a different machine will just prompt for that new machine's RSA key,
not require redoing Developer Options.

**The blocker**: `adb devices` failed with `protocol fault (couldn't read status): Connection reset
by peer` on every attempt, including after `adb kill-server`/`start-server` and trying an unrelated
port (`-P 5999`) with no server bound there at all — the same reset happened regardless. Verified
concretely, not assumed:

- The `adb` binary itself is fine (`adb version` succeeds; a foreground `adb server` process starts
  and `ss -tlnp` confirms it actually binds `127.0.0.1:5037`).
- No conflicting process was already bound to 5037 or 5999 (`ss`, `lsof -i`, `fuser` all came up
  empty before starting adb).
- A connection to an **unbound** port produced the identical "reset by peer" as the real adb port —
  that's the signature of a network-filter driver intercepting loopback TCP, not an adb-specific
  problem.
- Process inspection found **ESET Endpoint Antivirus** running under `ERAAgent` (ESET Remote
  Administrator Agent — `/opt/eset/eea/*`, `/opt/eset/RemoteAdministrator/Agent/ERAAgent`), meaning
  this machine reports to a centrally managed ESET PROTECT policy (this is an AGH-managed laptop).
  ESET's network-attack-protection/IDS module is the standard explanation for exactly this failure
  mode (binary, non-HTTP(S) protocol on a loopback port gets reset). **Not independently confirmed
  via ESET's own logs** — `/var/log/eset/` and `/var/opt/eset/` require root, and this account has
  no passwordless `sudo` — so this is strong circumstantial evidence, not a certainty.
- The ESET GUI's "Pause protection" (or equivalent Network Protection toggle) was the next
  troubleshooting step, but policy-managed installs commonly lock that control for non-admin users,
  and escalating to IT for an exclusion would stall this session — **decision: move to a different,
  unmanaged machine instead of waiting on an IT ticket.**

### TODO for the next machine

1. Install Android Studio (Standard install type) + add the NDK ("side by side") via
   Settings/Preferences → Languages & Frameworks → Android SDK → SDK Tools.
2. Connect the Pixel 7A via USB — Developer Options/USB debugging are already enabled on the phone
   itself, so this should just need accepting the new machine's RSA key prompt on the phone (tap
   Allow, check "always allow").
3. Confirm `<sdk>/platform-tools/adb devices` lists the phone as `device`.
4. Then work through §5's runbook in priority order (established from §3's desktop numbers):
   - **sherpa-onnx first** (best desktop result, least native-build risk — prebuilt AAR, no NDK
     needed for this candidate specifically). Sparse-clone just what's needed:
     ```
     git clone --depth 1 --filter=blob:none --sparse https://github.com/k2-fsa/sherpa-onnx <dest>
     cd <dest> && git sparse-checkout set android kotlin-api sherpa-onnx/kotlin-api
     ```
     Fork `android/SherpaOnnxVadAsr` as the starting skeleton — confirmed this session it's already
     wired to `OfflineRecognizer` (the non-streaming API Whisper needs; the flagship `SherpaOnnx`
     demo app is streaming-only and won't work for this). Strip its VAD/live-mic UI, bundle the
     whisper-small int8 model (re-fetch via `scripts/android-asr-fetch-models.sh sherpa-onnx`, or
     reuse `.android-asr-cache/sherpa-onnx/` if this repo's checkout carries over) plus the 89 eval
     clips as assets, loop + time + emit the §4 JSON contract, `adb pull`, score with
     `pnpm eval:e2e` / `pnpm asr:score` (both unmodified).
   - **whisper.cpp second**: `git clone --depth 1 https://github.com/ggml-org/whisper.cpp`, open
     `examples/whisper.android` (this one does need the NDK). Resolve §5.2's remaining TODO first —
     whether the Kotlin/JNI wrapper exposes `initial_prompt` — before wiring up the same
     loop-and-emit-JSON approach.
   - **Vosk — quick plain-dictation confirmation only**, from `alphacep/vosk-android-demo`. Skip
     re-testing the grammar-constrained variant on-device: §3.4 already confirmed that failure is
     about the model's fixed lexicon (missing "mev" etc.), not something a different CPU
     architecture changes.
   - Wrap each candidate's full 89-clip batch with `scripts/android-asr-battery-bench.sh` (before/
     after snapshots).
   - Fill in §6's results table with the real numbers, and write the final recommendation. If the
     result is actionable, file the separate Android-app-decision tracking issue this issue's own
     description calls for.
5. None of the Android tooling (Studio, SDK, NDK) or the cloned example-app repos persist in git —
   same regenerable-artifact convention as `.hf-cache/`/`.android-asr-cache/` — so the new machine
   starts that part from scratch. §3's desktop CPU numbers are already committed and don't need to
   be re-run.

## Sources consulted this session

- [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) — license, model memory table.
- [ggml-org/whisper.cpp — examples/whisper.android](https://github.com/ggml-org/whisper.cpp/tree/master/examples/whisper.android) — Android example setup.
- [ggml-org/whisper.cpp Discussion #348 — add initial_prompt parameter?](https://github.com/ggml-org/whisper.cpp/discussions/348) and general `--prompt` CLI documentation (secondary sources: RubyDoc.info whispercpp gem docs, DeepWiki).
- [k2-fsa/sherpa-onnx — Export Whisper to ONNX](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/whisper/export-onnx.html) — whisper-small fp32/int8 file sizes.
- [k2-fsa/sherpa-onnx#2295 — whisper prompts?](https://github.com/k2-fsa/sherpa-onnx/issues/2295) — no `initial_prompt` support, open/unanswered.
- [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) — Android/Kotlin API existence, wav2vec2_asr model category.
- Vosk model sizes and Android demo — via search results mirroring alphacephei.com's official models page (direct fetch 403'd, §0) and [alphacep/vosk-android-demo](https://github.com/alphacep/vosk-android-demo).
- `setGrammar` mechanics — [alphacep/vosk-api issues #1617](https://github.com/alphacep/vosk-api/issues/1617), [#1584](https://github.com/alphacep/vosk-api/issues/1584), [#1720](https://github.com/alphacep/vosk-api/issues/1720), and [alphacephei.com/vosk/android](https://alphacephei.com/vosk/android).
