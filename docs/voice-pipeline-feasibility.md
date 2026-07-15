# Voice pipeline feasibility — measurements, audit of prior findings, and a revised architecture

_Session report, 2026-07-05. All benchmarks re-run from scratch on this machine (Linux,
12 threads, 15 GB RAM, **no GPU**, Node 24, `@huggingface/transformers` 4.2.0, models from
`.hf-cache/`, audio from `eval/audio/{km,lg,mn}/` — 89 clips, 3 speakers × ~30 sentences)._

## TL;DR

**The spoken-question → libdedx-answer pipeline is feasible today, on CPU-only hardware,
without any LLM in the main path.**

- **The single biggest lever found: Whisper domain-prompt biasing works — the earlier
  "doesn't help" conclusion came from a one-token bug in the harness.** `asr-batch.mjs`
  hardcodes `<|startofprev|> = 50362`; in whisper-small's multilingual vocab it is
  **50361**. With the wrong token the decoder degenerates into repetition loops (1%
  usable output); with the right one, **raw** whisper-small jumps from 88.0% → 95.6%
  slot-token accuracy (clip pass 57% → 81%) at identical speed — passing issue #7's
  ≥95% criterion _before any correction layer_ (§2.4).
- **End-to-end audio → intent: 89%** (prompt-biased whisper-small q8 + extended
  correction layer + the existing deterministic matcher), against a 100% text-only
  ceiling on the same 30 sentences; 6 of the 10 remaining failures are known-cheap
  matcher fixes ("one GeV", "dE, dx", "10-cm"), putting **~95% in reach**.
  whisper-large-v3-turbo buys nothing worth 3× the latency on CPU; Moonshine is ruled
  out (15% clip accuracy).
- **Slot-bearing-token accuracy reaches 98.7%** with prompt biasing + the extended
  correction layer (caveat: correction rules partly tuned on the same recordings;
  needs held-out speakers to confirm, see §6.1).
- **The NLU does not need an LLM for the current eval set at all**: a ~10-line
  quantity-synonym table in front of the deterministic matcher takes coverage from
  110/120 to **120/120**. The 10 "adversarial" examples were vocabulary gaps, and in
  this closed domain vocabulary is enumerable.
- Two claims from earlier spike write-ups do **not** hold up (§3): grammar-constrained
  decoding _is_ available in transformers.js (demonstrated with a working
  `LogitsProcessor`), and the "50% LLM accuracy ceiling" was measured on a degenerate
  benchmark (all 10 examples share the same label) that label-biased small models can
  game accidentally.
- The residual ~4% of clips carry genuine acoustic losses ("240" heard as "214",
  "30 MeV" as "Ferdy MEV", "carbon-13" as "carbon-30") that **no text-level layer can
  fix** — these must be caught by the trust UX (editable chips + plausibility-gated
  re-ask), which issue #10 already plans.

The rest of this report: what exists today (§1), new benchmark results (§2), audit of
prior findings (§3), the revised architecture with the reasoning behind it (§4), a
ranked idea list (§5), risks and open questions (§6), an issue-by-issue roadmap (§7),
and a reproduction appendix (§8).

---

## 1. Inventory — what exists in the repo today

| Asset                             | State                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Issues**                        | #1 master design (voice-first local front-end to libdedx); #2–#6 closed (scaffold, eval set, aliases, matcher, WASM); #7 closed (ASR spike, single-speaker results); #8 open (LLM NLU); #9 open (runtime/hosting); #10 open (trust UX); #17 open (hw status panel); #20 open (multi-speaker ASR); #21 open (Apple-Silicon run) |
| **Eval set**                      | `eval/intents.jsonl`, 120 examples (110 original + 10 adversarial), frozen, CI-validated                                                                                                                                                                                                                                       |
| **Audio**                         | `eval/audio/{km,lg,mn}/` — 3 speakers × ~30 sentences, 63 MB WAV (gitignored). PR #18 benchmarked them with **exact-match only** (36% whisper-small, 35% turbo — a metric its own thread had already recognized as wrong); no slot-level or intent-level numbers existed until this session                                    |
| **Models** (`.hf-cache/`, 9.1 GB) | whisper tiny/base/small/large-v3-turbo, moonshine-base, Qwen2.5-0.5B/1.5B, Llama-3.2-1B — all ONNX, offline-ready                                                                                                                                                                                                              |
| **NLU**                           | deterministic matcher (`src/lib/intent/matcher.ts`) + alias tables + coverage harness; 110/120 on the eval set                                                                                                                                                                                                                 |
| **Correction layer**              | `scripts/asr-correct.mjs` — regex fixes for the whisper-small error classes found in #7                                                                                                                                                                                                                                        |
| **Compute**                       | libdedx WASM vendored + `LibdedxService` wrapper (`src/lib/wasm/`, `src/lib/compute/`)                                                                                                                                                                                                                                         |

## 2. New benchmark results (this session)

### 2.1 ASR: 3 models × 3 speakers × 30 sentences, CPU, q8

Metric: **slot-bearing tokens** (numbers, units, particles, materials, quantity words,
program names — the things the NLU actually consumes), per issue #7's pass criterion.
"Clip pass" = every slot token of the sentence survived transcription.
"base" = shipped `asr-correct.mjs`; "ext" = experimental extended rules (§2.2).

| Model                                              | med. s/clip | clip pass raw   | + base corr | + ext corr      | slot tokens raw | + ext corr |
| -------------------------------------------------- | ----------- | --------------- | ----------- | --------------- | --------------- | ---------- |
| whisper-small q8                                   | 2.7 s       | 57% (51/89)     | 70% (62/89) | 89% (79/89)     | 88.0%           | 97.7%      |
| **whisper-small q8 + domain prompt (fixed, §2.4)** | **2.8 s**   | **81% (71/88)** | 85% (75/88) | **94% (83/88)** | **95.6%**       | **98.7%**  |
| whisper-large-v3-turbo q8                          | 8.1 s       | 60% (53/89)     | 61% (54/89) | 90% (80/89)     | 88.4%           | 98.1%      |
| moonshine-base q8                                  | 0.6 s       | 16% (14/89)     | 19%         | —               | 72.3%           | —          |

Slot-token accuracy by category, whisper-small (raw → ext-corrected):
number 87→93.5%, unit 75→95.7%, particle 88→97.9%, material 97→99%,
quantity 92→98.9%, program 33→100%.

Findings:

1. **whisper-small q8 is the right CPU model.** Turbo's _raw_ output is only marginally
   better, it is 3× slower (8.1 s vs 2.7 s per clip — already borderline for
   interactive use on CPU), and its error _distribution is different_ (it glues units
   to numbers: "100mEV", "150mv"; produces "kV", "MHz", "ASTOR/PSTOR"), so a corrector
   tuned on whisper-small transfers poorly (base corrector: +13 pp on small, +1 pp on
   turbo). Turbo remains the natural candidate for the WebGPU tier, with its own rule
   set. Moonshine-base, despite being 4× faster, collapses on domain vocabulary
   ("carbon iron", spelled-out numbers) — **ruled out**.
2. **Domain-prompt biasing is the cheapest large win** — +24 pp raw clip pass at the
   same latency, once the harness token bug is fixed (§2.4).
3. **The error mass is concentrated and enumerable.** Units are the worst category
   (75% raw) but almost all failures are _phonetically transparent_ corruptions of a
   ~15-word unit vocabulary: "per napelion / nutlion / nukleon / nuclei / knockdown /
   nuclear ion" → per nucleon; "per year / per you / per u" → /u; "kV / K EV / KEV" →
   keV; "mm / ml / mv / ma / mb / MHz" after a number and before a particle word → MeV.
   The same is true for particles ("Dutrons / deuterans / deuterine / dealt t-rons" →
   deuterons, "products / proteins" → protons) and materials ("PMMEA" → PMMA,
   "silicone" → silicon, "the low side / loose site" → Lucite).

### 2.2 Correction-layer headroom

Adding ~25 rules discovered in this 3-speaker run (`scripts/.tmp-asr-correct2.mjs`)
moves whisper-small from 70% → **89% clip pass** and 91.9% → **97.7% slot tokens**.
Honest caveat: those rules were written _from_ these failures, so this is a headroom
measurement, not a generalization claim (§6.1). But the _mechanism_ generalizes: every
rule is an instance of "match a garbled token against a closed domain lexicon by sound"
— which is exactly what a phonetic lexicon matcher does systematically (§5.1).

**After the extended corrector, no sentence fails for all three speakers.** The
systematic errors (per-nucleon variants, glued units, dE/dx spellings) are absorbed;
the 10 remaining failures are speaker-specific one-offs. This largely answers the
systematic-vs-speaker-specific question that issue #20 poses.

The 10 residual failures split into:

- **Still fixable cheaply** (5): "Stoping power" (fuzzy quantity keyword), "one
  giga-electron volt" (number words + unit phrase), "100 NEV" (one more unit variant),
  "helium free ion" (phonetic _free_ ≈ _three_ → helium-3), "the low side" (phonetic →
  Lucite).
- **Genuinely lost in audio** (5, ≈6% of clips): "240 keV" → "214 keV", "30 MeV" →
  "Ferdy MEV", "carbon-13" → "carbon-30", "60 MeV, a proton" → "60mm aproton",
  "MeV/nucl" → "megaelectronautals per nuclear". No text-level pass can recover a
  wrong _number_; only the trust UX can (§4, stage 6).

### 2.3 End-to-end: audio → QueryIntent (the metric that matters)

Saved transcripts → corrector → deterministic matcher → `compareIntent` against the
eval labels:

| Pipeline                                                           | audio→intent slot match |
| ------------------------------------------------------------------ | ----------------------- |
| whisper-small raw → matcher                                        | 54% (48/89)             |
| whisper-small → **base** corrector → matcher                       | 67% (60/89)             |
| whisper-small → **ext** corrector → matcher                        | 85% (76/89)             |
| whisper-turbo → ext corrector → matcher                            | 87% (77/89)             |
| **whisper-small + domain prompt → ext corrector → matcher (§2.4)** | **89% (78/88)**         |
| _text-only ceiling (ground-truth sentences → matcher)_             | _100% (30/30)_          |

Of the 10 E2E failures on the best pipeline, 6 are **matcher/corrector** gaps, not ASR
gaps — cheap fixes worth more than any model change:

- "one GeV" / "one giga-electron-volt" (3×) — the energy grammar doesn't parse
  spelled-out numbers ("one", "three"…);
- "dE, dx" (2×) — one more dE/dx punctuation variant for the corrector;
- "10-cm" — hyphenated length target misses the target regex;
- "…in Lucite? Lucite" — Whisper echoed a word; two material mentions → spurious
  `compareDim: "material"`. Deduplicate repeated resolved entities.
- (In the no-prompt pipelines also: "Helium 3 ion" / "carbon 13 ions" — unhyphenated
  isotopes miss the alias table.)

With those fixes the E2E number is ~95% (84/88) before touching ASR again; the
remaining 3–4 clips are the genuine acoustic number losses (§2.2) owned by the trust
UX.

### 2.4 Whisper `initial_prompt` domain biasing — a one-token bug hid the best result

`asr-batch.mjs --prompt` replicates Whisper's `prompt_ids` mechanism by prepending
`[<|startofprev|>, …prompt tokens…, <|startoftranscript|>, …]` to `decoder_input_ids`,
with `<|startofprev|>` **hardcoded as 50362**. In the multilingual Whisper vocabulary
(checked in `.hf-cache/onnx-community/whisper-small/tokenizer_config.json`):

| id    | token                  |
| ----- | ---------------------- |
| 50360 | `<\|startoflm\|>`      |
| 50361 | `<\|startofprev\|>` ✔  |
| 50362 | (what the script uses) |

Running with the hardcoded 50362 destroys decoding entirely — 88/89 clips degenerate
into repetition loops ("the the the …", "What What What …"), 22.6% slot tokens, 18.5 s
median per clip (it decodes to the length cap). **The earlier finding "`initial_prompt`
biasing doesn't help numbers (confirmed on stress-001)" was produced through this
broken path and is invalid.**

With the token resolved from the tokenizer (50361) and the same domain-vocabulary
prompt (`"MeV, keV, GeV, MeV/u, MeV/nucl, dE/dx, CSDA, PMMA, ASTAR, PSTAR, nucleon,
proton, deuteron, …"`), whisper-small q8:

| metric                       | no prompt | with prompt   |
| ---------------------------- | --------- | ------------- |
| slot tokens, raw             | 88.0%     | **95.6%**     |
| slot tokens, ext corrector   | 97.7%     | **98.7%**     |
| clip pass, raw               | 57%       | **81%**       |
| clip pass, ext corrector     | 89%       | **94%**       |
| E2E audio→intent (corrected) | 85%       | **89%**       |
| median s/clip                | 2.7       | 2.8 (no cost) |

The prompt fixes precisely the systematic unit problems: "per nucleon" variants,
keV/MeV/GeV casing, dE/dx spelling, ASTAR/PSTAR — because the decoder has now _seen_
the correct spellings as prior context. Raw output passes the ≥95% slot-token
criterion with **no correction layer at all**, which also de-risks the overfitting
concern about the extended rules (§6.1).

Two costs to note: one clip (lg/stress-002) returned empty output under prompt mode
(`token_ids must be a non-empty array` — the same empty-output failure PR #18 saw with
whisper-base; needs a retry-without-prompt guard), and the prompt slightly changes
punctuation habits ("dE, dx", "10-cm"), which needs two trivial corrector rules.

**Action items:** fix `SOT_PREV` in `asr-batch.mjs` (resolve from tokenizer, never
hardcode), make the domain prompt the default in the production ASR path, and re-test
prompt content variants (e.g. adding material names helped: "Lucite" transcribed
correctly in all prompt-mode clips).

### 2.4.1 Update (2026-07-15, issue #25): fix landed, turbo+prompt measured

`scripts/asr-batch.mjs` now resolves `<|startofprev|>` from the tokenizer instead of
hardcoding it, matching `scripts/asr-transcribe.mjs`; both scripts make domain-prompt
biasing the default (`--no-prompt` to opt out), with a feature-detection guard that
disables it cleanly on non-Whisper models (e.g. moonshine) instead of crashing on a
missing `generation_config` field. The production path
(`src/lib/asr/transcribe.ts`) already had the correct tokenizer-resolved fix and
already defaulted the prompt on — it referenced this issue in its own comments before
the fix — but was missing the retry guard below; that gap is now closed there too,
with a regression test.

**Retry-without-prompt guard**, added to both scripts and the production module: on a
decode failure under prompt mode, retry once without the prompt rather than losing the
clip. Verified against real audio: it fires exactly once across both re-runs below
(`lg/stress-002`, whisper-small — the same clip §2.4 flagged as returning empty output)
and recovers it; it never fires for turbo (0/89), so the empty-decode failure is
whisper-small/vocab-specific, not a general hazard of prompt mode.

**Two corrector rules** landed in `asr-correct.mjs` for the punctuation drift prompt
mode introduces: `dE, dx` → `dE/dx` (extends the existing dE/dx regex to accept a
comma separator) and `10-cm` → `10 cm` (hyphenated length targets). Verified against
"km/inv-rng-001" and "lg/sp-008" style clips from the sets below.

Re-running the full 3-speaker/89-clip matrix with the fixed code:

| Model                                  | median s/clip | clip pass raw   | + ext corr      | slot tokens raw | + ext corr |
| -------------------------------------- | ------------- | --------------- | --------------- | --------------- | ---------- |
| whisper-small q8, no prompt (§2.1)     | 2.7 s         | 57% (51/89)     | 89% (79/89)     | 88.0%           | 97.7%      |
| **whisper-small q8 + prompt (fixed)**  | **2.3 s**     | **80% (71/89)** | **93% (83/89)** | **95.4%**       | **98.6%**  |
| whisper-large-v3-turbo q8, no prompt   | 8.1 s         | 60% (53/89)     | 90% (80/89)     | 88.4%           | 98.1%      |
| **whisper-large-v3-turbo q8 + prompt** | **5.0 s**     | **73% (65/89)** | **91% (81/89)** | **91.9%**       | **98.1%**  |

E2E audio→intent (saved transcripts → ext corrector → deterministic matcher →
`compareIntent`):

| Pipeline                                           | audio→intent slot match |
| -------------------------------------------------- | ----------------------- |
| whisper-small, no prompt → ext corrector           | 85% (76/89)             |
| **whisper-small + prompt (fixed) → ext corrector** | **91% (81/89)**         |
| turbo, no prompt → ext corrector                   | 87% (77/89)             |
| **turbo + prompt → ext corrector**                 | **90% (80/89)**         |
| _text-only ceiling_                                | _100% (30/30)_          |

whisper-small's E2E number improves on the 89% reported in §2.3/§2.4 — the retry guard
recovers the previously-lost `lg/stress-002` clip, and the two new corrector rules
eliminate the "dE, dx" and "10-cm" failure modes §2.3 had listed as open matcher gaps.

Turbo's raw slot-token accuracy also benefits from prompt biasing (+3.5 pp), and its
ext-corrected ceiling is unchanged at 98.1% (the extended corrector already closed
most of turbo's gap even without the prompt; the prompt's contribution for turbo is on
the raw/uncorrected side). This confirms turbo remains a real (if unproven-on-CPU-yet)
WebGPU-tier candidate now that domain-prompt biasing is verified to help it too, but
doesn't change the CPU-tier recommendation: whisper-small + prompt is still both more
accurate (91% vs 90% E2E) and ~2× faster per clip. Turbo's median per-clip latency in
this run (5.0 s) was notably lower than §2.1's 8.1 s under otherwise-similar
conditions; treat that gap as environment/load noise (§2.1's number was measured with
other CPU-bound work running concurrently, per §2.5) rather than a reproducible
speedup, and prefer the 8.1 s figure as the conservative planning number.

Not done in this pass (left for a follow-up): tuning prompt content variants (§5.0's
"tune prompt content" experiment) — the current `DOMAIN_PROMPT` string is unchanged
from §2.4.

Raw transcripts (committed, text only): `eval/results/asr-2026-07-15/{small-q8-prompt,turbo-q8-prompt}.json`.

### 2.5 LLM NLU: single-token constrained classification (new experiment)

Rationale: the deterministic matcher's 10 misses fail **only on the `quantity` slot** —
a 4-way closed choice. So the LLM fallback does not need to generate a full JSON
intent (the source of the JSON-validity and latency problems in PR #22); it needs to
emit **one constrained token**. Implemented with a custom `LogitsProcessor` that masks
every logit except the four choice letters — which doubles as a proof that
**grammar-constrained decoding works in transformers.js today** (contradicting PR #22,
see §3).

Test: 10 adversarial examples (label A = stoppingPower) **+ 10 controls** covering the
other three labels — controls matter, see below.

| Model (q4, CPU) | adversarial (A) | forward controls (A/B) | inverse controls (C/D) | total |
| --------------- | --------------- | ---------------------- | ---------------------- | ----- |
| Qwen2.5-0.5B    | 9/10            | 2/5                    | 0/5                    | 11/20 |
| Qwen2.5-1.5B    | **10/10**       | **5/5**                | 0/5                    | 15/20 |

- **Qwen-0.5B answers "A" almost regardless of input** (classic small-model label
  bias). On the adversarial-only set it would have scored 90% _for the wrong reason_ —
  any evaluation on a single-label benchmark is meaningless. This retroactively
  clouds the PR #22 numbers too (§3.4).
- **Qwen-1.5B is perfect on the forward stopping-power-vs-range decision (15/15 A/B)**
  and fails only inverse queries (C/D) — but inverse detection is precisely what the
  deterministic matcher does reliably (the "what energy…" rule, 100% on the eval set).
  Division of labor: rules detect inverse; the LLM, when consulted at all, only
  arbitrates forward quantity.
- Latency: single-token decode was ~3.4 s (0.5B) / ~9.7 s (1.5B) _under concurrent
  CPU load from the ASR benchmark_ — dominated by prefill of the ~700-token few-shot
  prompt, not by generation. Two known levers: shrink the prompt (a binary A/B
  question needs far fewer shots), and reuse the constant prefix KV cache across
  queries (`past_key_values` is in the transformers.js generate API). Neither was
  measured this session.

### 2.6 Quantity-synonym pre-pass: the LLM is not needed for the eval set

A ~10-entry replacement table (linear energy transfer / LET / specific ionisation /
Bethe-Bloch / retarding force / energy deposition (density) / dose per micrometer →
"stopping power") applied before `matchIntent`:

```
plain matcher : 110/120
with pre-pass : 120/120
```

This is the same design as the material alias table — quantity names deserve their own
synonym table, seeded from a physicist's list rather than discovered adversarially.

## 3. Audit of prior findings (they were produced under weaker conditions — verify before building on them)

| Prior claim                                                                                                              | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#7:** whisper-small ≈ 47% "semantically parseable" (1 speaker, eyeballed); **PR #18:** 36% exact-match (3 speakers)    | **Pessimistic and under-measured.** Both used transcript-level metrics after the #7 thread itself concluded "exact match is the wrong metric". With the slot-token metric issue #7 actually defines, the same model scores 88% raw / 91.9% with the _existing_ corrector; clip-level 57% raw / 70% corrected. The right headline was "units are the bottleneck", which the #7 comment did identify correctly. PR #18's model _ranking_ (small ≥ turbo on CPU, tiny/base/moonshine unusable) is confirmed.      |
| **#7:** "MeV→mm acoustic confusion is systematic"                                                                        | **Confirmed** across speakers, and extended: turbo produces mV/mA/MB/MHz variants of the same confusion. Fully correctable by context rules (number + m-unit + particle ⇒ MeV) because no mm/mV/MHz reading is valid in energy position in this domain.                                                                                                                                                                                                                                                        |
| **#7:** "MeV/nucl and MeV/u completely unreliable"                                                                       | **Half-true.** "per nucleon" is transcribed correctly more often than not; the failures are a small, enumerable set of phonetic variants, most already fixed by the shipped corrector. "Completely unreliable" overstated it.                                                                                                                                                                                                                                                                                  |
| **#7 next steps:** "consider large-v3-turbo and moonshine" (downloaded, never run)                                       | **Now measured.** Turbo: +1–2 pp for 3× latency on CPU — not worth it on the CPU tier; reconsider for WebGPU. Moonshine: ruled out.                                                                                                                                                                                                                                                                                                                                                                            |
| **PR #22:** "grammar-constrained decoding is not available in `@huggingface/transformers`"                               | **False.** `LogitsProcessor` / `LogitsProcessorList` are exported, and `generate()` accepts `logits_processor` (verified in dist; used in §2.5). There is no off-the-shelf JSON-schema grammar library, but a constrained decoder for this schema is ~100 lines, and for the actual need (one enum token) it is ~15 lines.                                                                                                                                                                                     |
| **PR #22:** "50% is the ceiling with prompt-level enforcement" (all 3 models 50%)                                        | **Unsound benchmark.** All 10 eval examples share the label `stoppingPower`, so the quantity axis cannot distinguish a competent model from a label-biased one (§2.5 shows Qwen-0.5B _is_ label-biased). The identical 50% across three models is itself a red flag. The constructive replacements: the synonym pre-pass (§2.6) removes the need, and single-token classification (§2.5) fixes the mechanism. The 13–40 s latencies were an artifact of generating ~300 JSON tokens on CPU with a long prompt. |
| **#7:** "`initial_prompt` biasing doesn't help numbers … not solvable with vocabulary biasing (confirmed on stress-001)" | **Invalid — tested through a broken harness.** The hardcoded `<                                                                                                                                                                                                                                                                                                                                                                                                                                                | startofprev | >` id (50362) is wrong for the multilingual vocab (50361); with it the decoder produces repetition loops, so the mechanism was never actually evaluated. Fixed, it is the largest single improvement measured this session: raw slot tokens 88.0% → 95.6% at zero latency cost (§2.4). It still does not fix _numbers_ ("240"→"214" persists) — that specific sub-claim happens to survive. |

## 4. Revised architecture — the closed-world principle

The single organizing idea: **this is not open-dictation ASR followed by open NLU; it
is slot extraction against a known, finite vocabulary.** Users ask precisely, in
domain. Every stage should consume domain knowledge, and the pipeline should be
evaluated end-to-end (audio→intent), never on transcript fidelity.

```
🎤 push-to-talk, 16 kHz mono
 │
 ▼
ASR        whisper-small q8 + domain prompt biasing (§2.4) — CPU/WASM tier
 │           (WebGPU tier: re-test turbo *with* prompt biasing before choosing)
 │           per-tier correction rule sets — error distributions differ (§2.1)
 ▼
CORRECT    closed-vocabulary phonetic lexicon matcher (§5.1)
 │           regex fast-path (current asr-correct.mjs) + phonetic fallback for
 │           unknown tokens; unit decisions use slot context (number → unit position)
 ▼
NLU        quantity-synonym table → deterministic matcher (unchanged)
 │           matcher fixes: number words, unhyphenated isotopes, entity dedupe (§2.3)
 │           [rare fallback: single-token constrained LLM classification, §2.5 —
 │            only when quantitySource === "default"; ship later, maybe never]
 ▼
VALIDATE   physics plausibility from libdedx itself (§5.3)
 │           parsed (particle, energy, material) checked against real table ranges;
 │           implausible slot ⇒ targeted re-ask, never silent acceptance
 ▼
COMPUTE    LibdedxService (exists) — numbers only ever from libdedx
 ▼
TRUST UX   editable chips + assumptions panel (issue #10, unchanged) +
 │           confidence gate: unknown-token count, corrector edit count, plausibility
 │           failures ⇒ "Did you say 240 keV or 240 MeV?" (§5.4)
 ▼
NLG + TTS  templated sentence → SpeechSynthesis / Piper (unchanged from #1)
```

What changed vs the issue #1 design and why:

1. **The LLM moved from "fallback for odd phrasing" to "optional last resort", and its
   job shrank from JSON generation to one constrained token.** Evidence: 120/120
   deterministic with a synonym table (§2.6); full-JSON small-LLM generation was the
   source of every JSON-validity, latency, and enum-escape problem in PR #22; and the
   only slot the matcher ever misses is `quantity` (§2.5). A user-visible corollary:
   CPU users get instant answers because nothing on the main path runs a generative
   model.
2. **The correction layer is promoted to a first-class stage with a principled
   implementation** (phonetic lexicon matching, §5.1) instead of an open-ended pile of
   regexes, and it is tier-specific because whisper-small and turbo garble differently.
3. **A validation stage is added between NLU and compute.** The domain gives strong
   priors for free: libdedx knows exactly which (particle, material, program) tuples
   exist and their energy ranges. "100 mm protons in water" (unit lost) or "carbon-30"
   (no such table) are detectable _before_ computing, turning silent wrong answers
   into targeted questions. This is also precisely where the ~6% unfixable acoustic
   errors get caught: "240 keV carbon" is plausible, "214 keV carbon" is too — but the
   corrector's edit log plus a low-confidence unit means the chip renders highlighted
   for confirmation.
4. **Evaluation is end-to-end.** The regression metric for the voice path should be
   audio→intent slot match over `eval/audio/`, not WER and not exact transcript match
   (the #7 thread already discovered exact match was wrong, then kept using it).

## 5. Ranked ideas (highest leverage first)

### 5.0 Fix the prompt-injection bug and ship domain-prompt biasing — hours

Resolve `<|startofprev|>` from the tokenizer in `asr-batch.mjs` (and the future
production ASR module), enable the domain prompt by default, add a
retry-without-prompt guard for the rare empty-output decode, and re-run the benchmark
matrix (including turbo-with-prompt for the WebGPU tier). Measured effect: §2.4.
Follow-up experiment: tune prompt content (units + notation + material trade names
seem to matter most; keep it short — prompt tokens add prefill cost linearly).

### 5.1 Phonetic lexicon matcher (replaces regex accretion) — ~1–2 days

The generalization of every correction rule discovered so far. Build once:

- **Lexicon**: all alias-table surface forms (materials, particles) + units
  (keV/MeV/GeV, /u, per nucleon) + quantity keywords + program names (ASTAR…), each
  with a phonetic key (Double Metaphone or a simple grapheme-to-phoneme + edit
  distance; "napelion" and "nucleon" collide phonetically, which is the point).
- **Pass**: for each transcript token (and 2–3-gram) not recognized by the exact/fuzzy
  alias lookup, find the nearest lexicon entry by phonetic distance; accept above a
  threshold, weighted by **slot context** — a token right after a number is a unit
  candidate ("60 tamiya" → unit slot → MeV); a token before "ion(s)" is an element.
- **Log every substitution** into `QueryIntent.assumptions` so the trust UX can show
  "heard: _per napelion_ → read as: _per nucleon_". The corrector's edit count feeds
  the confidence gate.
- The existing regex layer stays as a fast path; the phonetic pass replaces the
  unbounded tail of new regexes ("NEV", "kAV", "nukleon", …) that each new
  speaker/model would otherwise demand.

### 5.2 Ten lines of matcher work worth ~5 E2E points — hours

Number words in the energy grammar ("one GeV", "three MeV"), unhyphenated isotopes
("helium 3 ion", "carbon 13"), dedupe of repeated resolved entities (Whisper echo →
spurious comparison), fuzzy quantity keywords ("Stoping power"), plus the
quantity-synonym table from §2.6 checked in as a real module. All measured against
existing failures in §2.2/§2.3.

### 5.3 Plausibility validation from libdedx tables — ~1 day

`LibdedxService` already knows every valid (program, particle, material) combination
and its energy grid. Expose a `validateIntent(intent)` that returns per-slot
plausibility. Catches: impossible units (mm in energy position), out-of-range energies
(likely wrong unit or wrong number), unknown isotopes ("carbon-30"). Cheap, fully
deterministic, and it converts the worst failure mode (confident wrong answer) into a
question. Needs a physicist decision on how wide "plausible" is (§6.4).

### 5.4 Targeted re-ask instead of "please repeat" — with #10's chips

When exactly one slot is low-confidence, ask about that slot only, as a binary or
short-list question ("240 keV or 240 MeV?"), and highlight the chip. The ~6% residual
acoustic-loss rate (§2.2) is the budget for this interaction; everything else flows
through silently.

### 5.5 TTS-synthesized eval audio (and only later, maybe, fine-tuning) — ~1 day / GPU-days

Generate the 120 eval sentences (and paraphrases) with Piper/Kokoro across many
voices. Two uses, in order of certainty:

1. **Cheap eval scale-up** — hundreds of audio clips with known labels, no humans;
   catches corrector regressions per model tier. (Synthetic speech is cleaner than
   human speech, so treat it as a lower bound on difficulty.)
2. **Contingency: LoRA fine-tune of whisper-small** on synthetic + real domain audio.
   This is the only fix that reaches _number_ mishearings at the source. It needs a
   GPU, an ONNX re-export, and validation against catastrophic forgetting — do not
   start it unless the corrector + UX path measurably stalls below target. The M5 Mac
   from #21 or a Colab session suffices for a first attempt.

### 5.6 LLM fallback, if kept: constrained single-token classification — ~1 day

Per §2.5: Qwen2.5-1.5B q4, A/B (forward quantity) only, logit-masked single token,
short prompt, prefix KV-cache reuse. Add label-bias controls to its eval permanently.
Prediction to verify on the M5 (#21): sub-second on Metal/WebGPU. Note the model is
2.7 GB in RAM — only worth shipping if telemetry from real users shows novel phrasings
escaping the synonym table at a meaningful rate.

### 5.7 Research-grade option (note only): domain-constrained Whisper decoding

Whisper's decoder can also take a `logits_processor` in transformers.js; a
domain-grammar-constrained beam (or n-best rescoring against a domain phrase LM) would
attack errors at the source. High effort, uncertain payoff next to §5.1 — file as an
idea, don't schedule.

## 6. Risks and open questions

1. **Overfitting of the extended rules (§2.2).** The +19 pp from the extended corrector
   was measured on the recordings that motivated the rules. Mitigation: hold out one
   speaker when tuning (with three speakers: leave-one-out), and prioritize the
   phonetic matcher (§5.1) whose parameters are a threshold, not per-error rules.
   Issue #20's plan (2–3 more speakers) remains the right next data collection.
2. **Node ≠ browser.** All numbers here are Node/ONNX-CPU. The browser WASM backend is
   typically slower (threads/SIMD depend on COOP/COEP — issue #9), and WebGPU changes
   the model choice (turbo becomes viable). The 2.7 s/clip CPU figure is a _favorable_
   bound for WASM; Spike 3 must re-measure in-browser.
3. **Accent coverage.** Three speakers, likely shared accent profile (Polish English).
   The per-speaker spread after correction (24–29/30) is encouraging, but "no
   systematic failures remain" is a 3-speaker statement.
4. **Physicist sign-off still pending** (issue #1 §17) on isotope defaults,
   total-vs-per-nucleon reading, and now also plausibility windows for §5.3.
5. **Prompt-mode edge cases.** One empty-output decode in 89 clips under prompt mode;
   punctuation drift ("dE, dx"). Both handled with a retry guard + two corrector rules
   (§2.4.1); the retry guard never fired for turbo (0/89), so treat the empty-output
   failure as whisper-small/vocab-specific rather than assuming it recurs on every
   model — watch for it on new model variants regardless.
6. **Latency numbers for LLM experiments** (§2.5) were taken under concurrent CPU load;
   treat as upper bounds only.

## 7. Suggested issue updates

- **#7 (closed)** — post the multi-speaker + multi-model results (§2.1–§2.4): turbo and
  moonshine questions from its "next steps" comment are now answered, and the
  `initial_prompt` conclusion is retracted (harness bug, §2.4). The `asr-batch.mjs`
  `SOT_PREV` fix landed as issue #25 (§2.4.1).
- **#25 (closed)** — `SOT_PREV` fix, retry guard, and the two corrector rules landed
  (§2.4.1); turbo+prompt measured. Prompt-content tuning (§5.0's follow-up experiment)
  remains open for a future pass.
- **#8 (LLM NLU)** — rescope: (a) land the quantity-synonym table (deterministic
  120/120); (b) if an LLM fallback is kept at all, single-token constrained
  classification per §5.6, with label-bias controls in the eval; (c) drop full-JSON
  generation and its "grammar constraints unavailable" premise.
- **#9 (runtime/hosting)** — unchanged, now with a concrete model matrix to test:
  whisper-small q8 (WASM) vs turbo (WebGPU), and no LLM on the critical path.
- **#10 (trust UX)** — add the targeted re-ask (§5.4) and corrector-substitution
  display (§5.1) to its scope; it is the designated home for the ~6% unfixable errors.
- **#20 (multi-speaker)** — partially answered: benchmark ran on 3 speakers; after
  correction, no all-speaker systematic failures remain. Keep open for the
  `--speaker` flag + 2 external speakers as generalization holdout.
- **#21 (M5 run)** — extend its task list with the single-token classifier and the
  prefix-KV-cache latency measurement.
- **New issues worth filing**: phonetic lexicon matcher (§5.1); matcher quick fixes +
  synonym table (§5.2); `validateIntent` plausibility layer (§5.3); TTS synthetic eval
  audio (§5.5); end-to-end audio→intent metric in CI for `eval/audio` when present
  (§4.4).

## 8. Reproduction appendix

Scripts from this session (in `scripts/`):

| Script                                                        | What it does                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asr-transcribe.mjs <model> <dtype> <out.json> [--no-prompt]` | transcribes all speakers' clips, saves raw transcripts + timing to JSON (so scoring is offline/re-runnable); domain-prompt biasing is on by default since issue #25 (pass `--no-prompt` to disable) and resolves the `<\|startofprev\|>` token from the tokenizer at runtime (§2.4) |
| `asr-score-slots.mjs [--ext] <out.json>…`                     | slot-token + clip-level scoring, raw vs corrector (`--ext` = `asr-correct-ext.mjs`, default = `asr-correct.mjs`)                                                                                                                                                                    |
| `asr-correct-ext.mjs`                                         | extended correction rules (experiment, §2.2)                                                                                                                                                                                                                                        |
| `e2e-audio-intents.ts <out.json> [--base]`                    | end-to-end audio→intent vs eval labels (§2.3)                                                                                                                                                                                                                                       |
| `nlu-quantity-prepass.ts`                                     | synonym pre-pass → 120/120 (§2.6)                                                                                                                                                                                                                                                   |
| `llm-quantity-classify.mjs [model]`                           | single-token constrained quantity classification with LogitsProcessor + label-bias controls (§2.5)                                                                                                                                                                                  |

Raw transcripts (committed, text only — audio stays local per `.gitignore`):
`eval/results/asr-2026-07-05/{small-q8,turbo-q8,moonshine-q8,small-q8-prompt,small-q8-prompt-fixed}.json`
(`small-q8-prompt` = broken 50362 token, kept as evidence; `-fixed` = 50361).
Issue #25's re-run with the shipped fix (§2.4.1):
`eval/results/asr-2026-07-15/{small-q8-prompt,turbo-q8-prompt}.json`.

Scorer notes: per-nucleon unit variants are normalized before matching; decimal points
and number words ("one" → 1) are handled; two scorer bugs (case-sensitive normalization
of the per-nucleon marker; decimal stripping) were found and fixed during the session —
tables above are post-fix.
