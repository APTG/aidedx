# Polish 1000-sentence TTS eval-audio batch: Piper vs. experimental Qwen3-TTS (issue #79 Track 3)

_Session report, 2026-07-19. Results write-up for the Athena run this PR's first commit built the
pipeline for — see that commit's message for the generator/matcher design and the three latent bugs
found while wiring up Polish scoring. This doc only covers what the completed run's data shows._

## 1. TL;DR

**Piper (real `pl_PL` voices) is the only viable engine for Polish TTS eval audio. Qwen3-TTS is
confirmed non-functional for Polish** — not merely lower quality, but literally unable to accept
`language="Polish"` at all: all 1000 clips fell back to `Auto` mode with the same rejection error
recorded per clip (§4). Piper reaches 20.8% clip-level accuracy (new corrector) against Qwen's 0.9%,
and even Piper's number is far below English's 84.0% (`docs/tts-eval-1000-v3.md`) — flagged as an open
question for a follow-up, not resolved here (§9).

A real bug was also found in `scripts/tts-qwen-1000-pl.py` while investigating the data (§7) and is
fixed in this PR.

## 2. Generation

| Metric                      | Piper                                  | Qwen3-TTS (Polish, experimental)                                                                |
| --------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Total generation time       | 5829.4 s (1.62 h) for 1000 clips       | 12270.7 s (3.41 h) for 1000 clips                                                               |
| Per-clip average            | 5.83 s                                 | 12.27 s (**2.1× slower**)                                                                       |
| Total audio produced        | 5127.0 s (85.5 min)                    | 6991.8 s (116.5 min)                                                                            |
| Output size                 | 206 MB (1000 WAVs, gitignored)         | 324 MB (1000 WAVs, gitignored)                                                                  |
| Voices/profiles used        | 5 real `pl_PL` voices, ~200 clips each | 23 VoiceDesign profiles (20 fresh + 3 nominal "CustomVoice" presets, see §7)                    |
| Outright synthesis failures | 0/1000                                 | 0/1000 (every clip produced a WAV — the failure is in what language it's actually speaking, §4) |

Both engines ran to completion inside the 12h walltime with no resubmit needed. As with the English v3
run, the job's own scoring step (Step 4/4 of `scripts/submit-pl.sh`) didn't finish before results were
copied off Athena — `piper-score-base.log` came back as an empty file and nothing else from Step 4 was
present. Scoring is a pure, fast, GPU-free Node computation over the already-transcribed JSON + the
gitignored manifests, so nothing needed re-running on Athena; all 6 scoring passes (2 engines × 3
correctors) were computed locally from the committed transcripts, same as `docs/tts-eval-1000-v3.md`
§3 point 3 documents for the English run.

## 3. Cross-check methodology

Before trusting any number below:

1. **Regenerated the 1000-sentence set locally** from the committed fixed-seed generator
   (`scripts/generate-1000-sentences-pl.mjs`) and diffed it (text, quantity, `slotTruth`) against both
   engines' manifests (`eval/audio/tts-{piper,qwen}-1000-pl/manifest.json`, gitignored) —
   **0/1000 mismatches against either**. Confirms both engines synthesized the exact same 1000
   sentences, isolating every difference below to the synthesis engine itself.
2. **Re-ran `scripts/tts-sentence-check.ts --lang pl`** against the regenerated set — **1000/1000
   passed** against the real Polish matcher + libdedx WASM.
3. **Independently ran all three scoring passes** (`scripts/asr-score-slots-generic.mjs`, base/ext/new)
   for both engines against the committed `*-small-q8-prompt.json` transcripts, from a clean checkout
   of this branch.

## 4. Root cause: Qwen3-TTS never actually spoke Polish

Every one of Qwen3-TTS's 1000 Polish clips carries `"langMode": "Auto"` and an identical
`polishModeError` in the manifest:

```
Unsupported languages: ['Polish']. Supported: ['auto', 'chinese', 'english', 'french', 'german',
'italian', 'japanese', 'korean', 'portuguese', 'russian', 'spanish']
```

**1000/1000 — not one clip synthesized with the literal `language="Polish"` this PR's first commit set
out to test.** Every clip fell through to `tts-qwen-1000-pl.py`'s documented fallback: `language="Auto"`,
i.e. the model auto-detecting the input language from the Polish _text_ while producing speech through
whatever internal voice/language model it actually has. This is exactly the risk the PR called out in
advance ("Qwen3-TTS's own documented language support ... does not include Polish — confirmed before
writing this, not assumed") — now empirically total, not partial: this isn't a "Qwen3-TTS Polish is
weaker than English" data point, it's a "Qwen3-TTS has no Polish mode and Auto doesn't rescue it" one.

## 5. Headline results

| Engine                               | Raw              | Base corrector   | Ext corrector    | New corrector (regex + phonetic, issue #28) |
| ------------------------------------ | ---------------- | ---------------- | ---------------- | ------------------------------------------- |
| **Piper** (real `pl_PL` voices)      | 192/1000 (19.2%) | 192/1000 (19.2%) | 204/1000 (20.4%) | **208/1000 (20.8%)**                        |
| **Qwen3-TTS** (Polish, experimental) | 8/1000 (0.8%)    | 8/1000 (0.8%)    | 8/1000 (0.8%)    | **9/1000 (0.9%)**                           |

Piper outperforms Qwen3-TTS by roughly **23×** at the clip level. The correction layers (ext/new) move
Piper +1.6pp over raw — a real but modest gain, nowhere near enough to close the gap to English. They
move Qwen3-TTS essentially nothing (+0.1pp), consistent with §4: there's no partial-credit "almost
right" signal for the correctors to repair when the underlying audio was never reliably Polish speech
to begin with.

## 6. By quantity, scenario, and stratum (new-corrected)

| Quantity          | Piper           | Qwen3-TTS    |
| ----------------- | --------------- | ------------ |
| `csdaRange`       | 138/600 (23.0%) | 4/600 (0.7%) |
| `energyFromRange` | 56/250 (22.4%)  | 2/250 (0.8%) |
| `stoppingPower`   | 14/150 (9.3%)   | 3/150 (2.0%) |

| Scenario                  | Piper           | Qwen3-TTS    |
| ------------------------- | --------------- | ------------ |
| single                    | 174/800 (21.8%) | 8/800 (1.0%) |
| energy (multi-energy)     | 19/100 (19.0%)  | 0/100 (0.0%) |
| material (multi-material) | 7/55 (12.7%)    | 1/55 (1.8%)  |
| particle (multi-particle) | 8/45 (17.8%)    | 0/45 (0.0%)  |

| Stratum       | Piper           | Qwen3-TTS    |
| ------------- | --------------- | ------------ |
| long-tail     | 142/608 (23.4%) | 7/608 (1.2%) |
| clinical-core | 66/392 (16.8%)  | 2/392 (0.5%) |

Same ordering as English (`stoppingPower` hardest, long-tail scoring at or above clinical-core) survives
for Piper, just compressed to much lower absolute numbers. Qwen3-TTS's near-zero rate is too close to
noise to read a shape into at all — `material`/`particle` scenarios landing at literal 0% (45 and 55
clips respectively) is as much a small-n artifact of an already-broken engine as a real pattern.

## 7. By voice/profile — and a bug found while reading this table

| Piper voice (real `pl_PL`) | new-corrected  |
| -------------------------- | -------------- |
| `pl_PL-mls_6892-low`       | 8/201 (4.0%)   |
| `pl_PL-bass-high`          | 11/197 (5.6%)  |
| `pl_PL-mc_speech-medium`   | 33/200 (16.5%) |
| `pl_PL-darkman-medium`     | 72/201 (35.8%) |
| `pl_PL-gosia-medium`       | 84/201 (41.8%) |

Piper's 5 real voices span a genuine **4.0%–41.8%** range — a >10× spread that looks like actual
voice-quality variation (the two -high/-low voices are worst, the -medium voices markedly better),
worth knowing if a future Polish batch wants to drop the worst voices the way the English batch's v2/v3
runs pruned CustomVoice presets.

Qwen3-TTS's 23 profiles, by contrast, are **uniformly near-zero** — every profile in the "worst 10"
prints 0.0%, and the best of all 23 tops out at 5.1% (`pl-female-tired`, 2/39). No profile-quality signal
survives an engine that isn't reliably speaking the target language in the first place (§4).

**While reading this table, `tts-qwen-1000-pl.py`'s 3 nominal `CustomVoice` presets
(`custom-ryan`/`custom-aiden`/`custom-eric`) turned out not to have actually run through
`generate_custom_voice` at all.** `CUSTOM_VOICE_PROFILES` was written as 2-element tuples
`(tag, speaker)`, but `VOICE_DESIGN_PROFILES` entries are also 2-element (`(tag, instruct)`) — so
`synthesize_one`'s `if len(rest) == 1` dispatch check, meant to tell the two profile kinds apart, was
always true for both, and every "custom-\*" clip silently went through `generate_voice_design` with the
bare speaker name (`"Ryan"`, `"Aiden"`, or `"Eric"`) passed as `instruct` — not a real design
description, and not the actual named-speaker embedding `generate_custom_voice` would have used. The
parent script (`tts-qwen-1000.py`) doesn't have this bug: its `CUSTOM_VOICE_PROFILES` are 3-element
`(tag, speaker, instruct)` tuples, correctly giving `rest` length 2 and taking the `else` branch.
**Fixed in this PR** by matching that 3-tuple shape. This doesn't change §4–§6's conclusions — Qwen3-TTS
rejects `language="Polish"` before voice selection even happens, so the bug affected _which_ nominal
profile label 142 clips got, not whether Qwen3-TTS can speak Polish — but it does mean this run's
`custom-*`-labeled rows above are better read as "yet another oddly-prompted VoiceDesign call" than as
real CustomVoice-preset data. Not considered worth a re-run given §4's already-total finding; the fix is
here for whenever this script runs again.

## 8. Failure shape: isolated slips vs. wholesale garble

Beyond the headline rate, _how_ each engine fails is itself informative — computed from each failing
clip's count of missing slot categories (quantity/particle/material/number/unit, max 5):

| Engine    | Failing clips | Avg. missing slots/clip | Single-slot-miss failures |
| --------- | ------------- | ----------------------- | ------------------------- |
| Piper     | 792/1000      | 2.26                    | 270/792 (34%)             |
| Qwen3-TTS | 991/1000      | 3.51                    | 55/991 (6%)               |

A third of Piper's failures are a single wrong slot on an otherwise-correct parse — the familiar
"MeV→MAV"-style near-miss the English runs also show (`docs/tts-eval-1000-v3.md` §8), e.g.
`pl-rng-0013`: `"ile wynosi zasięg, protonu, oranelid, 250 V w wodzie"` (only `unit` missing — "MeV"
came through as "V"). Qwen3-TTS's failures skew hard toward losing **half or more** of the sentence's
content (e.g. `pl-rng-0025`: `"Elvinasi, zasięg, jonu neonu, o energii, jentantime, nukleon, bukans,
mięśniowe"` — quantity keyword, number, and unit all gone, material barely recognizable) — consistent
with §4: an engine not reliably producing Polish speech doesn't fail token-by-token, it fails
wholesale.

## 9. Per-unit accuracy (raw → new-corrected)

| Unit     | Piper         | Qwen3-TTS     |
| -------- | ------------- | ------------- |
| MeV      | 45.0% → 49.8% | 39.9% → 45.0% |
| MeV/nucl | 43.0% → 48.0% | 48.0% → 52.3% |
| keV      | 73.4% → 74.7% | 65.8% → 68.4% |
| GeV      | 26.3% → 26.3% | 42.1% → 42.1% |
| mm       | 44.4% → 44.4% | 61.9% → 61.9% |
| cm       | 58.8% → 58.8% | 79.7% → 79.7% |

Unlike the clip-level numbers, per-unit accuracy alone doesn't cleanly separate the two engines — Qwen
is competitive or ahead on several units (`MeV/nucl`, `GeV`, `mm`, `cm`). Read this alongside §5/§8, not
instead of it: unit tokens are short and can survive by luck even in a clip that garbles everything else
around them, so per-unit accuracy is a noisier, more forgiving measure than the clip-level all-slots
number that actually determines whether a query would resolve correctly end to end.

**Open question, not resolved here:** Piper's Polish clip-level rate (20.8%) is roughly a quarter of
English's whisper-small + DOMAIN_PROMPT + new-corrector rate (84.0%, `docs/tts-eval-1000-v3.md` §4),
using real, non-experimental TTS voices on both sides. Candidate explanations — Whisper's Polish
transcription quality lagging its English quality even with `--lang pl` + a Polish `DOMAIN_PROMPT`;
Piper's Polish voices being lower-fidelity than the English batch's engine; or the Polish matcher/scorer
still having gaps that only show up under real ASR noise despite the generator's 100% self-consistency
check (perfect-transcript-in, perfect-score-out, which by construction can't see ASR-induced errors) —
aren't distinguished by this run's data and would need a dedicated follow-up (e.g. an ASR-only
Polish-vs-English accuracy comparison holding text/voice-quality fixed) to attribute cleanly.

## 10. Status — issue #79 Track 3

**Resolved by this run:** whether Qwen3-TTS is viable for a Polish eval batch. It is not — confirmed
categorically (§4), not just "measured as worse." Piper is the engine to use for any future Polish TTS
eval-audio work; its per-voice spread (§7) is worth pruning the same way English's CustomVoice pool was
pruned in v2/v3 if a future run wants to improve the average.

**Left open:** why Polish (Piper, real voices) still trails English by such a wide margin (§9) — flagged
as a genuine follow-up question, not guessed at here.

## 11. Files

**Committed in this PR** (matches the existing `eval/results/` convention):

- `eval/results/tts-1000-pl-2026-07-19/{piper,qwen}-small-q8-prompt.json` — raw transcripts, all 1000
  clips per engine, zero transcription errors.
- `eval/results/tts-1000-pl-2026-07-19/{piper,qwen}-score-{base,ext,new}.json` + matching `.log` — full
  per-clip scoring output for all three correctors × both engines, computed locally from the committed
  transcripts (§2) since Athena's own scoring step didn't complete before its output was copied off the
  cluster.
- `scripts/tts-qwen-1000-pl.py` — the `CustomVoice` tuple-arity fix (§7).
- `.gitignore` — added the Polish-batch entries (`scripts/tts-1000-sentences-pl.json`,
  `aidedx-tts1000-pl-*.out/.err`) mirroring the existing v1/v2 pattern; missed in the original commit.

**Not committed — stays local**, same convention as the English batches:

- `eval/audio/tts-{piper,qwen}-1000-pl/*.wav` (1000 clips each, 206 MB / 324 MB) + `manifest.json`
  (ground truth + voice profile/engine/timing/`langMode`/`polishModeError` per clip).
- `scripts/tts-1000-sentences-pl.json` — regenerable from the fixed seed (§3 point 1).
