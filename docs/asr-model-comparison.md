# ASR model comparison — faster-prefill candidates vs whisper-small (issue #49)

_Session report, 2026-07-15. Linux CPU, Node 24, `@huggingface/transformers` 4.2.0. Same audio
(`eval/audio/{km,lg,mn}/`, up to 89 clips / 3 speakers) and eval set as
`docs/voice-pipeline-feasibility.md` / `docs/apple-silicon-benchmark.md`. In-browser numbers use
`scripts/asr-browser-benchmark.mjs` (Playwright, headless Chromium, real `onnxruntime-web`/WASM,
single-threaded — no COOP/COEP on GitHub Pages, issue #9), matching the methodology
`docs/whisper-progress-feedback.md`'s "Real-browser verification" section established for
whisper-small: **Node latency is a reference number only, ~5× too fast for prefill vs. the browser**
(confirmed again below for whisper-base/whisper-tiny)._

## TL;DR — verdict

**whisper-small stays.** No ≤500 MB candidate beats it on the metric that matters
(E2E audio→intent, #27):

| model                                           | size (q8) | in-browser prefill         | E2E audio→intent | verdict                                                                           |
| ----------------------------------------------- | --------- | -------------------------- | ---------------- | --------------------------------------------------------------------------------- |
| **whisper-small (baseline)**                    | 240 MB    | **~7.9 s**                 | **85% (76/89)**  | ships today                                                                       |
| whisper-base                                    | 80 MB     | **~2.5 s (3.2× faster)**   | 52% (45/86)      | faster, but 33pp worse — fails the accuracy bar                                   |
| whisper-tiny                                    | 40 MB     | **~1.3 s (6.1× faster)**   | 7% (6/89)        | floor confirmed — far too weak                                                    |
| distil-small.en                                 | 190 MB    | not measurable (see below) | 19% (17/89)      | ruled out on accuracy; also breaks in this app's code                             |
| moonshine-base                                  | 200 MB    | not re-measured            | 22% (20/89)      | ruled out on accuracy (Node-only, see caveat)                                     |
| moonshine-tiny                                  | 50 MB     | not re-measured            | 17% (15/89)      | ruled out on accuracy (Node-only, see caveat)                                     |
| wav2vec2-base-960h                              | 91 MB     | not re-measured            | **0% (0/89)**    | ruled out on accuracy — corrector can't parse CTC output                          |
| whisper-large-v3-turbo (reference, over budget) | ~650 MB   | not re-measured            | 87% (77/89)      | best accuracy, but over the 500 MB CPU/WASM budget (already excluded, issue text) |

The prefill lever (smaller Whisper encoder) works exactly as physics predicts — whisper-base is
genuinely 3.2× faster prefill, whisper-tiny 6.1× — but domain accuracy falls off a cliff faster than
latency improves. The corrector (#28) absorbs Whisper-small's transcription noise well (54%→85%
raw→corrected) but the _smaller_ Whisper checkpoints and every Lever-2 architecture produce errors
the corrector's rules don't cover (missing/garbled numbers, wrong units, dropped particle names) —
the closed-vocabulary matcher needs those slots intact, and there's a floor of transcript fidelity
below which no amount of regex correction recovers them. **The real lever remains COOP/COEP
threading (#9)**, which the whisper-progress-feedback.md doc's real-browser numbers show would cut
whisper-small's ~7.9 s single-thread prefill directly, without giving up any accuracy.

## Method

1. Transcribed all candidates over the full eval set with `scripts/asr-transcribe.mjs <repo> q8
<out.json>` (no `--prompt`, matching the un-prompted `small-q8.json` baseline for a fair
   apples-to-apples comparison — domain-prompt biasing, issue #25, is Whisper-only and out of
   scope for this cross-architecture comparison).
2. Scored **E2E audio→intent** with `scripts/e2e-audio-intents.ts` (transcript → extended corrector
   → matcher → `compareIntent` vs. the eval set's gold `QueryIntent` — the metric issue #27 owns)
   and **slot-token accuracy** with `scripts/asr-score-slots.mjs --ext` (transcript-level regex
   slot recall, corrected).
3. Measured **real in-browser latency** with `scripts/asr-browser-benchmark.mjs` for the two
   candidates that are true architectural drop-ins (whisper-base, whisper-tiny) — see "Why only two
   got real in-browser numbers" below.

Results are committed at `eval/results/asr-2026-07-15/` (new candidates) alongside the existing
`eval/results/asr-2026-07-05/` (whisper-small, moonshine-base, whisper-large-v3-turbo, all
previously benchmarked).

## Full results table

Node timing is a **reference only** (onnxruntime-node, multi-threaded — not what ships). In-browser
prefill is the number that matters for issue #49's goal.

| model                    | q8 size | Node median/clip | in-browser prefill                                             | in-browser ms/token | E2E raw→corrected   | slot-token (corrected) |
| ------------------------ | ------- | ---------------- | -------------------------------------------------------------- | ------------------- | ------------------- | ---------------------- |
| whisper-small (baseline) | 240 MB  | 2.7 s            | **7927 ms** (mean, 8 samples, from #48)                        | **65.2 ms**         | 54%→**85%** (76/89) | 88.0%→**97.7%**        |
| whisper-large-v3-turbo   | ~650 MB | 8.1 s            | not re-measured (over budget; issue notes ~3× slower on CPU)   | —                   | 61%→87% (77/89)     | 88.4%→98.1%            |
| whisper-base             | 80 MB   | 1.5 s            | **2481 ms** (mean, 5 clips)                                    | **30.3 ms**         | 22%→52% (45/86)¹    | 69.5%→88.2%            |
| whisper-tiny             | 40 MB   | 1.1 s            | **1301 ms** (mean, 5 clips)                                    | **19.5 ms**         | 0%→7% (6/89)        | 42.9%→49.9%            |
| distil-small.en          | 190 MB  | 2.8 s            | n/a — code-incompatible in this app (see below)                | —                   | 3%→19% (17/89)      | 71.4%→78.9%            |
| moonshine-base           | 200 MB  | 0.6 s            | n/a — not re-measured (would need app code changes, see below) | —                   | 15%→22% (20/89)     | 72.3%→77.8%            |
| moonshine-tiny           | 50 MB   | 0.4 s            | n/a — same caveat                                              | —                   | 6%→17% (15/89)      | 62.1%→70.2%            |
| wav2vec2-base-960h       | 91 MB   | 0.5 s            | n/a — same caveat                                              | —                   | 0%→**0%** (0/89)    | 20.3%→20.5%            |

¹ whisper-base threw `token_ids must be a non-empty array of integers` on 3/89 clips (empty-decode
edge case, likely repetition/silence suppression on short low-signal segments); those 3 are excluded
from both its E2E and slot-token denominators (n=86).

In-browser prefill/ms-per-token numbers are the mean of 5 real clips each (`km/sp-005`,
`km/rng-002`, `km/cmp-mat-001`, `mn/pernuc-001`, `lg/stress-001` — same clip set
`whisper-progress-feedback.md` used for whisper-small), single fresh page load per clip, headless
Chromium, `onnxruntime-web`/WASM, single-threaded.

## Why only two candidates got real in-browser numbers

The app's ASR worker (`src/lib/asr/transcribe.ts`) is architecture-generic **only across true
multilingual Whisper checkpoints** — it unconditionally builds domain-prompt `decoder_input_ids`
from `generation_config.lang_to_id`/`task_to_id` (transcribe.ts:151-154) and wires a
`WhisperTextStreamer` for token-count progress (transcribe.ts:191-201). Confirmed by checking each
candidate's actual `generation_config.json`:

- **whisper-base, whisper-tiny**: both have `is_multilingual: true` with `lang_to_id`/`task_to_id`
  present — genuinely a one-line `manifest.ts` `repo`/`dtype` swap, no other code touched. This is
  why these two got real in-browser numbers.
- **distil-small.en**: `is_multilingual: false`, and **`lang_to_id`/`task_to_id` are absent from its
  `generation_config.json` entirely** — `transcribe.ts`'s unconditional
  `generationConfig.lang_to_id["<|en|>"]` would throw immediately in the actual app (not just an
  accuracy gap; a hard runtime error). This is a genuine finding, not a benchmarking inconvenience:
  distil-whisper's English-only distillation drops fields this app's domain-prompt code assumes
  exist on every Whisper checkpoint. Since it's already ruled out on E2E accuracy (19%, worse than
  small), fixing `transcribe.ts` to guard this case wasn't worth doing for this pass — flagging it
  here in case a future spike considers distil-whisper again.
- **moonshine-base/tiny, wav2vec2-base-960h**: no `generate()`/decoder loop at all (Moonshine is a
  much shorter autoregressive decode; wav2vec2 is CTC, one forward pass, no decoder). Neither the
  domain-prompt path nor the `WhisperTextStreamer` progress mechanism apply — getting a real
  in-browser number would require making both conditional in `transcribe.ts`, which is a genuine
  (if small) code change, not a benchmark-harness change. Given all three are already disqualified
  on E2E accuracy (22%, 17%, 0%) using Node timing as directional evidence they're fast (0.4-0.6
  s/clip vs. Whisper's 1.1-2.8 s), the accuracy verdict doesn't change regardless of their exact
  browser latency, so this pass didn't invest in the `transcribe.ts` change. Worth doing only if a
  future architecture in this family clears the accuracy bar.

## Per-model notes

**whisper-base** — the single-highest-value retest per the issue: real, genuine 3.2× prefill
speedup (7927 ms → 2481 ms) for 80 MB. But E2E collapses from 85% to 52% even after the corrector —
worse than prior "unusable" raw-only verdicts suggested it might improve to. Representative
failures: dropped/garbled units ("100 MPV" for "100 MeV"), material confusion ("volume" for
"bone"), and outright wrong numbers. Also the only candidate that threw a hard decode error on 3
clips (`token_ids must be a non-empty array of integers`) — a reliability concern independent of
accuracy.

**whisper-tiny** — confirms the floor: 7% E2E, 0% raw. Useful only as a sanity check on how far the
correction layer can stretch (not far, at this transcript quality).

**distil-small.en** — confirms the issue's prediction exactly: distil-whisper speeds up _decode_
(2-layer decoder) while leaving the _encoder_ (hence prefill) essentially whisper-small's, so it
buys nothing on the ~88%-of-wall-clock bottleneck this issue targets, and its accuracy is
whisper-tiny-adjacent (19% E2E) despite being 190 MB. Also the app-integration break noted above.
One data point confirming, not a headline candidate — as predicted.

**moonshine-base** — re-scored E2E from the already-committed `moonshine-q8.json` transcripts
(no re-transcription needed). 22% E2E, only modestly above its already-known 16% raw clip-pass rate
— the corrector helps far less here than for Whisper family transcripts, because Moonshine's errors
(no punctuation/casing cues, garbled compound words like "carbon iron" for "carbon ion") don't match
the corrector's Whisper-shaped heuristics as well.

**moonshine-tiny** — weaker still (17% E2E), as expected for the smaller model in this family.
Fastest Node latency of any candidate (0.4 s/clip) — genuinely would be the fastest architecture in
this budget if its accuracy were viable, which it is not.

**wav2vec2-base-960h** — **0/89 E2E**, the starkest result in this set. Raw CTC output is uppercase,
unpunctuated, and phonetically approximate with no numerals at all (e.g. "STOPING POWER OF FIVE
HUNDRED CAVIPROTONS EWOTE" for "stopping power of 500 keV protons in water"). The closed-vocabulary
matcher and corrector — both tuned against Whisper's error patterns — have no foothold here: no
digit tokens for the regex-based slot scorer to find, and made-up run-on words the corrector's
phonetic rules don't recognize. This is a real, informative negative result for the "encoder-only,
no fixed 30 s window" hypothesis in this issue's Lever 2 — the architecture is fast (0.5 s/clip
Node) but the surface transcript is too degraded for this app's closed-vocabulary post-processing to
recover, at least without a CTC-specific corrector (out of scope here).

## Follow-up

None of the ≤500 MB candidates clear whisper-small's E2E bar, so there is no `manifest.ts` +
S3-mirror follow-up PR from this issue. Per the issue's own framing, the productive next lever is
**COOP/COEP threading (issue #9)** — it would cut whisper-small's ~7.9 s single-thread prefill
directly (the encoder's large batched matmul is exactly the workload multi-threading helps most)
without trading away any of the 85% E2E accuracy this comparison confirms nothing else in budget can
match. A CTC-specific correction layer for wav2vec2-family models is a possible but currently
out-of-scope alternative path if #9 stalls.
