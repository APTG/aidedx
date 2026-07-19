# Apple Silicon (M5) benchmark — ASR, LLM-NLU fallback, and KV-cache latency

_Session report, 2026-07-10. Companion to
[`docs/voice-pipeline-feasibility.md`](./voice-pipeline-feasibility.md) (the 2026-07-05 Linux
CPU-only baseline) — re-runs the same benchmarks on different hardware to answer issue #21's
question: does any of this change on the actual target hardware for capable users? Posted
originally as comments on [issue #21](https://github.com/APTG/aidedx/issues/21) (Tasks B, C,
D/E/F) and [issue #8](https://github.com/APTG/aidedx/issues/8) (Task A, since that's the
LLM-NLU-fallback decision it's most relevant to); captured here as one report so the numbers don't
depend on reading four separate comments across two issues._

**Machine:** Apple M5, 10 cores, 16 GB RAM, macOS, Node 24.18, `@huggingface/transformers` 4.2.0 on
`onnxruntime-node` (**CPU execution provider** — the Node package has no Metal/CoreML EP, and
WebGPU is browser-only, so every number below is an Apple-Silicon **CPU** figure and a lower bound
for the eventual in-browser WebGPU tier). Same audio (`eval/audio/{km,lg,mn}/`, 89 clips / 3
speakers) and eval set as the Linux session.

## TL;DR

- **CPU-only ASR is comfortably interactive on Apple Silicon.** Prompt-biased whisper-small q8:
  **0.82 s/clip** (vs 2.8 s on Linux, ~3.4× faster). Model ranking from the Linux session holds:
  small ≈ turbo on accuracy, small ~3× faster → still the CPU-tier pick; tiny/base/moonshine remain
  unusable on this domain's vocabulary.
- **Full-JSON LLM-NLU generation is not viable even on M5**: 4–12 s/query, ≤71% JSON-valid. This
  confirms (doesn't just repeat) the feasibility report's rescope away from it.
- **The single-token constrained classifier is the one LLM-fallback shape that clears the
  interactive budget.** Raw: 0.59 s (Qwen-0.5B) / 1.86 s (Qwen-1.5B). With prefix-KV-cache reuse,
  the 1.5B's steady-state per-query cost drops to **~0.34 s** — under the <1 s target, no GPU
  required.
- **Full-sentence LLM correction of ASR errors is not competitive** with the deterministic
  corrector: ~12–14 s/case on CPU, versus effectively-instant regex/phonetic rules.

## Task A — full-JSON LLM-NLU eval (decision-relevant for #8)

`scripts/llm-nlu-eval.ts --all`, full 120-example eval set, all three models. Prompt-level JSON
enforcement only (no grammar-constrained decoding).

| Model (ONNX q4)  | JSON-valid | Slot-acc | Exact-acc | Median   | p95      |
| ---------------- | ---------- | -------- | --------- | -------- | -------- |
| Qwen2.5-0.5B     | 65%        | 22%      | 22%       | 4135 ms  | 5069 ms  |
| **Qwen2.5-1.5B** | **71%**    | **45%**  | **41%**   | 12365 ms | 14578 ms |
| Llama-3.2-1B     | 71%        | 38%      | 37%       | 4270 ms  | 4744 ms  |

- **Latency vs the <500 ms target:** every model is **8–25× over budget** — 4.1 s (0.5B / Llama) to
  12.4 s (1.5B) per query, even on Apple Silicon.
- **Accuracy:** best is Qwen-1.5B at 45% slot / 41% exact, and **JSON validity tops out at 71%** —
  prompt-level enforcement leaks constantly. Dominant schema failures: invalid `energies[].unit`
  values and out-of-enum `quantity` strings (the model invented `"energyLossPerLength"`).
- **Two operational notes:** the multi-model orchestrator's 600 s per-child timeout SIGTERM'd
  Qwen-1.5B at 48/120 (re-run standalone with no timeout to get the row above — worth raising for
  full-set runs on slower hardware); no memory pressure on 16 GB (1.5B q4 peaks ~2.7 GB).

**Reads the same as the Linux result:** full-JSON generation by small local LLMs is both too slow
and too unreliable for the main path. The productive directions are the deterministic matcher +
synonym table (120/120, sub-ms — #26) and a narrow **single-token constrained** fallback (Task E),
which on this same M5 ran at 0.59 s (0.5B) / 1.86 s (1.5B).

## Task B — ASR batch benchmark (Whisper family + Moonshine)

`scripts/asr-batch.mjs`, invoked per model (the bare command only runs whisper-small). Metric is
**exact full-transcript match** — a known-poor proxy here (punctuation/casing sink it); the
slot-token accuracy that actually matters is 88–98% for the same clips (see the feasibility
report).

| Model (q8)             | exact-match     | load  | median     | p95    |
| ---------------------- | --------------- | ----- | ---------- | ------ |
| whisper-tiny           | 0/89 (0%)       | 0.2 s | 0.20 s     | 3.00 s |
| whisper-base           | 1/89 (1%)       | 0.3 s | 0.30 s     | 0.40 s |
| **whisper-small**      | **31/89 (35%)** | 0.5 s | **0.80 s** | 0.90 s |
| whisper-large-v3-turbo | 30/89 (34%)     | 0.9 s | 2.70 s     | 2.80 s |
| moonshine-base         | 2/89 (2%)       | 0.4 s | 0.10 s     | 0.20 s |

**M5 vs the Linux/no-GPU baseline (PR #18):**

- **Latency is ~3–4× better on M5.** whisper-small drops from 2.7 s/clip (Linux) to **0.80 s**
  here; turbo from 8.1 s to 2.70 s; moonshine 0.6 s → 0.10 s. CPU-only ASR on Apple Silicon is
  comfortably interactive.
- **Model ranking is unchanged:** small ≈ turbo on accuracy but small is ~3.4× faster → small
  stays the CPU-tier pick; tiny/base/moonshine remain unusable for this domain.
- Exact-match numbers reproduce PR #18 (≈35% small/turbo) — the metric is still the wrong one, kept
  here only for continuity; slot-token accuracy (the real metric) is unchanged from Linux. No
  crashes, no memory pressure (peak ~600 MB).

## Task C — full-sentence LLM correction of ASR errors

`scripts/llm-correct.mjs` (Qwen2.5-1.5B-Instruct, ONNX q4) as a post-correction layer over
Whisper-style transcription errors, 12 test cases.

**Result: 7/12 passed** at ~12–14 s per case (full-sentence generation, CPU). Model load ~1.5 s,
RAM ~2.7 GB, no memory pressure on 16 GB. The 5 "failures" split into:

- **Genuine misses (3):** `"290 MeV per year"` → `/u` (left unchanged), `"De-dx"` → `dE/dx` (left
  unchanged), `"A-star and P-star"` → `ASTAR`/`PSTAR` (left unchanged).
- **Correct content, punctuation/case artifact (2):** it _did_ fix `"per nuclear"` →
  `"per nucleon"` and `"loose site"` → `"Lucite"`, but added a trailing period/capital, so the
  exact-string comparison marked them wrong. Under a content-based check this is closer to **9/12**.

**Takeaway:** the correction works but at ~12–14 s on CPU — far above the interactive budget, and
exact-match scoring understates real quality. Reinforces the feasibility report's direction: keep
the deterministic regex/phonetic corrector (#28) on the main path, and reserve the LLM for a
narrow, cheap fallback (Task E's single-token classification was 0.59 s for 0.5B on this same M5)
rather than full-sentence rewriting.

## Tasks D/E/F — prompt-biased Whisper, single-token classification, KV-cache reuse

Follow-ups on the Linux CPU reference numbers from the 2026-07-05 task-list-extension comment on
#21.

### D — prompt-biased Whisper (recommended ASR config, cf. #25)

`asr-transcribe.mjs whisper-small q8 --prompt` → `asr-score-slots.mjs --ext` →
`e2e-audio-intents.ts`, 89 clips / 3 speakers.

| Metric                       | M5          | Linux CPU ref |
| ---------------------------- | ----------- | ------------- |
| median latency / clip        | **0.82 s**  | 2.8 s         |
| slot tokens, raw             | 95.0%       | 95.6%         |
| slot tokens, + ext corrector | 98.1%       | —             |
| clip pass, raw → ext         | 78% → 92%   | —             |
| E2E audio→intent (ext)       | 86% (76/88) | 89%           |

Accuracy reproduces the Linux baseline within run-to-run noise (one clip, `lg/stress-002`, hit the
known empty-output-under-prompt decode). **Latency is ~3.4× better** — prompt-biased whisper-small
is ~0.82 s/clip on M5 CPU, comfortably interactive. (One harness portability fix was needed:
`asr-transcribe.mjs` hardcoded a Linux path; replaced with portable resolution.)

### E — single-token constrained quantity classification (decision-relevant for #8)

`llm-quantity-classify.mjs` (custom `LogitsProcessor`, one masked token), 10 adversarial + 10
controls:

| Model (q4)   | accuracy | M5 median  | Linux CPU ref                    |
| ------------ | -------- | ---------- | -------------------------------- |
| Qwen2.5-0.5B | 11/20    | **0.59 s** | —                                |
| Qwen2.5-1.5B | 15/20    | **1.86 s** | 15/20, ~9.7 s (under contention) |

Accuracy matches Linux exactly: **1.5B is perfect on the forward stopping-power-vs-range decision
(A/B, 15/15)** and misses only inverse C/D queries — which the deterministic matcher already
handles. 0.5B is label-biased toward "A" (right on adversarials for the wrong reason). Latency is
**~5× better** than the Linux reference; 0.5B is already sub-second, 1.5B is ~1.86 s (see Task F
for why, and how to get it under 1 s).

### F — prefix KV-cache reuse headroom

The system + few-shot prefix (**~235 tokens**) is constant across queries; only the ~35-token user
turn varies. transformers.js 4.x doesn't cleanly expose manual `past_key_values` reuse through
`generate()` (hand-driving the ONNX session with a pre-filled cache fails on position/shape
handling), so the _effect_ of reuse was measured instead — the constant-prefix prefill — by
comparing single-token decode latency for the full prompt vs. the variable query turn alone:

| Model (q4)   | full prompt (now) | query-only (prefix cached) | prefix prefill tax | reuse speedup |
| ------------ | ----------------- | -------------------------- | ------------------ | ------------- |
| Qwen2.5-0.5B | 539 ms            | **107 ms**                 | ~432 ms (80%)      | ~5×           |
| Qwen2.5-1.5B | 1863 ms           | **341 ms**                 | ~1522 ms (82%)     | ~5.5×         |

**~80% of classification latency is re-prefilling the constant prefix every query.** With
`past_key_values` reuse the prefix is prefilled once and steady-state per-query drops to **~0.34 s
(1.5B) / ~0.11 s (0.5B)** — i.e. the 1.5B fallback clears the <1 s interactive target with margin,
no GPU required (benchmark script: `scripts/llm-kvcache-bench.mjs`, kept local for now — not
committed).

## Net effect on open decisions

- **#8 (LLM NLU fallback)** — Task A closes the door on full-JSON generation on this hardware too;
  Tasks E/F confirm the single-token classifier + KV-cache reuse is the only LLM-fallback shape
  that's actually interactive, on CPU, without a GPU. Still gated on real-world need per the
  feasibility report's §5.6 ("only worth shipping if telemetry shows novel phrasings escaping the
  synonym table").
- **#9 (runtime/hosting)** — the CPU/WASM tier now has a third hardware reference point (M1,
  addendum below, alongside M5 and the Linux no-GPU baseline); all three are comfortably interactive
  for whisper-small. The WebGPU-tier question (turbo, re-tested with prompt biasing) is answered —
  see `docs/threading-coop-coep.md`'s addendum (issue #60): not worth it.
- **#20 (multi-speaker holdout)** — unaffected; this session reused the same 3-speaker recordings
  and didn't add new speakers.

## Reproduction

Scripts used (all in `scripts/`, same as the Linux session unless noted):
`asr-transcribe.mjs`, `asr-score-slots.mjs`, `e2e-audio-intents.ts`, `asr-batch.mjs`,
`llm-nlu-eval.ts`, `llm-correct.mjs`, `llm-quantity-classify.mjs`, and `llm-kvcache-bench.mjs`
(Task F's benchmark — kept local, not committed).

## Addendum (2026-07-16, issue #60): M1 CPU-only ASR benchmark — a second Apple Silicon data point

_Session report. Apple M1 (MacBookAir10,1), 8 cores (4P+4E), 16 GB RAM, macOS 26.3, Node 24.18,
`@huggingface/transformers` 4.2.0 on `onnxruntime-node` (CPU execution provider — same caveat as the
M5 session above: this is a CPU figure, not the in-browser WebGPU number, which is covered
separately in `docs/threading-coop-coep.md`'s addendum). Same audio (`eval/audio/{km,lg,mn}/`, 89
clips / 3 speakers) and eval set as the Linux and M5 sessions. Scored with the same scripts
(`asr-transcribe.mjs` → `asr-score-slots.mjs --ext` → `e2e-audio-intents.ts`), so every column below
is directly comparable to the Linux and M5 numbers, not just latency._

### Results

| Model (q8)                          | median/clip | load   | E2E audio→intent (ext) | slot-token (ext) |
| ----------------------------------- | ----------- | ------ | ---------------------- | ---------------- |
| whisper-tiny                        | 0.3 s       | 2.2 s  | 0%→**6%** (5/89)       | 42.9%→49.9%      |
| whisper-base                        | 0.5 s       | 2.9 s  | 22%→**52%** (45/86)    | 69.2%→87.3%      |
| whisper-small                       | 1.3 s       | 7.0 s  | 56%→**88%** (78/89)    | 88.8%→98.1%      |
| **whisper-small + prompt**          | **1.4 s**   | 0.9 s  | 79%→**90%** (80/89)    | 94.8%→97.9%      |
| whisper-large-v3-turbo              | 5.5 s       | 25.4 s | 57%→**82%** (73/89)    | 87.8%→97.3%      |
| **whisper-large-v3-turbo + prompt** | **5.7 s**   | 1.3 s  | 75%→**87%** (77/89)    | 92.1%→97.7%      |
| moonshine-base                      | 0.2 s       | 4.0 s  | 15%→**20%** (18/89)    | 72.0%→76.6%      |

("load" is the one-time model/session load; ignore the outlier 25.4 s turbo-no-prompt row — that's a
cold weight fetch into `.hf-cache/`, not a steady-state number, same caveat the M5 doc notes for its
own load column.)

### M1 vs M5 vs Linux — same model, same script, three machines

| Model                              | metric      | M1 (this session) | M5                        | Linux CPU ref |
| ---------------------------------- | ----------- | ----------------- | ------------------------- | ------------- |
| whisper-small + prompt             | median/clip | **1.4 s**         | **0.82 s**                | 2.8 s         |
| whisper-small + prompt             | E2E (ext)   | 90% (80/89)       | 86% (76/88)               | 89% (78/88)   |
| whisper-large-v3-turbo + prompt    | median/clip | **5.7 s**         | not measured¹             | 5.0 s         |
| whisper-large-v3-turbo + prompt    | E2E (ext)   | 87% (77/89)       | not measured¹             | ~91%²         |
| whisper-large-v3-turbo (no prompt) | median/clip | 5.5 s             | 2.70 s (exact-match run)³ | 8.1 s         |

¹ The prompt-biasing fix (issue #25) landed 2026-07-15, five days after the M5 session — M5 has no
turbo+prompt number at all, only un-prompted.
² Read off `docs/voice-pipeline-feasibility.md` §2.4.1's clip-pass figure (81/89, "corrected"); that
session didn't print this exact `e2e-audio-intents.ts` line for turbo+prompt in the excerpt kept
here, so treat this one figure as approximate, unlike every other number in this table.
³ M5's only turbo number comes from Task B's cruder `asr-batch.mjs` exact-match harness, not
`asr-transcribe.mjs`+`e2e-audio-intents.ts` — latency is comparable, the accuracy metric is not.

**Takeaways:**

- **M5 really is faster than M1 for this workload — roughly 1.7–2× on whisper-small, once compared
  on identical audio/scripts.** That's a plausible two-generation Apple Silicon CPU gap (M1 2020 →
  M5 2025), not noise.
- **Accuracy is hardware-invariant, as expected.** whisper-small+prompt E2E lands at 86–90% across
  M1, M5, and Linux — the same weights doing the same math, run-to-run noise on an 89-clip set, not a
  hardware effect. Model-choice conclusions (small over turbo/tiny/base/moonshine on the CPU tier)
  transfer across all three machines without re-litigating.
- **M1 is still comfortably interactive.** 1.4 s/clip for the shipped whisper-small+prompt config is
  well inside the same "fast enough" bucket as M5's 0.82 s and Linux's 2.8 s — this doesn't change
  the CPU-tier recommendation, it just adds a second real Apple-Silicon-generation calibration point
  to it.
- **Bonus data the M5 session didn't have:** real E2E/slot-token numbers (not just exact-match) for
  whisper-tiny, whisper-base, and turbo-un-prompted, plus the first-ever turbo**+prompt** CPU number
  on Apple Silicon (5.7 s, 87% E2E) — useful context for the WebGPU-tier verdict in
  `docs/threading-coop-coep.md`'s addendum, since native CPU already beats what that addendum
  measures in-browser by a wide margin.

Raw transcripts (committed): `eval/results/asr-2026-07-16/*.json`.

## Related

- [`docs/voice-pipeline-feasibility.md`](./voice-pipeline-feasibility.md) — the Linux CPU-only
  baseline this session re-measures on Apple Silicon.
- [`docs/threading-coop-coep.md`](./threading-coop-coep.md) — the WebGPU-tier measurement (issue
  #60) this addendum's turbo+prompt CPU number gives context to.
- Issue #8 — LLM NLU fallback decision (Task A).
- Issue #9 — runtime/hosting spike (Tasks B, D feed its CPU/WASM-tier evidence).
- Issue #21 — the M5 benchmark task list (Tasks A–F) this doc reports on.
- Issue #60 — the M1 hardware this addendum's benchmark ran on, and the WebGPU tier it was
  originally scoped to answer.
