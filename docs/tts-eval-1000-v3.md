# 1000-sample TTS eval-audio batch v3 (issue #92 Group B — DOMAIN_PROMPT + voice-composition)

_Session report, 2026-07-18. Builds directly on `docs/tts-eval-1000-v2.md` (the v2 run) — read that
first for the generator design, the voice-profile pool, and the sbatch-on-Athena methodology, all of
which carry over unchanged. This doc measures issue #92 Group B: the `DOMAIN_PROMPT` expansion and
voice-composition fixes that were code-complete in #93/PR #94 but explicitly left unmeasured until a
new Athena run could produce fresh transcripts._

## 1. What changed from v2 (issue #92 Group B, PR #94)

The **sentences are byte-identical to v2** (same generator, same fixed seed —
`scripts/generate-1000-sentences.mjs` itself wasn't touched) — confirmed in §3. What changed:

- **`DOMAIN_PROMPT` expansion** (`src/lib/asr/transcribe.ts`, mirrored into the Node benchmark scripts
  that don't import it) — added the material trade names and quantity terms that both v1 §6.4 and v2
  §8 found fail consistently: Kapton, Mylar, Teflon, Pyrex glass, sodium/cesium iodide, `LET`,
  `linear energy transfer`, `keV/µm`.
- **Voice-composition fixes** (`scripts/tts-qwen-1000.py`): the `CustomVoice` preset pool shrunk from
  10 to 3 presets (v2 §6 found it trails `VoiceDesign` on every corrector); voice assignment is now a
  stable hash of the sentence id instead of `global_index % poolSize` (decorrelates voice from the
  fixed category order sentences are generated in); each clip's Qwen synthesis is individually seeded
  for bit-reproducible audio.

## 2. Generation

| Metric                | Value                                                           |
| --------------------- | --------------------------------------------------------------- |
| Total generation time | 11,785.7 s (3.27 h) for 1000 clips                              |
| Per-clip average      | 11.79 s                                                         |
| Total audio produced  | 6145.2 s (102.4 min) across 1000 clips                          |
| Output size           | 285 MB (1000 WAVs, gitignored, local only — see §11)            |
| Engine split          | 935 VoiceDesign / 65 CustomVoice (50-profile pool, all 50 used) |

Engine split moved sharply toward `VoiceDesign` vs. v2's 830/170 — the direct, expected effect of
shrinking the `CustomVoice` preset pool 10→3 (fewer presets to draw from means each is drawn less often
in a flat random assignment over 1000 clips).

The Athena job (job 2803127, `scripts/submit-v3.sh`) needed a resubmit after job 2803055 hit the
original 4h walltime mid-transcription — the resumable-transcription fix and 4h→6h walltime bump
landed in this same branch beforehand. This run completed cleanly with no interruption.

## 3. Cross-check methodology

Same three checks v2 §3 ran, before trusting or committing any number below:

1. **Regenerated the 1000-sentence manifest locally** from the committed fixed-seed generator and
   diffed it against the manifest the Athena job actually used
   (`eval/audio/tts-qwen-1000-v3/manifest.json`, gitignored) — **0/1000 content mismatches** (text,
   quantity, multi-scenario tag, and `slotTruth` all identical for every id). Confirms v3 tests the
   exact same 1000 sentences as v2, isolating this run's deltas to the prompt/voice changes in §1.
2. **Re-ran `scripts/tts-sentence-check.ts`** against the regenerated manifest — **1000/1000 passed**
   against the real matcher + libdedx WASM.
3. **Independently ran all three scoring passes** (`scripts/asr-score-slots-generic.mjs`, base/ext/new)
   against the committed `small-q8-prompt.json` from a clean checkout of this branch — this is also how
   the numbers below were produced in the first place: the Athena job's own scoring step didn't
   complete before its output was copied off Athena, but scoring is a pure, fast, GPU-free Node
   computation over the already-transcribed JSON + the gitignored manifest, so nothing about it
   actually needed re-running on Athena.

## 4. Headline results

|                              | Raw              | Base corrector   | Ext corrector    | New corrector (regex + phonetic, issue #28) |
| ---------------------------- | ---------------- | ---------------- | ---------------- | ------------------------------------------- |
| Clip-level all-slots-correct | 782/1000 (78.2%) | 782/1000 (78.2%) | 786/1000 (78.6%) | **840/1000 (84.0%)**                        |

| vs. v2 | Raw        | Base   | Ext    | New    |
| ------ | ---------- | ------ | ------ | ------ |
| v2     | 74.1%      | 74.5%  | 75.2%  | 80.7%  |
| v3     | 78.2%      | 78.2%  | 78.6%  | 84.0%  |
| Δ      | **+4.1pp** | +3.7pp | +3.4pp | +3.3pp |

The **raw** pass rate moved +4.1pp on the exact same 1000 sentences — meaningful evidence the
`DOMAIN_PROMPT` expansion (a pure Whisper-decode-time intervention, independent of which corrector runs
afterward) is doing real work, not just the correctors picking up more of the same raw transcript.
One oddity: the **base corrector fixed zero additional clips this run** (782 raw → 782 base, exactly
equal, vs. v2's 741→745). Ext and new both still show their expected incremental gains, so the
correctors themselves aren't broken — the base corrector's narrower rule set just didn't happen to
match any of this run's specific mistranscriptions.

## 5. By quantity (ext-corrected, matching v2 §5's comparison basis)

| Quantity          | v2 (ext-corrected) | v3 (ext-corrected) | Δ           |
| ----------------- | ------------------ | ------------------ | ----------- |
| `csdaRange`       | 439/600 (73.2%)    | 450/600 (75.0%)    | +1.8pp      |
| `energyFromRange` | 227/250 (90.8%)    | 234/250 (93.6%)    | +2.8pp      |
| `stoppingPower`   | 86/150 (57.3%)     | 102/150 (68.0%)    | **+10.7pp** |

`stoppingPower` — the category the prompt expansion targeted most directly (LET, linear energy
transfer, keV/µm are all stopping-power vocabulary) — improved the most by a wide margin. §8 breaks
this down further by exact phrasing.

## 6. By scenario type and voice engine

| Scenario                  | v2 (ext)        | v3 (ext)        | Δ       |
| ------------------------- | --------------- | --------------- | ------- |
| material (multi-material) | 44/55 (80.0%)   | 48/55 (87.3%)   | +7.3pp  |
| single-value              | 602/800 (75.3%) | 614/800 (76.8%) | +1.5pp  |
| particle (multi-particle) | 33/45 (73.3%)   | 38/45 (84.4%)   | +11.1pp |
| energy (multi-energy)     | 73/100 (73.0%)  | 86/100 (86.0%)  | +13.0pp |

Same pattern as v1/v2: no "more entities = compounding failure" effect — every multi-entity scenario
still scores at or above the single-value baseline, now by a wider margin than before.

| Engine                             | v2 Base         | v2 Ext          | v2 New          | v3 Base         | v3 Ext          | v3 New              |
| ---------------------------------- | --------------- | --------------- | --------------- | --------------- | --------------- | ------------------- |
| VoiceDesign (free-text `instruct`) | 640/830 (77.1%) | 643/830 (77.5%) | 678/830 (81.7%) | 739/935 (79.0%) | 742/935 (79.4%) | **792/935 (84.7%)** |
| CustomVoice (preset + `instruct`)  | 105/170 (61.8%) | 109/170 (64.1%) | 129/170 (75.9%) | 43/65 (66.2%)   | 44/65 (67.7%)   | 48/65 (73.8%)       |

VoiceDesign improved (+3.0pp new-corrected) as expected from the better prompt. CustomVoice's own rate
moved less and, on the new corrector, is actually **2.1pp lower** than v2 (75.9%→73.8%) despite
shrinking the preset pool — shrinking to 3 presets didn't make the surviving presets easier, and
`custom-aiden-curious`/`custom-ryan-happy` still land in the worst-10 list in every corrector, same
names v2 flagged. The VoiceDesign/CustomVoice gap **widened** (5.8pp → 10.9pp on the new corrector)
rather than narrowing — worth watching if a future run changes the CustomVoice pool again, since n=65
is small enough that this could partly be which 3 presets happened to be kept, not a fundamental
property of CustomVoice itself.

## 7. LET vs. "stopping power" phrasing — re-measuring v2 §7's finding

v2 §7 flagged the bare **"LET" acronym as the one stopping-power phrasing the phonetic pass barely
moved** (50.0%→51.9%) and suggested it was worth a look "before calling issue #28 done." The prompt
expansion (which adds `LET` and `linear energy transfer` as literal biasing tokens) gives a direct way
to check whether fixing this at the ASR-decode level, rather than only post-hoc correction, helps:

| Phrasing (n)                  | v2 Base       | v2 Ext        | v2 New        | v3 Base       | v3 Ext        | v3 New            | Δ (new) |
| ----------------------------- | ------------- | ------------- | ------------- | ------------- | ------------- | ----------------- | ------- |
| "stopping power" (44)         | 29/44 (65.9%) | 30/44 (68.2%) | 36/44 (81.8%) | 33/44 (75.0%) | 33/44 (75.0%) | **39/44 (88.6%)** | +6.8pp  |
| "linear energy transfer" (32) | 19/32 (59.4%) | 20/32 (62.5%) | 25/32 (78.1%) | 26/32 (81.3%) | 26/32 (81.3%) | **28/32 (87.5%)** | +9.4pp  |
| "LET" acronym (52)            | 26/52 (50.0%) | 26/52 (50.0%) | 27/52 (51.9%) | 30/52 (57.7%) | 30/52 (57.7%) | **32/52 (61.5%)** | +9.6pp  |
| dE/dx, indirect (22)          | 9/22 (40.9%)  | 10/22 (45.5%) | 13/22 (59.1%) | 13/22 (59.1%) | 13/22 (59.1%) | **14/22 (63.6%)** | +4.5pp  |

Every phrasing improved, including — notably — the bare **"LET" acronym, +9.6pp**, the exact case v2
found resistant to the phonetic pass alone. This is consistent with the mechanism: biasing the prompt
gets Whisper to transcribe `LET` correctly (or closer to it) in the first place, rather than relying on
a post-hoc edit-distance lookup to repair a transcript that already lost the signal. `LET` is still the
hardest of the four phrasings in absolute terms (61.5% vs. 88.6% for plain "stopping power"), but the
gap narrowed. Reasonable to consider issue #28/#87's "LET acronym" callout addressed by this result,
though the acronym remains the weakest of the four.

## 8. What actually fails

Same dominant failure signature as v1/v2: unit tokens are still the majority of failures. `"MeV"` →
`"MAV"`, `"MIV"`, `"MV"`, `"EmeV"`; `"Kapton"` still occasionally slips even with the expanded prompt
(`"captain"` still appears in a handful of ext-corrector failures); new near-misses like `"1G,V-proton"`
for "1 GeV proton" and `"ADMAV-tritin"` show the failure mode is the same class of plausible-sounding
real-word substitution, just on a smaller failing set (160/1000 after the new corrector, vs. 193/1000
in v2). Nothing here suggests a new failure class — the prompt/voice changes moved the rate, not the
shape, of what still fails.

## 9. Per-unit and clinical-core/long-tail stratification (issue #92 Group A methodology, re-run on v3 data)

**Per-unit accuracy** (raw → new-corrected; same six units v2 §9 tracked):

| Unit       | v2 raw → new    | v3 raw → new      |
| ---------- | --------------- | ----------------- |
| `MeV`      | 81.5% → 90.9%   | 84.2% → **89.4%** |
| `MeV/nucl` | 79.5% → 92.9%   | 80.1% → **93.8%** |
| `keV`      | 100.0% → 100.0% | 98.8% → 98.8%     |
| `GeV`      | 53.3% → 80.0%   | 66.7% → 66.7%     |
| `cm`       | 99.5% → 99.5%   | 100.0% → 100.0%   |
| `mm`       | 98.5% → 98.5%   | 95.5% → 95.5%     |

`MeV`/`MeV/nucl` raw accuracy both improved (the direct prompt effect, since these are exactly the
per-nucleon/energy tokens targeted), and the new corrector still closes most of the remaining gap on
both. `GeV` (n=15, too few to read much into) and `mm` (n=66) moved in the noisy direction this time —
consistent with v2's own read that these small-n unit buckets are sensitive to exactly which few clips
land where, not a systematic regression. `keV/µm` (the LET unit) remains absent from this table for the
same reason as v2: this generator's `stoppingPower` category never builds an `energyFromStp` inverse
query.

**Clinical-core vs. long-tail** (new-corrected):

| Stratum       | v2              | v3                  | Δ          |
| ------------- | --------------- | ------------------- | ---------- |
| clinical-core | 263/302 (87.1%) | 251/302 (**83.1%**) | **−4.0pp** |
| long-tail     | 544/698 (77.9%) | 589/698 (**84.4%**) | **+6.5pp** |

This is the one genuinely surprising number in this run: long-tail improved substantially while
clinical-core _regressed_, even though the aggregate headline number (§4) went up. **Caveat that
applies specifically to this table** (not the rest of this doc): v3 changed _two_ things at once — the
prompt and the voice-assignment scheme (§1) — and voice reassignment means a specific clinical-core
sentence that had an easy voice in v2 could have a harder one in v3 and vice versa, purely from the
hash reshuffle. With n=302/698 this is unlikely to be pure noise, but this run alone can't cleanly
separate "the new prompt handles long-tail vocabulary better" from "the voice reshuffle happened to
land harder voices on more clinical-core clips this time." A future controlled run (same voice
assignment, prompt-only change, or vice versa) would be needed to attribute this cleanly — flagged as
an open question rather than resolved here, in the same spirit as v2's own confound callouts (§5's
scorer-fix caveat, §6's engine-gap note).

The n-split itself is unchanged from v2 (long-tail 698/1000, 69.8% of the batch) — still the accidental
majority v2 §9 flagged, not a deliberate reweighting toward real-world usage.

## 10. Status — issue #92 Group B

Both Group B items (`DOMAIN_PROMPT` expansion, voice-composition fixes) are now code-complete _and_
measured. Net result: **+3.3pp on the new-corrector headline** (80.7%→84.0%), with the clearest wins in
`stoppingPower`/LET-family phrasing (§5, §7) — directly the vocabulary the prompt targeted — and a
genuine open question on the clinical-core/long-tail split (§9) that a future run could resolve with a
controlled ablation. Reasonable to close issue #92 on this basis, noting the stratum confound as a
still-open methodology question if anyone wants to chase it further.

## 11. Files

**Committed in this PR** (matches the existing `eval/results/` convention):

- `eval/results/tts-1000-v3-2026-07-18/small-q8-prompt.json` — raw transcripts, all 1000 clips, zero
  transcription errors.
- `eval/results/tts-1000-v3-2026-07-18/score-{base,ext,new}.json` + matching `.log` — full per-clip
  scoring output for all three correctors, computed locally from the committed transcripts (§3 point 3)
  since Athena's own scoring step didn't complete before its output was copied off the cluster.

**Not committed — stays local**, same convention as v1/v2 (`.gitignore`'s `/eval/audio/`):

- `eval/audio/tts-qwen-1000-v3/*.wav` (1000 clips, 285 MB) + `manifest.json` (ground truth + voice
  profile/engine/timing per clip).
- `scripts/tts-1000-sentences-v3.json` — regenerable from the fixed seed (§3 point 1).
