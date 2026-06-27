# GPU & training strategy — does Cyfronet (Helios / Athena) help aidedx?

> **Scope.** This is an analysis/decision document, not an implementation. It
> answers three questions raised about access to ACK Cyfronet GPUs (Helios,
> Athena):
>
> 1. Does that compute help **this** project?
> 2. Can the planned models be made **smaller / more efficient**?
> 3. Should we **train anything from scratch**?
>
> It is grounded in the architecture frozen in issue [#1](https://github.com/APTG/aidedx/issues/1)
> and the spike plan (#7 ASR, #8 NLU, #9 runtime, #10 trust loop).

## TL;DR

- **Inference is, and must remain, on the user's device.** Cyfronet GPUs can
  **never** serve inference — that would break the project's defining constraint
  ("no network inference", #1 §4.1). So the GPUs have exactly one role: an
  **offline model factory** (training, fine-tuning, distillation, synthetic-data
  generation, quantization calibration, benchmarking). They never sit in the
  request path.
- **In that offline role, the GPUs genuinely help — but the project does not
  need HPC scale.** Every useful job here fits on a *single* A100. The Helios /
  Athena fleet is overkill; its real value is convenience, queue-free
  iteration, and the fact that it doubles as the **weight-hosting CDN** already
  named in #1 §11 (that part is storage + CORS, not GPU).
- **The biggest concrete win is efficiency, not capability:** a LoRA/full
  fine-tune of the *smallest* NLU model so that **0.5 B fine-tuned ≥ 1.5 B
  few-shot**. That shrinks the download ~3× and the CPU-path latency ~3×, which
  directly attacks the project's worst case (the no-GPU user, #1 §8).
- **Do not train the LLM or Whisper from scratch.** Fine-tune / distill from
  pretrained checkpoints. A *tiny, task-specific* slot-filler (≈20–60 M params)
  trained mostly from scratch is the one "from-scratch-ish" idea worth a spike,
  because the task is a closed-schema slot-fill, not open language.
- **Precondition before spending any GPU hours:** the deterministic matcher
  already hits **100 % exact-intent on eval v0** (`docs/nlu.md`). There is *no
  demonstrated need for the LLM yet*. The highest-leverage next step is an
  **adversarial eval set** — pure data work, no GPU — which is also the training
  and distillation target everything below depends on.

---

## 1. What the project actually runs

The ML surface is small and entirely **client-side inference**:

| Stage | Model (planned) | Job | Constraint |
| --- | --- | --- | --- |
| ASR | Whisper tiny/base/small, q4/q8 (ONNX) | speech → text | runs in transformers.js (WebGPU; WASM/CPU fallback) |
| NLU | deterministic matcher **⊕** Qwen2.5-0.5B/1.5B or Llama-3.2-1B, q4/q8 | text → `QueryIntent` JSON | LLM only on low-confidence misses; grammar-constrained JSON |
| TTS | SpeechSynthesis / Piper / Kokoro | text → speech | off-the-shelf; not a training target |

Two facts dominate everything that follows:

1. **The LLM never produces numbers** (#1 §4.2). Its sole job is *slot-filling*
   into a fixed schema: 4 `quantity` values, 5 `compareDim` values, and
   entity slots that are *already* resolved against the libdedx alias tables
   downstream. This is a **narrow, closed-world task**, not general chat — which
   is exactly what makes a small or custom model viable.
2. **The deployment target is the browser.** Anything trained must export to
   **ONNX** and run under ONNX Runtime Web (transformers.js) on WebGPU or WASM.
   That rules out exotic architectures and custom CUDA ops; it rewards standard
   transformer encoders/decoders that the runtime already supports.

Net: the limiting factor on model choice is **download size + CPU inference
speed on the user's machine**, *not* training difficulty. Training compute was
never the bottleneck — so simply "having big GPUs" does not unblock anything by
itself. It only helps if we convert it into a *smaller or more accurate*
shippable artifact.

## 2. Where Cyfronet compute helps (ranked by ROI)

### 2.1 Fine-tune the smallest NLU model — headline efficiency win

**Goal:** make `Qwen2.5-0.5B` (or smaller) fine-tuned **match or beat**
`Qwen2.5-1.5B`/`Llama-3.2-1B` few-shot on the eval set, so we can *ship the
smaller one*.

Why it matters: per `docs/local-model-cache.md` the LLM weights are the bulk of
the download (0.5B+1.5B+1B ≈ 7.3 GB cached; a single shipped 1.5B-q4 is the
heavy item a user actually pays for). Dropping from 1.5 B to 0.5 B is roughly:

- **~3× smaller weight download** (the one-time cost #1 §8 worries about), and
- **~3× faster CPU/WASM inference** — the difference between a tolerable and an
  embarrassing no-GPU experience (#1 §8: "few tok/s → 10–30 s").

This is explicitly already on the roadmap — **Phase 4: "synthetic dataset +
LoRA fine-tune + eval harness + S3 export"** (#1 §16) — and Spike 2 (#8) is
literally chartered to output a *"few-shot vs fine-tune decision"*. So this is
not new scope; the GPUs make the fine-tune branch cheap to take.

**Compute reality:** a LoRA on a 0.5–1.5 B model is **minutes to a few hours on
one A100**. A full fine-tune of a 1 B model is hours on one A100. This is the
single most valuable use of the access and it barely scratches a single node.

### 2.2 Synthetic data generation — the actual enabler

Fine-tuning and distillation both need (text → `QueryIntent`) pairs far beyond
the ~110 hand-labeled eval rows. The generator is a **grammar/template
expander** (we already own the alias tables, units grammar, and idiom table in
`src/lib/intent/`) **paraphrased by a large teacher LLM** to inject phrasing
variety, conversational filler, and indirect idioms.

This is the one place HPC *scale* is genuinely useful: hosting a big teacher
(e.g. a 70B-class instruct model) and running **embarrassingly parallel**
paraphrase + back-translation jobs across many GPUs to produce tens of
thousands of diverse, schema-validated examples. Every generated row is checked
with the existing `validateQueryIntent()` so the dataset is clean by
construction.

> Caveat: generation can also be done off-cluster via an API. Cyfronet's
> advantage is doing it **fully locally/offline at volume** with no per-token
> cost and no data leaving controlled infrastructure.

### 2.3 Distill a tiny, task-specific slot-filler — stretch, high upside

Because the target is closed-schema slot-filling, a general LLM is heavier than
the task requires. A **~20–60 M-param encoder** (e.g. fine-tuned MiniLM /
DistilBERT-class) doing:

- sequence **classification** for `quantity` + `compareDim`, and
- token **tagging** (BIO) for particle / material / energy / target spans,

would be **10–50× smaller** than even a 0.5 B LLM, run in **milliseconds on
CPU**, and could plausibly make the LLM tier unnecessary for the vast majority
of queries — leaving the deterministic matcher + tiny tagger as the whole NLU,
with an LLM only for genuine long-tail oddities.

Trained by **distillation** from the 2.2 teacher + synthetic set. Single GPU,
hours. **Risk:** a small/from-scratch tagger generalizes worse to *unseen*
idioms than a pretrained LLM does for free; this must be proven on the
adversarial eval set before it can replace the LLM tier, not assumed. Treat it
as a spike that *extends* Spike 2, not a commitment.

### 2.4 Domain-adapt Whisper — smaller ASR that still clears the bar

Spike 1 (#7) requires **≥95 % accuracy on slot-bearing tokens** ("240 keV",
"MeV/nucl", "PMMA", "Bragg", "neon") and flags domain mis-transcription as the
top ASR risk. Two GPU-enabled levers:

- **Fine-tune `whisper-base` (or `tiny`)** on domain audio so it clears the 95 %
  bar that otherwise needs `whisper-small` — shipping a smaller, faster ASR.
- **Generate domain audio at scale** with TTS over the eval/synthetic text
  (many voices/accents/SNRs) to build that fine-tuning corpus cheaply, since
  #7 otherwise depends on a human recording only ~30 sentences.

Whisper fine-tunes comfortably on one A100 in hours. **Do not** train Whisper
from scratch (see §4).

### 2.5 Quantization calibration / QAT + benchmark sweeps

Lower-leverage but cheap: use the GPUs to produce **better q4/q8 quants**
(calibration-set–driven, or quantization-aware training) tuned to the
slot-filling distribution rather than generic text, and to run **hyperparameter
/ variant sweeps** (which model × which quant × few-shot vs fine-tune) against
the frozen eval harness. Sweeps are embarrassingly parallel and a good fit for
the fleet.

## 3. Can the planned models be made smaller / more efficient?

Yes — and §2 is precisely how. Summary of the efficiency ladder, smallest win
first:

1. **Pick the smaller off-the-shelf model** the eval harness allows (no
   training): if few-shot 0.5 B already passes Spike 2's 90 % bar, ship it.
2. **Fine-tune the smaller model** (§2.1) to *make* it pass → ship 0.5 B instead
   of 1.5 B. (≈3× size/latency.)
3. **Distill to a tiny task-specific tagger** (§2.3) → potentially drop the LLM
   tier for most traffic. (≈10–50× over the LLM.)
4. **Domain-fine-tune Whisper down a size class** (§2.4). (base instead of
   small.)
5. **Better quantization** (§2.5) on top of any of the above.

All of these *reduce* what the user downloads and how long inference takes —
the metrics that actually matter here — and several are already implied by the
Phase 4 plan. None of them require holding capability constant at a *larger*
model "because we have the GPUs"; the GPUs are spent buying *smallness*.

## 4. Should we train anything from scratch?

| Component | From scratch? | Verdict |
| --- | --- | --- |
| **NLU LLM** | No | Fine-tune / LoRA a pretrained small model. From-scratch throws away the phrasing-robustness a pretrained model gives for free — exactly what we need for indirect idioms & filler — and would need far more data than we'll have. |
| **Tiny slot-filler/tagger** | Partly (fine-tune a small pretrained encoder, *not* a blank model) | The only "from-scratch-ish" idea worth a spike (§2.3). A blank ~30 M model is trainable on our compute, but a fine-tuned MiniLM-class encoder is strictly better ROI and equally small. |
| **Whisper / ASR** | **No** | Training an ASR model from scratch needs tens of thousands of hours of audio and far more compute than even this fleet justifies for a side feature. Fine-tune only (§2.4). |
| **TTS** | No | Off-the-shelf (SpeechSynthesis / Piper / Kokoro). Not a training target. |

**Bottom line:** "from scratch" is the wrong frame for everything except a
deliberately tiny, narrow tagger — and even there, *fine-tuning a small
pretrained encoder* wins. The project's narrowness makes small models viable;
it does **not** make from-scratch pretraining worthwhile.

## 5. What the GPUs do *not* do here

- **They do not serve inference.** Ever. That is the whole privacy thesis
  (#1 §2, §4.1). No "just call our Cyfronet endpoint" shortcut exists in this
  design.
- **They do not remove the browser deployment constraint.** A bigger/fancier
  trained model that won't export to ONNX or won't fit a CPU budget is useless
  here regardless of how much it cost to train.
- **They do not substitute for the eval set.** The matcher is at 100 % on
  eval v0; until adversarial examples exist, there is nothing to fine-tune
  *toward* and no way to prove a trained model is better. Data first, GPUs
  second.
- **HPC scale is mostly unused.** Single-A100 jobs cover §2.1, §2.3, §2.4,
  §2.5; only §2.2 (teacher-driven synthetic generation) and §2.5 sweeps benefit
  from many nodes. Don't let fleet access inflate scope.

## 6. Recommended sequence

1. **(No GPU) Build the adversarial eval set** — novel idioms, ambiguous
   coordination, free-form units, conversational filler — extending
   `eval/intents.jsonl`. This is the precondition `docs/nlu.md` already calls
   out and the target for every job below.
2. **(No / little GPU) Run Spike 2 (#8) as written** — few-shot 0.5B/1.5B/1B,
   grammar-constrained JSON, measure exact-intent accuracy + JSON validity. If
   a small model already passes, you may be **done** — ship it, no training.
3. **(GPU) Synthetic data generation** (§2.2) — teacher-paraphrased,
   schema-validated, from our own grammar/alias assets.
4. **(GPU) Fine-tune the smallest viable NLU model** (§2.1) to ship 0.5 B in
   place of 1.5 B; re-run the eval harness to confirm the size/latency win is
   real and accuracy holds.
5. **(GPU, stretch) Distill the tiny tagger** (§2.3) and test whether it can
   shrink or remove the LLM tier on the adversarial set.
6. **(GPU, parallel track) Domain-fine-tune Whisper** (§2.4) + TTS-generated
   domain audio so a smaller ASR clears Spike 1's 95 % bar.
7. **(GPU) Quantization calibration + variant sweeps** (§2.5) on the finalists.

Each step is gated by the eval harness, so GPU time is only spent once there's a
measurable target and a measurable win — consistent with the spike-first,
pass/fail discipline of #1 §13.

## 7. References

- `docs/nlu.md` — deterministic matcher + coverage harness (100 % on eval v0)
- `docs/local-model-cache.md` — model list, quant levels, download sizes
- `eval/README.md` — the frozen eval set and tag taxonomy
- Issue #1 §4 (constraints), §8 (CPU strategy), §11 (Cyfronet hosting),
  §16 Phase 4 (LoRA fine-tune), §13 (spikes)
- Issues #7 (Spike 1 ASR), #8 (Spike 2 NLU), #9 (Spike 3 runtime)
