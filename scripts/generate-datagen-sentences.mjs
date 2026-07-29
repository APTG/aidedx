/**
 * Generates the 50-sentence bilingual (EN+PL) benchmark-data-generator prompt set
 * (issue #130, Part 1) — a fixed, hand-picked (not randomly sampled) set of physics tuples,
 * each rendered in both languages with two text variants:
 *
 *  - `canonical`: the abbreviated form ("150 MeV", "10 cm") — the reference transcript for
 *    WER, the input validated against the real matcher + libdedx WASM, and the source of
 *    `slotTruth`.
 *  - `display`: what the phone shows the reader. Length units (cm/mm) are ALWAYS spelled
 *    out ("10 centimeters" / "10 centymetrów") in every record. Energy units (keV/MeV/GeV)
 *    are spelled out ("kiloelectronvolts" / "kiloelektronowoltów") in exactly 5 of the 50
 *    records (`energyRendering: "expanded"`) and left as the abbreviation in the other 45
 *    (`"abbrev"`) — Polish/English speakers read "MeV"/"keV"/"GeV" as compact acronyms
 *    ("mef"/"kef"/"Gef"), not letter-by-letter, so no pronunciation hint is needed or wanted
 *    for the abbreviated majority (see docs/unit-pronunciation-asr.md §5.1 and
 *    docs/nemo-parakeet-comparison.md §4.3, which measured that biasing toward a
 *    letter-spelled reading actively hurt unit-slot accuracy).
 *
 * Particle/material word forms mirror the already-vetted pools in
 * scripts/generate-1000-sentences.mjs (English) and scripts/generate-1000-sentences-pl.mjs /
 * eval/RECORDING.pl.md (Polish) — not invented. Sentence *shapes* are drawn from the same
 * template literals those two generators already validate at scale, applied here to fixed
 * tuples instead of a random sample.
 *
 * Every candidate (both languages) is gated inline through checkCandidate() — the real
 * matcher (`matchIntent`) + real libdedx WASM — exactly like generate-1000-sentences.mjs
 * does; a tuple that fails is a bug in this script, not a resampled draw (there is no RNG
 * here to resample from).
 *
 * Usage: node scripts/generate-datagen-sentences.mjs eval/datagen-sentences.json
 */
import { writeFileSync } from "node:fs";
import { checkCandidate, loadService } from "./tts-sentence-check.ts";

// ---------------------------------------------------------------------------
// Particles — one entry per key, EN + PL word forms side by side so a tuple only has to
// name the key once. PL forms use the ion()-wrapper convention from
// scripts/generate-1000-sentences-pl.mjs (`kind: "ion"` = generic "jon <gen>" wrapper;
// `kind: "named"` = a particle that declines on its own, never wrapped in "jon").
// ---------------------------------------------------------------------------
function ionPL(nom, gen) {
  return { kind: "ion", nom, gen };
}
const PARTICLES = {
  proton: {
    isLight: true,
    isProton: true,
    en: { phrase: "proton", listForm: "protons", bare: "protons?" },
    pl: { kind: "named", nom: "proton", gen: "protonu", bare: "proton(?:u|y|ów)?" },
  },
  deuteron: {
    isLight: true,
    en: { phrase: "deuteron", listForm: "deuterons", bare: "deuterons?" },
    pl: { kind: "named", nom: "deuteron", gen: "deuteronu", bare: "deuteron(?:u)?" },
  },
  triton: {
    isLight: true,
    en: { phrase: "triton", listForm: "tritons", bare: "tritons?" },
    pl: { kind: "named", nom: "tryton", gen: "trytonu", bare: "tryton(?:u)?" },
  },
  alpha: {
    isLight: true,
    en: { phrase: "alpha particle", listForm: "alpha particles", bare: "alpha" },
    pl: {
      kind: "named",
      nom: "cząstka alfa",
      gen: "cząstki alfa",
      bare: "cząstk[ai] alfa|cząstce alfa",
      // "cząstka" is grammatically feminine ("ta cząstka") — unlike every other particle
      // here (named or "jon X"), which is masculine — so the possessive referring back to
      // it must be "jej", not the default "jego" (INV_SINGLE template, below).
      possessive: "jej",
    },
  },
  helium3: {
    isLight: true,
    en: { phrase: "helium-3 ion", listForm: "helium-3 ions", bare: "helium" },
    // Always the disambiguated isotope, per RECORDING.pl.md's own convention note (a bare
    // "jon helu" defaults to the alpha particle / ⁴He).
    pl: { ...ionPL("hel", "helu-3"), bare: "helu-3" },
  },
  // Bare element name, no mass number, in EITHER language — matches the "jon węgla, not
  // jon węgla-12" convention eval/RECORDING.pl.md's own doc comment already established
  // for Polish: ions are named without an isotope number in the ~95% case where the
  // number would just repeat the element's own default (most abundant/stable) isotope,
  // which the matcher already assumes. Every mass number below WAS that same default
  // isotope (Li-7, B-11, N-14, O-16, Ne-20, Mg-24, Si-28, Ar-40, Ca-40, Ti-48, Fe-56,
  // Cu-63, Kr-84, Xe-132 are each their element's dominant natural abundance) — carried
  // over unchanged from scripts/generate-1000-sentences.mjs's own EN phrase strings, which
  // states the number for every heavy ion regardless of whether it disambiguates anything
  // (a fine convenience for that generator's own scoring convention, but not the natural-
  // speech convention this hand-curated set otherwise follows). Only `carbon14` below
  // keeps an explicit number, because it's genuinely NOT the default isotope.
  lithium: {
    en: { phrase: "lithium ion", listForm: "lithium ions", bare: "lithium" },
    pl: { ...ionPL("lit", "litu"), bare: "litu" },
  },
  boron: {
    en: { phrase: "boron ion", listForm: "boron ions", bare: "boron" },
    pl: { ...ionPL("bor", "boru"), bare: "boru" },
  },
  carbon: {
    en: { phrase: "carbon ion", listForm: "carbon ions", bare: "carbon" },
    pl: { ...ionPL("węgiel", "węgla"), bare: "węgla" },
  },
  // The deliberate disambiguation example alongside `helium3` below: carbon-14 is a real
  // but uncommon isotope (trace natural abundance, distinct from the default carbon-12),
  // so — unlike every bare element above — the mass number is stated explicitly in BOTH
  // languages ("carbon-14 ion" / "jon węgla-14"), mirroring RECORDING.pl.md's own
  // "węgiel-12" and "helu-3" convention of keeping a number only where it disambiguates.
  carbon14: {
    en: { phrase: "carbon-14 ion", listForm: "carbon-14 ions", bare: "carbon" },
    pl: { ...ionPL("węgiel", "węgla-14"), bare: "węgla-14" },
  },
  nitrogen: {
    en: { phrase: "nitrogen ion", listForm: "nitrogen ions", bare: "nitrogen" },
    pl: { ...ionPL("azot", "azotu"), bare: "azotu" },
  },
  oxygen: {
    en: { phrase: "oxygen ion", listForm: "oxygen ions", bare: "oxygen" },
    pl: { ...ionPL("tlen", "tlenu"), bare: "tlenu" },
  },
  neon: {
    en: { phrase: "neon ion", listForm: "neon ions", bare: "neon" },
    pl: { ...ionPL("neon", "neonu"), bare: "neonu" },
  },
  magnesium: {
    en: { phrase: "magnesium ion", listForm: "magnesium ions", bare: "magnesium" },
    pl: { ...ionPL("magnez", "magnezu"), bare: "magnezu" },
  },
  silicon: {
    en: { phrase: "silicon ion", listForm: "silicon ions", bare: "silicon" },
    pl: { ...ionPL("krzem", "krzemu"), bare: "krzemu" },
  },
  argon: {
    en: { phrase: "argon ion", listForm: "argon ions", bare: "argon" },
    pl: { ...ionPL("argon", "argonu"), bare: "argonu" },
  },
  calcium: {
    en: { phrase: "calcium ion", listForm: "calcium ions", bare: "calcium" },
    pl: { ...ionPL("wapń", "wapnia"), bare: "wapnia" },
  },
  titanium: {
    en: { phrase: "titanium ion", listForm: "titanium ions", bare: "titanium" },
    pl: { ...ionPL("tytan", "tytanu"), bare: "tytanu" },
  },
  iron: {
    en: { phrase: "iron ion", listForm: "iron ions", bare: "iron" },
    pl: { ...ionPL("żelazo", "żelaza"), bare: "żelaza" },
  },
  copper: {
    en: { phrase: "copper ion", listForm: "copper ions", bare: "copper" },
    pl: { ...ionPL("miedź", "miedzi"), bare: "miedzi" },
  },
  krypton: {
    en: { phrase: "krypton ion", listForm: "krypton ions", bare: "krypton" },
    pl: { ...ionPL("krypton", "kryptonu"), bare: "kryptonu" },
  },
  xenon: {
    en: { phrase: "xenon ion", listForm: "xenon ions", bare: "xenon" },
    pl: { ...ionPL("ksenon", "ksenonu"), bare: "ksenonu" },
  },
};

function pNomPL(p) {
  const f = p.pl;
  return f.kind === "ion" ? `jon ${f.gen}` : f.nom;
}
function pGenPL(p) {
  const f = p.pl;
  return f.kind === "ion" ? `jonu ${f.gen}` : f.gen;
}
/** Possessive pronoun referring back to the particle ("jego zasięg" = "its range") —
 * agrees with the particle's own grammatical gender, not "zasięg"'s. All "jon X" ions are
 * masculine via "jon"; named particles default masculine except "cząstka alfa" (feminine). */
function possessivePL(p) {
  return p.pl.possessive ?? "jego";
}

/** English indefinite article by pronounced-initial-sound, not spelling — "helium"/"xenon"
 * start with a consonant sound despite their spelling, so they stay "a" while
 * "alpha"/"iron"/"oxygen"/"argon" take "an". Only matters for templates that place the
 * article directly before the particle phrase with nothing (no energy number) in between. */
function articleForEN(phrase) {
  const first = phrase.trim().toLowerCase();
  if (/^(helium|xenon)/.test(first)) return "a";
  return /^[aeiou]/.test(first) ? "an" : "a";
}

// ---------------------------------------------------------------------------
// Materials — EN phrase (as used mid-sentence, "in <phrase>") + PL phrase (already the
// locative "w <phrase>" form, per RECORDING.pl.md's convention).
// ---------------------------------------------------------------------------
const MATERIALS = {
  water: { en: { phrase: "water", bare: "water" }, pl: { phrase: "wodzie", bare: "wodzie" } },
  air: { en: { phrase: "air", bare: "\\bair\\b" }, pl: { phrase: "powietrzu", bare: "powietrzu" } },
  pmma: { en: { phrase: "PMMA", bare: "pmma" }, pl: { phrase: "PMMA", bare: "pmma" } },
  corticalBone: {
    en: { phrase: "cortical bone", bare: "bone" },
    pl: { phrase: "kości korowej", bare: "kości korowej" },
  },
  adipose: {
    en: { phrase: "adipose tissue", bare: "adipose" },
    pl: { phrase: "tkance tłuszczowej", bare: "tkance tłuszczowej" },
  },
  muscle: {
    en: { phrase: "muscle tissue", bare: "muscle" },
    pl: { phrase: "tkance mięśniowej", bare: "tkance mięśniowej" },
  },
  siliconMat: {
    en: { phrase: "silicon", bare: "silicon" },
    pl: { phrase: "krzemie", bare: "krzemie" },
  },
  siliconDioxide: {
    en: { phrase: "silicon dioxide", bare: "silicon" },
    pl: { phrase: "dwutlenku krzemu", bare: "dwutlenku krzemu" },
  },
  aluminum: {
    en: { phrase: "aluminum", bare: "aluminum|aluminium" },
    pl: { phrase: "aluminium", bare: "aluminium" },
  },
  gold: { en: { phrase: "gold", bare: "gold" }, pl: { phrase: "złocie", bare: "złocie" } },
  lead: { en: { phrase: "lead", bare: "lead" }, pl: { phrase: "ołowiu", bare: "ołowiu" } },
  graphite: {
    en: { phrase: "graphite", bare: "graphite" },
    pl: { phrase: "graficie", bare: "graficie" },
  },
  polyethylene: {
    en: { phrase: "polyethylene", bare: "polyethylene" },
    pl: { phrase: "polietylenie", bare: "polietylenie" },
  },
  polycarbonate: {
    en: { phrase: "polycarbonate", bare: "polycarbonate" },
    pl: { phrase: "poliwęglanie", bare: "poliwęglanie" },
  },
  kapton: {
    en: { phrase: "Kapton", bare: "kapton" },
    pl: { phrase: "Kaptonie", bare: "kaptonie" },
  },
  a150: {
    en: { phrase: "A-150 tissue-equivalent plastic", bare: "a[- ]?150" },
    pl: { phrase: "plastiku tkankopodobnym A-150", bare: "plastiku tkankopodobnym a[- ]?150" },
  },
};

// ---------------------------------------------------------------------------
// Unit rendering — canonical is always the abbreviation; display spells out length units
// always, and energy units only for the 5 "expanded" tuples.
// ---------------------------------------------------------------------------

/** Standard Polish numeral-noun plural rule: 1 -> singular, 2-4 (not 12-14) -> plural
 * nominative, else -> genitive plural. `forms` = [one, few, many]. */
function plCount(n, forms) {
  if (n === 1) return forms[0];
  const last = n % 10;
  const lastTwo = n % 100;
  if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return forms[1];
  return forms[2];
}

const LENGTH_WORDS_EN = {
  cm: ["centimeter", "centimeters"],
  mm: ["millimeter", "millimeters"],
};
const LENGTH_WORDS_PL = {
  cm: ["centymetr", "centymetry", "centymetrów"],
  mm: ["milimetr", "milimetry", "milimetrów"],
};
// Always singular, same reasoning as energyWordEN below: every EN use of this is the
// compound modifier "a <value>-<unit> range", where English wants the singular noun
// regardless of magnitude ("a 20-centimeter range", not "a 20 centimeters range").
function lengthWordEN(_value, unit) {
  return LENGTH_WORDS_EN[unit][0];
}
function lengthWordPL(value, unit) {
  return plCount(value, LENGTH_WORDS_PL[unit]);
}

const ENERGY_WORDS_EN = {
  keV: ["kiloelectronvolt", "kiloelectronvolts"],
  MeV: ["megaelectronvolt", "megaelectronvolts"],
  GeV: ["gigaelectronvolt", "gigaelectronvolts"],
};
const ENERGY_WORDS_PL = {
  keV: ["kiloelektronowolt", "kiloelektronowolty", "kiloelektronowoltów"],
  MeV: ["megaelektronowolt", "megaelektronowolty", "megaelektronowoltów"],
  GeV: ["gigaelektronowolt", "gigaelektronowolty", "gigaelektronowoltów"],
};
// Always singular: in this dataset the expanded form only ever appears as a compound
// modifier directly before the particle noun ("a 500 kiloelectronvolt proton"), where
// English uses the singular unit form regardless of magnitude — same as "a five-year
// plan", never "a five-years plan". A bare-list use ("at 100 megaelectronvolts, 150...")
// would want the plural instead, but no expanded record in this set does that.
function energyWordEN(_value, unit) {
  return ENERGY_WORDS_EN[unit][0];
}
function energyWordPL(value, unit) {
  return plCount(value, ENERGY_WORDS_PL[unit]);
}

/** e = {value, unit, perNucleon?}. `expanded`: spell out the energy unit word. */
function energyPhraseEN(e, expanded) {
  const unit = expanded ? energyWordEN(e.value, e.unit) : e.unit;
  return e.perNucleon ? `${e.value} ${unit} per nucleon` : `${e.value} ${unit}`;
}
function energyPhrasePL(e, expanded) {
  const unit = expanded ? energyWordPL(e.value, e.unit) : e.unit;
  return e.perNucleon ? `${e.value} ${unit} na nukleon` : `${e.value} ${unit}`;
}
/** Length target is always spelled out in `display`, always abbreviated in `canonical`. */
function targetPhraseEN(t, spelled) {
  return spelled ? `${t.value} ${lengthWordEN(t.value, t.unit)}` : `${t.value} ${t.unit}`;
}
function targetPhrasePL(t, spelled) {
  return spelled ? `${t.value} ${lengthWordPL(t.value, t.unit)}` : `${t.value} ${t.unit}`;
}

function joinListEN(words) {
  if (words.length === 1) return words[0];
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(", ")}, and ${words[words.length - 1]}`;
}
function joinListPL(words) {
  if (words.length === 1) return words[0];
  if (words.length === 2) return `${words[0]} i ${words[1]}`;
  return `${words.slice(0, -1).join(", ")} i ${words[words.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Sentence templates — literal strings mirroring scripts/generate-1000-sentences{,-pl}.mjs
// and eval/RECORDING.pl.md exactly, parameterized by a `expanded` flag threaded through
// energyPhrase*/targetPhrase* instead of a fixed energy/target string.
// ---------------------------------------------------------------------------
// Most real questions just ask for "range"/"zasięg" — "CSDA" is the qualifier a minority
// actually says (`RANGE_SINGLE_CSDA` below, 3 of the 30 csdaRange tuples, ~10%). When it IS
// said, it's said in both languages consistently — never English-only the way an earlier
// draft of this set had it — matching eval/RECORDING.pl.md's own "Ile wynosi zasięg CSDA
// protonu..." (pl-rng-02) precedent.
const RANGE_SINGLE_PLAIN = {
  en: (p, m, e, x) =>
    `What is the range of a ${energyPhraseEN(e, x)} ${p.en.phrase} in ${m.en.phrase}?`,
  pl: (p, m, e, x) =>
    `Jaki jest zasięg ${pGenPL(p)} o energii ${energyPhrasePL(e, x)} w ${m.pl.phrase}?`,
  kw: { en: "range", pl: "zasięg" },
};
const RANGE_SINGLE_CSDA = {
  en: (p, m, e, x) =>
    `What is the CSDA range of a ${energyPhraseEN(e, x)} ${p.en.phrase} in ${m.en.phrase}?`,
  pl: (p, m, e, x) =>
    `Jaki jest zasięg CSDA ${pGenPL(p)} o energii ${energyPhrasePL(e, x)} w ${m.pl.phrase}?`,
  kw: { en: "range", pl: "zasięg" },
};
const RANGE_SINGLE_ALT = {
  en: (p, m, e, x) =>
    `How far will a ${energyPhraseEN(e, x)} ${p.en.phrase} travel through ${m.en.phrase}?`,
  pl: (p, m, e, x) =>
    `Jak daleko doleci ${pNomPL(p)} o energii ${energyPhrasePL(e, x)} w ${m.pl.phrase}?`,
  kw: { en: "how far", pl: "daleko" },
};
const RANGE_SINGLE_ALT2 = {
  en: (p, m, e, x) =>
    `How deep does a ${energyPhraseEN(e, x)} ${p.en.phrase} penetrate into ${m.en.phrase}?`,
  pl: (p, m, e, x) =>
    `Jak głęboko wniknie ${pNomPL(p)} o energii ${energyPhrasePL(e, x)} w ${m.pl.phrase}?`,
  kw: { en: "penetrat", pl: "głęboko" },
};
const RANGE_MULTI_ENERGY = {
  en: (p, m, es, x) =>
    `What is the range of ${p.en.listForm} in ${m.en.phrase} at ${joinListEN(es.map((e) => energyPhraseEN(e, x)))}?`,
  pl: (p, m, es, x) =>
    `Jaki jest zasięg ${pGenPL(p)} w ${m.pl.phrase} dla energii ${joinListPL(es.map((e) => energyPhrasePL(e, x)))}?`,
  kw: { en: "range", pl: "zasięg" },
};
const RANGE_MULTI_MATERIAL = {
  en: (p, ms, e, x) =>
    `Compare the range of a ${energyPhraseEN(e, x)} ${p.en.phrase} in ${joinListEN(ms.map((m) => m.en.phrase))}.`,
  pl: (p, ms, e, x) =>
    `Porównaj zasięg ${pGenPL(p)} o energii ${energyPhrasePL(e, x)} w ${joinListPL(ms.map((m) => m.pl.phrase))}.`,
  kw: { en: "range", pl: "zasięg" },
};
// NOT "a <E> <P1> and a <E> <P2>" (repeating the energy once per particle clause): that
// phrasing gives matchIntent two identical energy mentions, which tips its compareDim
// auto-selection to "energy" instead of "particle" — computeIntent's compareDim:"energy"
// path then only ever reads `particles[0]`, silently computing the FIRST particle's value
// twice and never touching the second (confirmed directly against matchIntent/computeIntent
// while building this set — a real bug in the shared matcher, in scope for a separate fix,
// not something to bake into this sentence set). Stating the energy once, trailing, avoids
// triggering it: 1 energy mention + 2 particles resolves compareDim:"particle" correctly.
const RANGE_MULTI_PARTICLE = {
  en: (ps, m, e, x) =>
    `Compare the range of ${articleForEN(ps[0].en.phrase)} ${ps[0].en.phrase} and ${articleForEN(ps[1].en.phrase)} ${ps[1].en.phrase} in ${m.en.phrase}, both at ${energyPhraseEN(e, x)}.`,
  pl: (ps, m, e, x) =>
    `Co wniknie głębiej w ${m.pl.phrase} przy ${energyPhrasePL(e, x)}: ${pNomPL(ps[0])} czy ${pNomPL(ps[1])}?`,
  kw: { en: "range", pl: "głębiej" },
};

// LET is the dominant real-world phrasing (7 of the 8 stoppingPower tuples below use one
// of the _LET templates, 1 uses plain "stopping power") — matches how the term is
// actually used more than "stopping power" is. English speakers read the acronym
// letter-by-letter ("el-ee-tee"), applied to `display` only, in render() below; Polish
// borrows "LET" as a one-syllable word (rhymes with the English word "let") and reads it
// unchanged, so no PL rendering rule is needed.
const STP_SINGLE = {
  en: (p, m, e, x) =>
    `What is the stopping power of a ${energyPhraseEN(e, x)} ${p.en.phrase} in ${m.en.phrase}?`,
  pl: (p, m, e, x) =>
    `Jaka jest zdolność hamowania ${pGenPL(p)} o energii ${energyPhrasePL(e, x)} w ${m.pl.phrase}?`,
  kw: { en: "stopping power", pl: "zdolność hamowania" },
};
const STP_SINGLE_LET = {
  en: (p, m, e, x) =>
    `What is the LET of a ${energyPhraseEN(e, x)} ${p.en.phrase} in ${m.en.phrase}?`,
  pl: (p, m, e, x) =>
    `Jaki jest LET ${pGenPL(p)} o energii ${energyPhrasePL(e, x)} w ${m.pl.phrase}?`,
  kw: { en: "\\blet\\b", pl: "\\blet\\b" },
};
const STP_MULTI_ENERGY_LET = {
  en: (p, m, es, x) =>
    `What is the LET of ${p.en.listForm} in ${m.en.phrase} at ${joinListEN(es.map((e) => energyPhraseEN(e, x)))}?`,
  pl: (p, m, es, x) =>
    `Porównaj LET ${pGenPL(p)} w ${m.pl.phrase} przy ${joinListPL(es.map((e) => energyPhrasePL(e, x)))}.`,
  kw: { en: "\\blet\\b", pl: "\\blet\\b" },
};
const STP_MULTI_MATERIAL = {
  en: (p, ms, e, x) =>
    `Compare the LET of a ${energyPhraseEN(e, x)} ${p.en.phrase} in ${joinListEN(ms.map((m) => m.en.phrase))}.`,
  pl: (p, ms, e, x) =>
    `Porównaj LET ${pGenPL(p)} o energii ${energyPhrasePL(e, x)} w ${joinListPL(ms.map((m) => m.pl.phrase))}.`,
  kw: { en: "\\blet\\b", pl: "\\blet\\b" },
};
// Same duplicate-energy compareDim trap as RANGE_MULTI_PARTICLE above — energy stated
// once, trailing, not once per particle clause.
const STP_MULTI_PARTICLE_LET = {
  en: (ps, m, e, x) =>
    `Compare the LET of ${articleForEN(ps[0].en.phrase)} ${ps[0].en.phrase} and ${articleForEN(ps[1].en.phrase)} ${ps[1].en.phrase} in ${m.en.phrase}, both at ${energyPhraseEN(e, x)}.`,
  pl: (ps, m, e, x) =>
    `Porównaj LET ${pGenPL(ps[0])} i ${pGenPL(ps[1])} w ${m.pl.phrase} przy ${energyPhrasePL(e, x)}.`,
  kw: { en: "\\blet\\b", pl: "\\blet\\b" },
};

const INV_SINGLE = {
  en: (p, m, t, spelled) =>
    `What energy gives a ${targetPhraseEN(t, spelled)} range in ${m.en.phrase} for ${p.en.listForm}?`,
  pl: (p, m, t, spelled) =>
    `Jaką energię musi mieć ${pNomPL(p)}, żeby ${possessivePL(p)} zasięg w ${m.pl.phrase} wynosił ${targetPhrasePL(t, spelled)}?`,
  kw: { en: "what energy", pl: "jak(?:ą|iej|a|ie)\\s+energi" },
};
const INV_SINGLE_ALT = {
  en: (p, m, t, spelled) =>
    `How energetic must ${articleForEN(p.en.phrase)} ${p.en.phrase} be for a ${targetPhraseEN(t, spelled)} range in ${m.en.phrase}?`,
  pl: (p, m, t, spelled) =>
    `Ile energii potrzebuje ${pNomPL(p)} na zasięg ${targetPhrasePL(t, spelled)} w ${m.pl.phrase}?`,
  kw: { en: "how energetic", pl: "ile\\s+energi" },
};
const INV_MULTI_MATERIAL = {
  en: (p, ms, t, spelled) =>
    `What energy do ${p.en.listForm} need for a ${targetPhraseEN(t, spelled)} range in ${joinListEN(ms.map((m) => m.en.phrase))}?`,
  pl: (p, ms, t, spelled) =>
    `Jaką energię musi mieć ${pNomPL(p)}, aby uzyskać zasięg ${targetPhrasePL(t, spelled)} w ${joinListPL(ms.map((m) => m.pl.phrase))}?`,
  kw: { en: "what energy", pl: "jak(?:ą|iej|a|ie)\\s+energi" },
};
const INV_MULTI_PARTICLE = {
  en: (ps, m, t, spelled) =>
    `What energy do ${ps[0].en.listForm} need for a ${targetPhraseEN(t, spelled)} range in ${m.en.phrase}? What about ${ps[1].en.listForm}?`,
  pl: (ps, m, t, spelled) =>
    `Jaką energię potrzebuje ${pNomPL(ps[0])} na zasięg ${targetPhrasePL(t, spelled)} w ${m.pl.phrase}? A ${pNomPL(ps[1])}?`,
  kw: { en: "what energy", pl: "jak(?:ą|iej|a|ie)\\s+energi" },
};

// ---------------------------------------------------------------------------
// The 50 tuples. `x` marks the 5 records rendered with energyRendering: "expanded".
// ---------------------------------------------------------------------------
const P = PARTICLES;
const M = MATERIALS;
const e = (value, unit, perNucleon) => ({
  value,
  unit,
  ...(perNucleon ? { perNucleon: true } : {}),
});
const t = (value, unit) => ({ value, unit });

const TUPLES = [
  // --- csdaRange, single (22) ---
  {
    id: "dg-01",
    q: "csdaRange",
    tpl: RANGE_SINGLE_CSDA,
    p: P.proton,
    m: M.water,
    en1: e(150, "MeV"),
  },
  {
    id: "dg-02",
    q: "csdaRange",
    tpl: RANGE_SINGLE_PLAIN,
    p: P.proton,
    m: M.corticalBone,
    en1: e(100, "MeV"),
  },
  {
    id: "dg-03",
    q: "csdaRange",
    tpl: RANGE_SINGLE_ALT,
    p: P.proton,
    m: M.pmma,
    en1: e(250, "MeV"),
  },
  {
    id: "dg-04",
    q: "csdaRange",
    tpl: RANGE_SINGLE_PLAIN,
    p: P.proton,
    m: M.water,
    en1: e(500, "keV"),
    x: true,
  },
  {
    id: "dg-05",
    q: "csdaRange",
    tpl: RANGE_SINGLE_PLAIN,
    p: P.deuteron,
    m: M.siliconMat,
    en1: e(60, "MeV"),
  },
  {
    id: "dg-06",
    q: "csdaRange",
    tpl: RANGE_SINGLE_ALT2,
    p: P.triton,
    m: M.pmma,
    en1: e(40, "MeV"),
  },
  { id: "dg-07", q: "csdaRange", tpl: RANGE_SINGLE_ALT, p: P.alpha, m: M.air, en1: e(20, "MeV") },
  {
    id: "dg-08",
    q: "csdaRange",
    tpl: RANGE_SINGLE_ALT2,
    p: P.helium3,
    m: M.graphite,
    en1: e(30, "MeV"),
  },
  {
    id: "dg-09",
    q: "csdaRange",
    tpl: RANGE_SINGLE_PLAIN,
    p: P.lithium,
    m: M.polycarbonate,
    en1: e(50, "MeV", true),
  },
  {
    id: "dg-10",
    q: "csdaRange",
    tpl: RANGE_SINGLE_PLAIN,
    p: P.boron,
    m: M.polyethylene,
    en1: e(100, "MeV", true),
  },
  {
    id: "dg-11",
    q: "csdaRange",
    tpl: RANGE_SINGLE_PLAIN,
    p: P.carbon,
    m: M.water,
    en1: e(300, "MeV", true),
    x: true,
  },
  {
    id: "dg-12",
    q: "csdaRange",
    tpl: RANGE_SINGLE_ALT,
    p: P.nitrogen,
    m: M.corticalBone,
    en1: e(180, "MeV", true),
  },
  {
    id: "dg-13",
    q: "csdaRange",
    tpl: RANGE_SINGLE_CSDA,
    p: P.oxygen,
    m: M.pmma,
    en1: e(250, "MeV", true),
  },
  {
    id: "dg-14",
    q: "csdaRange",
    tpl: RANGE_SINGLE_ALT2,
    p: P.neon,
    m: M.water,
    en1: e(400, "MeV", true),
  },
  {
    id: "dg-15",
    q: "csdaRange",
    tpl: RANGE_SINGLE_PLAIN,
    p: P.magnesium,
    m: M.a150,
    en1: e(150, "MeV", true),
  },
  {
    id: "dg-16",
    q: "csdaRange",
    tpl: RANGE_SINGLE_PLAIN,
    p: P.silicon,
    m: M.siliconDioxide,
    en1: e(300, "MeV", true),
  },
  {
    id: "dg-17",
    q: "csdaRange",
    tpl: RANGE_SINGLE_ALT,
    p: P.argon,
    m: M.water,
    en1: e(350, "MeV", true),
  },
  {
    id: "dg-18",
    q: "csdaRange",
    tpl: RANGE_SINGLE_PLAIN,
    p: P.calcium,
    m: M.adipose,
    en1: e(200, "MeV", true),
  },
  {
    id: "dg-19",
    q: "csdaRange",
    tpl: RANGE_SINGLE_ALT2,
    p: P.titanium,
    m: M.water,
    en1: e(600, "MeV", true),
  },
  {
    id: "dg-20",
    q: "csdaRange",
    tpl: RANGE_SINGLE_CSDA,
    p: P.iron,
    m: M.aluminum,
    en1: e(600, "MeV", true),
  },
  {
    id: "dg-21",
    q: "csdaRange",
    tpl: RANGE_SINGLE_PLAIN,
    p: P.copper,
    m: M.lead,
    en1: e(500, "MeV", true),
  },
  {
    id: "dg-22",
    q: "csdaRange",
    tpl: RANGE_SINGLE_ALT,
    p: P.proton,
    m: M.water,
    en1: e(1, "GeV"),
    x: true,
  },

  // --- csdaRange, multi (8) ---
  {
    id: "dg-23",
    q: "csdaRange",
    tpl: RANGE_MULTI_ENERGY,
    p: P.proton,
    m: M.water,
    enN: [e(100, "MeV"), e(150, "MeV"), e(200, "MeV")],
  },
  {
    id: "dg-24",
    q: "csdaRange",
    tpl: RANGE_MULTI_ENERGY,
    p: P.carbon,
    m: M.water,
    enN: [e(200, "MeV", true), e(300, "MeV", true), e(400, "MeV", true)],
  },
  {
    id: "dg-25",
    q: "csdaRange",
    tpl: RANGE_MULTI_ENERGY,
    p: P.alpha,
    m: M.air,
    enN: [e(5, "MeV"), e(10, "MeV"), e(20, "MeV")],
  },
  {
    id: "dg-26",
    q: "csdaRange",
    tpl: RANGE_MULTI_MATERIAL,
    p: P.proton,
    ms: [M.water, M.pmma, M.corticalBone],
    en1: e(150, "MeV"),
  },
  {
    id: "dg-27",
    q: "csdaRange",
    tpl: RANGE_MULTI_MATERIAL,
    p: P.oxygen,
    ms: [M.water, M.aluminum],
    en1: e(300, "MeV", true),
  },
  {
    id: "dg-28",
    q: "csdaRange",
    tpl: RANGE_MULTI_MATERIAL,
    p: P.proton,
    ms: [M.water, M.adipose],
    en1: e(100, "MeV"),
  },
  {
    id: "dg-29",
    q: "csdaRange",
    tpl: RANGE_MULTI_PARTICLE,
    ps: [P.carbon, P.neon],
    m: M.water,
    en1: e(200, "MeV", true),
  },
  {
    id: "dg-30",
    q: "csdaRange",
    tpl: RANGE_MULTI_PARTICLE,
    ps: [P.proton, P.deuteron],
    m: M.water,
    en1: e(60, "MeV"),
  },

  // --- energyFromRange, single (9) ---
  {
    id: "dg-31",
    q: "energyFromRange",
    tpl: INV_SINGLE,
    p: P.proton,
    m: M.water,
    target: t(20, "cm"),
  },
  {
    id: "dg-32",
    q: "energyFromRange",
    tpl: INV_SINGLE_ALT,
    p: P.proton,
    m: M.water,
    target: t(15, "cm"),
  },
  {
    id: "dg-33",
    q: "energyFromRange",
    tpl: INV_SINGLE,
    p: P.proton,
    m: M.pmma,
    target: t(5, "cm"),
  },
  {
    id: "dg-34",
    q: "energyFromRange",
    tpl: INV_SINGLE_ALT,
    p: P.carbon14,
    m: M.water,
    target: t(10, "cm"),
  },
  {
    id: "dg-35",
    q: "energyFromRange",
    tpl: INV_SINGLE,
    p: P.alpha,
    m: M.muscle,
    target: t(30, "mm"),
  },
  {
    id: "dg-36",
    q: "energyFromRange",
    tpl: INV_SINGLE_ALT,
    p: P.iron,
    m: M.water,
    target: t(3, "cm"),
  },
  {
    id: "dg-37",
    q: "energyFromRange",
    tpl: INV_SINGLE,
    p: P.oxygen,
    m: M.water,
    target: t(12, "cm"),
  },
  // 9, not 8: "a 8 centimeter range" reads wrong aloud ("eight" starts with a vowel sound,
  // wants "an") — the hardcoded "a" before a bare number in INV_SINGLE_ALT only agrees
  // with consonant-initial numbers, so the target value is picked to avoid the clash
  // rather than adding a full number-to-spoken-initial-sound resolver for one occurrence.
  {
    id: "dg-38",
    q: "energyFromRange",
    tpl: INV_SINGLE_ALT,
    p: P.proton,
    m: M.corticalBone,
    target: t(9, "cm"),
  },
  {
    id: "dg-39",
    q: "energyFromRange",
    tpl: INV_SINGLE,
    p: P.calcium,
    m: M.pmma,
    target: t(5, "cm"),
  },

  // --- energyFromRange, multi (3) ---
  {
    id: "dg-40",
    q: "energyFromRange",
    tpl: INV_MULTI_MATERIAL,
    p: P.proton,
    ms: [M.water, M.pmma],
    target: t(10, "cm"),
  },
  {
    id: "dg-41",
    q: "energyFromRange",
    tpl: INV_MULTI_MATERIAL,
    p: P.proton,
    ms: [M.water, M.corticalBone, M.adipose],
    target: t(15, "cm"),
  },
  {
    id: "dg-42",
    q: "energyFromRange",
    tpl: INV_MULTI_PARTICLE,
    ps: [P.proton, P.carbon],
    m: M.water,
    target: t(15, "cm"),
  },

  // --- stoppingPower, single (5) ---
  {
    id: "dg-43",
    q: "stoppingPower",
    tpl: STP_SINGLE_LET,
    p: P.proton,
    m: M.water,
    en1: e(100, "MeV"),
    x: true,
  },
  {
    id: "dg-44",
    q: "stoppingPower",
    tpl: STP_SINGLE,
    p: P.carbon,
    m: M.water,
    en1: e(200, "MeV", true),
    x: true,
  },
  {
    id: "dg-45",
    q: "stoppingPower",
    tpl: STP_SINGLE_LET,
    p: P.proton,
    m: M.aluminum,
    en1: e(10, "MeV"),
  },
  {
    id: "dg-46",
    q: "stoppingPower",
    tpl: STP_SINGLE_LET,
    p: P.deuteron,
    m: M.air,
    en1: e(40, "MeV"),
  },
  {
    id: "dg-47",
    q: "stoppingPower",
    tpl: STP_SINGLE_LET,
    p: P.alpha,
    m: M.siliconMat,
    en1: e(5, "MeV"),
  },

  // --- stoppingPower, multi (3) ---
  {
    id: "dg-48",
    q: "stoppingPower",
    tpl: STP_MULTI_MATERIAL,
    p: P.proton,
    ms: [M.water, M.pmma, M.corticalBone],
    en1: e(150, "MeV"),
  },
  {
    id: "dg-49",
    q: "stoppingPower",
    tpl: STP_MULTI_ENERGY_LET,
    p: P.proton,
    m: M.water,
    enN: [e(50, "MeV"), e(100, "MeV"), e(150, "MeV")],
  },
  {
    id: "dg-50",
    q: "stoppingPower",
    tpl: STP_MULTI_PARTICLE_LET,
    ps: [P.proton, P.carbon],
    m: M.water,
    en1: e(100, "MeV"),
  },
];

const expandedCount = TUPLES.filter((tu) => tu.x).length;
if (expandedCount !== 5) {
  throw new Error(`expected exactly 5 expanded-energy tuples, found ${expandedCount}`);
}

// ---------------------------------------------------------------------------
// Render one tuple -> the full record shape (both languages).
// ---------------------------------------------------------------------------
/** Strips undefined keys so e.g. a non-inverse record's slotTruth has no `target: undefined`
 * and a non-multi record's `energies`/`target` shape stays exactly what
 * scripts/asr-score-slots-generic.mjs's convention expects. */
function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function render(tu) {
  const expanded = !!tu.x;
  const isInverse = tu.q === "energyFromRange";

  // Resolve the particle(s)/material(s) subject/object of the sentence, and the bare-regex
  // slot lists per language, uniformly across the single/multi-material/multi-particle
  // tuple shapes (`tu.ms`/`tu.ps` are mutually exclusive with each other and with the
  // plain single `tu.p`/`tu.m`).
  const subjectEn = tu.ps ?? tu.p;
  const subjectPl = tu.ps ?? tu.p;
  const objectEn = tu.ms ?? tu.m;
  const objectPl = tu.ms ?? tu.m;
  const particlesEn = (tu.ps ?? [tu.p]).map((p) => p.en.bare);
  const particlesPl = (tu.ps ?? [tu.p]).map((p) => p.pl.bare);
  const materialsEn = (tu.ms ?? [tu.m]).map((m) => m.en.bare);
  const materialsPl = (tu.ms ?? [tu.m]).map((m) => m.pl.bare);

  const energyArg = tu.enN ?? tu.en1;
  const spelledCanonical = false;
  const spelledDisplay = true;

  const enCanonical = isInverse
    ? tu.tpl.en(subjectEn, objectEn, tu.target, spelledCanonical)
    : tu.tpl.en(subjectEn, objectEn, energyArg, false);
  // English reads the acronym "LET" letter-by-letter ("el-ee-tee"); Polish borrows it as a
  // one-syllable word (rhymes with the English word "let") and reads it unchanged, so only
  // the EN `display` gets this substitution — `canonical` keeps "LET" so the matcher's own
  // `\blet\b` slotTruth keyword still matches it. "CSDA" is likewise read letter-by-letter
  // in English ("see-ess-dee-ay") — unlike LET, no PL sentence in this set contains "CSDA"
  // at all (eval/RECORDING.pl.md's own PL set uses it in exactly one sentence, "zasięg CSDA",
  // but this generator's PL templates never do), so only the EN side needs a rule. NOT
  // applied to "PMMA": letter-by-letter is already the only way anyone reads it in either
  // language — no ambiguity to resolve, unlike LET/CSDA — so `display` leaves it untouched.
  const enDisplayRaw = isInverse
    ? tu.tpl.en(subjectEn, objectEn, tu.target, spelledDisplay)
    : tu.tpl.en(subjectEn, objectEn, energyArg, expanded);
  const enDisplay = enDisplayRaw
    .replace(/\bLET\b/, "el-ee-tee")
    .replace(/\bCSDA\b/, "see-ess-dee-ay");
  const plCanonical = isInverse
    ? tu.tpl.pl(subjectPl, objectPl, tu.target, spelledCanonical)
    : tu.tpl.pl(subjectPl, objectPl, energyArg, false);
  const plDisplay = isInverse
    ? tu.tpl.pl(subjectPl, objectPl, tu.target, spelledDisplay)
    : tu.tpl.pl(subjectPl, objectPl, energyArg, expanded);

  const baseSlotTruth = {
    isInverse: isInverse || undefined,
    particles: undefined, // filled per-language below
    materials: undefined,
    energies: isInverse ? undefined : Array.isArray(energyArg) ? energyArg : [energyArg],
    target: isInverse ? tu.target : undefined,
  };

  const enSlotTruth = compact({
    ...baseSlotTruth,
    quantityKeyword: tu.tpl.kw.en,
    particles: particlesEn,
    materials: materialsEn,
  });
  const plSlotTruth = compact({
    ...baseSlotTruth,
    quantityKeyword: tu.tpl.kw.pl,
    particles: particlesPl,
    materials: materialsPl,
  });

  return {
    id: tu.id,
    quantity: tu.q,
    energyRendering: expanded ? "expanded" : "abbrev",
    en: { canonical: enCanonical, display: enDisplay, slotTruth: enSlotTruth },
    pl: { canonical: plCanonical, display: plDisplay, slotTruth: plSlotTruth },
  };
}

const records = TUPLES.map(render);

// ---------------------------------------------------------------------------
// Inline validation gate — same "real matcher + real libdedx, never guessed" rule as
// generate-1000-sentences.mjs. Any failure aborts the whole run (no RNG to resample from
// here — a failure means this script's template/tuple data is wrong and must be fixed).
// ---------------------------------------------------------------------------
const service = await loadService();
let failures = 0;
for (let i = 0; i < records.length; i++) {
  const r = records[i];
  const tu = TUPLES[i];
  for (const lang of ["en", "pl"]) {
    const res = checkCandidate({ id: `${r.id}-${lang}`, text: r[lang].canonical }, service, lang);
    if (!res.ok) {
      failures++;
      console.error(`✗ ${r.id} [${lang}]: ${res.reason}\n  text: ${r[lang].canonical}`);
      continue;
    }
    // A multi-particle/multi-material tuple must actually resolve to a comparison over
    // that many distinct entries — not just "any finite positive number" (checkCandidate's
    // own check). This is exactly the class of bug found while building this set: a
    // phrasing that repeats the energy once per particle clause silently tips matchIntent's
    // compareDim to "energy" instead of "particle", and computeIntent's compareDim:"energy"
    // path then only ever reads particles[0] — a real result, just the wrong one.
    if (
      tu.ps &&
      (res.intent.compareDim !== "particle" || res.intent.particles.length !== tu.ps.length)
    ) {
      failures++;
      console.error(
        `✗ ${r.id} [${lang}]: expected compareDim="particle" with ${tu.ps.length} particles, got compareDim="${res.intent.compareDim}" with ${res.intent.particles.length}\n  text: ${r[lang].canonical}`,
      );
    }
    if (
      tu.ms &&
      (res.intent.compareDim !== "material" || res.intent.materials.length !== tu.ms.length)
    ) {
      failures++;
      console.error(
        `✗ ${r.id} [${lang}]: expected compareDim="material" with ${tu.ms.length} materials, got compareDim="${res.intent.compareDim}" with ${res.intent.materials.length}\n  text: ${r[lang].canonical}`,
      );
    }
  }
}
if (failures > 0) {
  console.error(`\n${failures} candidate(s) failed validation.`);
  process.exit(1);
}
console.log(
  `✓ all ${records.length * 2} canonical sentences (${records.length} tuples × 2 languages) validated.`,
);

const outPath = process.argv[2];
if (outPath) {
  writeFileSync(outPath, JSON.stringify(records, null, 2) + "\n");
  console.log(`wrote ${outPath}`);
}
