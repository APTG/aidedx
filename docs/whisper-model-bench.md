# Multi-size Whisper benchmark

_Session report, 2026-07-20, updated 2026-07-21 and 2026-07-22. Covers four Athena runs: job
2805165 (§1–7, original session — 36/42 combos) resumed by jobs 2806224 (lane 2, `large-v3-turbo`'s
remaining `pl-qwen`/`q8` clips) and 2806225 (lanes 0/1, `large-v2-ONNX`/`large-v3-ONNX` `fp32`), all
three against `eval/results/whisper-bench-2805165/`; plus job 2804461 (§8, prior session — 3/42
combos, superseded wherever it overlaps but kept for provenance). See §9 for the 2026-07-21 update
(full 42/42 grid + Chatterbox Polish datasets against 2 of 7 model sizes) and §10 for the
2026-07-22 update (job 2807345, `eval/results/whisper-bench-2807345/` — the remaining 5 model sizes
against both Chatterbox datasets). See `scripts/submit-whisper-bench.sh` for the full plan (7
Whisper sizes × {q8, fp32} × 5 datasets = 70 combos, once `pl-chat-clone`/`pl-chat-native` were
added to `DATASETS` alongside the original 3)._

## 1. TL;DR

**The `q8`/`fp32` scoring step silently produced zero output for every one of this run's 36
completed transcripts — not a partial failure like job 2804461, a total one.** Root-caused to a
missing `--experimental-strip-types` flag (§3) and fixed in this PR. All 36 transcripts were
re-scored locally instead (same fallback `docs/tts-eval-1000-v3.md` and `docs/tts-eval-1000-pl.md`
already used for their own Athena scoring-step failures).

With that data recovered: **`whisper-large-v2-ONNX` and `whisper-large-v3-ONNX`, both q8, are the
clear leaders on English** (92.5% and 90.6% new-corrected clip accuracy vs. `small`-q8's
already-shipped 84.0% baseline) — the first real evidence in this benchmark that going bigger
meaningfully helps, not just marginally as `medium`/`turbo` suggested in the job 2804461 slice.

**`whisper-large-v3-turbo` at `q8` has a real, reproducible bug**: it falls into token-repetition
hallucination loops (`"...zbita, zbita, zbita..."` repeated dozens of times) far more often than
every other model/dtype combination in this benchmark — 296/1000 English clips affected vs.
34–43/1000 for everything else, including `turbo` itself at `fp32` (§5). This tanks both its
accuracy (63.6% vs. `fp32`'s 84.6% on English; 5.4% vs. 39.1% on Polish) and its speed (median
17.2s/clip on Polish vs. `fp32`'s 5.1s). Don't ship `large-v3-turbo` at `q8` without addressing
this.

`large-v2-ONNX`/`large-v3-ONNX` **fp32** still didn't download (§6) — same external-data
`.onnx_data` failure job 2804461 hit, recurring even with the retry-with-backoff fix already
landed. And `pl-qwen`'s near-zero scores across every model (§4) are expected, not new — Qwen3-TTS
is already confirmed non-functional for Polish (`docs/tts-eval-1000-pl.md` §4).

**Update, §9: as of 2026-07-21 the full 42/42 grid is complete**, plus 8 more combos against two new
Chatterbox Polish datasets (`pl-chat-clone`, `pl-chat-native`, issue #106). The §6 download failure
did not recur on retry — `large-v2-ONNX`/`large-v3-ONNX` `fp32` downloaded and ran cleanly this
time, essentially tying their already-measured `q8` numbers (92.0% vs. 92.5% English clip accuracy
for `large-v2-ONNX`, `fp32` vs. `q8`) — `q8` remains the better choice on cost with no accuracy
penalty. Both new Chatterbox Polish datasets score far below `pl-piper` (18–25% vs. ~50%) — see
§9.2.

## 2. What completed

| Lane | Model(s)        | Combos done                                                                     | Combos planned |
| ---- | --------------- | ------------------------------------------------------------------------------- | -------------- |
| 0    | large-v3-ONNX   | 3 (q8 only, all 3 datasets)                                                     | 6 (fp32 + q8)  |
| 1    | large-v2-ONNX   | 3 (q8 only, all 3 datasets)                                                     | 6 (fp32 + q8)  |
| 2    | large-v3-turbo  | 5 of 6 (fp32/q8 × en-v3/pl-piper, + pl-qwen fp32; pl-qwen q8 partial, 235/1000) | 6 (fp32 + q8)  |
| 3    | medium-ONNX     | 6 (fp32 + q8, all 3 datasets)                                                   | 6 (fp32 + q8)  |
| 4    | small/base/tiny | 18 (fp32 + q8 × 3 sizes, all 3 datasets)                                        | 18             |

**36 of 42 combos complete, 1 in progress, 5 missing.** Per the user-provided `squeue` snapshot
(`2805165_2` at 12:14:37 elapsed, node `t0001`), lane 2 (`large-v3-turbo`) was still running when
this data was pulled — consistent with its `pl-qwen`/`q8` transcript stopping at 235/1000 records
(the resumable-transcribe design mid-write, not a crash). Lanes 0, 1, 3, 4 had already finished (not
in `squeue`). Missing entirely: `large-v3-ONNX`/`fp32` and `large-v2-ONNX`/`fp32`, all 3 datasets
each (§6).

## 3. Root cause: scoring step produced zero output for all 36 combos

Every `*__score-{base,ext,new}.log` in this job's results directory is a 0-byte file, and no
`*__score-*.json` exists at all — for every lane, every model, every dataset, not a subset like job
2804461's lanes 2–4. That total, uniform failure pattern (rather than a handful of one-off crashes)
pointed at the invocation itself rather than the data.

`scripts/asr-score-slots-generic.mjs` imports `../src/lib/asr/correct/core.ts` directly — a `.ts`
file. `submit-whisper-bench.sh`'s score step called it as plain `node scripts/asr-score-slots-generic.mjs
...`, but `scripts/submit-v3.sh`, `submit.sh`, `submit-pl.sh`, and `submit-v2.sh` all add
`node --experimental-strip-types` for their own direct `.ts` imports — `submit-whisper-bench.sh`'s score
step never got that flag. Reproduced locally:

```
$ node --no-experimental-strip-types scripts/asr-score-slots-generic.mjs <manifest> <transcript> --new --json out.json
TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts" for .../src/lib/asr/correct/core.ts
```

This throws at import time, before any stdout is produced — exactly matching the observed 0-byte
`tee` output and missing `--json` file. It doesn't reproduce with a bare `node` on this machine
(Node 24, where type-stripping is on by default per `package.json`'s `"engines": {"node": ">=24"}`)
— only Athena matters here, where `scripts/athena-env.sh` does `module load ... nodejs/22.17.1`,
and Node 22's type-stripping is opt-in only. This also explains why the prior report's job 2804461
lanes 2–4 hit the exact same "died right at first scoring call, empty `.log`" symptom and it went
unconfirmed — this was always the actual cause, present since the script's first commit, not a
walltime coincidence or a new regression.

**Fixed in this PR**: added `--experimental-strip-types` to the score invocation in
`submit-whisper-bench.sh`. **Not fixed by resubmitting** — this run's 36 transcripts are genuinely
complete (job 2804461's `set -euo pipefail`/per-step-`continue` fixes already landed and worked:
one lane's failure no longer takes out its siblings), so all scoring below was computed locally from
the committed transcripts instead of waiting on a resubmit, same fallback the two 1000-sentence TTS
docs already used for their own Athena scoring-step failures.

## 4. Headline results (new-corrected clip accuracy, raw → new)

### English (`tts-qwen-1000-v3`)

| Model                  | dtype | Median inference | Raw   | New (shipped corrector)          |
| ---------------------- | ----- | ---------------- | ----- | -------------------------------- |
| whisper-tiny           | q8    | 1.2s             | 22.1% | 37.1%                            |
| whisper-tiny           | fp32  | 1.0s             | 45.7% | 53.6%                            |
| whisper-base           | q8    | 1.5s             | 63.6% | 71.1%                            |
| whisper-base           | fp32  | 1.3s             | 74.1% | 79.7%                            |
| whisper-small          | q8    | 2.7s             | 78.2% | **84.0%** (shipped baseline)     |
| whisper-small          | fp32  | 2.6s             | 76.6% | 82.3%                            |
| whisper-medium-ONNX    | q8    | 4.2s             | 81.7% | 83.6%                            |
| whisper-medium-ONNX    | fp32  | 5.1s             | 82.8% | 84.2%                            |
| whisper-large-v2-ONNX  | q8    | 6.3s             | 87.6% | **92.5%** (best so far)          |
| whisper-large-v3-ONNX  | q8    | 6.6s             | 84.4% | **90.6%**                        |
| whisper-large-v3-turbo | q8    | 4.6s             | 59.0% | 63.6% ⚠️ repetition-loop bug, §5 |
| whisper-large-v3-turbo | fp32  | 4.7s             | 78.3% | 84.6%                            |

### Polish, Piper voices (`tts-piper-1000-pl`)

| Model                  | dtype | Median inference | Raw   | New                                                  |
| ---------------------- | ----- | ---------------- | ----- | ---------------------------------------------------- |
| whisper-tiny           | q8    | 1.4s             | 0.1%  | 0.1%                                                 |
| whisper-tiny           | fp32  | 1.1s             | 0.4%  | 0.5%                                                 |
| whisper-base           | q8    | 1.8s             | 0.2%  | 1.5%                                                 |
| whisper-base           | fp32  | 1.5s             | 6.5%  | 7.3%                                                 |
| whisper-small          | q8    | 3.1s             | 19.2% | 20.8% (shipped baseline, `docs/tts-eval-1000-pl.md`) |
| whisper-small          | fp32  | 3.1s             | 20.4% | 22.4%                                                |
| whisper-medium-ONNX    | q8    | 5.1s             | 29.3% | 32.3%                                                |
| whisper-medium-ONNX    | fp32  | 6.2s             | 28.2% | 31.0%                                                |
| whisper-large-v2-ONNX  | q8    | 7.5s             | 43.9% | **49.1%** (best so far)                              |
| whisper-large-v3-ONNX  | q8    | 7.8s             | 45.0% | **51.7%**                                            |
| whisper-large-v3-turbo | q8    | 17.2s            | 1.2%  | 5.4% ⚠️ repetition-loop bug, §5                      |
| whisper-large-v3-turbo | fp32  | 5.1s             | 14.9% | 39.1%                                                |

### Polish, Qwen3-TTS voices (`tts-qwen-1000-pl`) — expected near-zero, see §4.1

| Model                  | dtype | Median inference           | Raw  | New  |
| ---------------------- | ----- | -------------------------- | ---- | ---- |
| whisper-tiny           | q8    | 1.5s                       | 0.0% | 0.0% |
| whisper-tiny           | fp32  | 1.1s                       | 0.0% | 0.0% |
| whisper-base           | q8    | 2.1s                       | 0.1% | 0.2% |
| whisper-base           | fp32  | 1.6s                       | 0.1% | 0.1% |
| whisper-small          | q8    | 3.3s                       | 0.8% | 0.9% |
| whisper-small          | fp32  | 3.3s                       | 0.6% | 0.7% |
| whisper-medium-ONNX    | q8    | 5.4s                       | 1.8% | 1.9% |
| whisper-medium-ONNX    | fp32  | 6.6s                       | 2.0% | 2.0% |
| whisper-large-v2-ONNX  | q8    | 8.5s                       | 2.5% | 2.5% |
| whisper-large-v3-ONNX  | q8    | 8.7s                       | 1.8% | 1.9% |
| whisper-large-v3-turbo | q8    | 16.5s (n=235, in progress) | 0.4% | 0.4% |
| whisper-large-v3-turbo | fp32  | 5.1s                       | 0.9% | 1.3% |

### 4.1 Why `pl-qwen` is near-zero for every model, not just turbo-q8

Not a new finding — `docs/tts-eval-1000-pl.md` §4 already established Qwen3-TTS **never actually
speaks Polish**: `language="Polish"` is rejected outright, every clip falls back to `Auto` mode, and
that doc's own whisper-small-q8 measurement already landed at 0.9%. Every model size/dtype here
lands in the same 0.0–2.5% band, confirming the failure is upstream in the audio, not something a
bigger or better-quantized Whisper can fix. Read `pl-piper` (§4, middle table) as the real Polish
signal; `pl-qwen` numbers are included only for completeness since the job produced them.

## 5. `whisper-large-v3-turbo` + `q8`: a real repetition-loop bug, not noise

`turbo`'s `q8` numbers are the one place in this benchmark where quantization doesn't just cost a
point or two — it collapses the model. Comparing `fp32` vs. `q8` for the same model on the same
data:

| Dataset  | fp32 (raw→new) | q8 (raw→new)        | fp32 median | q8 median |
| -------- | -------------- | ------------------- | ----------- | --------- |
| en-v3    | 78.3% → 84.6%  | 59.0% → 63.6%       | 4.7s        | 4.6s      |
| pl-piper | 14.9% → 39.1%  | 1.2% → 5.4%         | 5.1s        | **17.2s** |
| pl-qwen  | 0.9% → 1.3%    | 0.4% → 0.4% (n=235) | 5.1s        | 16.5s     |

Inspecting the raw transcripts explains both the accuracy drop and the ~3.5× slowdown on Polish: a
large share of `turbo`/`q8` clips are token-repetition hallucinations — the decoder gets stuck
emitting the same word or short phrase dozens of times before hitting the length cap, e.g.
(`pl-rng-0001`, `whisper-large-v3-turbo` q8): `"Objeżę, objeżę, zbita, zbita, zbita, zbita, zbita,
zbita, zbita, zbita, zbita, zbita, ..."` (continues for the full clip). Counting clips whose raw
transcript exceeds 20 words (a proxy for "probably looping," since these sentences are all
single/short queries) isolates this cleanly to `turbo`/`q8` specifically — every other model/dtype
combination, including `turbo` itself at `fp32`, clusters in the same narrow 34–43/1000 band:

| Model / dtype (English)         | Clips with >20-word raw output |
| ------------------------------- | ------------------------------ |
| whisper-tiny / q8               | 34/1000                        |
| whisper-base / q8               | 41/1000                        |
| whisper-small / q8              | 43/1000                        |
| whisper-medium-ONNX / q8        | 38/1000                        |
| whisper-large-v2-ONNX / q8      | 39/1000                        |
| whisper-large-v3-ONNX / q8      | 40/1000                        |
| **whisper-large-v3-turbo / q8** | **296/1000**                   |
| whisper-large-v3-turbo / fp32   | 39/1000                        |

Not a generic "q8 makes Whisper loop more" effect (every other q8 model sits in the normal band)
and not inherent to the `turbo` architecture (its own `fp32` checkpoint is normal too) — it's
specific to this one (model, dtype) pair's ONNX quantization. **Recommendation: don't adopt
`large-v3-turbo` at `q8` for anything until this is understood** (e.g. a decoder repetition penalty
/ `no_repeat_ngram_size` setting, or a re-quantization); `large-v3-turbo`/`fp32` itself is fine and
roughly ties `medium` on English (84.6% vs. 84.2%).

## 6. Still missing: `large-v2-ONNX`/`large-v3-ONNX` at `fp32`

Neither downloaded in this run either — the same `.onnx_data` external-weights companion file job
2804461 first hit (`docs/whisper-model-bench.md` §8 below), this time recurring **despite** the
3-attempt retry-with-backoff fix from that report already being in this branch. That downgrades the
original "HF CDN contention, transient" hypothesis: a genuinely transient failure should have been
caught by 3 retries with backoff across two separate job runs. Worth capturing lane 0/1's `.err`
output specifically (not copied off Athena this round) before resubmitting again, since the
transient-failure fix already didn't hold up a second time.

## 7. Status and next step

**36/42 combos now have real, locally-scored data** — a big step up from job 2804461's 3/42, and
enough to answer the benchmark's core question on English and Polish(Piper): bigger, well-behaved q8
models (`large-v2`, `large-v3`) clearly beat `small`'s shipped baseline by a wide margin (+8.5pp and
+6.6pp on English), at a real but bounded cost (~6.5s/clip vs. `small`'s ~2.7s). `medium` and
`turbo`/`fp32` sit in between, close to each other, both only marginally ahead of `small`-q8 despite
costing more.

**Next**: (1) resubmit lanes 0/1 with `.err` capture to finally root-cause the recurring fp32
external-data download failure (§6); (2) resubmit lane 2 to pick up `pl-qwen`/`large-v3-turbo`/`q8`'s
remaining 765 clips (cosmetic only, given §4.1 — expected to stay near-zero); (3) decide whether
`large-v3-turbo`/`q8`'s repetition-loop bug (§5) is worth investigating before this benchmark is
considered final, since it's currently the only combo whose number doesn't mean what it looks like
it means.

## 8. Files

**Committed in this PR** (matches the existing `eval/results/` convention):

- `eval/results/whisper-bench-2805165/{en-v3,pl-piper,pl-qwen}__whisper-*__{fp32,q8}.json` — raw
  transcripts for all 36 completed combos (35 at 1000/1000 clips; `pl-qwen__whisper-large-v3-turbo__q8`
  at 235/1000, job still running when pulled, §2), zero transcription errors on any completed clip.
- `eval/results/whisper-bench-2805165/*__score-{base,ext,new}.json` + matching `.log` — full
  per-clip scoring output for all three correctors × all 36 transcripts, computed locally (§3) since
  Athena's own scoring step produced no output for this job at all.
- `scripts/submit-whisper-bench.sh` — the `--experimental-strip-types` fix (§3).

**Not committed — stays local**: no `fp32` transcripts for `large-v2-ONNX`/`large-v3-ONNX` (§6, never
downloaded), no completed `pl-qwen__whisper-large-v3-turbo__q8` (§2, in progress).

## 9. Update, 2026-07-21: full grid complete + two new Chatterbox Polish datasets

Two follow-up resumes against the same `RESULTS_DIR=eval/results/whisper-bench-2805165/` (per §7's
"next step" plan, run as jobs 2806224 and 2806225 rather than a re-run of 2805165 itself — see
`kill-and-resume-2805165-lane2.md`): job 2806224 (`--array=2`) finished lane 2's remaining
`pl-qwen`/`large-v3-turbo`/`q8` clips (235 → 1000/1000), and job 2806225 (`--array=0,1`) finally
got `large-v2-ONNX`/`large-v3-ONNX` `fp32` downloaded and transcribed on all 3 original datasets.
Separately, the Chatterbox Polish TTS pipeline (issue #106) produced two new 1000-sentence datasets,
transcribed here against just `large-v2-ONNX`/`large-v3-ONNX` (both dtypes) rather than the full
7-model sweep. **All 50 combos across both this update and §1–8 are complete, 1000/1000 clips each,
zero transcription errors.**

### 9.1 §6 resolved, without a real root cause

`large-v2-ONNX`/`large-v3-ONNX` `fp32` downloaded and ran without incident on both datasets this
time — no `.onnx_data` companion-file failure, no retry needed. Since nothing in
`scripts/asr-transcribe-manifest.mjs`'s download path changed between this run and job 2805165's
failed attempt, the most consistent read is that this was genuinely transient HF CDN contention
after all (the original hypothesis job 2804461 proposed and §6 above walked back) — it just needed
more than 3 retries-with-backoff on a bad day. Not a satisfying root cause, but not worth more
investigation now that the data exists.

### 9.2 Complete English + Polish(Piper/Qwen) grid — `fp32` rows for `large-v2/v3-ONNX`

Filling in the previously-missing rows from §4's tables (existing `q8` rows unchanged, repeated here
for context):

**English (`tts-qwen-1000-v3`)**

| Model                 | dtype | Median inference | Raw   | New                          |
| --------------------- | ----- | ---------------- | ----- | ---------------------------- |
| whisper-large-v2-ONNX | fp32  | 7.9s             | 85.8% | **92.0%** (new overall best) |
| whisper-large-v2-ONNX | q8    | 6.3s             | 87.6% | **92.5%**                    |
| whisper-large-v3-ONNX | fp32  | 7.9s             | 83.4% | 90.4%                        |
| whisper-large-v3-ONNX | q8    | 6.6s             | 84.4% | 90.6%                        |

**Polish, Piper voices (`tts-piper-1000-pl`)**

| Model                 | dtype | Median inference | Raw   | New                          |
| --------------------- | ----- | ---------------- | ----- | ---------------------------- |
| whisper-large-v2-ONNX | fp32  | 9.5s             | 50.2% | **53.8%** (new overall best) |
| whisper-large-v2-ONNX | q8    | 7.5s             | 43.9% | 49.1%                        |
| whisper-large-v3-ONNX | fp32  | 10.2s            | 46.2% | 52.2%                        |
| whisper-large-v3-ONNX | q8    | 7.8s             | 45.0% | 51.7%                        |

**Polish, Qwen3-TTS voices (`tts-qwen-1000-pl`)** — still near-zero, §4.1's explanation still holds:

| Model                  | dtype | Median inference      | Raw  | New  |
| ---------------------- | ----- | --------------------- | ---- | ---- |
| whisper-large-v2-ONNX  | fp32  | 9.8s                  | 3.1% | 3.2% |
| whisper-large-v3-ONNX  | fp32  | 11.2s                 | 2.0% | 2.3% |
| whisper-large-v3-turbo | q8    | 17.2s (now 1000/1000) | 0.1% | 0.1% |

`large-v3-turbo`/`q8`'s completed `pl-qwen` run confirms §5's repetition-loop bug at full scale:
**955/1000 clips** now exceed the 20-word "probably looping" proxy (vs. the 235-clip partial sample
this doc previously didn't have a number for) — worse, proportionally, than the English 296/1000,
consistent with the bug compounding on already-broken Qwen3-TTS Polish audio rather than being
data-dependent.

### 9.3 New: Chatterbox Polish datasets score well below Piper

`pl-chat-clone` (voice-cloned) and `pl-chat-native` (Chatterbox's own Polish voice) are new
1000-sentence batches from the Chatterbox pipeline (issue #106, `docs/tts-chatterbox-pl-clone.md`).
Both were only run against `large-v2-ONNX`/`large-v3-ONNX` (this benchmark's two best models so far,
not the full 7-size sweep):

| Dataset        | Model                 | dtype | Median inference | Raw   | New              |
| -------------- | --------------------- | ----- | ---------------- | ----- | ---------------- |
| pl-chat-clone  | whisper-large-v2-ONNX | fp32  | 8.9s             | 23.1% | 23.6%            |
| pl-chat-clone  | whisper-large-v2-ONNX | q8    | 7.9s             | 22.1% | 22.8%            |
| pl-chat-clone  | whisper-large-v3-ONNX | fp32  | 10.8s            | 22.1% | 22.8%            |
| pl-chat-clone  | whisper-large-v3-ONNX | q8    | 8.7s             | 24.4% | **25.0%** (best) |
| pl-chat-native | whisper-large-v2-ONNX | fp32  | 9.2s             | 18.2% | 18.6%            |
| pl-chat-native | whisper-large-v2-ONNX | q8    | 7.6s             | 18.0% | 18.7%            |
| pl-chat-native | whisper-large-v3-ONNX | fp32  | 12.3s            | 20.5% | **20.6%** (best) |
| pl-chat-native | whisper-large-v3-ONNX | q8    | 8.7s             | 19.9% | 20.2%            |

Both Chatterbox datasets land well below `pl-piper`'s ~50–54% on the same two models (§9.2) — the
gap is far bigger than the raw→new correction step can close (≤1.4pp movement, vs. ~4–6pp for
`pl-piper`), pointing at the audio itself (pronunciation, pacing, or clarity of Chatterbox's Polish
output) rather than a scoring/corrector mismatch. Neither is anywhere near a shippable ASR accuracy
level for the voice pipeline. Not investigated further here — flagging for whoever picks up
Chatterbox Polish quality next (issue #106).

### 9.4 Updated status

**50/50 combos across both sessions now have real, locally-scored data.** Confirmed conclusions:
`large-v2-ONNX` (either dtype) is this benchmark's best English and Polish(Piper) model;
`large-v3-turbo`/`q8`'s repetition-loop bug (§5) is real and gets worse, not better, on harder
Polish audio; and Chatterbox's Polish TTS output (both native and cloned) is currently much harder
for Whisper to transcribe than Piper's, an issue #106 finding, not a Whisper-side one.

**Files (this update)**: `eval/results/whisper-bench-2805165/` — added
`{en-v3,pl-qwen}__whisper-large-v{2,3}-ONNX__fp32*`, `pl-chat-{clone,native}__whisper-large-v{2,3}-ONNX__{fp32,q8}*`,
and updated `pl-qwen__whisper-large-v3-turbo__q8*` (now 1000/1000) plus all `*__score-*` files that
depend on it — raw transcripts, `--new`/`--ext`/`--base` corrector scoring JSON, and matching `.log`
per combo, same convention as §8.

## 10. Update, 2026-07-22: job 2807345 — remaining 5 model sizes vs. both Chatterbox datasets

§9.3 only ran the two new Chatterbox Polish datasets (`pl-chat-clone`, `pl-chat-native`) against
`large-v2-ONNX`/`large-v3-ONNX`, this benchmark's two best models — not the full 7-size sweep. Job
2807345 (`sbatch --array=2,3,4`, lanes `large-v3-turbo`/`medium-ONNX`/`small-base-tiny`) fills in the
remaining 5 sizes (`tiny`, `base`, `small`, `medium-ONNX`, `large-v3-turbo`) against both datasets.
`DATASETS` in `submit-whisper-bench.sh` now lists all 5 datasets unconditionally (not just the
Chatterbox ones), so this job also re-transcribed `en-v3`/`pl-piper`/`pl-qwen` for these same 5
models — confirmed byte-identical `raw` transcript text against job 2805165's already-committed data
for every record checked (only the per-clip `secs` timing differs, as expected re-running on a
different day). That redundant slice **was not re-committed** — no accuracy signal in it that
isn't already in §4/§9.2, and `eval/results/` doesn't need a second multi-megabyte copy of the same
transcripts. Only the genuinely new `pl-chat-clone`/`pl-chat-native` combos landed in
`eval/results/whisper-bench-2807345/`.

**One combo is incomplete**: `pl-chat-native__whisper-large-v3-turbo__q8` stopped at 467/1000 clips
with no `score-*` files — lane 4's last (dataset, model) pair in iteration order, consistent with
the job still running (or having hit walltime) when this session's data was pulled, the same
"partial, resumable" pattern §2 and §9's job 2805165 hit for `pl-qwen__whisper-large-v3-turbo__q8`.
The 467 completed records are committed for provenance; a resubmit of lane 2 with
`RESULTS_DIR=eval/results/whisper-bench-2807345` will resume from clip 468 via
`asr-transcribe-manifest.mjs`'s existing per-clip resume. Scoring for this one combo is deferred
until it completes.

### 10.1 Full 7-model grid, both Chatterbox datasets (new-corrected clip accuracy)

Combining this update's 5 sizes with §9.3's already-committed `large-v2-ONNX`/`large-v3-ONNX` rows:

**`pl-chat-clone` (voice-cloned)**

| Model                  | dtype | Median inference | Raw   | New                     |
| ---------------------- | ----- | ---------------- | ----- | ----------------------- |
| whisper-tiny           | q8    | 1.4s             | 0.0%  | 0.0%                    |
| whisper-tiny           | fp32  | 1.0s             | 0.8%  | 1.1%                    |
| whisper-base           | q8    | 1.7s             | 1.7%  | 2.1%                    |
| whisper-base           | fp32  | 1.3s             | 4.3%  | 6.2%                    |
| whisper-small          | q8    | 2.7s             | 12.8% | 13.2%                   |
| whisper-small          | fp32  | 2.6s             | 13.8% | 13.9%                   |
| whisper-medium-ONNX    | q8    | 4.3s             | 15.2% | 16.4%                   |
| whisper-medium-ONNX    | fp32  | 4.6s             | 17.2% | 18.0%                   |
| whisper-large-v2-ONNX  | q8    | 7.9s             | 22.1% | 22.8%                   |
| whisper-large-v2-ONNX  | fp32  | 8.9s             | 23.1% | 23.6%                   |
| whisper-large-v3-ONNX  | q8    | 8.7s             | 24.4% | **25.0%** (best)        |
| whisper-large-v3-ONNX  | fp32  | 10.8s            | 22.1% | 22.8%                   |
| whisper-large-v3-turbo | fp32  | 5.0s             | 11.9% | 12.6%                   |
| whisper-large-v3-turbo | q8    | 14.9s            | 1.4%  | 1.8% ⚠️ repetition loop |

**`pl-chat-native` (Chatterbox's own Polish voice)**

| Model                  | dtype | Median inference | Raw   | New                                  |
| ---------------------- | ----- | ---------------- | ----- | ------------------------------------ |
| whisper-tiny           | q8    | 1.4s             | 0.1%  | 0.1%                                 |
| whisper-tiny           | fp32  | 0.9s             | 0.6%  | 0.6%                                 |
| whisper-base           | q8    | 1.7s             | 1.0%  | 1.1%                                 |
| whisper-base           | fp32  | 1.3s             | 2.7%  | 3.7%                                 |
| whisper-small          | q8    | 2.7s             | 9.1%  | 9.1%                                 |
| whisper-small          | fp32  | 2.7s             | 9.4%  | 9.8%                                 |
| whisper-medium-ONNX    | q8    | 4.5s             | 12.9% | 14.3%                                |
| whisper-medium-ONNX    | fp32  | 4.8s             | 13.3% | 14.2%                                |
| whisper-large-v2-ONNX  | q8    | 7.6s             | 18.0% | 18.7%                                |
| whisper-large-v2-ONNX  | fp32  | 9.2s             | 18.2% | 18.6%                                |
| whisper-large-v3-ONNX  | q8    | 8.7s             | 19.9% | 20.2%                                |
| whisper-large-v3-ONNX  | fp32  | 12.3s            | 20.5% | **20.6%** (best)                     |
| whisper-large-v3-turbo | fp32  | 5.1s             | 8.6%  | 9.0%                                 |
| whisper-large-v3-turbo | q8    | —                | —     | not scored yet, 467/1000 clips (§10) |

Both tables confirm §9.3's read at full resolution: `large-v2-ONNX`/`large-v3-ONNX` remain the best
models on Chatterbox Polish audio same as everywhere else in this benchmark, but the gap to
`medium-ONNX` is narrower here (≤9pp) than on `pl-piper` (§9.2, ~35–40pp) — Chatterbox's output is
hard enough for every model that going bigger buys proportionally less. `tiny`/`base`/`small` are
all close to unusable on this data (≤14% even at `small`), consistent with §9.3's "far below
`pl-piper`" finding extending down the whole size range, not just the two best models.

### 10.2 `large-v3-turbo`/`q8`'s repetition-loop bug (§5) is at its worst yet on Chatterbox audio

Same >20-word-raw-output proxy as §5 and §9.2:

| Dataset        | fp32 clips >20 words | q8 clips >20 words |
| -------------- | -------------------- | ------------------ |
| pl-chat-clone  | 15/1000              | **768/1000**       |
| pl-chat-native | 23/1000              | 380/467 (partial)  |

768/1000 on `pl-chat-clone` is the highest looping rate this benchmark has measured for this bug —
above English's 296/1000 (§5) and Qwen3-TTS Polish's 955/1000 (§9.2), and `pl-chat-native`'s partial
380/467 (81%) tracks the same direction. Consistent with §9.2's read: the bug compounds on
already-hard input rather than being specific to one dataset's audio characteristics. Reinforces §5's
recommendation not to adopt `large-v3-turbo`/`q8` anywhere until this is understood.

### 10.3 Updated status

**134 new files landed** in `eval/results/whisper-bench-2807345/`: 10 combos × 7 files (main +
3 correctors × {json, log}) for `pl-chat-clone` (all complete, 1000/1000), and 9 combos for
`pl-chat-native` (8 complete at 1000/1000, `large-v3-turbo`/`q8` at 467/1000 with scoring deferred).
Combined with §9.3, both Chatterbox Polish datasets now have a complete 7-model sweep (bar the one
in-progress combo). Confirmed conclusions unchanged from §9.4: `large-v2-ONNX`/`large-v3-ONNX` are
the best models on every dataset this benchmark covers, and `large-v3-turbo`/`q8`'s repetition-loop
bug gets worse, not better, as the input audio gets harder to transcribe.

**Files (this update)**: `eval/results/whisper-bench-2807345/pl-chat-{clone,native}__whisper-{tiny,base,small,medium-ONNX,large-v3-turbo}__{fp32,q8}*`
(`pl-chat-native__whisper-large-v3-turbo__q8` main transcript only, no `score-*` yet, §10). This
job's redundant `en-v3`/`pl-piper`/`pl-qwen` re-transcriptions for these same 5 models were **not**
committed (§10, byte-identical to already-committed data).

---

## Appendix: job 2804461 (prior session, superseded above)

_Original interim report, 2026-07-19 — kept for provenance. §1–7 above supersede this wherever they
overlap (all of English/`fp32`/{small, medium-ONNX, large-v3-turbo}); this section's own
"still worth watching for lanes 2–4's scoring-stage failure recurring" note (its closing line) is
what §3 above confirms and fixes._

**This was a partial run** — 3 of the planned 42 (model, dtype, dataset) combos completed; 2 of the
5 SLURM array lanes (large-v2, large-v3) produced no output at all.

### What actually finished

| Lane | Model(s)        | Combos done                | Combos planned        |
| ---- | --------------- | -------------------------- | --------------------- |
| 0    | large-v3-ONNX   | **0**                      | 2 (× 3 datasets = 6)  |
| 1    | large-v2-ONNX   | **0**                      | 2 (× 3 datasets = 6)  |
| 2    | large-v3-turbo  | 1 (fp32, en-v3 only)       | 2 (× 3 datasets = 6)  |
| 3    | medium-ONNX     | 1 (fp32, en-v3 only)       | 2 (× 3 datasets = 6)  |
| 4    | small/base/tiny | 1 (small fp32, en-v3 only) | 6 (× 3 datasets = 18) |

### Root cause found — two distinct bugs, not a walltime cutoff

1. **Lanes 0 and 1 (large-v3, large-v2): the fp32 `encoder_model.onnx_data` download failed** —
   models over ~2GB get split into a small `.onnx` header plus a `.onnx_data` companion; for both
   lanes the header downloaded but the companion didn't. `large-v3-turbo` needs the identical
   split-file shape and downloaded fine, so this looked like transient HF CDN contention, not a hard
   library bug — a hypothesis job 2805165 (§6 above) shows didn't fully hold up on a second run.
2. **Lanes 2, 3, 4: died right at the first scoring call**, empty `.log`, no `.json` — now known
   (§3 above) to be the missing `--experimental-strip-types` flag, not a walltime coincidence.

### What the 3 completed combos showed (English, fp32, `tts-qwen-1000-v3`)

| Model                  | Median inference | Raw   | New (shipped corrector) |
| ---------------------- | ---------------- | ----- | ----------------------- |
| whisper-small          | 2.3s             | 76.6% | 82.3%                   |
| whisper-medium-ONNX    | 4.5s             | 82.8% | 84.2%                   |
| whisper-large-v3-turbo | 4.5s             | 78.3% | 84.6%                   |

(Job 2805165's own re-measurement of these same three combos, §4 above, landed at the exact same
82.3%/84.2%/84.6% — confirmed byte-identical raw transcripts across both runs, 0/1000 clips differ.
Whisper's greedy CPU decoding here is fully deterministic; a useful cross-run sanity check, not
independent evidence, if this benchmark is ever re-run again.)

### Files (job 2804461)

- `eval/results/whisper-bench-2804461/en-v3__{whisper-small,whisper-medium-ONNX,whisper-large-v3-turbo}__fp32.json`
  — raw transcripts, all 1000 clips each, zero transcription errors.
- `eval/results/whisper-bench-2804461/en-v3__*__fp32__score-{base,ext,new}.json` + matching `.log`
  — full per-clip scoring output, computed locally from the committed transcripts.
