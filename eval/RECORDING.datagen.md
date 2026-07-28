# Benchmark data-generator prompt set (issue #130, Part 1)

50 physics tuples, each rendered as a bilingual (EN+PL) pair, machine-readable in
`eval/datagen-sentences.json` and reproduced human-readably below — the source data and
format for the Android benchmark-data-generator app (issue #130 Parts 2–4): it shows the
`display` text, records the reader saying it, transcribes with both NeMo Parakeet-v3 and
Whisper, and saves the WAV + transcripts for later scoring.

Every record has two text variants per language:

- **`canonical`** — the abbreviated form ("150 MeV", "10 cm"). The reference transcript for
  WER, the input validated against the real matcher (`matchIntent`) + vendored libdedx WASM
  (`computeIntent`) below, and the source of `slotTruth`.
- **`display`** — what the phone shows the reader. Differs from `canonical` only in unit
  renderings (never in the digits, the particle, the material, or the sentence structure):
  - **Length units** (`cm`/`mm`) are **always** spelled out — "10 centimeters" /
    "10 centymetrów" — the same convention `docs/unit-pronunciation-asr.md` already
    documented humans reading these aloud.
  - **Energy units** (`keV`/`MeV`/`GeV`) are spelled out in exactly **5 of the 50** records
    (`energyRendering: "expanded"`) and left as the abbreviation in the other **45**
    (`"abbrev"`). Polish and English speakers read `MeV`/`keV`/`GeV` as compact acronyms
    ("mef"/"kef"/"Gef" in Polish) rather than letter-by-letter, so no pronunciation hint is
    needed — or wanted — for the abbreviated majority: `docs/unit-pronunciation-asr.md` §5.1
    measured TTS engines rendering `keV`/`GeV` as a compact acronym, shorter than even a
    letter-spelled reading, and `docs/nemo-parakeet-comparison.md` §4.3 measured that biasing
    _toward_ a letter-spelled form (`M E V`) actively hurt unit-slot accuracy (90.2% →
    66.3%). No letter-spelled form appears anywhere in this set.
  - **`LET`** (7 of the 8 `stoppingPower` records — see Composition) is read differently per
    language and rendered accordingly: English spells the acronym letter-by-letter
    ("el-ee-tee") in `display`; Polish borrows "LET" as a one-syllable word (rhymes with the
    English word "let") and reads it unchanged, so the Polish `display` is untouched.
    `canonical` keeps the literal string `LET` in both languages either way — it's what the
    matcher's `\blet\b` slot keyword and `checkCandidate()` validation actually match against.
  - **`CSDA`** (3 of the 30 `csdaRange` records, `RANGE_SINGLE_CSDA` below — see Composition)
    is likewise read letter-by-letter, so EN `display` spells it "see-ess-dee-ay". Said in
    **both languages whenever it's said at all** — `dg-01`/`dg-13`/`dg-20`'s PL canonical
    reads "zasięg CSDA", matching `eval/RECORDING.pl.md`'s own "Ile wynosi zasięg CSDA
    protonu..." (pl-rng-02) precedent, not an English-only qualifier the way an earlier draft
    of this set had it. The Polish letter-name reading is roughly "ce-es-de-a" (Polish letter
    names), noted here for completeness though no PL `display` rule was added for it — the
    3 sentences that say "CSDA" say it identically in `canonical` and `display` in Polish
    (no ambiguity resolved by respelling; only English's `display` needed the transform).
  - **`PMMA`** gets **no** rendering rule, deliberately, unlike `LET`/`CSDA` above: it is
    already read letter-by-letter in both languages with no plausible alternative reading
    ("pee-em-em-ay" in English, "pe-em-em-a" in Polish) — the same "already unambiguous, no
    hint needed or wanted" category as the abbreviated `MeV`/`keV`/`GeV` majority, not the
    "genuinely two-way ambiguous" category `LET` was in.

The 45/5 energy-rendering split is one deliberately controlled variable in this set — see
"What this set can and cannot measure" below.

## Composition

Weighted like `eval/RECORDING.pl.md` and the 1000-sentence TTS batches: **60% range · 25%
energy-from-range · 15% stopping power** (30/12/8 of 50), with single- and multi-value
(multi-energy / multi-material / multi-particle) variants in each category. Within the 8
`stoppingPower` sentences, **7 use `LET` phrasing and 1 uses literal "stopping power"** (the
closest integer split to a requested 90/10 — `LET` is the term real users actually say far
more often, same finding `eval/RECORDING.pl.md`'s own domain review and issue #86 already
made for Polish, now applied on the English side too).

Within the 30 `csdaRange` sentences, the same 90/10 shape applies to the qualifier "CSDA":
**3 use `RANGE_SINGLE_CSDA` ("What is the CSDA range...") and 27 just say "range"/"zasięg"**
with no qualifier at all — most real questions omit it — and, unlike an earlier draft of this
set, the 3 that do say it, say it in **both** languages (`dg-01`/`13`/`20`'s Polish canonical
reads "zasięg CSDA", not plain "zasięg"), never English-only.

Particle and material word forms are drawn from the already-vetted pools in
`scripts/generate-1000-sentences.mjs` (English) and `scripts/generate-1000-sentences-pl.mjs` /
`eval/RECORDING.pl.md` (Polish) — not invented — extended by exactly two English particle
names (`titanium`, `copper`) following that pool's own element-name pattern, confirmed
resolvable via the shared element alias table (`src/lib/aliases/elements.ts`, Z=22/29).

**Isotope numbers are stated only where they disambiguate, in both languages consistently** —
the same "jon węgla, not jon węgla-12" convention `eval/RECORDING.pl.md`'s own doc comment
established for Polish (ions named by bare element, matcher assumes the default/most-abundant
isotope), now applied to English too instead of English always stating a mass number the way
`scripts/generate-1000-sentences.mjs`'s own pool does (a fine convenience for that generator's
scoring, not a natural-speech convention). Two exceptions, present in **both** languages
identically: **helium-3** ("helium-3 ion" / "jon helu-3") disambiguates from the default
alpha particle/⁴He, and **carbon-14** ("carbon-14 ion" / "jon węgla-14", `dg-34` only)
disambiguates from the default, far-more-common carbon-12 — a genuinely uncommon isotope,
not the most abundant one, matching how a number is actually used in practice. Every other
heavy-ion mention (`dg-11`/`24`/`29`/`42`/`44`/`50`'s carbon included) is bare — "carbon ion" /
"jon węgla" — with no number in either language.

### Range / csdaRange (30)

| id      | energy unit | EN canonical                                                                                                    | PL canonical                                                                                                  |
| ------- | ----------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `dg-01` | abbrev      | What is the CSDA range of a 150 MeV proton in water?                                                            | Jaki jest zasięg CSDA protonu o energii 150 MeV w wodzie?                                                     |
| `dg-02` | abbrev      | What is the range of a 100 MeV proton in cortical bone?                                                         | Jaki jest zasięg protonu o energii 100 MeV w kości korowej?                                                   |
| `dg-03` | abbrev      | How far will a 250 MeV proton travel through PMMA?                                                              | Jak daleko doleci proton o energii 250 MeV w PMMA?                                                            |
| `dg-04` | expanded    | What is the range of a 500 keV proton in water?                                                                 | Jaki jest zasięg protonu o energii 500 keV w wodzie?                                                          |
| `dg-05` | abbrev      | What is the range of a 60 MeV deuteron in silicon?                                                              | Jaki jest zasięg deuteronu o energii 60 MeV w krzemie?                                                        |
| `dg-06` | abbrev      | How deep does a 40 MeV triton penetrate into PMMA?                                                              | Jak głęboko wniknie tryton o energii 40 MeV w PMMA?                                                           |
| `dg-07` | abbrev      | How far will a 20 MeV alpha particle travel through air?                                                        | Jak daleko doleci cząstka alfa o energii 20 MeV w powietrzu?                                                  |
| `dg-08` | abbrev      | How deep does a 30 MeV helium-3 ion penetrate into graphite?                                                    | Jak głęboko wniknie jon helu-3 o energii 30 MeV w graficie?                                                   |
| `dg-09` | abbrev      | What is the range of a 50 MeV per nucleon lithium ion in polycarbonate?                                         | Jaki jest zasięg jonu litu o energii 50 MeV na nukleon w poliwęglanie?                                        |
| `dg-10` | abbrev      | What is the range of a 100 MeV per nucleon boron ion in polyethylene?                                           | Jaki jest zasięg jonu boru o energii 100 MeV na nukleon w polietylenie?                                       |
| `dg-11` | expanded    | What is the range of a 300 MeV per nucleon carbon ion in water?                                                 | Jaki jest zasięg jonu węgla o energii 300 MeV na nukleon w wodzie?                                            |
| `dg-12` | abbrev      | How far will a 180 MeV per nucleon nitrogen ion travel through cortical bone?                                   | Jak daleko doleci jon azotu o energii 180 MeV na nukleon w kości korowej?                                     |
| `dg-13` | abbrev      | What is the CSDA range of a 250 MeV per nucleon oxygen ion in PMMA?                                             | Jaki jest zasięg CSDA jonu tlenu o energii 250 MeV na nukleon w PMMA?                                         |
| `dg-14` | abbrev      | How deep does a 400 MeV per nucleon neon ion penetrate into water?                                              | Jak głęboko wniknie jon neonu o energii 400 MeV na nukleon w wodzie?                                          |
| `dg-15` | abbrev      | What is the range of a 150 MeV per nucleon magnesium ion in A-150 tissue-equivalent plastic?                    | Jaki jest zasięg jonu magnezu o energii 150 MeV na nukleon w plastiku tkankopodobnym A-150?                   |
| `dg-16` | abbrev      | What is the range of a 300 MeV per nucleon silicon ion in silicon dioxide?                                      | Jaki jest zasięg jonu krzemu o energii 300 MeV na nukleon w dwutlenku krzemu?                                 |
| `dg-17` | abbrev      | How far will a 350 MeV per nucleon argon ion travel through water?                                              | Jak daleko doleci jon argonu o energii 350 MeV na nukleon w wodzie?                                           |
| `dg-18` | abbrev      | What is the range of a 200 MeV per nucleon calcium ion in adipose tissue?                                       | Jaki jest zasięg jonu wapnia o energii 200 MeV na nukleon w tkance tłuszczowej?                               |
| `dg-19` | abbrev      | How deep does a 600 MeV per nucleon titanium ion penetrate into water?                                          | Jak głęboko wniknie jon tytanu o energii 600 MeV na nukleon w wodzie?                                         |
| `dg-20` | abbrev      | What is the CSDA range of a 600 MeV per nucleon iron ion in aluminum?                                           | Jaki jest zasięg CSDA jonu żelaza o energii 600 MeV na nukleon w aluminium?                                   |
| `dg-21` | abbrev      | What is the range of a 500 MeV per nucleon copper ion in lead?                                                  | Jaki jest zasięg jonu miedzi o energii 500 MeV na nukleon w ołowiu?                                           |
| `dg-22` | expanded    | How far will a 1 GeV proton travel through water?                                                               | Jak daleko doleci proton o energii 1 GeV w wodzie?                                                            |
| `dg-23` | abbrev      | What is the range of protons in water at 100 MeV, 150 MeV, and 200 MeV?                                         | Jaki jest zasięg protonu w wodzie dla energii 100 MeV, 150 MeV i 200 MeV?                                     |
| `dg-24` | abbrev      | What is the range of carbon ions in water at 200 MeV per nucleon, 300 MeV per nucleon, and 400 MeV per nucleon? | Jaki jest zasięg jonu węgla w wodzie dla energii 200 MeV na nukleon, 300 MeV na nukleon i 400 MeV na nukleon? |
| `dg-25` | abbrev      | What is the range of alpha particles in air at 5 MeV, 10 MeV, and 20 MeV?                                       | Jaki jest zasięg cząstki alfa w powietrzu dla energii 5 MeV, 10 MeV i 20 MeV?                                 |
| `dg-26` | abbrev      | Compare the range of a 150 MeV proton in water, PMMA, and cortical bone.                                        | Porównaj zasięg protonu o energii 150 MeV w wodzie, PMMA i kości korowej.                                     |
| `dg-27` | abbrev      | Compare the range of a 300 MeV per nucleon oxygen ion in water and aluminum.                                    | Porównaj zasięg jonu tlenu o energii 300 MeV na nukleon w wodzie i aluminium.                                 |
| `dg-28` | abbrev      | Compare the range of a 100 MeV proton in water and adipose tissue.                                              | Porównaj zasięg protonu o energii 100 MeV w wodzie i tkance tłuszczowej.                                      |
| `dg-29` | abbrev      | Compare the range of a carbon ion and a neon ion in water, both at 200 MeV per nucleon.                         | Co wniknie głębiej w wodzie przy 200 MeV na nukleon: jon węgla czy jon neonu?                                 |
| `dg-30` | abbrev      | Compare the range of a proton and a deuteron in water, both at 60 MeV.                                          | Co wniknie głębiej w wodzie przy 60 MeV: proton czy deuteron?                                                 |

### Energy from range / energyFromRange (inverse) (12)

| id      | energy unit | EN canonical                                                                               | PL canonical                                                                                          |
| ------- | ----------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `dg-31` | abbrev      | What energy gives a 20 cm range in water for protons?                                      | Jaką energię musi mieć proton, żeby jego zasięg w wodzie wynosił 20 cm?                               |
| `dg-32` | abbrev      | How energetic must a proton be for a 15 cm range in water?                                 | Ile energii potrzebuje proton na zasięg 15 cm w wodzie?                                               |
| `dg-33` | abbrev      | What energy gives a 5 cm range in PMMA for protons?                                        | Jaką energię musi mieć proton, żeby jego zasięg w PMMA wynosił 5 cm?                                  |
| `dg-34` | abbrev      | How energetic must a carbon-14 ion be for a 10 cm range in water?                          | Ile energii potrzebuje jon węgla-14 na zasięg 10 cm w wodzie?                                         |
| `dg-35` | abbrev      | What energy gives a 30 mm range in muscle tissue for alpha particles?                      | Jaką energię musi mieć cząstka alfa, żeby jej zasięg w tkance mięśniowej wynosił 30 mm?               |
| `dg-36` | abbrev      | How energetic must an iron ion be for a 3 cm range in water?                               | Ile energii potrzebuje jon żelaza na zasięg 3 cm w wodzie?                                            |
| `dg-37` | abbrev      | What energy gives a 12 cm range in water for oxygen ions?                                  | Jaką energię musi mieć jon tlenu, żeby jego zasięg w wodzie wynosił 12 cm?                            |
| `dg-38` | abbrev      | How energetic must a proton be for a 9 cm range in cortical bone?                          | Ile energii potrzebuje proton na zasięg 9 cm w kości korowej?                                         |
| `dg-39` | abbrev      | What energy gives a 5 cm range in PMMA for calcium ions?                                   | Jaką energię musi mieć jon wapnia, żeby jego zasięg w PMMA wynosił 5 cm?                              |
| `dg-40` | abbrev      | What energy do protons need for a 10 cm range in water and PMMA?                           | Jaką energię musi mieć proton, aby uzyskać zasięg 10 cm w wodzie i PMMA?                              |
| `dg-41` | abbrev      | What energy do protons need for a 15 cm range in water, cortical bone, and adipose tissue? | Jaką energię musi mieć proton, aby uzyskać zasięg 15 cm w wodzie, kości korowej i tkance tłuszczowej? |
| `dg-42` | abbrev      | What energy do protons need for a 15 cm range in water? What about carbon ions?            | Jaką energię potrzebuje proton na zasięg 15 cm w wodzie? A jon węgla?                                 |

### Stopping power / stoppingPower (8)

| id      | energy unit | EN canonical                                                             | PL canonical                                                                   |
| ------- | ----------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `dg-43` | expanded    | What is the LET of a 100 MeV proton in water?                            | Jaki jest LET protonu o energii 100 MeV w wodzie?                              |
| `dg-44` | expanded    | What is the stopping power of a 200 MeV per nucleon carbon ion in water? | Jaka jest zdolność hamowania jonu węgla o energii 200 MeV na nukleon w wodzie? |
| `dg-45` | abbrev      | What is the LET of a 10 MeV proton in aluminum?                          | Jaki jest LET protonu o energii 10 MeV w aluminium?                            |
| `dg-46` | abbrev      | What is the LET of a 40 MeV deuteron in air?                             | Jaki jest LET deuteronu o energii 40 MeV w powietrzu?                          |
| `dg-47` | abbrev      | What is the LET of a 5 MeV alpha particle in silicon?                    | Jaki jest LET cząstki alfa o energii 5 MeV w krzemie?                          |
| `dg-48` | abbrev      | Compare the LET of a 150 MeV proton in water, PMMA, and cortical bone.   | Porównaj LET protonu o energii 150 MeV w wodzie, PMMA i kości korowej.         |
| `dg-49` | abbrev      | What is the LET of protons in water at 50 MeV, 100 MeV, and 150 MeV?     | Porównaj LET protonu w wodzie przy 50 MeV, 100 MeV i 150 MeV.                  |
| `dg-50` | abbrev      | Compare the LET of a proton and a carbon ion in water, both at 100 MeV.  | Porównaj LET protonu i jonu węgla w wodzie przy 100 MeV.                       |

## Display rendering — the 5 expanded-energy sentences

Every other sentence (45/50) leaves the energy unit as the abbreviation in `display` too —
only these 5 spell the energy unit out. Length units (`cm`/`mm`) are spelled out in `display`
for every sentence that has one (only the `energyFromRange` group), regardless of this flag.

| id      | EN display                                                                            | PL display                                                                                     |
| ------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `dg-04` | What is the range of a 500 kiloelectronvolt proton in water?                          | Jaki jest zasięg protonu o energii 500 kiloelektronowoltów w wodzie?                           |
| `dg-11` | What is the range of a 300 megaelectronvolt per nucleon carbon ion in water?          | Jaki jest zasięg jonu węgla o energii 300 megaelektronowoltów na nukleon w wodzie?             |
| `dg-22` | How far will a 1 gigaelectronvolt proton travel through water?                        | Jak daleko doleci proton o energii 1 gigaelektronowolt w wodzie?                               |
| `dg-43` | What is the el-ee-tee of a 100 megaelectronvolt proton in water?                      | Jaki jest LET protonu o energii 100 megaelektronowoltów w wodzie?                              |
| `dg-44` | What is the stopping power of a 200 megaelectronvolt per nucleon carbon ion in water? | Jaka jest zdolność hamowania jonu węgla o energii 200 megaelektronowoltów na nukleon w wodzie? |

Example length-unit spelling (from the `energyFromRange` group, applies to all 12):

| id      | EN display                                                                    | PL display                                                                                      |
| ------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `dg-31` | What energy gives a 20 centimeter range in water for protons?                 | Jaką energię musi mieć proton, żeby jego zasięg w wodzie wynosił 20 centymetrów?                |
| `dg-35` | What energy gives a 30 millimeter range in muscle tissue for alpha particles? | Jaką energię musi mieć cząstka alfa, żeby jej zasięg w tkance mięśniowej wynosił 30 milimetrów? |
| `dg-36` | How energetic must an iron ion be for a 3 centimeter range in water?          | Ile energii potrzebuje jon żelaza na zasięg 3 centymetry w wodzie?                              |

Example LET pronunciation (EN spells the acronym letter-by-letter, PL reads it unchanged):

| id      | EN display                                                                 | PL display                                                    |
| ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `dg-45` | What is the el-ee-tee of a 10 MeV proton in aluminum?                      | Jaki jest LET protonu o energii 10 MeV w aluminium?           |
| `dg-49` | What is the el-ee-tee of protons in water at 50 MeV, 100 MeV, and 150 MeV? | Porównaj LET protonu w wodzie przy 50 MeV, 100 MeV i 150 MeV. |

Example CSDA pronunciation (EN spells the acronym letter-by-letter; PL says "CSDA" unchanged in both canonical and display, since it's already unambiguous there too):

| id      | EN display                                                                      | PL display                                                                  |
| ------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `dg-01` | What is the see-ess-dee-ay range of a 150 MeV proton in water?                  | Jaki jest zasięg CSDA protonu o energii 150 MeV w wodzie?                   |
| `dg-13` | What is the see-ess-dee-ay range of a 250 MeV per nucleon oxygen ion in PMMA?   | Jaki jest zasięg CSDA jonu tlenu o energii 250 MeV na nukleon w PMMA?       |
| `dg-20` | What is the see-ess-dee-ay range of a 600 MeV per nucleon iron ion in aluminum? | Jaki jest zasięg CSDA jonu żelaza o energii 600 MeV na nukleon w aluminium? |

## What this set can and cannot measure

The 45/5 energy split, recorded with the same speaker/mic/session as everything else, is
designed to answer whether _prompting_ an expanded energy reading changes what the ASR models
actually hear versus the natural abbreviated reading — the open question
`docs/unit-pronunciation-asr.md` §7.1 raised and could not answer from TTS data alone. At
**n=5** this is a directional signal, not a statistic — the eventual findings doc (issue #130
Part 4) must report it that way, not as a percentage.

Length rendering is **not** a variable in this set — all 50 spell it out wherever it appears
(only the 12 `energyFromRange` sentences have a length-unit token in their text at all). That
is deliberate, not an oversight: `LENGTH_TARGET_RE` already accepts
`centimeters?`/`millimeters?`/`micrometers?` alongside the abbreviations since
`docs/nemo-parakeet-comparison.md` §5.3, so the abbreviated arm for length is already the one
covered by every prior corpus in this repo (`eval/RECORDING.pl.md`, the 1000-sentence
batches); this set adds the spelled-out arm.

## A matcher bug found and worked around while building this set

The first drafts of the two multi-particle comparison sentences (now `dg-29`/`dg-30`/`dg-50`)
used the same phrasing pattern `scripts/generate-1000-sentences.mjs`'s own
`RANGE_MULTI_PARTICLE`/`STP_MULTI_PARTICLE` templates use: **"Compare the range of a 200 MeV
per nucleon carbon-12 ion and a 200 MeV per nucleon neon-20 ion in water."** — repeating the
energy once per particle clause.

That phrasing silently computes the **wrong** answer. `matchIntent` correctly captures both
particles (`intent.particles = ["carbon-12 ion", "neon-20 ion"]`), but the repeated energy
mention makes `intent.energies.length === 2` too, which tips the matcher's `compareDim`
auto-selection to `"energy"` instead of `"particle"`. `computeIntent`'s `compareDim === "energy"`
path (`src/lib/compute/compute.ts`, the trailing `else` branch) then reads only
`reqFirst(intent.particles, ...)` — **the first particle** — and fans out over the (duplicate,
identical-valued) energy list instead. Confirmed directly: the sentence above returns
`carbon-12`'s range **twice**, at 0.97 confidence, and never touches neon at all.

**Worked around in this set** by stating the energy once, trailing ("...in water, both at 200
MeV per nucleon."), which resolves `compareDim: "particle"` correctly with 1 energy mention —
confirmed for all three affected sentences, and now enforced by `scripts/generate-datagen-sentences.mjs`'s
own inline validation gate (which asserts `compareDim`/particle-count for every multi-particle
tuple, not just "computes _a_ finite positive number").

**Not fixed here** — this is a real bug in the shared `matchIntent`/`computeIntent` pipeline
(`src/lib/intent/matcher.ts`'s `compareDim` auto-selection, `src/lib/compute/compute.ts`'s
`compareDim: "energy"` branch), predating this issue and reachable by any real user query
phrased the "repeat the energy per particle" way, not just by this generator's own original
phrasing. Worth a follow-up issue; out of scope for a sentence-set PR.

## Ground-truth appendix (verified against libdedx)

Computed by the real matcher (`matchIntent`) + vendored libdedx WASM (`computeIntent`) from
each record's **English** canonical text — physics is language-independent, so the Polish
canonical of the same tuple computes identically (spot-checked, not exhaustively re-run here).
Program names per libdedx's own tables (ICRU49 = protons/light ions, ICRU73 = heavier ions,
Bethe = the #81 fallback for combinations neither program tabulates).

| id      | quantity        | unit       | result                                                                                                       |
| ------- | --------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `dg-01` | csdaRange       | g/cm²      | Water (liquid): 15.78 (ICRU49)                                                                               |
| `dg-02` | csdaRange       | g/cm²      | Bone, Cortical (ICRP): 8.645 (ICRU49)                                                                        |
| `dg-03` | csdaRange       | g/cm²      | PMMA (Plexiglass): 38.99 (ICRU49)                                                                            |
| `dg-04` | csdaRange       | g/cm²      | Water (liquid): 0.0008405 (ICRU49)                                                                           |
| `dg-05` | csdaRange       | g/cm²      | Silicon: 1.150 (ICRU49)                                                                                      |
| `dg-06` | csdaRange       | g/cm²      | PMMA (Plexiglass): 0.2109 (ICRU49)                                                                           |
| `dg-07` | csdaRange       | g/cm²      | Air (dry, near sea level): 0.04226 (ICRU49)                                                                  |
| `dg-08` | csdaRange       | g/cm²      | Graphite: 0.1388 (ICRU49)                                                                                    |
| `dg-09` | csdaRange       | g/cm²      | Polycarbonate (Makrolon/Lexan): 1.826 (ICRU73)                                                               |
| `dg-10` | csdaRange       | g/cm²      | Polyethylene: 3.190 (ICRU73)                                                                                 |
| `dg-11` | csdaRange       | g/cm²      | Water (liquid): 17.26 (ICRU73)                                                                               |
| `dg-12` | csdaRange       | g/cm²      | Bone, Cortical (ICRP): 6.818 (ICRU73)                                                                        |
| `dg-13` | csdaRange       | g/cm²      | PMMA (Plexiglass): 9.665 (ICRU73)                                                                            |
| `dg-14` | csdaRange       | g/cm²      | Water (liquid): 16.50 (ICRU73)                                                                               |
| `dg-15` | csdaRange       | g/cm²      | A-150 Tissue-Equivalent Plastic: 2.597 (ICRU73)                                                              |
| `dg-16` | csdaRange       | g/cm²      | Silicon Dioxide: 8.780 (ICRU73)                                                                              |
| `dg-17` | csdaRange       | g/cm²      | Water (liquid): 8.196 (ICRU73)                                                                               |
| `dg-18` | csdaRange       | g/cm²      | Adipose Tissue (ICRP): 2.540 (Bethe)                                                                         |
| `dg-19` | csdaRange       | g/cm²      | Water (liquid): 15.37 (Bethe)                                                                                |
| `dg-20` | csdaRange       | g/cm²      | Aluminium: 16.53 (Bethe)                                                                                     |
| `dg-21` | csdaRange       | g/cm²      | Lead: 17.46 (Bethe)                                                                                          |
| `dg-22` | csdaRange       | g/cm²      | Water (liquid): 325.5 (ICRU49)                                                                               |
| `dg-23` | csdaRange       | g/cm²      | Water (liquid): 7.721/15.78/25.97 (ICRU49)                                                                   |
| `dg-24` | csdaRange       | g/cm²      | Water (liquid): 8.720/17.26/27.56 (ICRU73)                                                                   |
| `dg-25` | csdaRange       | g/cm²      | Air (dry, near sea level): 0.004390/0.01312/0.04226 (ICRU49)                                                 |
| `dg-26` | csdaRange       | g/cm²      | Water (liquid): 15.78 (ICRU49); PMMA (Plexiglass): 16.21 (ICRU49); Bone, Cortical (ICRP): 17.62 (ICRU49)     |
| `dg-27` | csdaRange       | g/cm²      | Water (liquid): 12.93 (ICRU73); Aluminium: 16.54 (ICRU73)                                                    |
| `dg-28` | csdaRange       | g/cm²      | Water (liquid): 7.721 (ICRU49); Adipose Tissue (ICRP): 7.496 (ICRU49)                                        |
| `dg-29` | csdaRange       | g/cm²      | ¹²C: 8.720 (ICRU73); ²⁰Ne: 5.231 (ICRU73)                                                                    |
| `dg-30` | csdaRange       | g/cm²      | ¹H: 3.094 (ICRU49); ²H: 0.8857 (ICRU49)                                                                      |
| `dg-31` | energyFromRange | MeV(/nucl) | Water (liquid): 171.9 (ICRU49)                                                                               |
| `dg-32` | energyFromRange | MeV(/nucl) | Water (liquid): 145.7 (ICRU49)                                                                               |
| `dg-33` | energyFromRange | MeV(/nucl) | PMMA (Plexiglass): 85.12 (ICRU49)                                                                            |
| `dg-34` | energyFromRange | MeV(/nucl) | Water (liquid): 216.7 (ICRU73)                                                                               |
| `dg-35` | energyFromRange | MeV(/nucl) | Muscle, Skeletal: 59.72 (ICRU49)                                                                             |
| `dg-36` | energyFromRange | MeV(/nucl) | Water (liquid): 241.9 (Bethe)                                                                                |
| `dg-37` | energyFromRange | MeV(/nucl) | Water (liquid): 286.7 (ICRU73)                                                                               |
| `dg-38` | energyFromRange | MeV(/nucl) | Bone, Cortical (ICRP): 145.2 (ICRU49)                                                                        |
| `dg-39` | energyFromRange | MeV(/nucl) | PMMA (Plexiglass): 321.9 (Bethe)                                                                             |
| `dg-40` | energyFromRange | MeV(/nucl) | Water (liquid): 115.7 (ICRU49); PMMA (Plexiglass): 125.8 (ICRU49)                                            |
| `dg-41` | energyFromRange | MeV(/nucl) | Water (liquid): 145.7 (ICRU49); Bone, Cortical (ICRP): 195.1 (ICRU49); Adipose Tissue (ICRP): 141.2 (ICRU49) |
| `dg-42` | energyFromRange | MeV(/nucl) | ¹H: 145.7 (ICRU49); ¹²C: 275.7 (ICRU73)                                                                      |
| `dg-43` | stoppingPower   | MeV·cm²/g  | Water (liquid): 7.286 (ICRU49)                                                                               |
| `dg-44` | stoppingPower   | MeV·cm²/g  | Water (liquid): 160.8 (ICRU73)                                                                               |
| `dg-45` | stoppingPower   | MeV·cm²/g  | Aluminium: 33.75 (ICRU49)                                                                                    |
| `dg-46` | stoppingPower   | MeV·cm²/g  | Air (dry, near sea level): 22.93 (ICRU49)                                                                    |
| `dg-47` | stoppingPower   | MeV·cm²/g  | Silicon: 617.4 (ICRU49)                                                                                      |
| `dg-48` | stoppingPower   | MeV·cm²/g  | Water (liquid): 5.443 (ICRU49); PMMA (Plexiglass): 5.298 (ICRU49); Bone, Cortical (ICRP): 4.892 (ICRU49)     |
| `dg-49` | stoppingPower   | MeV·cm²/g  | Water (liquid): 12.44/7.286/5.443 (ICRU49)                                                                   |
| `dg-50` | stoppingPower   | MeV·cm²/g  | ¹H: 7.286 (ICRU49); ¹²C: 1888 (ICRU73)                                                                       |

## Reproducing

```
node scripts/generate-datagen-sentences.mjs eval/datagen-sentences.json
```

Regenerates `eval/datagen-sentences.json` from the tuple table in
`scripts/generate-datagen-sentences.mjs` and re-validates every one of the 100 canonical
sentences (50 tuples × 2 languages) against the real matcher + libdedx WASM before writing —
exits non-zero on any failure, matching `scripts/generate-1000-sentences.mjs`'s own
inline-validation convention. `scripts/validate-datagen-sentences.ts`
(`pnpm run validate:eval`) re-checks the committed file on every CI run, so a hand-edit that
breaks a sentence — or drifts `display` from `canonical` in more than the unit rendering, or
changes the expanded-energy count away from 5 — is caught without needing to regenerate.

## Status / next steps

- **This doc (Part 1):** the 50-sentence bilingual set, done — committed as
  `eval/datagen-sentences.json`, validated by `scripts/validate-datagen-sentences.ts`, and
  covered by a matcher unit test (`src/lib/intent/matcher.datagen.test.ts`) asserting every one
  of the 100 canonical sentences resolves to its expected quantity.
- **Not yet built (Parts 2–4):** the Android `DataGenActivity` that actually prompts, records,
  and dual-transcribes these sentences on-device; the PC-side import/scoring path; the
  findings doc. See issue #130.
- **Native-speaker review still wanted** for the Polish word forms, especially the 5 expanded
  energy renderings (`kiloelektronowoltów`/`megaelektronowoltów`/`gigaelektronowolt` — genitive
  plural / genitive plural / nominative singular by the standard Polish numeral-noun rule) and
  the length-unit declensions throughout (`centymetr`/`centymetry`/`centymetrów`,
  `milimetr`/`milimetry`/`milimetrów`) — implemented mechanically by
  `scripts/generate-datagen-sentences.mjs`'s `plCount()` helper and spot-checked, but not
  substituted for a physicist's read the way `eval/RECORDING.pl.md`'s own set was.
