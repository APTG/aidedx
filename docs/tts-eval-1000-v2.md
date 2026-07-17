# 1000-sample TTS eval-audio batch v2 (issue #83 — expanded pool + LET terminology)

_Session report, 2026-07-17. Builds directly on `docs/tts-eval-1000.md` (the v1 run) — read that
first for the generator design, the 57-voice-profile pool, and the sbatch-on-Athena methodology, all
of which carry over to this run unchanged. This doc covers what changed for v2, the results from the
now-completed Athena job (`scripts/submit-v2.sh`, committed in #86), and a full independent
cross-check of those numbers before committing anything to the repo._

## 1. What changed from v1 (issue #83)

Three gaps issue #83 catalogued in the v1 batch, all addressed in `scripts/generate-1000-sentences.mjs`
before this run:

- **Particle pool extended past Z=18 (argon)** — calcium, iron, krypton, xenon, gold, lead, uranium,
  unlocked by #81's Bethe-Bloch fallback for particle/material combinations MSTAR doesn't tabulate.
- **Material pool restores the six entries v1 excluded as broken** (soft tissue, skin, lung, brain,
  blood, concrete), plus the boron family (boron, boron carbide, boron oxide).
- **`stoppingPower` sentences now mostly say "LET" or "linear energy transfer"** instead of "stopping
  power" — the term real particle-therapy/radiobiology users actually say, matcher support landed in
  #86. Measured split in the actual generated batch (§7): 56% (84/150) of `stoppingPower` sentences
  use LET-family wording, close to the "~50%" figure #86 targeted.
- **The generate→validate loop is closed**: every candidate is checked against the real matcher +
  libdedx WASM inline as it's generated (reusing `tts-sentence-check.ts`'s `checkCandidate`), with
  bounded resampling on failure, instead of validating as a separate pass afterward.

## 2. Generation — ran cleanly this time

Per #86, the whole pipeline (regenerate + validate → TTS synthesis → transcribe → score with both
correctors) now runs as one `sbatch` job (`scripts/submit-v2.sh`), which is what actually completed
this time with no dropped-session interruption (v1's generation run, §4 of `docs/tts-eval-1000.md`,
lost its interactive shell 502 clips in).

| Metric                | Value                                                          |
| --------------------- | -------------------------------------------------------------- |
| Total generation time | 11,569.0 s (3.21 h) for 1000 clips                             |
| Per-clip average      | 11.57 s                                                        |
| Total audio produced  | 6132.2 s (102.2 min) across 1000 clips                         |
| Output size           | 284 MB (1000 WAVs, gitignored, local only — see §9)            |
| Engine split          | 830 VoiceDesign / 170 CustomVoice (same 57-profile pool as v1) |

## 3. Cross-check methodology

Before trusting or committing any number below, verified three things independently rather than
taking the copied files at face value:

1. **Regenerated the 1000-sentence manifest locally** from the committed fixed-seed generator
   (`node scripts/generate-1000-sentences.mjs`) and diffed it against the manifest the Athena job
   actually used (`eval/audio/tts-qwen-1000-v2/manifest.json`, gitignored, not part of this PR) —
   **0/1000 content mismatches** (text, quantity, multi-scenario tag, and `slotTruth` all identical
   for every id). Confirms the "fully regenerable from the fixed seed" claim in #86 actually holds,
   not just asserted.
2. **Re-ran `scripts/tts-sentence-check.ts`** against the regenerated manifest — **1000/1000 passed**
   against the real matcher + libdedx WASM, matching #86's claim exactly.
3. **Re-scored the committed transcripts independently.** Ran
   `scripts/asr-score-slots-generic.mjs` (both correctors) against
   `eval/results/tts-1000-v2-2026-07-17/small-q8-prompt.json` from a clean checkout — reproduced the
   committed `score-base.json`/`score-ext.json` numbers exactly (709/1000 base, 722/1000 ext; see §4).

## 4. Headline results

|                              | Raw              | Base corrector   | Ext corrector    | New corrector (regex + phonetic, issue #28) |
| ---------------------------- | ---------------- | ---------------- | ---------------- | ------------------------------------------- |
| Clip-level all-slots-correct | 705/1000 (70.5%) | 709/1000 (70.9%) | 722/1000 (72.2%) | **777/1000 (77.7%)**                        |

The "new corrector" column wasn't part of the Athena job — the phonetic-lexicon pass
(`src/lib/asr/correct/`, issue #28) merged to `main` _after_ this batch was submitted. Scoring the
already-recorded transcripts against it retroactively gives the first large-scale data point for that
work (the eval it actually shipped against, #90, was the 3-speaker/30-sentence set — 89 clips). The
gain here is substantially bigger: **+55 clips over raw** (vs ext's +17), where the 3-speaker set only
saw +1 to +3 clips of improvement per model. A wider, more diverse voice pool (57 profiles vs 3 human
speakers) exercises far more of exactly the case the phonetic pass exists for — a mishearing nobody
wrote a regex rule for yet.

## 5. Why the raw pass rate is lower than v1 — a harder pool, not a regression

v1's raw pass rate was 738/1000 (73.8%); this batch's is 705/1000 (70.5%), a 3.3pp drop. Comparing
per-quantity (ext-corrected) against v1's own §6.3 table shows where it comes from:

| Quantity          | v1 (ext-corrected) | v2 (ext-corrected) | Δ           |
| ----------------- | ------------------ | ------------------ | ----------- |
| `csdaRange`       | 437/600 (72.8%)    | 439/600 (73.2%)    | +0.4pp      |
| `energyFromRange` | 207/250 (82.8%)    | 197/250 (78.8%)    | −4.0pp      |
| `stoppingPower`   | 105/150 (70.0%)    | 86/150 (57.3%)     | **−12.7pp** |

`csdaRange` — the category that absorbed the new heavier ions and restored materials — is
essentially flat, so the expanded particle/material pool isn't the main driver. Almost the entire
drop is concentrated in `stoppingPower`, and §7 shows why: LET-family phrasing (now the majority of
that category) is measurably harder for whisper-small than "stopping power" was. This is the expected
cost of the v2 pool testing genuinely harder, more realistic content (issue #83's explicit goal), not
a regression anywhere in the ASR/correction pipeline itself — nothing about Whisper or the correctors
changed between the two runs.

## 6. By scenario type and voice engine (ext-corrected)

| Scenario                  | Pass rate       |
| ------------------------- | --------------- |
| material (multi-material) | 42/55 (76.4%)   |
| energy (multi-energy)     | 73/100 (73.0%)  |
| single-value              | 577/800 (72.1%) |
| particle (multi-particle) | 30/45 (66.7%)   |

Same pattern v1 found: no "more entities = compounding failure" effect — multi-entity scenarios
score at least as well as single-value ones.

| Engine                             | Base            | Ext             | New                 |
| ---------------------------------- | --------------- | --------------- | ------------------- |
| VoiceDesign (free-text `instruct`) | 611/830 (73.6%) | 619/830 (74.6%) | 654/830 (78.8%)     |
| CustomVoice (preset + `instruct`)  | 98/170 (57.6%)  | 103/170 (60.6%) | **123/170 (72.4%)** |

VoiceDesign again outperforms CustomVoice across every corrector, confirming v1's finding rather than
it being a one-batch artifact. Worth noting: the phonetic pass narrows this gap more than it widens
it — CustomVoice gains +11.8pp (60.6→72.4%) vs VoiceDesign's +4.2pp (74.6→78.8%), i.e. the
generalized fuzzy-lookup approach helps proportionally _more_ on the noisier preset voices than the
fixed regex list did, consistent with §4's explanation for why the phonetic pass matters more here
than on the cleaner 3-speaker human recordings.

## 7. LET vs "stopping power" phrasing — a new finding this run makes possible

The `stoppingPower` category's own `slotTruth.quantityKeyword` field records exactly which phrase
each sentence used, so it's possible to break the pass rate down by wording — something v1 couldn't
do, since it had no LET phrasing at all:

| Phrasing (n)                  | Base          | Ext           | New               |
| ----------------------------- | ------------- | ------------- | ----------------- |
| "stopping power" (44)         | 29/44 (65.9%) | 30/44 (68.2%) | **36/44 (81.8%)** |
| "linear energy transfer" (32) | 19/32 (59.4%) | 20/32 (62.5%) | **25/32 (78.1%)** |
| "LET" acronym (52)            | 26/52 (50.0%) | 26/52 (50.0%) | 27/52 (51.9%)     |
| dE/dx, indirect (22)          | 9/22 (40.9%)  | 10/22 (45.5%) | 13/22 (59.1%)     |

LET-family phrasing is measurably harder than plain "stopping power" across every corrector — and the
bare **"LET" acronym is the one case the phonetic pass barely moves** (50.0% → 51.9%, vs the
double-digit gains everywhere else). This is a real, specific interaction worth flagging for anyone
picking up issue #87/#28 next: the matcher's LET support (#86) matches the acronym
case-sensitively against the _original_ (not lowercased) text specifically so the common word "let"
isn't misread as the physics term — but that means if Whisper transcribes the acronym in lowercase or
folds it into a differently-spelled token, neither the matcher's exact check nor the phonetic pass's
edit-distance lookup (which isn't case-sensitive-aware in that specific way) reliably recovers it.
Not fixed here — out of scope for a results write-up — but worth a look before calling issue #28 done.

## 8. What actually fails

Reading the failing transcripts, the dominant failure signature from v1 §6.4 (unit tokens are the
overwhelming majority of failures — whisper-small doesn't know `MeV`/`keV`/`GeV` well and substitutes
plausible-sounding real words) holds here too: `"MeV"` → `"MIV"`, `"MFv"`, `"MAV"`, `"NEV"`;
`"Kapton"` → `"captain"` (still consistent every time it occurs, as v1 found); newly-added heavier
ions add their own variants (`"krypton-84"` → `"crypton-84"`, `"helium-3"` → `"healium-3"`). None of
this is new relative to v1 — the pool got harder, not the failure mode.

## 9. Files

**Committed in this PR** (matches the existing `eval/results/` convention — lightweight, derived,
reproducible; unlike the audio, never gitignored):

- `eval/results/tts-1000-v2-2026-07-17/small-q8-prompt.json` — raw transcripts, all 1000 clips, zero
  transcription errors.
- `eval/results/tts-1000-v2-2026-07-17/score-base.json`, `score-base.log`, `score-ext.json`,
  `score-ext.log` — full per-clip scoring output for both shipped correctors, produced by the Athena
  job and independently reproduced here (§3).
- `eval/results/tts-1000-v2-2026-07-17/score-new.json`, `score-new.log` — same, for the phonetic
  corrector (issue #28), computed for this report (not part of the Athena job — see below).

**Not committed — stays local, per this project's existing convention for TTS-synthesized audio**
(`.gitignore`'s `/eval/audio/`, same as the v1 batch and the 3-speaker human recordings):

- `eval/audio/tts-qwen-1000-v2/*.wav` (1000 clips, 284 MB) + `manifest.json` (full ground truth: text,
  quantity/multi-scenario tags, `slotTruth`, voice profile/engine, per-clip generation timing).
- `scripts/tts-1000-sentences-v2.json` — the sentence generator's own manifest; regenerable from the
  fixed seed (§3 point 1), so nothing is lost by not committing it.

**Not produced by the Athena job, computed for this report** — the "New corrector" column throughout
(§4, §6, §7): `node scripts/asr-score-slots-generic.mjs <manifest.json> eval/results/tts-1000-v2-2026-07-17/small-q8-prompt.json --new`.
The headline clip-pass number (§4) only needs `id`/`quantity`/`multi`/`slotTruth` per clip, so it
reproduces from the committed generator's own manifest (`node scripts/generate-1000-sentences.mjs`,
§3 point 1 — profile-less, scores as "unknown"). The by-voice-engine/profile breakdowns in §6 need
the gitignored `eval/audio/tts-qwen-1000-v2/manifest.json` instead, since profile/engine assignment
is done by `scripts/tts-qwen-1000.py` (also deterministic — round-robin by sentence index — but not
reproduced by `generate-1000-sentences.mjs` alone).
