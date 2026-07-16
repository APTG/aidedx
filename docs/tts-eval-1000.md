# 1000-sample TTS eval-audio batch (issue #30, production-scale run)

_Session report, 2026-07-16. Builds directly on `docs/tts-eval-audio.md` §6–7 (the Qwen3-TTS
feasibility check and its first 100-sentence scale-up) — read those first for the model choice,
the Athena/PLGrid environment setup, and the libdedx WASM gaps discovered there. This doc covers
the second scale-up: 1000 sentences, weighted to a stated real-world usage distribution rather than
even coverage, generated and then benchmarked against the shipped ASR + correction pipeline._

## 1. Brief

Requested distribution of real-world query intent, assumed by the requester rather than measured:

- **60% range** (`csdaRange`)
- **25% kinetic energy needed for a given range** (`energyFromRange`, inverse)
- **15% stopping power** (`stoppingPower`)

Plus: every sentence must be genuinely understandable by aidedx (not just plausible-sounding), and
a meaningful fraction must pose "multiple numbers" scenarios — the brief's own example is asking
for range at several energies in one query.

## 2. Method — generate at scale, but never guess at correctness

The core lesson carried over from the 100-sentence batch (`docs/tts-eval-audio.md` §7.1): a
sentence is only "understandable by aidedx" if the actual deterministic matcher
(`src/lib/intent/matcher.ts`) resolves a complete intent from it _and_ the actual libdedx WASM
(`computeIntent`, `src/lib/compute/compute.ts`) returns a finite, positive number — not a guess
about whether that would happen. At 1000 sentences, hand-writing each one (as the 100-sentence
batch did) doesn't scale, so this run took a different approach:

1. **A programmatic generator** (`scripts/generate-1000-sentences.mjs`) builds sentences from
   templates + pools of particles/materials/energies, with the known-safe constraints from the
   100-sentence batch's post-mortem baked in from the start (§3) — rather than discovering them by
   trial and error again.
2. **The same validation harness** (`scripts/tts-sentence-check.ts`, unmodified from the
   100-sentence batch) checks every candidate against the real matcher + WASM before any audio is
   synthesized.
3. Deterministic generation (a fixed-seed PRNG, not `Math.random()`) so the exact batch is
   reproducible from the script alone — no separate record of "what was randomly chosen" needs to
   be kept.

### 2.1 Quantity split and the "multiple numbers" requirement

| Quantity                    | Count | Single-value | Multi-energy                | Multi-material | Multi-particle |
| --------------------------- | ----- | ------------ | --------------------------- | -------------- | -------------- |
| `csdaRange`                 | 600   | 480 (80%)    | 80 (13.3%)                  | 20 (3.3%)      | 20 (3.3%)      |
| `energyFromRange` (inverse) | 250   | 200 (80%)    | — (schema can't; see below) | 30 (12%)       | 20 (8%)        |
| `stoppingPower`             | 150   | 120 (80%)    | 20 (13.3%)                  | 5 (3.3%)       | 5 (3.3%)       |

200 of 1000 sentences (20%) pose a genuine "multiple numbers" scenario. For the two forward
quantities this is literally the brief's own example — "range of protons in water at 50, 100, and
150 MeV" — via the matcher's `compareDim: "energy"` path (≥2 energies in one query).

**`energyFromRange` cannot have a multi-_energy_ analogue at all** — not a phrasing limitation, a
schema one: `QueryIntent.target` (the known range an inverse query solves for) is a single value,
not an array (`src/lib/intent/query-intent.ts`), and the matcher's target extractor
(`extractRangeTarget`) only ever captures one number+unit per query. The closest schema-legal
equivalent — confirmed to actually compute correctly, not assumed — is comparing several
_materials_ or _particles_ against the same single target range (`compareDim: "material"` /
`"particle"` on an inverse query still fans out one series per entity, each solved independently:
`src/lib/compute/compute.ts`'s `isInverse ? buildInverse : buildForward` dispatch doesn't
special-case compareDim). That's what the 50 multi-entity `energyFromRange` sentences use.

### 2.2 Pools — restricted to what's already confirmed to work

Every particle and material in the generator's pools was already empirically confirmed against the
real libdedx WASM during the 100-sentence batch (`docs/tts-eval-audio.md` §7.3), specifically to
avoid rediscovering the same failures at 10x the scale:

- **Particles**: protons, deuterons, tritons, alpha particles, and ion beams for every element
  hydrogen through argon (Z 1–18) — heavier ions (calcium and up) fail unconditionally via the
  auto-selected MSTAR program regardless of energy or material.
- **Materials**: water, air, PMMA, A-150 tissue-equivalent plastic, cortical/compact bone, adipose/
  muscle tissue, silicon (+ dioxide), aluminum (+ oxide), gold, graphite, polyethylene, polystyrene,
  Kapton, Mylar, lithium fluoride, sodium/cesium iodide, Pyrex glass, Teflon, polycarbonate —
  excluding the six materials confirmed broken in this libdedx build regardless of particle/energy
  (soft tissue, skin, lung, brain, blood, concrete).

### 2.3 New matcher edge cases found while generating at scale

Baking in the _known_ constraints from the 100-sentence batch still wasn't enough — generating
1000 candidates surfaced three more matcher edge cases the smaller batch never happened to trigger,
each found and fixed the same way as before: run the harness, read the actual failure, fix the
generator, re-verify against `matchIntent` directly before trusting the fix.

1. **A hyphenated particle name silently breaks inverse-query detection.** `detectInverse()`'s
   "which/what + up to 3 words + energy" regex requires every intervening word to be plain letters
   (`[a-z]+`); a phrase like "silicon-28 ion" has a digit in it, so `"Which silicon-28 ion energy is
needed…"` never matches at all. The query then silently falls through to a _forward_ `csdaRange`
   reading instead (the sentence still contains the literal word "range"), which then fails for a
   completely different reason (no energy slot). Fixed by keeping "which"/"what" immediately
   adjacent to "energy" in every inverse template (`"Which energy does a <particle> need…"`), which
   is immune to whatever particle name follows.
2. **A coordinated particle list with two different trailing head nouns gets silently
   misresolved — to a wrong element.** `"neon-20 ions and alpha particles"` uses `"ions"` as the
   head noun for the first particle and `"particles"` for the second; the matcher's coordinated-list
   regex only expects _one_ shared head noun for the whole list, and gets confused into treating the
   word `"ions"` itself as if it were a list member. `resolveParticle("ions")` then **fuzzy-matches
   to element Iron** — "ion" is a Levenshtein distance of exactly 1 from "iron" — silently
   substituting a completely wrong particle into the query with no error at all. This is the one
   finding from this run worth flagging as a real latent bug in `src/lib/aliases/lookup.ts`'s fuzzy
   matching, independent of anything to do with sentence generation. Fixed on this project's side by
   never generating a coordinated "X and Y ions/particles" list with mismatched head nouns — every
   multi-particle sentence instead repeats a full self-contained "a `<energy>` `<particle>`" mention
   per entity, which the single-mention matchers (`PARTICLE_HEAD_RE`, `NAMED_PARTICLE_RE`) resolve
   independently with no list-coordination logic involved at all.
3. **The generator's own slot-truth ground truth was wrong for indirectly-phrased sentences** — a
   bug in this session's tooling, not the matcher. Every `csdaRange` template was tagged with the
   blanket ground-truth keyword `"range"` regardless of which template text actually fired, but half
   the templates use indirect idioms ("how far will it travel", "how deep does it penetrate") that
   never say the word "range" at all. Scoring those against a literal `"range"` requirement would
   have flagged the _scorer_ as wrong, not the ASR — every template is now paired with the exact
   phrase its own text contains, so the recorded ground truth matches what the sentence actually
   says. Caught only because a live smoke-test transcription surfaced spurious "quantity slot
   missing" failures on sentences a human would clearly call correct; fixed by patching just the
   `slotTruth` field of already-generated manifest entries (`scripts/patch-slot-truth.mjs`) — the
   fix only touches scoring ground truth, not the audio or the sentence text, so no regeneration
   was needed.

None of these three were present in, or discoverable from, the 100-sentence batch — they only
showed up at this scale, which is itself evidence for point 1 of the "scaling to 1000" plan
(`docs/tts-eval-audio.md` §7.7): the validation loop, not raw synthesis time, is where the real cost
of scaling up lives.

### 2.4 Result: 1000/1000 pass, no manual fixing required

After the three fixes in §2.3, `scripts/tts-sentence-check.ts` reports **1000/1000 passed** against
the real matcher + libdedx WASM — every sentence resolves a complete intent and computes a finite,
positive number. Worth contrasting with the 100-sentence batch's own first-pass rate: that batch
started at 77/106 (~73%) and needed several rounds of manual diagnosis to reach 100/100
(`docs/tts-eval-audio.md` §7.3). This run's _first_ full validation pass (after baking in the known
constraints from that post-mortem) was already 934/1000 (93.4%) before the three new fixes above —
higher first-pass accuracy from applying prior lessons up front, though still not 100%, which is
exactly the point of §2.3's fixes existing at all.

## 3. Voice, accent, and emotion

57 voice profiles (47 Qwen3-TTS VoiceDesign free-text `instruct` strings spanning accent/age/
gender/emotion/pace, plus 10 CustomVoice preset+instruct combinations), extended from the
100-sentence batch's 30-profile pool per that batch's own recommendation
(`docs/tts-eval-audio.md` §7.7 point 3: growing the pool avoids each voice repeating ~33x at this
scale instead of ~11x). Assigned round-robin by global sentence index — deterministic, and even
across the batch by construction (1000 / 57 ≈ 17.5 uses per profile).

## 4. Generation — and why it ended up running as an `sbatch` job

Started the same way as the 100-sentence batch (an interactive background command):

```sh
source scripts/athena-env.sh
source .venv-qwen/bin/activate
python scripts/tts-qwen-1000.py scripts/tts-1000-sentences.json eval/audio/tts-qwen-1000
```

502 clips into the run, the interactive session it was attached to was torn down and the process
died with it — no crash, no error, just gone, exactly the same failure mode §7 of
`docs/tts-eval-audio.md` first hit with a dropped connection, except this time the _generation_
itself (not just the monitoring) was casualty. The 502 completed clips were intact and the script's
resumability (skip any `<id>.wav` already on disk) meant nothing was lost — but it was the second
time in one project that "just run it in the background" turned out not to be durable enough for a
multi-hour job.

**Fix: moved the whole pipeline into a committed `sbatch` script** (`submit.sh`, run as
`sbatch submit.sh`) instead of an interactive background command — a job submitted to the SLURM
queue keeps running regardless of what happens to the shell that submitted it. One job now runs, in
order: regenerate + validate the 1000 sentences (cheap, deterministic, doubles as a pre-flight
check), resume TTS generation to completion, patch `slotTruth`, transcribe, and score with both
correctors — see `docs/athena-setup.md` §7 for the general rule this produced ("heavy work goes
through `sbatch`, never run directly in an interactive/login shell") and the resource request
details (1 A100, 16 CPUs, 64 GB, 4 h walltime, same account/partition as this project's interactive
allocations).

**Result**: all 1000 clips generated, zero failures.

| Metric                                         | Value                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| Total generation time (both sessions combined) | 11,000.4 s (3.06 h) for 1000 clips                               |
| Per-clip average                               | 11.0 s (the `sbatch` job's own 498 clips: 11.43 s/clip)          |
| Total audio produced                           | 6303.1 s (105.1 min) across 1000 clips                           |
| Output size                                    | ~330 MB (1000 WAVs, 24 kHz/16-bit mono)                          |
| Engine split                                   | 830 VoiceDesign / 170 CustomVoice (matches the 47:10 pool ratio) |

## 6. ASR benchmark — whisper-small q8 + domain prompt, both correction layers

Same model this project already ships (`docs/asr-model-comparison.md`'s pick, `onnx-community/
whisper-small` at `q8`, domain-vocabulary prompt biasing on by default per issue #25) — the point of
this run was to see how that _existing_ pipeline handles 1000 sentences weighted to a stated
real-world distribution, not to try a new model or a new corrector. Both shipped correction layers
were scored against the same transcripts: `asr-correct.mjs` ("base") and `asr-correct-ext.mjs`
("ext").

The 30-ID hardcoded scorer (`scripts/asr-score-slots.mjs`) doesn't fit a 1000-clip batch where every
clip has a unique id and its own voice, so this run used two new generic scripts:
`scripts/asr-transcribe-manifest.mjs` (transcribes from a manifest + audio directory instead of a
hardcoded ID list) and `scripts/asr-score-slots-generic.mjs` (derives each clip's expected slots
from the `slotTruth` recorded at generation time — §2 — rather than a hand-written table). Both
reuse the transcription/correction/normalization logic from the existing scripts unmodified.

### 6.1 A 10x throughput bug, already documented, fixed before this run

`docs/tts-eval-audio.md` §4 already diagnosed — but explicitly did not fix — a ~10x per-clip
slowdown on Athena: `onnxruntime-node`'s default thread pool sizes itself to the node's _physical_
core count (128) and tries to pin one thread per core, while the Slurm/cgroup allocation only grants
16, so ~112 pin attempts fail and the runtime falls back to running well over 100 threads on 16 real
cores. Fixed here (`asr-transcribe-manifest.mjs`) by passing `session_options: { interOpNumThreads:
1, intraOpNumThreads: nproc }` through `pipeline()`, with `nproc` read from
`os.availableParallelism()`. Confirmed against a real allocation: median inference dropped from the
previously-measured ~24 s/clip to **2.0 s/clip** — matching the non-HPC reference machine in
`docs/voice-pipeline-feasibility.md`. (The `pthread_setaffinity_np` warnings still print to stderr
during the ~1 s model-load window — apparently from a global default thread pool `onnxruntime`
creates eagerly before per-session options take effect — but they're cosmetic: the measured
inference time confirms the actual work runs on the correctly-sized pool, not the failing one.)

### 6.2 A second scoring bug, found and fixed _after_ the first result came back

The first scored run reported 66.1% clip-pass (ext-corrector) with "material" as an oddly weak
multi-entity scenario (47.3%). Digging into _why_ — reading actual failing transcripts, not just the
aggregate number — found that 115 of the failures were sentences where the raw transcript said
**"aluminum" correctly**, verbatim, and still got marked wrong. The bug was in this session's own
tooling, not the ASR: the generator recorded `bare: "alumin"` for aluminum/aluminum oxide (meant as
a stem match), but the scorer wraps every `bare` pattern in `\b...\b` (whole-word boundaries) —
and `\balumin\b` can never match "aluminum" or "aluminium" at all, because the boundary requires a
non-letter immediately after "alumin", and the real word keeps going with a "u". Every aluminum/
aluminum-oxide clip was guaranteed to fail the material slot regardless of what the ASR actually
said. Fixed in `scripts/generate-1000-sentences.mjs` (`bare: "aluminum|aluminium"`), then re-scored
the _existing_ transcripts (no re-transcription needed — `scripts/patch-slot-truth.mjs` updates only
the manifest's `slotTruth`, and scoring is pure text matching against already-computed output).

**This changed the headline number substantially**: 66.1% → 74.9% (ext-corrected). All results
below are post-fix. Flagging this prominently rather than quietly using the corrected number,
because it's the same discipline this whole project has tried to apply to the _matcher's_ bugs
(docs/tts-eval-audio.md §7.3, §2.3 above) — a benchmark's own tooling needs the same "verify, don't
assume" treatment as the thing it's benchmarking, and a first result that looks worse than expected
is exactly when to go read the actual failing examples before writing it up.

### 6.3 Headline results

|                              | Raw              | Base corrector   | Ext corrector        |
| ---------------------------- | ---------------- | ---------------- | -------------------- |
| Clip-level all-slots-correct | 738/1000 (73.8%) | 740/1000 (74.0%) | **749/1000 (74.9%)** |

Both correctors move the needle only slightly on this batch (+0.2pp base, +1.1pp ext) — a much
smaller effect than the 100-sentence batch saw, discussed in §6.5.

By quantity (ext-corrected):

| Quantity                    | Pass rate       |
| --------------------------- | --------------- |
| `energyFromRange` (inverse) | 207/250 (82.8%) |
| `stoppingPower`             | 105/150 (70.0%) |
| `csdaRange`                 | 437/600 (72.8%) |

By scenario type (ext-corrected):

| Scenario                  | Pass rate       |
| ------------------------- | --------------- |
| particle (multi-particle) | 39/45 (86.7%)   |
| energy (multi-energy)     | 79/100 (79.0%)  |
| material (multi-material) | 41/55 (74.5%)   |
| single-value              | 590/800 (73.8%) |

No sign of the "more entities = compounding failure" effect that a naive model would predict once
the aluminum bug is out of the picture — multi-entity scenarios score _at least as well_ as
single-value ones. Most likely explanation: the multi-entity builders skew toward simpler,
lower-noise phrasing on average (e.g. multi-energy sentences are majority-proton — §2's generator —
and proton/water-family sentences are exactly the register whisper-small's domain prompt was tuned
around), not that comparing several things is inherently easier for ASR than asking about one.

By voice engine (ext-corrected) — the clearest single finding in this data:

| Engine                             | Pass rate       |
| ---------------------------------- | --------------- |
| VoiceDesign (free-text `instruct`) | 642/830 (77.3%) |
| CustomVoice (preset + `instruct`)  | 107/170 (62.9%) |

Freely-designed voices transcribe _better_ than the fixed presets, the opposite of what "a real
preset voice should sound cleaner than a synthesized description" would predict. 5 of the 8
worst-performing individual profiles are CustomVoice presets (`custom-onoAnna-en`,
`custom-dylan-formal`, `custom-vivian-en`, `custom-serena-warm`, `custom-ryan-happy`). Not
understood why from this data alone — plausible candidates include the non-English-native presets
(Vivian, Sohee, Ono_Anna) carrying a stronger accent inflection when speaking English than a
"designed" English accent does, or the instruct-driven emotion control interacting differently with
a fixed timbre than a fully-designed voice — but this is a hypothesis, not a conclusion; noting the
open question rather than overclaiming a cause.

The 8 best-performing profiles span Irish, Australian, Chinese-accented, Korean-accented,
Italian-accented, Nigerian, Russian-accented, and Kenyan — no clustering around "native English"
accents outperforming others. That's a real (if partial) answer to the question this whole
heavier-model detour was chasing in the first place (`docs/tts-eval-audio.md` §6.3): whisper-small's
accuracy on this content does _not_ obviously degrade for non-American/British accents relative to
native ones, at least at the level this benchmark can detect.

### 6.4 What actually fails, and why

251 clips fail after ext-correction. Breaking down _which_ slot category each failure hits (a clip
can miss more than one):

| Category | Appears in N failures | % of all 251 failures |
| -------- | --------------------- | --------------------- |
| unit     | 163                   | 65%                   |
| number   | 80                    | 32%                   |
| material | 51                    | 20%                   |
| particle | 32                    | 13%                   |
| quantity | 19                    | 8%                    |

**Units are overwhelmingly the dominant failure mode** — nearly 2 out of 3 failing clips get the
unit wrong, far more than any other category, and the quantity phrase (the part that actually
carries the query's _intent_ — "range", "stopping power", "how far", "what energy") is by far the
most robust (98.5% raw token accuracy, only 8% of failures). Reading the actual failing transcripts
shows why — whisper-small doesn't reliably know the `MeV`/`keV`/`GeV`/`MeV/nucl` vocabulary and
substitutes acoustically-similar real words or garbled fragments instead of a genuine near-miss:

- `"2MeV"` → **`"2MeV"`** run together with no space (breaks the corrector's `\bmev\b` boundary
  check even though the letters are all there)
- `"MeV"` → `"MIV"`, `"MFv"`, `"MAV"`, `"NEATMEV"`, `"NEV"` — consistently a plausible-sounding but
  wrong 3-letter unit-shaped token, not random noise
- `"350 MeV"` → `"350eMeV"` — the unit fuses onto the number itself
- material names outside the common set get replaced by acoustically-similar real English words
  instead of near-misses: **"Kapton" → "captain"** (consistent across every occurrence — this isn't
  noise, whisper-small has never heard of Kapton and substitutes the closest real word every time),
  "cesium iodide" → "Czm iodide" / "incisium iodide" / "acesium iodide" (three different garbled
  spellings across three different clips, i.e. inconsistent, unlike "captain")
- particle names fare better overall (96.9% token accuracy) but still slip on less common isotope
  phrasings: "helium-3" → "healium-3", "deuteron" → "duteron"

This is a materially different failure signature than the 100-sentence batch found for Kokoro-82M
(`docs/tts-eval-audio.md` §3.1: TTS-side text-normalization artifacts, like reading "/" literally as
"slash"). Here the TTS side isn't obviously the problem — Qwen3-TTS is presumably pronouncing "MeV"
correctly — the bottleneck reads as whisper-small's own vocabulary gap for domain-specific physics
units and material trade names, which is exactly the kind of thing a domain prompt is supposed to
help with and evidently isn't fully closing at this scale.

### 6.5 Why the corrector helps less here than in the 30-sentence pilot

The 100-sentence/30-sentence pilots didn't report as large a raw-to-corrected gap either, but this
batch's ext-corrector gain (+1.1pp, 738→749) is smaller in absolute clip count than might be
expected given `docs/tts-eval-audio.md`'s framing of the correction layer as doing real work. Two
candidate explanations, not yet distinguished by this data:

1. The corrector's rules were written against the original 30-sentence set's specific failure modes
   (documented in `docs/tts-eval-audio.md` §3.1 — slash-as-"slash", specific number-word forms) —
   rules tuned to one small hand-picked set may simply not generalize to the wider vocabulary this
   1000-sentence batch exercises (24 materials, 20 particles, vs. the pilot's much narrower set).
2. Many of the failures in §6.4 are multi-character substitutions ("MIV", "captain", "duteron") that
   don't look like the kind of error a small hand-written regex correction layer can plausibly catch
   — the corrector can fix a systematic, predictable transformation (e.g. "slash" → "/"), not an
   acoustic mis-hearing that produces a different real word entirely.

### 6.6 Files (benchmark)

- `scripts/asr-transcribe-manifest.mjs` — generic transcription driver (§6, §6.1).
- `scripts/asr-score-slots-generic.mjs` — generic scorer, derives slots from `slotTruth` (§6, §6.2).
- `scripts/patch-slot-truth.mjs` — patches corrected `slotTruth` onto an existing manifest without
  touching audio or text (used for both the §2.3 point 3 fix and the §6.2 fix).
- `eval/results/tts-1000-2026-07-16/small-q8-prompt.json` — raw transcripts, all 1000 clips.
- `eval/results/tts-1000-2026-07-16/score-base.json`, `score-ext.json` — full per-clip scoring
  output for both correctors (committed — same convention as the existing `eval/results/` baselines,
  unlike the gitignored audio itself).

## 7. Files (generation)

- `scripts/generate-1000-sentences.mjs` — the sentence generator (§2).
- `scripts/tts-qwen-1000.py` — the synthesis driver (§3–4).
- `submit.sh` — the `sbatch` pipeline that runs generation → patch → transcribe → score as one job
  (§4).
- `eval/audio/tts-qwen-1000/*.wav` + `manifest.json` — 1000 clips + full ground truth (text,
  resolved-quantity/multi-scenario tags, `slotTruth`, voice profile) — gitignored like the rest of
  `eval/audio/`, per this project's existing convention for TTS-synthesized (not recorded-human)
  audio.
