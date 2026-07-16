# Polish ASR recording plan (issue #79)

Polish-language voice clips for the ASR eval set — the human-recorded track of the Polish
i18n eval work (issue #79). Audio files live in `eval/audio/<speaker-tag>/` (gitignored),
same convention as the English plan in `eval/RECORDING.md`. Record in a quiet room, normal
speaking pace, no post-processing.

50 sentences, written as a Polish physicist actually phrases range / stopping-power queries
(**not** translated from the English set) and weighted to the same real-world usage split as
the 1000-sentence Qwen TTS batch (`docs/tts-eval-1000.md` §2.1): **60% range · 25%
energy-from-range · 15% stopping power**, with ~20% posing "multiple numbers".

Ion coverage is deliberately broader than the English/TTS sets, which were capped at Z ≤ 18
(argon) because MSTAR has no data for heavier ions. The Bethe-Bloch fallback added in PR #81
(`fix(wasm): update libdedx to 22e43a9`) lifts that cap, so this set also exercises
**calcium, titanium, iron, nickel, copper, krypton, xenon** (🆕 below) plus new target
materials (lead, silicon dioxide, calcium-containing plastics). Every sentence's underlying
(particle, material, energy/target, quantity) tuple was verified to resolve and compute a
finite, positive number through the real vendored libdedx WASM — see the ground-truth
appendix; the assumed nuclide for each bare-element ion is listed there.

Two wording conventions from the domain review (issue #79):

- **Ions are named without an isotope number** in ~95% of cases (`jon węgla`, not `jon
węgla-12`) — that is how beams are referred to in practice. The matcher assumes the default
  (most abundant/stable) isotope. Only two sentences keep a number, where it disambiguates:
  `węgiel-12` (#7) and `hel-3` (#14, otherwise `jon helu` = ⁴He = cząstka alfa).
- **`LET`** is used as an everyday synonym for `zdolność hamowania` (stopping power) alongside
  `masowa zdolność hamowania`, `dE/dx`, and `ile energii traci … na centymetr` (#43, #47, #50).

## Format requirements

| Property    | Value                                                       |
| ----------- | ----------------------------------------------------------- |
| Format      | WAV (PCM, 16-bit)                                           |
| Sample rate | 44 100 Hz (or 48 000 Hz)                                    |
| Channels    | Mono or stereo — scripts resample to 16 kHz mono via ffmpeg |
| Path        | `eval/audio/<speaker-tag>/<id>.wav`                         |
| Language    | Polish (pl-PL)                                              |

## Sentences

### Range / zasięg (30)

| #   | ID          | Zdanie                                                                                      |
| --- | ----------- | ------------------------------------------------------------------------------------------- |
| 1   | `pl-rng-01` | Jaki jest zasięg protonu o energii 150 MeV w wodzie?                                        |
| 2   | `pl-rng-02` | Ile wynosi zasięg CSDA protonu o energii 230 MeV w wodzie?                                  |
| 3   | `pl-rng-03` | Jak głęboko wniknie proton o energii 70 MeV w tkankę mięśniową?                             |
| 4   | `pl-rng-04` | Jak daleko doleci cząstka alfa o energii 20 MeV w powietrzu?                                |
| 5   | `pl-rng-05` | Podaj zasięg deuteronu o energii 60 MeV w krzemie.                                          |
| 6   | `pl-rng-06` | Jaki zasięg ma tryton o energii 40 MeV w PMMA?                                              |
| 7   | `pl-rng-07` | Oblicz zasięg jonu węgla-12 o energii 300 MeV na nukleon w wodzie.                          |
| 8   | `pl-rng-08` | Na jaką głębokość wniknie jon tlenu o energii 250 MeV na nukleon w PMMA?                    |
| 9   | `pl-rng-09` | Jaki jest zasięg jonu neonu o energii 400 MeV na nukleon w wodzie?                          |
| 10  | `pl-rng-10` | Ile wynosi zasięg jonu żelaza o energii 600 MeV na nukleon w aluminium?                     |
| 11  | `pl-rng-11` | Jak daleko dotrze jon wapnia o energii 200 MeV na nukleon w tkance tłuszczowej?             |
| 12  | `pl-rng-12` | Podaj zasięg jonu argonu o energii 350 MeV na nukleon w wodzie.                             |
| 13  | `pl-rng-13` | Jaki zasięg ma jon azotu o energii 180 MeV na nukleon w kości korowej?                      |
| 14  | `pl-rng-14` | Jak głęboko wniknie jon helu-3 o energii 30 MeV w grafit?                                   |
| 15  | `pl-rng-15` | Oblicz zasięg jonu litu o energii 50 MeV na nukleon w poliwęglanie.                         |
| 16  | `pl-rng-16` | Jaki jest zasięg jonu boru o energii 100 MeV na nukleon w polietylenie?                     |
| 17  | `pl-rng-17` | Jak daleko doleci jon krzemu o energii 300 MeV na nukleon w dwutlenku krzemu?               |
| 18  | `pl-rng-18` | Ile wynosi zasięg jonu miedzi o energii 500 MeV na nukleon w ołowiu?                        |
| 19  | `pl-rng-19` | Podaj zasięg jonu kryptonu o energii 800 MeV na nukleon w aluminium.                        |
| 20  | `pl-rng-20` | Jaki zasięg ma jon ksenonu o energii 400 MeV na nukleon w wodzie?                           |
| 21  | `pl-rng-21` | Jak głęboko wniknie jon tytanu o energii 600 MeV na nukleon w wodzie?                       |
| 22  | `pl-rng-22` | Powiedz mi, jak daleko zajdzie proton o energii 100 MeV w kości zbitej.                     |
| 23  | `pl-rng-23` | Zasięg cząstki alfa o energii 10 MeV w Kaptonie – ile to wynosi?                            |
| 24  | `pl-rng-24` | Jaki jest zasięg jonu magnezu o energii 150 MeV na nukleon w plastiku tkankopodobnym A-150? |
| 25  | `pl-rng-25` | Jaki jest zasięg protonu w wodzie dla energii 100, 150 i 200 MeV?                           |
| 26  | `pl-rng-26` | Porównaj zasięg jonu węgla w wodzie przy 200, 300 i 400 MeV na nukleon.                     |
| 27  | `pl-rng-27` | Jak zmienia się zasięg cząstki alfa w powietrzu dla 5, 10 i 20 MeV?                         |
| 28  | `pl-rng-28` | Porównaj zasięg protonu o energii 150 MeV w wodzie, PMMA i kości korowej.                   |
| 29  | `pl-rng-29` | Jaki jest zasięg jonu tlenu o energii 300 MeV na nukleon w wodzie i w aluminium?            |
| 30  | `pl-rng-30` | Co wniknie głębiej w wodę przy 200 MeV na nukleon: jon węgla czy jon neonu?                 |

### Energy from range / energia z zasięgu (12)

| #   | ID          | Zdanie                                                                              |
| --- | ----------- | ----------------------------------------------------------------------------------- |
| 31  | `pl-inv-01` | Jaką energię musi mieć proton, żeby jego zasięg w wodzie wynosił 20 cm?             |
| 32  | `pl-inv-02` | Przy jakiej energii proton osiągnie zasięg 15 cm w wodzie?                          |
| 33  | `pl-inv-03` | Jaka energia protonu odpowiada zasięgowi 5 cm w PMMA?                               |
| 34  | `pl-inv-04` | Ile energii potrzebuje jon węgla, aby jego zasięg w wodzie wynosił 10 cm?           |
| 35  | `pl-inv-05` | Jaką energię trzeba nadać cząstce alfa, aby miała zasięg 30 mm w tkance mięśniowej? |
| 36  | `pl-inv-06` | Przy jakiej energii jon żelaza osiągnie zasięg 3 cm w wodzie?                       |
| 37  | `pl-inv-07` | Jaką energię musi mieć jon tlenu, żeby dotrzeć na głębokość 12 cm w wodzie?         |
| 38  | `pl-inv-08` | Ile energii potrzebuje proton na zasięg 8 cm w kości korowej?                       |
| 39  | `pl-inv-09` | Jaką energię musi mieć jon wapnia dla zasięgu 5 cm w PMMA?                          |
| 40  | `pl-inv-10` | Przy jakiej energii deuteron uzyska zasięg 50 mm w aluminium?                       |
| 41  | `pl-inv-11` | Jaką energię musi mieć proton, aby uzyskać zasięg 10 cm w wodzie i w PMMA?          |
| 42  | `pl-inv-12` | Jaką energię potrzebuje proton na zasięg 15 cm w wodzie? A jon węgla?               |

### Stopping power / zdolność hamowania / LET (8)

| #   | ID         | Zdanie                                                                                 |
| --- | ---------- | -------------------------------------------------------------------------------------- |
| 43  | `pl-sp-01` | Jaki jest LET protonu o energii 100 MeV w wodzie?                                      |
| 44  | `pl-sp-02` | Ile wynosi masowa zdolność hamowania jonu węgla o energii 200 MeV na nukleon w wodzie? |
| 45  | `pl-sp-03` | Ile energii traci proton o energii 10 MeV na centymetr drogi w aluminium?              |
| 46  | `pl-sp-04` | Podaj dE/dx dla deuteronu o energii 40 MeV w powietrzu.                                |
| 47  | `pl-sp-05` | Jaki jest LET cząstki alfa o energii 5 MeV w krzemie?                                  |
| 48  | `pl-sp-06` | Jaka jest zdolność hamowania jonu żelaza o energii 500 MeV na nukleon w złocie?        |
| 49  | `pl-sp-07` | Porównaj zdolność hamowania protonu w wodzie przy 50, 100 i 150 MeV.                   |
| 50  | `pl-sp-08` | Porównaj LET jonu węgla o energii 300 MeV na nukleon w wodzie i w PMMA.                |

## Why these 50?

| Coverage area                                             | Sentences          |
| --------------------------------------------------------- | ------------------ |
| Range — therapeutic protons                               | 1, 2, 22           |
| Range — light ions (α, d, t, ³He)                         | 4, 5, 6, 14, 23    |
| Range — hadron-therapy ions (C, O, Ne)                    | 7, 8, 9            |
| Range — heavy ions / space radiation (Fe, Ca, Cu, Kr…) 🆕 | 10, 11, 18–21      |
| Range — implantation / detectors (Si in SiO₂)             | 17                 |
| Range — other Z ≤ 18 ions (N, Li, B, Mg, Ar)              | 12, 13, 15, 16, 24 |
| Range — casual / indirect register                        | 22, 23, 30         |
| Multi-energy comparison                                   | 25, 26, 27, 49     |
| Multi-material comparison                                 | 28, 29, 41, 50     |
| Multi-particle comparison                                 | 30, 42             |
| Energy-from-range (inverse)                               | 31–42              |
| Stopping power — `LET` phrasing                           | 43, 47, 50         |
| Stopping power — `dE/dx` / mass / energy-loss phrasings   | 44, 45, 46, 48     |

## Ground-truth appendix (verified against libdedx)

Physics reference for each sentence, confirmed to compute a finite positive number through the
real `computeIntent` + vendored libdedx WASM (PR #81, commit `22e43a9`). Program is the
auto-selected libdedx model; `Bethe` marks the combinations newly enabled by the PR #81
fallback. Values are for spot-checking plausibility, not scoring targets.

| ID          | Quantity        | Particle (isotope) | Material        | Energy / target      | Program     | Result                         |
| ----------- | --------------- | ------------------ | --------------- | -------------------- | ----------- | ------------------------------ |
| `pl-rng-01` | csdaRange       | proton (¹H)        | water           | 150 MeV              | PSTAR       | 15.78 g/cm²                    |
| `pl-rng-02` | csdaRange       | proton (¹H)        | water           | 230 MeV              | PSTAR       | 32.96 g/cm²                    |
| `pl-rng-03` | csdaRange       | proton (¹H)        | muscle          | 70 MeV               | PSTAR       | 4.127 g/cm²                    |
| `pl-rng-04` | csdaRange       | alpha (⁴He)        | air             | 20 MeV               | ASTAR       | 0.04226 g/cm²                  |
| `pl-rng-05` | csdaRange       | deuteron (²H)      | silicon         | 60 MeV               | PSTAR       | 1.151 g/cm²                    |
| `pl-rng-06` | csdaRange       | triton (³H)        | PMMA            | 40 MeV               | PSTAR       | 0.2109 g/cm²                   |
| `pl-rng-07` | csdaRange       | carbon (¹²C)       | water           | 300 MeV/nucl         | MSTAR       | 17.13 g/cm²                    |
| `pl-rng-08` | csdaRange       | oxygen (¹⁶O)       | PMMA            | 250 MeV/nucl         | MSTAR       | 9.736 g/cm²                    |
| `pl-rng-09` | csdaRange       | neon (²⁰Ne)        | water           | 400 MeV/nucl         | MSTAR       | 16.42 g/cm²                    |
| `pl-rng-10` | csdaRange       | iron (⁵⁶Fe)        | aluminium       | 600 MeV/nucl         | Bethe       | 16.53 g/cm²                    |
| `pl-rng-11` | csdaRange       | calcium (⁴⁰Ca)     | adipose         | 200 MeV/nucl         | Bethe       | 2.540 g/cm²                    |
| `pl-rng-12` | csdaRange       | argon (⁴⁰Ar)       | water           | 350 MeV/nucl         | MSTAR       | 8.187 g/cm²                    |
| `pl-rng-13` | csdaRange       | nitrogen (¹⁴N)     | cortical bone   | 180 MeV/nucl         | MSTAR       | 6.889 g/cm²                    |
| `pl-rng-14` | csdaRange       | helium-3 (³He)     | graphite        | 30 MeV               | ASTAR       | 0.1388 g/cm²                   |
| `pl-rng-15` | csdaRange       | lithium (⁷Li)      | polycarbonate   | 50 MeV/nucl          | MSTAR       | 1.818 g/cm²                    |
| `pl-rng-16` | csdaRange       | boron (¹¹B)        | polyethylene    | 100 MeV/nucl         | MSTAR       | 3.187 g/cm²                    |
| `pl-rng-17` | csdaRange       | silicon (²⁸Si)     | silicon dioxide | 300 MeV/nucl         | MSTAR       | 8.828 g/cm²                    |
| `pl-rng-18` | csdaRange       | copper (⁶³Cu)      | lead            | 500 MeV/nucl         | Bethe       | 17.46 g/cm²                    |
| `pl-rng-19` | csdaRange       | krypton (⁸⁴Kr)     | aluminium       | 800 MeV/nucl         | Bethe       | 19.78 g/cm²                    |
| `pl-rng-20` | csdaRange       | xenon (¹³²Xe)      | water           | 400 MeV/nucl         | Bethe       | 3.818 g/cm²                    |
| `pl-rng-21` | csdaRange       | titanium (⁴⁸Ti)    | water           | 600 MeV/nucl         | Bethe       | 15.37 g/cm²                    |
| `pl-rng-22` | csdaRange       | proton (¹H)        | compact bone    | 100 MeV              | PSTAR       | 8.322 g/cm²                    |
| `pl-rng-23` | csdaRange       | alpha (⁴He)        | Kapton          | 10 MeV               | ASTAR       | 0.01246 g/cm²                  |
| `pl-rng-24` | csdaRange       | magnesium (²⁴Mg)   | A-150 plastic   | 150 MeV/nucl         | MSTAR       | 2.617 g/cm²                    |
| `pl-rng-25` | csdaRange       | proton (¹H)        | water           | 100/150/200 MeV      | PSTAR       | 7.72 / 15.78 / 25.97 g/cm²     |
| `pl-rng-26` | csdaRange       | carbon (¹²C)       | water           | 200/300/400 MeV/nucl | MSTAR       | 8.65 / 17.13 / 27.37 g/cm²     |
| `pl-rng-27` | csdaRange       | alpha (⁴He)        | air             | 5/10/20 MeV          | ASTAR       | 0.0044 / 0.0131 / 0.0423 g/cm² |
| `pl-rng-28` | csdaRange       | proton (¹H)        | water/PMMA/bone | 150 MeV              | PSTAR       | 15.78 / 16.21 / 17.62 g/cm²    |
| `pl-rng-29` | csdaRange       | oxygen (¹⁶O)       | water/aluminium | 300 MeV/nucl         | MSTAR       | 12.85 / 16.38 g/cm²            |
| `pl-rng-30` | csdaRange       | carbon/neon        | water           | 200 MeV/nucl         | MSTAR       | 8.65 / 5.19 g/cm²              |
| `pl-inv-01` | energyFromRange | proton (¹H)        | water           | 20 cm                | PSTAR       | 171.9 MeV                      |
| `pl-inv-02` | energyFromRange | proton (¹H)        | water           | 15 cm                | PSTAR       | 145.7 MeV                      |
| `pl-inv-03` | energyFromRange | proton (¹H)        | PMMA            | 5 cm                 | PSTAR       | 85.12 MeV                      |
| `pl-inv-04` | energyFromRange | carbon (¹²C)       | water           | 10 cm                | MSTAR       | 217.8 MeV/nucl                 |
| `pl-inv-05` | energyFromRange | alpha (⁴He)        | muscle          | 30 mm                | ASTAR       | 59.72 MeV/nucl                 |
| `pl-inv-06` | energyFromRange | iron (⁵⁶Fe)        | water           | 3 cm                 | Bethe       | 241.9 MeV/nucl                 |
| `pl-inv-07` | energyFromRange | oxygen (¹⁶O)       | water           | 12 cm                | MSTAR       | 287.9 MeV/nucl                 |
| `pl-inv-08` | energyFromRange | proton (¹H)        | cortical bone   | 8 cm                 | PSTAR       | 135.7 MeV                      |
| `pl-inv-09` | energyFromRange | calcium (⁴⁰Ca)     | PMMA            | 5 cm                 | Bethe       | 321.9 MeV/nucl                 |
| `pl-inv-10` | energyFromRange | deuteron (²H)      | aluminium       | 50 mm                | PSTAR       | 118.6 MeV                      |
| `pl-inv-11` | energyFromRange | proton (¹H)        | water/PMMA      | 10 cm                | PSTAR       | 115.7 / 125.8 MeV              |
| `pl-inv-12` | energyFromRange | proton/carbon      | water           | 15 cm                | PSTAR/MSTAR | 145.7 / 277.0                  |
| `pl-sp-01`  | stoppingPower   | proton (¹H)        | water           | 100 MeV              | PSTAR       | 7.286 MeV·cm²/g                |
| `pl-sp-02`  | stoppingPower   | carbon (¹²C)       | water           | 200 MeV/nucl         | MSTAR       | 162.0 MeV·cm²/g                |
| `pl-sp-03`  | stoppingPower   | proton (¹H)        | aluminium       | 10 MeV               | PSTAR       | 33.75 MeV·cm²/g                |
| `pl-sp-04`  | stoppingPower   | deuteron (²H)      | air             | 40 MeV               | PSTAR       | 22.93 MeV·cm²/g                |
| `pl-sp-05`  | stoppingPower   | alpha (⁴He)        | silicon         | 5 MeV                | ASTAR       | 617.4 MeV·cm²/g                |
| `pl-sp-06`  | stoppingPower   | iron (⁵⁶Fe)        | gold            | 500 MeV/nucl         | Bethe       | 981.6 MeV·cm²/g                |
| `pl-sp-07`  | stoppingPower   | proton (¹H)        | water           | 50/100/150 MeV       | PSTAR       | 12.44 / 7.29 / 5.44 MeV·cm²/g  |
| `pl-sp-08`  | stoppingPower   | carbon (¹²C)       | water/PMMA      | 300 MeV/nucl         | MSTAR       | 127.0 / 123.6 MeV·cm²/g        |

## Status / next steps

- **This track (human recording):** read each Polish sentence aloud and save it as
  `eval/audio/<speaker-tag>/<id>.wav` (2–3 speakers is already useful — issue #79). Quiet
  room, normal pace, no post-processing.
- **Not yet built:** a Polish intent matcher and a Polish-aware ASR scorer. Until those exist
  the recordings can be transcribed and eyeballed, but not auto-scored against the ground truth
  above the way the English set is (`docs/tts-eval-1000.md` §6). Sequencing follows issue #79:
  recordings + text examples first, large-scale Polish TTS after a matcher exists.
