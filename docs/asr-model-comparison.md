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
(E2E audio→intent, #27). Whisper-family candidates are compared **prompted** (with the same
domain-prompt biasing, #25, that whisper-small ships with — this is how they'd actually run); the
non-Whisper architectures have no prompt mechanism and are shown un-prompted (see the two full
tables below for both un-prompted and prompted numbers):

| model                                           | size (q8) | in-browser prefill         | E2E audio→intent (prompted) | verdict                                                                           |
| ----------------------------------------------- | --------- | -------------------------- | --------------------------- | --------------------------------------------------------------------------------- |
| **whisper-small (baseline)**                    | 240 MB    | **~7.9 s**                 | **89% (78/88)**             | ships today                                                                       |
| whisper-base                                    | 80 MB     | **~2.5 s (3.2× faster)**   | 63% (56/89)                 | faster, but 26pp worse — fails the accuracy bar                                   |
| whisper-tiny                                    | 40 MB     | **~1.3 s (6.1× faster)**   | 12% (11/89)                 | floor confirmed — far too weak                                                    |
| distil-small.en                                 | 190 MB    | not measurable (see below) | 19% (17/89) *un-prompted*²  | ruled out on accuracy; also breaks in this app's code (can't be prompted)         |
| moonshine-base                                  | 200 MB    | not re-measured            | 22% (20/89) _un-prompted_   | ruled out on accuracy (Node-only, see caveat)                                     |
| moonshine-tiny                                  | 50 MB     | not re-measured            | 17% (15/89) _un-prompted_   | ruled out on accuracy (Node-only, see caveat)                                     |
| wav2vec2-base-960h                              | 91 MB     | not re-measured            | **0% (0/89)** _un-prompted_ | ruled out on accuracy — corrector can't parse CTC output                          |
| whisper-large-v3-turbo (reference, over budget) | ~650 MB   | not re-measured            | 87% (77/89) _un-prompted_   | best accuracy; over the 500 MB CPU/WASM budget — the natural **WebGPU-tier** pick |

The prefill lever (smaller Whisper encoder) works exactly as physics predicts — whisper-base is
genuinely 3.2× faster prefill, whisper-tiny 6.1× — but domain accuracy falls off a cliff faster than
latency improves. Domain-prompt biasing (#25) helps the smaller Whisper models materially
(whisper-base 52%→63% E2E, whisper-tiny 7%→12% when prompted — see the two tables below), but not
nearly enough to close the gap to prompted small's 89%. The corrector (#28) absorbs whisper-small's
residual noise well, but the _smaller_ Whisper checkpoints and every Lever-2 architecture produce
errors the corrector's rules don't cover (missing/garbled numbers, wrong units, dropped particle
names) — the closed-vocabulary matcher needs those slots intact, and there's a floor of transcript
fidelity below which no amount of regex correction recovers them.

**Two levers beat any ≤500 MB CPU swap:** (1) **COOP/COEP threading (#9)** — whisper-progress-feedback.md's
real-browser numbers show it would cut whisper-small's ~7.9 s single-thread prefill directly, giving
up no accuracy; and (2) for capable users, **whisper-large-v3-turbo on the WebGPU tier (#9)** — the
highest accuracy measured here (87% un-prompted, and it's the one model that gains the most from
prompt biasing + a faster runtime), excluded only from the _CPU/WASM_ budget, not on merit. A
smaller CPU model is the one thing this comparison rules _out_.

## Method

1. Transcribed all candidates over the full eval set with `scripts/asr-transcribe.mjs <repo> q8
<out.json>`. The Whisper family (small/base/tiny) was run **both un-prompted and `--prompt`**, so
   each is compared to whisper-small on equal footing _and_ under the domain-prompt biasing (#25) it
   would actually ship with. The non-Whisper architectures (moonshine, wav2vec2) have no equivalent
   prompt mechanism and run un-prompted only — the fair comparison the E2E metric captures.
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
prefill is the number that matters for issue #49's goal. E2E and slot-token columns show
`raw→corrected` (extended corrector, #28).

**Un-prompted** — the cross-architecture apples-to-apples set (every model runs this way, so it's
the only fair comparison for moonshine/wav2vec2, which can't be prompted):

| model                    | q8 size | Node median/clip | in-browser prefill                                             | in-browser ms/token | E2E raw→corrected   | slot-token (corrected) |
| ------------------------ | ------- | ---------------- | -------------------------------------------------------------- | ------------------- | ------------------- | ---------------------- |
| whisper-small (baseline) | 240 MB  | 2.7 s            | **7927 ms** (mean, 8 samples, from #48)                        | **65.2 ms**         | 54%→**85%** (76/89) | 88.0%→**97.7%**        |
| whisper-large-v3-turbo   | ~650 MB | 8.1 s            | not re-measured (over budget; issue notes ~3× slower on CPU)   | —                   | 61%→87% (77/89)     | 88.4%→98.1%            |
| whisper-base             | 80 MB   | 1.5 s            | **2481 ms** (mean, 5 clips)                                    | **30.3 ms**         | 22%→52% (45/86)¹    | 69.5%→88.2%            |
| whisper-tiny             | 40 MB   | 1.1 s            | **1301 ms** (mean, 5 clips)                                    | **19.5 ms**         | 0%→7% (6/89)        | 42.9%→49.9%            |
| distil-small.en          | 190 MB  | 2.8 s            | n/a — code-incompatible in this app (see below)                | —                   | 3%→19% (17/89)²     | 71.4%→78.9%            |
| moonshine-base           | 200 MB  | 0.6 s            | n/a — not re-measured (would need app code changes, see below) | —                   | 15%→22% (20/89)     | 72.3%→77.8%            |
| moonshine-tiny           | 50 MB   | 0.4 s            | n/a — same caveat                                              | —                   | 6%→17% (15/89)      | 62.1%→70.2%            |
| wav2vec2-base-960h       | 91 MB   | 0.5 s            | n/a — same caveat                                              | —                   | 0%→**0%** (0/89)    | 20.3%→20.5%            |

**Prompted** (`--prompt`, domain-prompt biasing #25) — how the Whisper family would actually ship;
this is the row that decides the verdict for each Whisper candidate:

| model                    | q8 size | in-browser prefill | E2E raw→corrected   | slot-token raw→corrected |
| ------------------------ | ------- | ------------------ | ------------------- | ------------------------ |
| whisper-small (baseline) | 240 MB  | ~7.9 s             | 77%→**89%** (78/88) | 95.6%→**98.7%**          |
| whisper-base             | 80 MB   | ~2.5 s             | 39%→63% (56/89)     | 82.8%→91.7%              |
| whisper-tiny             | 40 MB   | ~1.3 s             | 0%→12% (11/89)      | 53.2%→61.3%              |

Prompting lifts whisper-base by +11pp E2E (52%→63%) and whisper-tiny by +5pp (7%→12%), confirming
the biasing mechanism helps the smaller encoders too — but the prompted gap to prompted small
(89%) is still 26pp for base and 77pp for tiny.

¹ whisper-base (un-prompted) threw `token_ids must be a non-empty array of integers` on 3/89 clips
(empty-decode edge case, likely repetition/silence suppression on short low-signal segments); those
3 are excluded from its un-prompted E2E and slot-token denominators (n=86). The **prompted**
whisper-base run had no such errors (full n=89) — the domain prompt seeds the decoder so it never
starts from an empty sequence, which also fixes this reliability edge, a second reason to prefer the
prompted numbers as the real verdict.

² distil-small.en / moonshine / wav2vec2 are shown un-prompted because they cannot take the
domain-prompt (distil-small.en's config lacks the required fields — see "Why only two…"; the others
have no prompt mechanism at all). Their un-prompted number _is_ their best-case in this app.

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
speedup (7927 ms → 2481 ms) for 80 MB, and the closest any candidate comes. Scored the way it would
ship (prompted, #25) it reaches **63% E2E** — meaningfully better than the 52% it gets un-prompted,
so the prompt biasing does help the smaller encoder. But 63% is still 26pp short of prompted small's
89%, so it fails as a drop-in _replacement_. Representative failures (prompted): dropped/garbled
units ("100 MPV" for "100 MeV"), material confusion ("volume" for "bone"), and outright wrong
numbers. **Where it's still interesting: as a fast first-pass tier**, not a replacement — 63%
correct at 3.2× faster prefill could back an instant provisional answer (~2.5 s) shown while
whisper-small runs in the background to confirm/correct (~7.9 s). That's real complexity (two loaded
models, a confirm-and-revise UX) and is probably dominated by just landing #9 threading for small,
but it's the one live use for a sub-small Whisper here, so it's recorded rather than dismissed.

**whisper-tiny** — confirms the floor: 12% E2E prompted (7% un-prompted), 0% raw both ways. Useful
only as a sanity check on how far the correction layer can stretch (not far, at this transcript
quality) — even the +5pp the prompt buys leaves it unusable.

**distil-small.en** — confirms the issue's prediction exactly: distil-whisper speeds up _decode_
(2-layer decoder) while leaving the _encoder_ (hence prefill) essentially whisper-small's, so it
buys nothing on the ~88%-of-wall-clock bottleneck this issue targets, and its accuracy is only 19%
E2E despite being 190 MB. It also can't take the domain prompt in this app (config lacks
`lang_to_id`/`task_to_id`, the same fields whisper-base/tiny have — see "Why only two…"), so unlike
those two it has no prompted number to improve on: 19% is its best case here. One data point
confirming, not a headline candidate — as predicted.

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
S3-mirror follow-up PR from this issue. The productive next levers, in priority order:

1. **COOP/COEP threading (issue #9)** — cuts whisper-small's ~7.9 s single-thread prefill directly
   (the encoder's large batched matmul is exactly the workload multi-threading helps most) with
   **zero accuracy cost**, unlike any model swap. This is the highest-value path and helps every
   user.
2. **whisper-large-v3-turbo on the WebGPU tier (also #9)** — the highest accuracy measured here (87%
   un-prompted; likely 90%+ prompted), excluded only from the _CPU/WASM_ budget, not on merit. For
   capable users, the right upgrade is a bigger/better model on a faster runtime, not a smaller one
   on the same slow runtime.
3. **whisper-base as an optional fast first-pass tier** — 63% E2E at 3.2× faster prefill (~2.5 s)
   could show an instant provisional answer refined by whisper-small in the background. Real UX
   value for the prefill complaint, but two-model complexity; only worth it if #1 stalls and instant
   feedback is deemed essential.
4. **A CTC-specific correction layer for wav2vec2-family models** — wav2vec2's 0% is a corrector
   artifact (Whisper-shaped rules can't parse uppercase, numeral-free CTC output), not a hard model
   ceiling. Possible but speculative (its _browser_ latency was never measured, and it's #28-scale
   work); lowest priority.
