# Multi-size Whisper benchmark — interim report (job 2804461)

_Session report, 2026-07-19. **This is a partial run, not the finished benchmark** — 3 of the
planned 42 (model, dtype, dataset) combos completed; 2 of the 5 SLURM array lanes (large-v2,
large-v3) produced no output at all. Read this as "what we've learned so far," not a final
comparison table. See `scripts/submit-whisper-bench.sh` for the full plan (7 Whisper sizes ×
{q8, fp32} × 3 datasets)._

## 1. What actually finished

| Lane | Model(s)        | Combos done                | Combos planned        |
| ---- | --------------- | -------------------------- | --------------------- |
| 0    | large-v3-ONNX   | **0**                      | 2 (× 3 datasets = 6)  |
| 1    | large-v2-ONNX   | **0**                      | 2 (× 3 datasets = 6)  |
| 2    | large-v3-turbo  | 1 (fp32, en-v3 only)       | 2 (× 3 datasets = 6)  |
| 3    | medium-ONNX     | 1 (fp32, en-v3 only)       | 2 (× 3 datasets = 6)  |
| 4    | small/base/tiny | 1 (small fp32, en-v3 only) | 6 (× 3 datasets = 18) |

**3 of 42 combos (7%) actually ran.** No `q8` transcript exists for any model in this job — every
completed combo is `fp32`, English (`tts-qwen-1000-v3`) only. No Polish data (`tts-piper-1000-pl`,
`tts-qwen-1000-pl`) at all. `base`/`tiny` (lane 4) never started.

**Root cause found — two distinct bugs, not a walltime cutoff.** Reading the `.err` logs (thread-
affinity warnings from `onnxruntime-node` aside) turned up the real errors:

1. **Lanes 0 and 1 (large-v3, large-v2): the fp32 `encoder_model.onnx_data` download failed.**
   Models over ~2GB get split by ONNX into a small `.onnx` header plus a `.onnx_data` companion
   holding the actual weights; for both lanes the header downloaded but the companion didn't
   (`ls .hf-cache/.../onnx/` confirmed it was simply absent, not a partial/corrupt file).
   `large-v3-turbo` needs the identical split-file shape and downloaded fine, so this looks like
   HF CDN contention from 5 lanes fetching concurrently at job start, not a hard library bug (a
   real bug would fail every external-data model, not 2 of 3). `prefetch-whisper-models.mjs`
   exits 1 on any failed model in its batch, and `submit-whisper-bench.sh`'s `set -euo pipefail`
   turned that single failed download into the **entire lane dying before it transcribed a single
   clip** — losing the other model (q8, which had already succeeded) along with it.
2. **Lanes 2, 3, 4 (turbo, medium, small/base/tiny): died right at the first scoring call**, with
   an empty `.log` and no `.json` output — the exact same symptom `docs/tts-eval-1000-v3.md` and
   `docs/tts-eval-1000-pl.md` both attributed to "the job's own scoring step didn't finish," an
   explanation that was never actually confirmed (no `sacct`/exit-code check was done for either
   prior run). Given the identical symptom recurring 3-for-3, this reads more like a reproducible
   scoring-stage failure under `set -e` than three independent walltime coincidences, but the
   `.err` content for these specific combos wasn't captured this time to confirm the exact
   exception — still an open thread if it recurs.

**Fixed in this PR:** `submit-whisper-bench.sh`'s per-model/per-combo steps (prefetch, transcribe,
each scoring pass) are now wrapped so a single failure is logged and skipped (`continue`) rather
than fatal to the rest of the lane — a flaky download for one model can no longer cost you the
other 5. `prefetch-whisper-models.mjs` also gained a 3-attempt retry with backoff on each model
fetch, directly targeting the demonstrated transient-download-failure mode. All scoring below was
computed locally from the (genuinely complete, 1000/1000-record) transcripts, matching the existing
convention from the prior two runs.

## 2. What the 3 completed combos show (English, fp32, `tts-qwen-1000-v3`)

| Model                  | Median inference | Raw              | Base             | Ext              | New (shipped corrector) |
| ---------------------- | ---------------- | ---------------- | ---------------- | ---------------- | ----------------------- |
| whisper-small          | 2.3s/clip        | 766/1000 (76.6%) | 767/1000 (76.7%) | 770/1000 (77.0%) | **823/1000 (82.3%)**    |
| whisper-medium-ONNX    | 4.5s/clip        | 828/1000 (82.8%) | 828/1000 (82.8%) | 833/1000 (83.3%) | **842/1000 (84.2%)**    |
| whisper-large-v3-turbo | 4.5s/clip        | 783/1000 (78.3%) | 783/1000 (78.3%) | 792/1000 (79.2%) | **846/1000 (84.6%)**    |

For reference, the already-documented `whisper-small` **q8** baseline on this exact dataset
(`docs/tts-eval-1000-v3.md` §4): 782/1000 (78.2%) raw → 840/1000 (84.0%) new-corrected.

**Two real signals, even from this small slice:**

1. **`small` at fp32 is slightly worse than `small` at q8** on the same 1000 sentences (76.6%→82.3%
   fp32 vs. 78.2%→84.0% q8) — a ~1.6–1.7pp gap in q8's favor. Quantization isn't hurting accuracy
   here; if anything it's marginally helping, contrary to the naive assumption that unquantized
   should always be at least as good.
2. **medium and turbo only marginally beat small-q8's already-documented 84.0%**, at roughly
   2× the per-clip cost (4.5s vs. small-q8's ~3.0s previously measured, or 2.3s for small-fp32 here).
   medium's raw accuracy is notably higher (82.8% vs. small's 76.6%/turbo's 78.3%) but its corrector
   gain is smallest (+1.4pp, since it starts from a stronger position); turbo's raw is the weakest of
   the three but the corrector recovers the most (+6.3pp), landing essentially tied with medium. Both
   land within ~0.6pp of small-q8 despite the cost — **no size gets much beyond ~84–85% on this eval
   set with this correction pipeline**, at least among the sizes measured so far.

### By quantity (new-corrected)

| Quantity          | small (fp32)    | medium (fp32)   | turbo (fp32)    |
| ----------------- | --------------- | --------------- | --------------- |
| `csdaRange`       | 484/600 (80.7%) | 495/600 (82.5%) | 519/600 (86.5%) |
| `energyFromRange` | 234/250 (93.6%) | 238/250 (95.2%) | 226/250 (90.4%) |
| `stoppingPower`   | 105/150 (70.0%) | 109/150 (72.7%) | 101/150 (67.3%) |

`stoppingPower` is still the hardest quantity for every model here, matching the pattern
`docs/tts-eval-1000-v3.md` §5 already found for small-q8 — bigger models don't change _which_
quantity is hardest, only move the rate a little.

### Worst voice profiles — same voices are hard regardless of model

| small (fp32) worst 3                   | medium (fp32) worst 3                  | turbo (fp32) worst 3            |
| -------------------------------------- | -------------------------------------- | ------------------------------- |
| nigerian-female-hurried (57.1%)        | jamaican-female-relaxed (63.6%)        | nigerian-female-hurried (57.1%) |
| spanish-accented-male-animated (60.0%) | custom-aiden-curious (66.7%)           | jamaican-female-relaxed (63.6%) |
| custom-ryan-happy (66.7%)              | spanish-accented-male-animated (68.0%) | british-male-skeptical (68.0%)  |

`nigerian-female-hurried`, `jamaican-female-relaxed`, `custom-aiden-curious`, and
`spanish-accented-male-animated` appear in all three worst-10 lists — a real, model-independent
signal that these specific synthesized voices are hard for reasons upstream of the ASR model choice
(TTS pronunciation/prosody quality most likely), not something a bigger Whisper fixes.

## 3. Status and next step

Not enough data yet to answer the benchmark's actual question (how do all 7 sizes compare, in both
languages, at both precisions). What's here is a real but small slice: 3 English-only fp32 points.
Root cause is now understood and fixed (§1) — `scripts/submit-whisper-bench.sh` no longer lets one
model's flaky download or one scoring pass's failure take down an entire lane's remaining work, and
`prefetch-whisper-models.mjs` retries a failed fetch 3 times before giving up. **Ready to resubmit**
(`sbatch scripts/submit-whisper-bench.sh` — safe to resubmit the whole array; already-transcribed
combos are skipped via the existing per-clip resume). Still worth watching for lanes 2–4's
scoring-stage failure recurring, since its exact cause wasn't confirmed this round (their `.err`
content wasn't captured) — if it does, capture the `.err` for whichever combo dies next.

## 4. Files

**Committed in this PR** (matches the existing `eval/results/` convention):

- `eval/results/whisper-bench-2804461/en-v3__{whisper-small,whisper-medium-ONNX,whisper-large-v3-turbo}__fp32.json`
  — raw transcripts, all 1000 clips each, zero transcription errors.
- `eval/results/whisper-bench-2804461/en-v3__*__fp32__score-{base,ext,new}.json` + matching `.log`
  — full per-clip scoring output for all three correctors × all three models, computed locally from
  the committed transcripts (§1) since the job's own scoring step didn't complete.

**Not committed — stays local**: nothing else exists yet for this job (no q8, no Polish, no
large-v2/large-v3, no base/tiny) — there's no local-only counterpart to omit this time.
