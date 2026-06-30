# ASR recording plan — Spike 1 (issue #7)

Voice clips for the ASR eval set. Audio files live in `eval/audio/<speaker>/` (gitignored).
Record in a quiet room, normal speaking pace, no post-processing.

Use `scripts/record-session.sh <speaker-tag>` to capture a full session; it writes each
clip to `eval/audio/<speaker-tag>/<id>.wav` automatically.

## Format requirements

| Property    | Value                                                       |
| ----------- | ----------------------------------------------------------- |
| Format      | WAV (PCM, 16-bit)                                           |
| Sample rate | 44 100 Hz (or 48 000 Hz)                                    |
| Channels    | Mono or stereo — scripts resample to 16 kHz mono via ffmpeg |
| Path        | `eval/audio/<speaker-tag>/<id>.wav`                         |

## Sentences

30 sentences chosen to stress-test Whisper on domain jargon: keV/MeV/GeV units,
per-nucleon notation, domain abbreviations (dE/dx, CSDA, PMMA), material aliases,
isotope names, compound/comparison queries, and conversational filler.

| #   | ID             | Sentence                                                                      |
| --- | -------------- | ----------------------------------------------------------------------------- |
| 1   | `stress-001`   | I am curious how far in water the 240 keV carbon ion will go                  |
| 2   | `stress-002`   | compare stopping power of neon ions in water and air for 100 MeV/nucl         |
| 3   | `sp-003`       | What's the dE/dx of 250 MeV protons in PMMA?                                  |
| 4   | `sp-005`       | Stopping power for 80 MeV per nucleon carbon ions in water.                   |
| 5   | `sp-007`       | What is the mass stopping power of 200 MeV protons in cortical bone?          |
| 6   | `sp-008`       | dE/dx of 3 MeV deuterons in silicon.                                          |
| 7   | `rng-002`      | What is the CSDA range of a 150 MeV proton in water?                          |
| 8   | `rng-005`      | Range of 90 MeV per nucleon carbon ions in water.                             |
| 9   | `rng-008`      | How deep does a 100 MeV proton penetrate in water?                            |
| 10  | `ind-001`      | How far will a 60 MeV proton travel in water?                                 |
| 11  | `ind-003`      | At what rate does a 30 MeV proton shed energy as it moves through aluminum?   |
| 12  | `ind-008`      | What penetration depth do 80 MeV per nucleon oxygen ions reach in water?      |
| 13  | `conv-003`     | Um, so like, how far does a 100 MeV proton go in water, roughly?              |
| 14  | `conv-008`     | Okay so I need the range of 230 MeV protons in water for a plan.              |
| 15  | `cmp-mat-001`  | Compare the stopping power of 100 MeV protons in water and bone.              |
| 16  | `cmp-mat-004`  | Range of 150 MeV protons in water, bone, and adipose tissue.                  |
| 17  | `cmp-mat-007`  | For 100 MeV per nucleon carbon ions, compare the range in water and PMMA.     |
| 18  | `cmp-par-003`  | How do carbon and neon ions compare in range in water at 100 MeV per nucleon? |
| 19  | `cmp-par-005`  | Which penetrates deeper in water at 60 MeV, a proton or a deuteron?           |
| 20  | `cmp-en-001`   | Compare the range of protons in water at 100 and 200 MeV.                     |
| 21  | `cmp-prog-001` | Compare the range of 150 MeV protons in water using ASTAR and PSTAR.          |
| 22  | `unit-001`     | Stopping power of 500 keV protons in water.                                   |
| 23  | `unit-003`     | What is the stopping power of 1 GeV protons in water?                         |
| 24  | `unit-006`     | What is the range of 900 keV deuterons in water?                              |
| 25  | `pernuc-001`   | Range of carbon ions in water at 290 MeV/u.                                   |
| 26  | `pernuc-003`   | What is the range of a carbon ion with 3.6 GeV total energy in water?         |
| 27  | `iso-002`      | Stopping power of carbon-13 ions in water at 100 MeV per nucleon.             |
| 28  | `iso-004`      | Stopping power of a helium-3 ion in water at 40 MeV per nucleon.              |
| 29  | `inv-rng-001`  | What energy gives a 10 cm range in water for protons?                         |
| 30  | `alias-001`    | What is the range of 60 MeV protons in Lucite?                                |

## Why these 30?

| Coverage area                       | Sentences |
| ----------------------------------- | --------- |
| Stress-test (§7 worked examples)    | 1–2       |
| Direct stopping-power queries       | 3–6       |
| Direct range queries                | 7–9       |
| Indirect / paraphrased phrasing     | 10–12     |
| Conversational filler               | 13–14     |
| Multi-material comparison           | 15–17     |
| Multi-particle comparison           | 18–19     |
| Multi-energy comparison             | 20        |
| Program comparison (ASTAR/PSTAR)    | 21        |
| Tricky units (keV, GeV, MeV/u)      | 22–26     |
| Isotope names (carbon-13, helium-3) | 27–28     |
| Inverse query                       | 29        |
| Material alias (Lucite)             | 30        |

## Recording a session

```sh
bash scripts/record-session.sh <speaker-tag>
# e.g. bash scripts/record-session.sh alice
# writes to eval/audio/alice/<id>.wav
```

## Running Whisper on a single clip

```sh
node scripts/test-asr.mjs eval/audio/<speaker>/<id>.wav whisper-small q8
```

## Running the full benchmark (all speakers)

```sh
node scripts/asr-batch.mjs                              # whisper-small, all speakers
node scripts/asr-batch.mjs onnx-community/whisper-small q8 --speaker alice
```
