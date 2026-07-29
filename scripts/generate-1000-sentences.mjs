/**
 * Generates the 1000-sentence TTS eval-audio batch (issue #30, second scale-up; v2 per
 * issue #83 following the libdedx WASM update + Bethe fallback in #81).
 *
 * Quantity split (per the user's stated real-world usage assumption):
 *   60% csdaRange, 25% energyFromRange (inverse), 15% stoppingPower.
 * ~20% of each category is a "multiple numbers" scenario: multi-energy for the two
 * forward quantities (compareDim: "energy"), multi-material/multi-particle for the
 * inverse quantity (a single target value shared across several materials/particles —
 * energyFromRange's target slot is singular in the schema, so it can't itself be
 * pluralized; comparing several entities against the same target is the schema-legal
 * equivalent).
 *
 * v2 changes (issue #83, after #81 landed the libdedx update + Bethe fallback):
 *  - Particle pool extended past Z=18 (argon) with calcium, iron, krypton, xenon, gold,
 *    lead, uranium — verified computable via the Bethe fallback, no longer failing
 *    unconditionally through the auto-selected MSTAR program.
 *  - Material pool restores the six previously-broken entries (soft tissue, skin, lung,
 *    brain, blood, concrete) plus the boron family (boron, boron carbide, boron oxide) —
 *    all verified computable now.
 *  - ~50% of the `stoppingPower` category is phrased with LET terminology ("LET" /
 *    "linear energy transfer") instead of "stopping power" — the term real users in
 *    particle therapy/radiobiology actually say (matcher support: see #86).
 *  - The generate→validate loop is now closed: every candidate is checked against the
 *    real matcher + libdedx WASM (the same logic scripts/tts-sentence-check.ts uses) as
 *    it's generated, and resampled on failure, rather than validated as a separate pass
 *    after the fact. This is what makes the expanded pool safe to use at all — the
 *    heavy-ion "implantation" keV register (bare keV total energy, divided by mass
 *    number) falls below the Bethe program's low-energy floor for iron and heavier
 *    (verified: xenon/gold reject below ~300 keV total), and resampling a fresh
 *    particle/material/energy draw is simpler and more robust than hand-deriving a
 *    per-ion floor. (The other edge considered — DEFAULT's adaptive CSDA integrator
 *    "recursing unboundedly at very low energies" — was checked directly and does not
 *    occur: energyBoundsError() rejects out-of-range energies before the integrator
 *    ever runs, confirmed in well under a millisecond even at calcium/uranium's lowest
 *    valid energy.)
 *
 * Output: a single JSON array of {id, text, quantity, multi, slotTruth}. `slotTruth` is
 * ground truth for scoring — derived from the exact words/values used to build the
 * sentence, not reverse-engineered from the parsed intent — consumed by
 * scripts/asr-score-slots-generic.mjs. The validator (scripts/tts-sentence-check.ts)
 * only reads {id, text}; the extra fields are inert to it.
 *
 * Usage: node scripts/generate-1000-sentences.mjs <outFile>
 */
import { writeFileSync } from "fs";
import { checkCandidate, loadService } from "./tts-sentence-check.ts";

// ---------------------------------------------------------------------------
// Pools — every entry confirmed to resolve correctly against libdedx in prior sessions.
// ---------------------------------------------------------------------------

// { phrase: singular form as written in a single-particle sentence,
//   listForm: plural/list form for coordinated lists ("X and Y ions"),
//   bare: slot regex for the element/particle name (isotope number not required — mirrors
//     the original hand-authored SLOTS table's treatment of generic ion mentions),
//   isLight: true for H/He isotopes (energies expressed as plain MeV, not per-nucleon) }
const PARTICLES = [
  { phrase: "proton", listForm: "protons", bare: "protons?", isLight: true, isProton: true },
  { phrase: "deuteron", listForm: "deuterons", bare: "deuterons?", isLight: true },
  { phrase: "triton", listForm: "tritons", bare: "tritons?", isLight: true },
  { phrase: "alpha particle", listForm: "alpha particles", bare: "alpha", isLight: true },
  { phrase: "helium-3 ion", listForm: "helium-3 ions", bare: "helium", isLight: true },
  { phrase: "lithium-7 ion", listForm: "lithium-7 ions", bare: "lithium" },
  { phrase: "beryllium-9 ion", listForm: "beryllium-9 ions", bare: "beryllium" },
  { phrase: "boron-11 ion", listForm: "boron-11 ions", bare: "boron" },
  { phrase: "carbon-12 ion", listForm: "carbon-12 ions", bare: "carbon" },
  { phrase: "carbon-13 ion", listForm: "carbon-13 ions", bare: "carbon" },
  { phrase: "nitrogen-14 ion", listForm: "nitrogen-14 ions", bare: "nitrogen" },
  { phrase: "oxygen-16 ion", listForm: "oxygen-16 ions", bare: "oxygen" },
  { phrase: "fluorine-19 ion", listForm: "fluorine-19 ions", bare: "fluorine" },
  { phrase: "neon-20 ion", listForm: "neon-20 ions", bare: "neon" },
  { phrase: "magnesium-24 ion", listForm: "magnesium-24 ions", bare: "magnesium" },
  { phrase: "silicon-28 ion", listForm: "silicon-28 ions", bare: "silicon" },
  { phrase: "phosphorus-31 ion", listForm: "phosphorus-31 ions", bare: "phosphorus" },
  { phrase: "sulfur-32 ion", listForm: "sulfur-32 ions", bare: "sulfur" },
  { phrase: "chlorine-35 ion", listForm: "chlorine-35 ions", bare: "chlorine" },
  { phrase: "argon-40 ion", listForm: "argon-40 ions", bare: "argon" },
  // Z > 18 — fail unconditionally via the auto-selected MSTAR program (no tabulated data
  // at any energy/material) but compute correctly via the Bethe fallback added in #81.
  // A representative long-tail rather than the full Z=20..98 space: calcium (bone/space-
  // radiation relevant), iron (the flagship GCR/space-radiation ion), and a spread up to
  // uranium for general robustness (docs/tts-eval-1000.md's own examples: Kr, Xe, Au, Pb, U).
  { phrase: "calcium-40 ion", listForm: "calcium-40 ions", bare: "calcium" },
  { phrase: "iron-56 ion", listForm: "iron-56 ions", bare: "iron" },
  { phrase: "krypton-84 ion", listForm: "krypton-84 ions", bare: "krypton" },
  { phrase: "xenon-132 ion", listForm: "xenon-132 ions", bare: "xenon" },
  { phrase: "gold-197 ion", listForm: "gold-197 ions", bare: "gold" },
  { phrase: "lead-208 ion", listForm: "lead-208 ions", bare: "lead" },
  { phrase: "uranium-238 ion", listForm: "uranium-238 ions", bare: "uranium" },
];
const LIGHT_IONS = PARTICLES.filter((p) => p.isLight);
const HEAVY_IONS = PARTICLES.filter((p) => !p.isLight);
const PROTON = PARTICLES[0];

const MATERIALS = [
  { phrase: "water", bare: "water" },
  { phrase: "air", bare: "\\bair\\b" },
  { phrase: "PMMA", bare: "pmma" },
  { phrase: "A-150 tissue-equivalent plastic", bare: "a[- ]?150" },
  { phrase: "cortical bone", bare: "bone" },
  { phrase: "compact bone", bare: "bone" },
  { phrase: "adipose tissue", bare: "adipose" },
  { phrase: "muscle tissue", bare: "muscle" },
  { phrase: "silicon", bare: "silicon" },
  { phrase: "silicon dioxide", bare: "silicon" },
  // NOT "alumin" — the scorer wraps every `bare` pattern in `\b...\b` (whole-word
  // boundaries), and `\balumin\b` can never match "aluminum"/"aluminium" at all (the
  // boundary requires a non-letter immediately after "alumin", but the word continues
  // with "u"). This silently failed the material slot on every aluminum/aluminum-oxide
  // clip regardless of what the ASR actually said — a scoring bug, not a real ASR miss.
  { phrase: "aluminum", bare: "aluminum|aluminium" },
  { phrase: "aluminum oxide", bare: "aluminum|aluminium" },
  { phrase: "gold", bare: "gold" },
  { phrase: "graphite", bare: "graphite" },
  { phrase: "polyethylene", bare: "polyethylene" },
  { phrase: "polystyrene", bare: "polystyrene" },
  { phrase: "Kapton", bare: "kapton" },
  { phrase: "Mylar", bare: "mylar" },
  { phrase: "lithium fluoride", bare: "lithium fluoride" },
  { phrase: "sodium iodide", bare: "sodium iodide|nai" },
  { phrase: "cesium iodide", bare: "cesium iodide|csi" },
  { phrase: "Pyrex glass", bare: "glass|pyrex" },
  { phrase: "Teflon", bare: "teflon" },
  { phrase: "polycarbonate", bare: "polycarbonate" },
  // Previously excluded — confirmed unconditionally broken (libdedx err 202) on the old
  // WASM; the #81 Bethe fallback now computes all six. These are the most clinically
  // realistic materials in the whole pool (radiotherapy/dosimetry queries), not exotic
  // additions, so they're weighted into the same flat pool as everything else.
  { phrase: "soft tissue", bare: "soft tissue" },
  { phrase: "skin", bare: "skin" },
  { phrase: "lung", bare: "lung" },
  { phrase: "brain", bare: "brain" },
  { phrase: "blood", bare: "blood" },
  { phrase: "concrete", bare: "concrete" },
  // Boron family — the original motivating case for #81 (proton + Boron used to hit a
  // raw libdedx error code with no clear message; now resolves via Bethe).
  { phrase: "boron", bare: "boron" },
  { phrase: "boron carbide", bare: "boron carbide" },
  { phrase: "boron oxide", bare: "boron oxide" },
];

const PROTON_MEV = [
  10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 120, 150, 180, 200, 220, 250, 300, 350,
];
const PROTON_GEV = [1, 1.5, 2, 3, 4];
const PROTON_KEV = [300, 500, 700, 900];
const LIGHT_MEV = [2, 5, 8, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100];
const HEAVY_MEV_NUCL = [20, 30, 40, 50, 60, 80, 100, 120, 150, 180, 200, 250, 300, 350, 400];
const HEAVY_KEV = [50, 100, 150, 200, 250, 300, 350, 400, 500]; // implantation flavor (B/P/Si/etc in silicon)

const RANGE_TARGETS_CM = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 20, 25, 30];
const RANGE_TARGETS_MM = [5, 10, 15, 20, 30, 50];

// ---------------------------------------------------------------------------
// Small deterministic PRNG (mulberry32) — reproducible without Math.random(), seeded once.
// ---------------------------------------------------------------------------
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(20260716); // fixed seed = reproducible generation

function pick(arr) {
  return arr[Math.floor(rng() * arr.length)];
}
function pickN(arr, n) {
  const pool = [...arr];
  const out = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}
function joinList(words) {
  if (words.length === 1) return words[0];
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(", ")}, and ${words[words.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Energy sampling per particle
// ---------------------------------------------------------------------------
function sampleEnergy(particle) {
  if (particle.isProton) {
    const r = rng();
    if (r < 0.08) return { value: pick(PROTON_GEV), unit: "GeV" };
    if (r < 0.16) return { value: pick(PROTON_KEV), unit: "keV" };
    return { value: pick(PROTON_MEV), unit: "MeV" };
  }
  if (particle.isLight) {
    return { value: pick(LIGHT_MEV), unit: "MeV" };
  }
  // Heavy ion: mostly per-nucleon MeV (therapy/space-radiation register); occasionally a
  // bare keV/MeV total energy (semiconductor-implantation register — energyToMeVPerNucl
  // divides by mass number since it's read as *total*, still lands in libdedx's valid range).
  const r = rng();
  if (r < 0.15) return { value: pick(HEAVY_KEV), unit: "keV" };
  return { value: pick(HEAVY_MEV_NUCL), unit: "MeV", perNucleon: true };
}
function energyPhrase(e) {
  return e.perNucleon ? `${e.value} MeV per nucleon` : `${e.value} ${e.unit}`;
}

// ---------------------------------------------------------------------------
// Spoken unit-rendering variance (issue #118 TODO item 1, docs/unit-pronunciation-asr.md §7#1):
// a bare abbreviation is only one of several ways a human reads these units aloud, and no single
// TTS engine's G2P covers the range (§3 of that doc) — so the corpus's INPUT TEXT needs to vary
// the rendering rather than relying on synthesis quirks to do it by accident.
//
// This is applied to `attempt.text` in buildCategory() AFTER checkCandidate() has already
// validated the sentence — never before. The real matcher (src/lib/intent/matcher.ts's
// energyRe/STP_UNIT_RE) only recognizes the bare abbreviation, which is also, per §1, exactly
// what Whisper's own ASR normalizes any spoken rendering back to before the matcher ever sees a
// real transcript — so validating against the abbreviated form matches what actually reaches the
// matcher in the real pipeline. Rendering a unit into something else *before* validation instead
// breaks multi-energy candidates silently: matchIntent only recognizes whichever energies still
// say "MeV"/"keV"/"GeV" in a list like "50, 100, and 150 MeV", and "at least one energy found" is
// enough to pass the incompleteness check — so a sentence can validate "ok" while quietly having
// fewer energies than slotTruth lists.
const ENERGY_UNIT_WORDS = {
  keV: ["keV", "kiloelectronvolt", "kilo electron volt"],
  MeV: ["MeV", "megaelectronvolt", "mega electron volt"],
  GeV: ["GeV", "gigaelectronvolt", "giga electron volt"],
};
const LENGTH_UNIT_WORDS = {
  cm: ["cm", "centimeter"],
  mm: ["mm", "millimeter"],
};
const UNIT_WORDS = { ...ENERGY_UNIT_WORDS, ...LENGTH_UNIT_WORDS };

// No strong evidence for the "true" human distribution — that's the open question issue #118
// investigates, not something settled here. Biased toward the bare abbreviation (still the
// majority rendering in the real-lecture forced-alignment sample, docs/unit-pronunciation-asr.md
// §6.4) while giving the other renderings enough weight to actually exercise the corrector and
// matcher against them.
function renderUnitWord(words) {
  const r = rng();
  if (words.length === 3) return r < 0.5 ? words[0] : r < 0.8 ? words[1] : words[2];
  return r < 0.5 ? words[0] : words[1];
}

// One rendering choice per unit-abbreviation PRESENT in the sentence (not per occurrence) — a
// multi-energy sentence repeating "MeV" reads more like one speaker's consistent habit than a
// mid-sentence style switch, and it keeps this from multiplying rng() draws unpredictably based
// on how many times a unit happens to appear.
function renderUnitsForSpeech(text) {
  let out = text;
  for (const [abbrev, words] of Object.entries(UNIT_WORDS)) {
    const boundary = `\\b${abbrev}\\b`;
    if (!new RegExp(boundary).test(out)) continue;
    const rendering = renderUnitWord(words);
    if (rendering !== abbrev) out = out.replace(new RegExp(boundary, "g"), rendering);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phrasing templates — each entry is { fn, kw }. `kw` is the exact quantity-indicating
// phrase *that template's own text actually contains* (a regex-ready fragment), recorded
// as slot-truth ground truth. Earlier draft mistakenly recorded a fixed "range"/"stopping
// power" label for every template regardless of which one fired, which is wrong for indirect
// phrasings ("how far will X travel" never says the word "range" at all) — fixed by pairing
// each template with its own keyword instead of guessing one after the fact.
// ---------------------------------------------------------------------------
function pickT(templates) {
  return pick(templates);
}

const RANGE_SINGLE_TEMPLATES = [
  {
    fn: (p, m, e) => `What is the CSDA range of a ${energyPhrase(e)} ${p.phrase} in ${m.phrase}?`,
    kw: "range",
  },
  {
    fn: (p, m, e) => `How far will a ${energyPhrase(e)} ${p.phrase} travel through ${m.phrase}?`,
    kw: "how far",
  },
  {
    fn: (p, m, e) => `How deep does a ${energyPhrase(e)} ${p.phrase} penetrate into ${m.phrase}?`,
    kw: "penetrat",
  },
  {
    fn: (p, m, e) => `Determine the range of ${energyPhrase(e)} ${p.listForm} in ${m.phrase}.`,
    kw: "range",
  },
  {
    fn: (p, m, e) => `What's the range of a ${energyPhrase(e)} ${p.phrase} in ${m.phrase}?`,
    kw: "range",
  },
  {
    fn: (p, m, e) =>
      `Before coming to rest, how far does a ${energyPhrase(e)} ${p.phrase} get through ${m.phrase}?`,
    kw: "how far",
  },
  {
    fn: (p, m, e) => `Find the CSDA range for ${energyPhrase(e)} ${p.listForm} in ${m.phrase}.`,
    kw: "range",
  },
  {
    fn: (p, m, e) =>
      `So, roughly how far would a ${energyPhrase(e)} ${p.phrase} make it into ${m.phrase}?`,
    kw: "how far",
  },
  {
    fn: (p, m, e) => `Range of a ${energyPhrase(e)} ${p.phrase} in ${m.phrase}, please.`,
    kw: "range",
  },
  {
    fn: (p, m, e) => `Quick one — how far does a ${energyPhrase(e)} ${p.phrase} go in ${m.phrase}?`,
    kw: "how far",
  },
];
const RANGE_MULTI_ENERGY_TEMPLATES = [
  {
    fn: (p, m, es) =>
      `What is the range of ${p.listForm} in ${m.phrase} at ${joinList(es.map((e) => energyPhrase(e)))}?`,
    kw: "range",
  },
  {
    fn: (p, m, es) =>
      `Compare the CSDA range of ${p.listForm} in ${m.phrase} at ${joinList(es.map((e) => energyPhrase(e)))}.`,
    kw: "range",
  },
  {
    fn: (p, m, es) =>
      `How far will a ${p.phrase} travel through ${m.phrase} at ${joinList(es.map((e) => energyPhrase(e)))}?`,
    kw: "how far",
  },
];
const RANGE_MULTI_MATERIAL_TEMPLATES = [
  {
    fn: (p, ms, e) =>
      `Compare the range of a ${energyPhrase(e)} ${p.phrase} in ${joinList(ms.map((m) => m.phrase))}.`,
    kw: "range",
  },
  {
    fn: (p, ms, e) =>
      `What is the CSDA range of ${energyPhrase(e)} ${p.listForm} in ${joinList(ms.map((m) => m.phrase))}?`,
    kw: "range",
  },
];
// Deliberately NOT a coordinated "X and Y ions" list: the matcher's PARTICLE_LIST_RE
// expects every member to share one trailing head noun ("carbon and neon ions"), and a
// mix of a named particle ("alpha particles") with an element-ion phrase ("neon-20 ions")
// has two different head nouns. That confuses the list regex into treating the first
// phrase's own head word ("ions") as if it were itself a list member — and "ions" then
// fuzzy-matches to element Iron (edit distance 1 from "iron"), silently substituting a
// completely wrong particle. Each mention below is a fully self-contained "a <energy>
// <particle>" clause instead, which PARTICLE_HEAD_RE/NAMED_PARTICLE_RE each match
// independently with no list coordination involved — confirmed by testing directly
// against matchIntent before relying on it here.
const RANGE_MULTI_PARTICLE_TEMPLATES = [
  {
    fn: (ps, m, e) =>
      `Compare the range of ${ps.map((p) => `a ${energyPhrase(e)} ${p.phrase}`).join(" and ")} in ${m.phrase}.`,
    kw: "range",
  },
  {
    fn: (ps, m, e) =>
      `Between ${ps.map((p) => `a ${energyPhrase(e)} ${p.phrase}`).join(" and ")}, which will travel farther in ${m.phrase}?`,
    kw: "travel",
  },
];

const STP_SINGLE_TEMPLATES = [
  {
    fn: (p, m, e) =>
      `What is the stopping power of a ${energyPhrase(e)} ${p.phrase} in ${m.phrase}?`,
    kw: "stopping power",
  },
  {
    fn: (p, m, e) =>
      `Determine the mass stopping power of ${energyPhrase(e)} ${p.listForm} in ${m.phrase}.`,
    kw: "stopping power",
  },
  {
    fn: (p, m, e) => `dE/dx for a ${energyPhrase(e)} ${p.phrase} in ${m.phrase}.`,
    kw: "de\\/dx|de dx|dedx",
  },
  {
    fn: (p, m, e) =>
      `How much energy does a ${energyPhrase(e)} ${p.phrase} lose per centimeter in ${m.phrase}?`,
    kw: "lose",
  },
  {
    fn: (p, m, e) =>
      `What's the stopping power of ${energyPhrase(e)} ${p.listForm} in ${m.phrase}?`,
    kw: "stopping power",
  },
  {
    fn: (p, m, e) =>
      `At what rate does a ${energyPhrase(e)} ${p.phrase} shed energy in ${m.phrase}?`,
    kw: "shed energy|at what rate",
  },
  {
    fn: (p, m, e) =>
      `Report the electronic stopping power of a ${energyPhrase(e)} ${p.phrase} in ${m.phrase}.`,
    kw: "stopping power",
  },
  {
    fn: (p, m, e) =>
      `Quick question — what's the stopping power of a ${energyPhrase(e)} ${p.phrase} in ${m.phrase}?`,
    kw: "stopping power",
  },
];
const STP_MULTI_ENERGY_TEMPLATES = [
  {
    fn: (p, m, es) =>
      `What is the stopping power of ${p.listForm} in ${m.phrase} at ${joinList(es.map((e) => energyPhrase(e)))}?`,
    kw: "stopping power",
  },
  {
    fn: (p, m, es) =>
      `Compare the mass stopping power of ${p.listForm} in ${m.phrase} at ${joinList(es.map((e) => energyPhrase(e)))}.`,
    kw: "stopping power",
  },
];
const STP_MULTI_MATERIAL_TEMPLATES = [
  {
    fn: (p, ms, e) =>
      `Compare the stopping power of a ${energyPhrase(e)} ${p.phrase} in ${joinList(ms.map((m) => m.phrase))}.`,
    kw: "stopping power",
  },
];
// Same list-regex trap as RANGE_MULTI_PARTICLE_TEMPLATES — self-contained mentions, no
// coordinated "X and Y ions/particles" grammar.
const STP_MULTI_PARTICLE_TEMPLATES = [
  {
    fn: (ps, m, e) =>
      `Compare the stopping power of ${ps.map((p) => `a ${energyPhrase(e)} ${p.phrase}`).join(" and ")} in ${m.phrase}.`,
    kw: "stopping power",
  },
];

// LET ("linear energy transfer") is the term real users in particle therapy/radiobiology
// actually say, far more often than "stopping power" — matcher support: #86. `kw` uses
// `\blet\b` (not bare "let") since the scorer's regex has no word boundaries by default
// and "let" is a common substring (violet, outlet, wallet); word-boundary it explicitly
// to avoid false-positive scoring hits on unrelated words in the ASR transcript.
const STP_SINGLE_LET_TEMPLATES = [
  {
    fn: (p, m, e) => `What is the LET of a ${energyPhrase(e)} ${p.phrase} in ${m.phrase}?`,
    kw: "\\blet\\b",
  },
  {
    fn: (p, m, e) =>
      `What is the linear energy transfer of ${energyPhrase(e)} ${p.listForm} in ${m.phrase}?`,
    kw: "linear energy transfer",
  },
  {
    fn: (p, m, e) => `Give me the LET of a ${energyPhrase(e)} ${p.phrase} in ${m.phrase}.`,
    kw: "\\blet\\b",
  },
  {
    fn: (p, m, e) =>
      `Determine the linear energy transfer for ${energyPhrase(e)} ${p.listForm} in ${m.phrase}.`,
    kw: "linear energy transfer",
  },
  {
    fn: (p, m, e) => `What's the LET of a ${energyPhrase(e)} ${p.phrase} in ${m.phrase}?`,
    kw: "\\blet\\b",
  },
  {
    fn: (p, m, e) => `Report the LET for a ${energyPhrase(e)} ${p.phrase} in ${m.phrase}.`,
    kw: "\\blet\\b",
  },
  {
    fn: (p, m, e) =>
      `Quick question — what's the linear energy transfer of a ${energyPhrase(e)} ${p.phrase} in ${m.phrase}?`,
    kw: "linear energy transfer",
  },
];
const STP_MULTI_ENERGY_LET_TEMPLATES = [
  {
    fn: (p, m, es) =>
      `What is the LET of ${p.listForm} in ${m.phrase} at ${joinList(es.map((e) => energyPhrase(e)))}?`,
    kw: "\\blet\\b",
  },
  {
    fn: (p, m, es) =>
      `Compare the linear energy transfer of ${p.listForm} in ${m.phrase} at ${joinList(es.map((e) => energyPhrase(e)))}.`,
    kw: "linear energy transfer",
  },
];
const STP_MULTI_MATERIAL_LET_TEMPLATES = [
  {
    fn: (p, ms, e) =>
      `Compare the LET of a ${energyPhrase(e)} ${p.phrase} in ${joinList(ms.map((m) => m.phrase))}.`,
    kw: "\\blet\\b",
  },
];
// Same list-regex trap as STP_MULTI_PARTICLE_TEMPLATES — self-contained mentions.
const STP_MULTI_PARTICLE_LET_TEMPLATES = [
  {
    fn: (ps, m, e) =>
      `Compare the LET of ${ps.map((p) => `a ${energyPhrase(e)} ${p.phrase}`).join(" and ")} in ${m.phrase}.`,
    kw: "\\blet\\b",
  },
];

const INVRNG_SINGLE_TEMPLATES = [
  {
    fn: (p, m, v, u) => `What energy gives a ${v} ${u} range in ${m.phrase} for ${p.listForm}?`,
    kw: "what energy",
  },
  // NOT "Which <particle> energy is needed..." — detectInverse()'s "which/what + up to 3
  // words + energy" regex requires each intervening word to be plain letters (`[a-z]+`); a
  // hyphenated isotope phrase like "silicon-28 ion" breaks that match entirely (the "-28"
  // has no word boundary the regex can cross), so the query silently falls through to a
  // forward "range" reading instead of the intended inverse one. Keeping "which"/"what"
  // immediately adjacent to "energy" avoids this regardless of which particle follows —
  // confirmed against matchIntent before relying on it here.
  {
    fn: (p, m, v, u) =>
      `Which energy does a ${p.phrase} need for a ${v} ${u} range in ${m.phrase}?`,
    kw: "which energy",
  },
  {
    fn: (p, m, v, u) => `How energetic must a ${p.phrase} be for a ${v} ${u} range in ${m.phrase}?`,
    kw: "how energetic",
  },
  {
    fn: (p, m, v, u) => `For a ${v} ${u} range in ${m.phrase}, what energy do ${p.listForm} need?`,
    kw: "what energy",
  },
  {
    fn: (p, m, v, u) => `What energy do ${p.listForm} need for a ${v} ${u} range in ${m.phrase}?`,
    kw: "what energy",
  },
];
const INVRNG_MULTI_MATERIAL_TEMPLATES = [
  // Same which/what+energy adjacency rule as INVRNG_SINGLE_TEMPLATES above.
  {
    fn: (p, ms, v, u) =>
      `Which energy does a ${p.phrase} need for a ${v} ${u} range in ${joinList(ms.map((m) => m.phrase))}?`,
    kw: "which energy",
  },
  {
    fn: (p, ms, v, u) =>
      `What energy do ${p.listForm} need for a ${v} ${u} range in ${joinList(ms.map((m) => m.phrase))}?`,
    kw: "what energy",
  },
];
// Two short questions rather than one coordinated-list sentence — sidesteps the
// PARTICLE_LIST_RE trap (see RANGE_MULTI_PARTICLE_TEMPLATES) entirely by never placing
// "and"/"," directly between the two particle mentions; confirmed safe against matchIntent.
const INVRNG_MULTI_PARTICLE_TEMPLATES = [
  {
    fn: (ps, m, v, u) =>
      `What energy do ${ps[0].listForm} need for a ${v} ${u} range in ${m.phrase}? What about ${ps[1].listForm}?`,
    kw: "what energy",
  },
];

// ---------------------------------------------------------------------------
// Builders — each returns { text, slotTruth }
// ---------------------------------------------------------------------------
function buildRangeSingle() {
  const heavy = rng() < 0.4;
  const p = heavy ? pick(HEAVY_IONS) : pick(LIGHT_IONS.concat([PROTON, PROTON]));
  const m = pick(MATERIALS);
  const e = sampleEnergy(p);
  const t = pickT(RANGE_SINGLE_TEMPLATES);
  return {
    text: t.fn(p, m, e),
    slotTruth: { quantityKeyword: t.kw, particles: [p.bare], materials: [m.bare], energies: [e] },
  };
}
function buildRangeMultiEnergy() {
  const p = rng() < 0.4 ? pick(HEAVY_IONS) : PROTON;
  const m = pick(MATERIALS);
  const n = rng() < 0.5 ? 2 : 3;
  const es = Array.from({ length: n }, () => sampleEnergy(p));
  const t = pickT(RANGE_MULTI_ENERGY_TEMPLATES);
  return {
    text: t.fn(p, m, es),
    slotTruth: { quantityKeyword: t.kw, particles: [p.bare], materials: [m.bare], energies: es },
  };
}
function buildRangeMultiMaterial() {
  const p = rng() < 0.4 ? pick(HEAVY_IONS) : PROTON;
  const ms = pickN(MATERIALS, rng() < 0.5 ? 2 : 3);
  const e = sampleEnergy(p);
  const t = pickT(RANGE_MULTI_MATERIAL_TEMPLATES);
  return {
    text: t.fn(p, ms, e),
    slotTruth: {
      quantityKeyword: t.kw,
      particles: [p.bare],
      materials: ms.map((m) => m.bare),
      energies: [e],
    },
  };
}
function buildRangeMultiParticle() {
  const ps = pickN(LIGHT_IONS.concat(HEAVY_IONS), 2);
  const m = pick(MATERIALS);
  const e = sampleEnergy(ps[0]);
  const t = pickT(RANGE_MULTI_PARTICLE_TEMPLATES);
  return {
    text: t.fn(ps, m, e),
    slotTruth: {
      quantityKeyword: t.kw,
      particles: ps.map((p) => p.bare),
      materials: [m.bare],
      energies: [e],
    },
  };
}

// ~50% of the stoppingPower category uses LET terminology instead of "stopping power"
// (issue #83) — the term real users in particle therapy/radiobiology actually say.
function pickStpTemplate(classic, let_) {
  return pickT(rng() < 0.5 ? let_ : classic);
}

function buildStpSingle() {
  const heavy = rng() < 0.4;
  const p = heavy ? pick(HEAVY_IONS) : pick(LIGHT_IONS.concat([PROTON, PROTON]));
  const m = pick(MATERIALS);
  const e = sampleEnergy(p);
  const t = pickStpTemplate(STP_SINGLE_TEMPLATES, STP_SINGLE_LET_TEMPLATES);
  return {
    text: t.fn(p, m, e),
    slotTruth: {
      quantityKeyword: t.kw,
      particles: [p.bare],
      materials: [m.bare],
      energies: [e],
    },
  };
}
function buildStpMultiEnergy() {
  const p = rng() < 0.4 ? pick(HEAVY_IONS) : PROTON;
  const m = pick(MATERIALS);
  const es = Array.from({ length: rng() < 0.5 ? 2 : 3 }, () => sampleEnergy(p));
  const t = pickStpTemplate(STP_MULTI_ENERGY_TEMPLATES, STP_MULTI_ENERGY_LET_TEMPLATES);
  return {
    text: t.fn(p, m, es),
    slotTruth: {
      quantityKeyword: t.kw,
      particles: [p.bare],
      materials: [m.bare],
      energies: es,
    },
  };
}
function buildStpMultiMaterial() {
  const p = rng() < 0.4 ? pick(HEAVY_IONS) : PROTON;
  const ms = pickN(MATERIALS, rng() < 0.5 ? 2 : 3);
  const e = sampleEnergy(p);
  const t = pickStpTemplate(STP_MULTI_MATERIAL_TEMPLATES, STP_MULTI_MATERIAL_LET_TEMPLATES);
  return {
    text: t.fn(p, ms, e),
    slotTruth: {
      quantityKeyword: t.kw,
      particles: [p.bare],
      materials: ms.map((m) => m.bare),
      energies: [e],
    },
  };
}
function buildStpMultiParticle() {
  const ps = pickN(LIGHT_IONS.concat(HEAVY_IONS), 2);
  const m = pick(MATERIALS);
  const e = sampleEnergy(ps[0]);
  const t = pickStpTemplate(STP_MULTI_PARTICLE_TEMPLATES, STP_MULTI_PARTICLE_LET_TEMPLATES);
  return {
    text: t.fn(ps, m, e),
    slotTruth: {
      quantityKeyword: t.kw,
      particles: ps.map((p) => p.bare),
      materials: [m.bare],
      energies: [e],
    },
  };
}

function sampleTarget() {
  if (rng() < 0.75) return { value: pick(RANGE_TARGETS_CM), unit: "cm" };
  return { value: pick(RANGE_TARGETS_MM), unit: "mm" };
}
function buildInvRngSingle() {
  const heavy = rng() < 0.3;
  const p = heavy ? pick(HEAVY_IONS) : pick(LIGHT_IONS.concat([PROTON, PROTON, PROTON]));
  const m = pick(MATERIALS);
  const t = sampleTarget();
  const tpl = pickT(INVRNG_SINGLE_TEMPLATES);
  return {
    text: tpl.fn(p, m, t.value, t.unit),
    slotTruth: {
      quantityKeyword: tpl.kw,
      isInverse: true,
      particles: [p.bare],
      materials: [m.bare],
      target: t,
    },
  };
}
function buildInvRngMultiMaterial() {
  const p = rng() < 0.3 ? pick(HEAVY_IONS) : PROTON;
  const ms = pickN(MATERIALS, rng() < 0.5 ? 2 : 3);
  const t = sampleTarget();
  const tpl = pickT(INVRNG_MULTI_MATERIAL_TEMPLATES);
  return {
    text: tpl.fn(p, ms, t.value, t.unit),
    slotTruth: {
      quantityKeyword: tpl.kw,
      isInverse: true,
      particles: [p.bare],
      materials: ms.map((m) => m.bare),
      target: t,
    },
  };
}
function buildInvRngMultiParticle() {
  const ps = pickN(LIGHT_IONS.concat(HEAVY_IONS), 2);
  const m = pick(MATERIALS);
  const t = sampleTarget();
  const tpl = pickT(INVRNG_MULTI_PARTICLE_TEMPLATES);
  return {
    text: tpl.fn(ps, m, t.value, t.unit),
    slotTruth: {
      quantityKeyword: tpl.kw,
      isInverse: true,
      particles: ps.map((p) => p.bare),
      materials: [m.bare],
      target: t,
    },
  };
}

// ---------------------------------------------------------------------------
// Assemble the 1000. Two checks gate every candidate before it's accepted, both with
// bounded resampling (a fresh fn() draw — new particle/material/energy, not just a
// patched energy) rather than a hand-derived per-pool exception list:
//  - dedup: the same particle+material+energy combo, same template, can collide across
//    independent draws at this pool size;
//  - validity (v2, issue #83): every candidate is checked against the real matcher +
//    libdedx WASM (scripts/tts-sentence-check.ts's checkCandidate — the exact logic that
//    used to run only as a separate pass after generation). This is what makes the wider
//    Z>18 ion pool and the heavy-ion keV "implantation" energy register safe to sample
//    from at all: e.g. xenon/gold below ~300 keV total resolve to <1 keV/nucl, under the
//    Bethe program's low-energy floor, and fail cleanly here instead of silently landing
//    in the batch as an uncomputed query.
// ---------------------------------------------------------------------------
function buildCategory(
  prefix,
  quantity,
  n,
  singleFrac,
  multiEnergyFrac,
  multiMaterialFrac,
  builders,
  service,
) {
  const out = [];
  const seenText = new Set();
  const nSingle = Math.round(n * singleFrac);
  const nMultiEnergy = builders.multiEnergy ? Math.round(n * multiEnergyFrac) : 0;
  const nMultiMaterial = Math.round(n * multiMaterialFrac);
  const nMultiParticle = n - nSingle - nMultiEnergy - nMultiMaterial;

  const plan = [
    ...Array(nSingle).fill({ fn: builders.single, multi: null }),
    ...Array(nMultiEnergy).fill({ fn: builders.multiEnergy, multi: "energy" }),
    ...Array(nMultiMaterial).fill({ fn: builders.multiMaterial, multi: "material" }),
    ...Array(nMultiParticle).fill({ fn: builders.multiParticle, multi: "particle" }),
  ];

  let i = 0;
  for (const { fn, multi } of plan) {
    const id = `${prefix}-${String(i + 1).padStart(4, "0")}`;
    const maxTries = 40;
    let attempt;
    let check;
    let tries = 0;
    do {
      attempt = fn();
      tries++;
      check = seenText.has(attempt.text)
        ? { ok: false, reason: "duplicate text" }
        : checkCandidate({ id, text: attempt.text }, service);
    } while (!check.ok && tries < maxTries);
    if (!check.ok) {
      // Fail loudly rather than ship an uncomputed query — the whole point of closing
      // the generate→validate loop is that this should never actually happen; if it
      // does, the pool/template needs a fix, not a silently-invalid sentence.
      throw new Error(
        `${id}: could not find a valid candidate after ${maxTries} tries. ` +
          `Last attempt: "${attempt.text}" — ${check.reason}`,
      );
    }
    seenText.add(attempt.text);
    i++;
    out.push({
      id,
      text: renderUnitsForSpeech(attempt.text),
      quantity,
      multi,
      slotTruth: attempt.slotTruth,
    });
  }
  return out;
}

async function main() {
  const outFile = process.argv[2];
  if (!outFile) {
    console.error("Usage: node scripts/generate-1000-sentences.mjs <outFile>");
    process.exit(1);
  }

  console.log("loading libdedx WASM for inline validation...");
  const service = await loadService();

  const rangeBatch = buildCategory(
    "rng",
    "csdaRange",
    600,
    0.8,
    0.1333,
    0.0333,
    {
      single: buildRangeSingle,
      multiEnergy: buildRangeMultiEnergy,
      multiMaterial: buildRangeMultiMaterial,
      multiParticle: buildRangeMultiParticle,
    },
    service,
  );
  const invRngBatch = buildCategory(
    "invrng",
    "energyFromRange",
    250,
    0.8,
    0,
    0.12,
    {
      single: buildInvRngSingle,
      multiEnergy: null,
      multiMaterial: buildInvRngMultiMaterial,
      multiParticle: buildInvRngMultiParticle,
    },
    service,
  );
  const stpBatch = buildCategory(
    "sp",
    "stoppingPower",
    150,
    0.8,
    0.1333,
    0.0333,
    {
      single: buildStpSingle,
      multiEnergy: buildStpMultiEnergy,
      multiMaterial: buildStpMultiMaterial,
      multiParticle: buildStpMultiParticle,
    },
    service,
  );

  const all = [...rangeBatch, ...invRngBatch, ...stpBatch];
  console.log(
    `generated: range=${rangeBatch.length} invRange=${invRngBatch.length} stp=${stpBatch.length} total=${all.length}`,
  );
  console.log(`every candidate already validated against the real matcher + WASM inline.`);

  writeFileSync(outFile, JSON.stringify(all, null, 2));
  console.log(`wrote ${outFile}`);
}

main();
