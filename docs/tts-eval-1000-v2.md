# 1000-sample TTS eval-audio batch v2 (issue #83 — expanded pool + LET terminology)

_Session report, 2026-07-17. Builds directly on `docs/tts-eval-1000.md` (the v1 run) — read that
first for the generator design, the 57-voice-profile pool, and the sbatch-on-Athena methodology, all
of which carry over to this run unchanged. This doc covers what changed for v2, the results from the
now-completed Athena job (`scripts/submit-v2.sh`, committed in #86), and a full independent
cross-check of those numbers before committing anything to the repo._

> **Correction (2026-07-17, same day, while extending this report for issue #92):** every number
> below was originally computed with a scorer bug that undercounted a real, common ASR/TTS rendering
> — a number glued straight to its unit with no space ("30mm", "100mev"). `\b` treats digits and
> letters as the same "word" character class, so `\bmm\b` silently fails to match the unit half of a
> glued token, even though the actual matcher (`LENGTH_TARGET_RE`/`ENERGY_RE` in
> `src/lib/intent/matcher.ts`) already tolerates zero whitespace there. Found while building the
> per-unit breakdown §9 asked for: 34/66 `mm`-target clips in this batch are glued this way (vs. 1/184
> for `cm`), which is why `mm` accuracy first came out at a suspicious flat 47% that correction didn't
> move at all. Fixed in `scripts/asr-score-slots-generic.mjs` (both `norm()` and every unit/number
> slot check now use a letter- or digit-specific boundary instead of `\b`); **every table in this
> document reflects the corrected scorer.** The relative story is unchanged (the new corrector is
> still by far the biggest win) but the absolute headline numbers moved up substantially — flagging
> this prominently rather than quietly using the corrected numbers, same discipline
> `docs/tts-eval-1000.md` §6.2 applied to its own aluminum-material scoring bug. **`docs/tts-eval-1000.md`
> (v1) uses the same scorer and almost certainly has the same undercounting artifact — left
> unmodified as this project's convention for a historical record, not recomputed here.**

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
| Output size           | 284 MB (1000 WAVs, gitignored, local only — see §11)           |
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
   committed `score-base.json`/`score-ext.json` numbers exactly (originally 709/1000 base, 722/1000
   ext; see the correction note above and §4 for the numbers after the scorer bug fix that
   superseded these).

## 4. Headline results

|                              | Raw              | Base corrector   | Ext corrector    | New corrector (regex + phonetic, issue #28) |
| ---------------------------- | ---------------- | ---------------- | ---------------- | ------------------------------------------- |
| Clip-level all-slots-correct | 741/1000 (74.1%) | 745/1000 (74.5%) | 752/1000 (75.2%) | **807/1000 (80.7%)**                        |

The "new corrector" column wasn't part of the Athena job — the phonetic-lexicon pass
(`src/lib/asr/correct/`, issue #28) merged to `main` _after_ this batch was submitted. Scoring the
already-recorded transcripts against it retroactively gives the first large-scale data point for that
work (the eval it actually shipped against, #90, was the 3-speaker/30-sentence set — 89 clips). The
gain here is substantially bigger: **+66 clips over raw** (vs ext's +11), where the 3-speaker set only
saw +1 to +3 clips of improvement per model. A wider, more diverse voice pool (57 profiles vs 3 human
speakers) exercises far more of exactly the case the phonetic pass exists for — a mishearing nobody
wrote a regex rule for yet.

## 5. Comparing against v1 — flat overall, with one real gap in `stoppingPower`

**Caveat on this whole section**: v1's figures below predate the scorer fix in the correction note
above and almost certainly undercount similarly (same scorer, same bug) — they're shown as originally
reported, an unmodified historical record, not recomputed here. This comparison is directionally
right but not a precise apples-to-apples measurement against the corrected v2 numbers. (This section
originally concluded the v2 pool was measurably harder in raw ASR terms — before the scorer fix. That
framing doesn't survive the fix and is corrected here rather than left standing.)

v1's raw pass rate was 738/1000 (73.8%); this batch's is 741/1000 (74.1%) post-fix — essentially flat,
not the 3.3pp drop the pre-fix numbers showed. The expanded particle/material pool (issue #83's whole
point) isn't dragging the headline number down. Comparing per-quantity (ext-corrected) against v1's
own §6.3 table:

| Quantity          | v1 (ext-corrected, unmodified) | v2 (ext-corrected, post-fix) | Δ           |
| ----------------- | ------------------------------ | ---------------------------- | ----------- |
| `csdaRange`       | 437/600 (72.8%)                | 439/600 (73.2%)              | +0.4pp      |
| `energyFromRange` | 207/250 (82.8%)                | 227/250 (90.8%)              | **+8.0pp**  |
| `stoppingPower`   | 105/150 (70.0%)                | 86/150 (57.3%)               | **−12.7pp** |

`csdaRange` is flat, and `energyFromRange` (the category the cm/mm scorer bug hit hardest, since it's
the one built from range _targets_ rather than energies) is now measurably _better_ than v1's
unmodified number, not worse — consistent with v1 likely carrying the same undercounting artifact.
`stoppingPower` is the one real, still-standing gap, and §7 shows why: LET-family phrasing (now the
majority of that category) is measurably harder for whisper-small than "stopping power" was. That gap
is the expected cost of the v2 pool testing genuinely harder, more realistic content (issue #83's
explicit goal) — not a regression anywhere in the ASR/correction pipeline itself.

## 6. By scenario type and voice engine (ext-corrected)

| Scenario                  | Pass rate       |
| ------------------------- | --------------- |
| material (multi-material) | 44/55 (80.0%)   |
| single-value              | 602/800 (75.3%) |
| particle (multi-particle) | 33/45 (73.3%)   |
| energy (multi-energy)     | 73/100 (73.0%)  |

Same pattern v1 found: no "more entities = compounding failure" effect — multi-entity scenarios
score at least as well as single-value ones.

| Engine                             | Base            | Ext             | New                 |
| ---------------------------------- | --------------- | --------------- | ------------------- |
| VoiceDesign (free-text `instruct`) | 640/830 (77.1%) | 643/830 (77.5%) | 678/830 (81.7%)     |
| CustomVoice (preset + `instruct`)  | 105/170 (61.8%) | 109/170 (64.1%) | **129/170 (75.9%)** |

VoiceDesign again outperforms CustomVoice across every corrector, confirming v1's finding rather than
it being a one-batch artifact. Worth noting: the phonetic pass narrows this gap more than it widens
it — CustomVoice gains +11.8pp (64.1→75.9%) vs VoiceDesign's +4.2pp (77.5→81.7%), i.e. the
generalized fuzzy-lookup approach helps proportionally _more_ on the noisier preset voices than the
fixed regex list did, consistent with §4's explanation for why the phonetic pass matters more here
than on the cleaner 3-speaker human recordings. (This session's voice-composition changes queued for
the next Athena run — §10 — act on this same finding.)

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

## 9. Per-unit accuracy and clinical-core/long-tail stratification (issue #92)

Two of the methodology improvements issue #83 asked for and #86/#91 didn't get to — both pure
re-analysis of the already-collected transcripts above, no new Athena run needed.

**Per-unit accuracy.** #83's own finding was that units are 65% of all failures — but that's one
blended number across five different unit tokens with plausibly very different accuracy. Breaking it
down (raw → corrected):

| Unit       | Base            | Ext             | New               | n   |
| ---------- | --------------- | --------------- | ----------------- | --- |
| `MeV`      | 81.5% → 81.5%   | 81.5% → 83.2%   | 81.5% → **90.9%** | 482 |
| `MeV/nucl` | 79.5% → 79.5%   | 79.5% → 79.5%   | 79.5% → **92.9%** | 322 |
| `keV`      | 100.0% → 100.0% | 100.0% → 100.0% | 100.0% → 100.0%   | 83  |
| `GeV`      | 53.3% → 80.0%   | 53.3% → 80.0%   | 53.3% → 80.0%     | 15  |
| `cm`       | 99.5% → 99.5%   | 99.5% → 99.5%   | 99.5% → 99.5%     | 184 |
| `mm`       | 98.5% → 98.5%   | 98.5% → 98.5%   | 98.5% → 98.5%     | 66  |

`keV/µm` (the LET unit) is absent from this table because this generator's `stoppingPower` category is
forward-only — it never builds an `energyFromStp` inverse query, so no sentence in this batch actually
uses it. `MeV`/`MeV/nucl` are where the phonetic pass (issue #28) does almost all of its work, exactly
matching §4/§6's finding that this batch is where it earns its keep; `GeV`'s raw accuracy is
strikingly poor (53.3% of only 15 occurrences — too few to read much into, but consistent with GeV
values being rarer and more likely to appear spelled out, e.g. "two GeV", which no unit-level regex or
edit-distance check touches). `cm`/`mm`/`keV` are already near-ceiling and none of the correctors move
them further.

**Clinical-core vs. long-tail-robustness stratum.** #83 asked not to let exotic entities (unlocked by
#81's Bethe fallback) masquerade as the real-world distribution in one blended headline number. A clip
is "long-tail" if any of its particles/materials falls outside the clinical set (protons/He/Li-Ar
ions, water/air/PMMA/A-150/ICRP tissues/bone) — Z>18 ions (calcium..uranium) or detector/electronics
materials and the boron family (`scripts/asr-score-slots-generic.mjs`'s `stratumFor()`, bare-string
sets mirroring the generator's own pools exactly):

| Stratum       | Base            | Ext             | New                 | n   |
| ------------- | --------------- | --------------- | ------------------- | --- |
| clinical-core | 245/302 (81.1%) | 247/302 (81.8%) | **263/302 (87.1%)** | 302 |
| long-tail     | 500/698 (71.6%) | 505/698 (72.3%) | **544/698 (77.9%)** | 698 |

Clinical-core clips consistently outperform long-tail ones by roughly 9-10pp across every corrector —
expected, since long-tail entities (uranium, krypton, Kapton, cesium iodide, ...) are rarer words
whisper-small has less training exposure to. The more consequential finding is the **n column**:
long-tail is 69.8% of this batch, not the minority "robustness" slice #83's framing implies. Flat
random sampling over a pool that happens to contain more long-tail entries (18) than clinical-core
ones (Z 1-18 ions plus ~12 clinical materials) makes long-tail the accidental majority. If a future
regeneration wants the headline number to represent real-world usage rather than a robustness sweep,
the generator's sampling would need explicit reweighting toward the clinical-core set — not done here,
flagged as a further open question for whoever picks this up next.

## 10. Code changes queued for the next Athena run (issue #92, not yet measured)

Two more #83 asks are pure code changes with no way to measure impact without a new `sbatch` run —
made in this same PR so the next run measures both at once instead of costing two separate GPU jobs:

- **`DOMAIN_PROMPT` expansion** (`src/lib/asr/transcribe.ts`) — added the material trade names and
  quantity terms §8 and `docs/tts-eval-1000.md` §6.4 both found fail consistently (Kapton, Mylar,
  Teflon, Pyrex glass, sodium/cesium iodide, LET, linear energy transfer, keV/µm). #83 named this one
  of "the two higher-leverage levers" alongside the phonetic corrector (#28) — only the corrector half
  had been measured until now.
- **Voice-composition fixes** (`scripts/tts-qwen-1000.py`) — shrunk the `CustomVoice` preset pool
  (§6's finding held again here: it trails `VoiceDesign` on every corrector), decorrelated voice
  assignment from sentence order (was `global_index % poolSize`, now a stable hash of the sentence id,
  per #83's own diagnosis that voice and category were partially confounded), and seeded Qwen
  synthesis per clip so a regenerated batch is bit-reproducible audio, not just equivalent sentences.

Neither change is reflected in any number above — both need a fresh TTS synthesis + transcription pass
to measure, which needs Athena GPU access outside this environment.

## 11. Files

**Committed in this PR** (matches the existing `eval/results/` convention — lightweight, derived,
reproducible; unlike the audio, never gitignored):

- `eval/results/tts-1000-v2-2026-07-17/small-q8-prompt.json` — raw transcripts, all 1000 clips, zero
  transcription errors.
- `eval/results/tts-1000-v2-2026-07-17/score-{base,ext,new}.json` + matching `.log` — full per-clip
  scoring output for all three correctors (base/ext produced by the Athena job, new computed here —
  see below), **regenerated with the scorer fix from the correction note above**, superseding the
  files #91 originally committed; `byUnit`/`byStratum` (§9) are new fields.

**Not committed — stays local, per this project's existing convention for TTS-synthesized audio**
(`.gitignore`'s `/eval/audio/`, same as the v1 batch and the 3-speaker human recordings):

- `eval/audio/tts-qwen-1000-v2/*.wav` (1000 clips, 284 MB) + `manifest.json` (full ground truth: text,
  quantity/multi-scenario tags, `slotTruth`, voice profile/engine, per-clip generation timing).
- `scripts/tts-1000-sentences-v2.json` — the sentence generator's own manifest; regenerable from the
  fixed seed (§3 point 1), so nothing is lost by not committing it.

**Not produced by the Athena job, computed for this report** — the "New corrector" column throughout
(§4, §6, §7, §9): `node scripts/asr-score-slots-generic.mjs <manifest.json> eval/results/tts-1000-v2-2026-07-17/small-q8-prompt.json --new`.
The headline clip-pass, per-unit, and stratum numbers (§4, §9) only need `id`/`quantity`/`multi`/
`slotTruth` per clip, so they reproduce from the committed generator's own manifest
(`node scripts/generate-1000-sentences.mjs`, §3 point 1 — profile-less, scores as "unknown"). The
by-voice-engine/profile breakdowns in §6 need the gitignored `eval/audio/tts-qwen-1000-v2/manifest.json`
instead, since profile/engine assignment is done by `scripts/tts-qwen-1000.py`.
