# ASR recording plan — Spike 1 (issue #7)

Voice clips for the ASR eval set.  Audio files live in `eval/audio/` (gitignored).
Record in a quiet room, normal speaking pace, no post-processing.

## Format requirements

| Property   | Value                        |
| ---------- | ---------------------------- |
| Format     | WAV (PCM, 16-bit)            |
| Sample rate | 44 100 Hz (or 48 000 Hz)   |
| Channels   | Mono or stereo — `test-asr.mjs` resamples to 16 kHz mono via ffmpeg |
| Filename   | `eval/audio/<id>.wav`        |

## Sentences

30 sentences chosen to stress-test Whisper on domain jargon: keV/MeV/GeV units,
per-nucleon notation, domain abbreviations (dE/dx, CSDA, PMMA), material aliases,
isotope names, compound/comparison queries, and conversational filler.

| # | ID | Filename | Status | Sentence |
|---|---|---|---|---|
| 1 | `stress-001` | `eval/audio/stress-001.wav` | ✅ done | I am curious how far in water the 240 keV carbon ion will go |
| 2 | `stress-002` | `eval/audio/stress-002.wav` | ⬜ todo | compare stopping power of neon ions in water and air for 100 MeV/nucl |
| 3 | `sp-003` | `eval/audio/sp-003.wav` | ⬜ todo | What's the dE/dx of 250 MeV protons in PMMA? |
| 4 | `sp-005` | `eval/audio/sp-005.wav` | ⬜ todo | Stopping power for 80 MeV per nucleon carbon ions in water. |
| 5 | `sp-007` | `eval/audio/sp-007.wav` | ⬜ todo | What is the mass stopping power of 200 MeV protons in cortical bone? |
| 6 | `sp-008` | `eval/audio/sp-008.wav` | ⬜ todo | dE/dx of 3 MeV deuterons in silicon. |
| 7 | `rng-002` | `eval/audio/rng-002.wav` | ⬜ todo | What is the CSDA range of a 150 MeV proton in water? |
| 8 | `rng-005` | `eval/audio/rng-005.wav` | ⬜ todo | Range of 90 MeV per nucleon carbon ions in water. |
| 9 | `rng-008` | `eval/audio/rng-008.wav` | ⬜ todo | How deep does a 100 MeV proton penetrate in water? |
| 10 | `ind-001` | `eval/audio/ind-001.wav` | ⬜ todo | How far will a 60 MeV proton travel in water? |
| 11 | `ind-003` | `eval/audio/ind-003.wav` | ⬜ todo | At what rate does a 30 MeV proton shed energy as it moves through aluminum? |
| 12 | `ind-008` | `eval/audio/ind-008.wav` | ⬜ todo | What penetration depth do 80 MeV per nucleon oxygen ions reach in water? |
| 13 | `conv-003` | `eval/audio/conv-003.wav` | ⬜ todo | Um, so like, how far does a 100 MeV proton go in water, roughly? |
| 14 | `conv-008` | `eval/audio/conv-008.wav` | ⬜ todo | Okay so I need the range of 230 MeV protons in water for a plan. |
| 15 | `cmp-mat-001` | `eval/audio/cmp-mat-001.wav` | ⬜ todo | Compare the stopping power of 100 MeV protons in water and bone. |
| 16 | `cmp-mat-004` | `eval/audio/cmp-mat-004.wav` | ⬜ todo | Range of 150 MeV protons in water, bone, and adipose tissue. |
| 17 | `cmp-mat-007` | `eval/audio/cmp-mat-007.wav` | ⬜ todo | For 100 MeV per nucleon carbon ions, compare the range in water and PMMA. |
| 18 | `cmp-par-003` | `eval/audio/cmp-par-003.wav` | ⬜ todo | How do carbon and neon ions compare in range in water at 100 MeV per nucleon? |
| 19 | `cmp-par-005` | `eval/audio/cmp-par-005.wav` | ⬜ todo | Which penetrates deeper in water at 60 MeV, a proton or a deuteron? |
| 20 | `cmp-en-001` | `eval/audio/cmp-en-001.wav` | ⬜ todo | Compare the range of protons in water at 100 and 200 MeV. |
| 21 | `cmp-prog-001` | `eval/audio/cmp-prog-001.wav` | ⬜ todo | Compare the range of 150 MeV protons in water using ASTAR and PSTAR. |
| 22 | `unit-001` | `eval/audio/unit-001.wav` | ⬜ todo | Stopping power of 500 keV protons in water. |
| 23 | `unit-003` | `eval/audio/unit-003.wav` | ⬜ todo | What is the stopping power of 1 GeV protons in water? |
| 24 | `unit-006` | `eval/audio/unit-006.wav` | ⬜ todo | What is the range of 900 keV deuterons in water? |
| 25 | `pernuc-001` | `eval/audio/pernuc-001.wav` | ⬜ todo | Range of carbon ions in water at 290 MeV/u. |
| 26 | `pernuc-003` | `eval/audio/pernuc-003.wav` | ⬜ todo | What is the range of a carbon ion with 3.6 GeV total energy in water? |
| 27 | `iso-002` | `eval/audio/iso-002.wav` | ⬜ todo | Stopping power of carbon-13 ions in water at 100 MeV per nucleon. |
| 28 | `iso-004` | `eval/audio/iso-004.wav` | ⬜ todo | Stopping power of a helium-3 ion in water at 40 MeV per nucleon. |
| 29 | `inv-rng-001` | `eval/audio/inv-rng-001.wav` | ⬜ todo | What energy gives a 10 cm range in water for protons? |
| 30 | `alias-001` | `eval/audio/alias-001.wav` | ⬜ todo | What is the range of 60 MeV protons in Lucite? |

## Why these 30?

| Coverage area | Sentences |
|---|---|
| Stress-test (§7 worked examples) | 1–2 |
| Direct stopping-power queries | 3–6 |
| Direct range queries | 7–9 |
| Indirect / paraphrased phrasing | 10–12 |
| Conversational filler | 13–14 |
| Multi-material comparison | 15–17 |
| Multi-particle comparison | 18–19 |
| Multi-energy comparison | 20 |
| Program comparison (ASTAR/PSTAR) | 21 |
| Tricky units (keV, GeV, MeV/u) | 22–26 |
| Isotope names (carbon-13, helium-3) | 27–28 |
| Inverse query | 29 |
| Material alias (Lucite) | 30 |

## Running Whisper on a recording

```sh
node scripts/test-asr.mjs eval/audio/<id>.wav whisper-small q8
```

## Updating status

Once a file is recorded, change its Status cell from `⬜ todo` to `✅ done`.
After all 30 are recorded, run the full benchmark:

```sh
for id in stress-001 stress-002 sp-003 sp-005 sp-007 sp-008 \
           rng-002 rng-005 rng-008 ind-001 ind-003 ind-008 \
           conv-003 conv-008 cmp-mat-001 cmp-mat-004 cmp-mat-007 \
           cmp-par-003 cmp-par-005 cmp-en-001 cmp-prog-001 \
           unit-001 unit-003 unit-006 pernuc-001 pernuc-003 \
           iso-002 iso-004 inv-rng-001 alias-001; do
  echo "=== $id ==="
  node scripts/test-asr.mjs "eval/audio/$id.wav" whisper-small q8
done
```
