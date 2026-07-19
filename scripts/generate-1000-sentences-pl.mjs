/**
 * Generates a 1000-sentence Polish TTS eval-audio batch (issue #79 Track 3 / #87), mirroring
 * scripts/generate-1000-sentences.mjs's architecture and the same 600/250/150
 * csdaRange/energyFromRange/stoppingPower balance exactly.
 *
 * Every particle/material word form used here is drawn from the physicist-reviewed
 * eval/RECORDING.pl.md 50-sentence set (via src/lib/aliases/{elements,materials,particles}.ts),
 * not invented — Polish's 7-case declension means a guessed form can be silently wrong in a
 * way that only a native speaker would catch, so the pool is deliberately scoped to forms
 * already vetted rather than the full English pool's breadth. Sentence *shapes* (which verb,
 * which case, "jon"-prefix vs. bare named particle) likewise mirror the exact constructions
 * RECORDING.pl.md's physicist reviewer used, generalized to take a parameter instead of one
 * fixed entity.
 *
 * Grammar notes baked into the pools below (see src/lib/intent/lang/pl.ts's own doc comment
 * for the matcher-side counterpart):
 *  - An ion is named head-first: "jon węgla" ("ion of-carbon"). The element word is always
 *    genitive regardless of which case "jon" itself takes ("jon" nominative-subject vs.
 *    "jonu" genitive-object, e.g. "zasięg jonu węgla") — so each ion entry only needs ONE
 *    element form (genitive), and a template-selected "jon"/"jonu" wrapper.
 *  - A "w <material>" phrase is always locative — every material below is already stored in
 *    that single locative form, used unchanged regardless of template.
 *  - Named particles (proton, deuteron, tryton, cząstka alfa) never take "jon" and decline on
 *    their own; only proton/tryton/cząstka alfa actually vary by template here (deuteron's
 *    only vetted genitive form, "deuteronu", covers every template that needs it).
 *  - Isotope numbers are omitted in ~95% of cases per RECORDING.pl.md's own domain-review
 *    note — only helium-3 (disambiguating it from the default ⁴He/"cząstka alfa") keeps one,
 *    represented here as its own light-ion pool entry rather than a rare suffix toggle.
 *
 * Usage: node --experimental-strip-types scripts/generate-1000-sentences-pl.mjs <outFile>
 */
import { writeFileSync } from "fs";
import { checkCandidate, loadService } from "./tts-sentence-check.ts";

// ---------------------------------------------------------------------------
// Particles — { kind: "named"|"ion", nom, gen, dat?, bare, isLight, isProton? }
// `bare` is a scoring regex source (see asr-score-slots-generic.mjs): a single fixed
// genitive form for "ion" particles (always genitive after "jon"/"jonu"), an alternation
// of every case form actually used in a template below for "named" particles.
// ---------------------------------------------------------------------------
function ion(nom, gen, isLight = false) {
  return { kind: "ion", nom, gen, bare: gen, isLight };
}
const PARTICLES = [
  {
    kind: "named",
    nom: "proton",
    gen: "protonu",
    bare: "proton(?:u|y|ów)?",
    isLight: true,
    isProton: true,
  },
  { kind: "named", nom: "deuteron", gen: "deuteronu", bare: "deuteron(?:u)?", isLight: true },
  { kind: "named", nom: "tryton", gen: "trytonu", bare: "tryton(?:u)?", isLight: true },
  {
    kind: "named",
    nom: "cząstka alfa",
    gen: "cząstki alfa",
    dat: "cząstce alfa",
    bare: "cząstk[ai] alfa|cząstce alfa",
    isLight: true,
  },
  ion("hel", "helu-3", true), // always the disambiguated isotope — see doc comment above
  ion("lit", "litu"),
  ion("bor", "boru"),
  ion("węgiel", "węgla"),
  ion("azot", "azotu"),
  ion("tlen", "tlenu"),
  ion("neon", "neonu"),
  ion("magnez", "magnezu"),
  ion("krzem", "krzemu"),
  ion("argon", "argonu"),
  ion("wapń", "wapnia"),
  ion("tytan", "tytanu"),
  ion("żelazo", "żelaza"),
  ion("miedź", "miedzi"),
  ion("krypton", "kryptonu"),
  ion("ksenon", "ksenonu"),
];
const LIGHT_IONS = PARTICLES.filter((p) => p.isLight);
const HEAVY_IONS = PARTICLES.filter((p) => !p.isLight);
const PROTON = PARTICLES[0];

/** "jon <gen>" (nominative-subject slot) or the named particle's own nominative form. */
function pNom(p) {
  return p.kind === "ion" ? `jon ${p.gen}` : p.nom;
}
/** "jonu <gen>" (genitive-object slot, e.g. after "zasięg"/"LET"/"dla") or the named particle's own genitive form. */
function pGen(p) {
  return p.kind === "ion" ? `jonu ${p.gen}` : p.gen;
}
// ---------------------------------------------------------------------------
// Materials — always the locative "w <M>" form, used unchanged by every template.
// ---------------------------------------------------------------------------
const MATERIALS = [
  { phrase: "wodzie", bare: "wodzie" },
  { phrase: "powietrzu", bare: "powietrzu" },
  { phrase: "PMMA", bare: "pmma" },
  { phrase: "tkance mięśniowej", bare: "tkance mięśniowej" },
  { phrase: "tkance tłuszczowej", bare: "tkance tłuszczowej" },
  { phrase: "kości korowej", bare: "kości korowej" },
  { phrase: "kości zbitej", bare: "kości zbitej" },
  { phrase: "Kaptonie", bare: "kaptonie" },
  { phrase: "graficie", bare: "graficie" },
  { phrase: "poliwęglanie", bare: "poliwęglanie" },
  { phrase: "polietylenie", bare: "polietylenie" },
  { phrase: "dwutlenku krzemu", bare: "dwutlenku krzemu" },
  { phrase: "aluminium", bare: "aluminium" },
  { phrase: "złocie", bare: "złocie" },
  { phrase: "ołowiu", bare: "ołowiu" },
  { phrase: "plastiku tkankopodobnym A-150", bare: "plastiku tkankopodobnym a[- ]?150" },
];

// Same numeric pools as the English generator — physics values, language-neutral.
const PROTON_MEV = [
  10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 120, 150, 180, 200, 220, 250, 300, 350,
];
const PROTON_GEV = [1, 1.5, 2, 3, 4];
const PROTON_KEV = [300, 500, 700, 900];
const LIGHT_MEV = [2, 5, 8, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100];
const HEAVY_MEV_NUCL = [20, 30, 40, 50, 60, 80, 100, 120, 150, 180, 200, 250, 300, 350, 400];
const HEAVY_KEV = [50, 100, 150, 200, 250, 300, 350, 400, 500];

const RANGE_TARGETS_CM = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 20, 25, 30];
const RANGE_TARGETS_MM = [5, 10, 15, 20, 30, 50];

// ---------------------------------------------------------------------------
// Small deterministic PRNG (mulberry32) — same seed convention as the English generator,
// a distinct constant so the two files' sequences don't accidentally correlate.
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
const rng = makeRng(20260718);

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
  if (words.length === 2) return `${words[0]} i ${words[1]}`;
  return `${words.slice(0, -1).join(", ")} i ${words[words.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Energy sampling — same distribution shape as the English generator.
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
  const r = rng();
  if (r < 0.15) return { value: pick(HEAVY_KEV), unit: "keV" };
  return { value: pick(HEAVY_MEV_NUCL), unit: "MeV", perNucleon: true };
}
function energyPhrase(e) {
  return e.perNucleon ? `${e.value} MeV na nukleon` : `${e.value} ${e.unit}`;
}

// ---------------------------------------------------------------------------
// Phrasing templates — each entry is { fn, kw }, `kw` a regex-ready quantity-cue fragment
// recorded as slot-truth ground truth, mirroring the English generator's own convention.
// ---------------------------------------------------------------------------
function pickT(templates) {
  return pick(templates);
}

const RANGE_SINGLE_TEMPLATES = [
  {
    fn: (p, m, e) => `Jaki jest zasięg ${pGen(p)} o energii ${energyPhrase(e)} w ${m.phrase}?`,
    kw: "zasięg",
  },
  {
    fn: (p, m, e) => `Ile wynosi zasięg ${pGen(p)} o energii ${energyPhrase(e)} w ${m.phrase}?`,
    kw: "zasięg",
  },
  {
    fn: (p, m, e) => `Podaj zasięg ${pGen(p)} o energii ${energyPhrase(e)} w ${m.phrase}.`,
    kw: "zasięg",
  },
  {
    fn: (p, m, e) => `Jaki zasięg ma ${pNom(p)} o energii ${energyPhrase(e)} w ${m.phrase}?`,
    kw: "zasięg",
  },
  {
    fn: (p, m, e) => `Oblicz zasięg ${pGen(p)} o energii ${energyPhrase(e)} w ${m.phrase}.`,
    kw: "zasięg",
  },
  {
    fn: (p, m, e) => `Jak głęboko wniknie ${pNom(p)} o energii ${energyPhrase(e)} w ${m.phrase}?`,
    kw: "głęboko",
  },
  {
    fn: (p, m, e) => `Jak daleko doleci ${pNom(p)} o energii ${energyPhrase(e)} w ${m.phrase}?`,
    kw: "daleko",
  },
  {
    fn: (p, m, e) => `Jak daleko dotrze ${pNom(p)} o energii ${energyPhrase(e)} w ${m.phrase}?`,
    kw: "daleko",
  },
  {
    fn: (p, m, e) =>
      `Powiedz mi, jak daleko zajdzie ${pNom(p)} o energii ${energyPhrase(e)} w ${m.phrase}.`,
    kw: "zajdzie",
  },
];
const RANGE_MULTI_ENERGY_TEMPLATES = [
  {
    fn: (p, m, es) =>
      `Jaki jest zasięg ${pGen(p)} w ${m.phrase} dla energii ${joinList(es.map((e) => energyPhrase(e)))}?`,
    kw: "zasięg",
  },
  {
    fn: (p, m, es) =>
      `Porównaj zasięg ${pGen(p)} w ${m.phrase} przy ${joinList(es.map((e) => energyPhrase(e)))}.`,
    kw: "zasięg",
  },
];
const RANGE_MULTI_MATERIAL_TEMPLATES = [
  {
    fn: (p, ms, e) =>
      `Porównaj zasięg ${pGen(p)} o energii ${energyPhrase(e)} w ${joinList(ms.map((m) => m.phrase))}.`,
    kw: "zasięg",
  },
];
// Each ion mention is a self-contained "jon <element>" clause — matches the matcher's
// `PARTICLE_LIST_RE: null` design for Polish (see lang/pl.ts) rather than a shared-head list.
const RANGE_MULTI_PARTICLE_TEMPLATES = [
  {
    fn: (ps, m, e) =>
      `Co wniknie głębiej w ${m.phrase} przy ${energyPhrase(e)}: ${pNom(ps[0])} czy ${pNom(ps[1])}?`,
    kw: "głębiej",
  },
];

const STP_SINGLE_TEMPLATES = [
  {
    fn: (p, m, e) =>
      `Jaka jest zdolność hamowania ${pGen(p)} o energii ${energyPhrase(e)} w ${m.phrase}?`,
    kw: "zdolność hamowania",
  },
  {
    fn: (p, m, e) =>
      `Ile wynosi masowa zdolność hamowania ${pGen(p)} o energii ${energyPhrase(e)} w ${m.phrase}?`,
    kw: "zdolność hamowania",
  },
  {
    fn: (p, m, e) => `Podaj dE/dx dla ${pGen(p)} o energii ${energyPhrase(e)} w ${m.phrase}.`,
    kw: "de\\/dx|de dx|dedx",
  },
  {
    fn: (p, m, e) =>
      `Ile energii traci ${pNom(p)} o energii ${energyPhrase(e)} na centymetr drogi w ${m.phrase}?`,
    kw: "traci",
  },
];
const STP_MULTI_ENERGY_TEMPLATES = [
  {
    fn: (p, m, es) =>
      `Porównaj zdolność hamowania ${pGen(p)} w ${m.phrase} przy ${joinList(es.map((e) => energyPhrase(e)))}.`,
    kw: "zdolność hamowania",
  },
];
const STP_MULTI_MATERIAL_TEMPLATES = [
  {
    fn: (p, ms, e) =>
      `Porównaj zdolność hamowania ${pGen(p)} o energii ${energyPhrase(e)} w ${joinList(ms.map((m) => m.phrase))}.`,
    kw: "zdolność hamowania",
  },
];
const STP_MULTI_PARTICLE_TEMPLATES = [
  {
    fn: (ps, m, e) =>
      `Porównaj zdolność hamowania ${pGen(ps[0])} i ${pGen(ps[1])} w ${m.phrase} przy ${energyPhrase(e)}.`,
    kw: "zdolność hamowania",
  },
];

// LET-family phrasing — "LET" is borrowed verbatim into Polish (see lang/pl.ts); no
// spelled-out Polish "linear energy transfer" equivalent is in the vetted vocabulary, so
// only the acronym form is used here, unlike the English generator's two LET variants.
const STP_SINGLE_LET_TEMPLATES = [
  {
    fn: (p, m, e) => `Jaki jest LET ${pGen(p)} o energii ${energyPhrase(e)} w ${m.phrase}?`,
    kw: "\\blet\\b",
  },
  {
    fn: (p, m, e) => `Podaj LET dla ${pGen(p)} o energii ${energyPhrase(e)} w ${m.phrase}.`,
    kw: "\\blet\\b",
  },
];
const STP_MULTI_ENERGY_LET_TEMPLATES = [
  {
    fn: (p, m, es) =>
      `Porównaj LET ${pGen(p)} w ${m.phrase} przy ${joinList(es.map((e) => energyPhrase(e)))}.`,
    kw: "\\blet\\b",
  },
];
const STP_MULTI_MATERIAL_LET_TEMPLATES = [
  {
    fn: (p, ms, e) =>
      `Porównaj LET ${pGen(p)} o energii ${energyPhrase(e)} w ${joinList(ms.map((m) => m.phrase))}.`,
    kw: "\\blet\\b",
  },
];
const STP_MULTI_PARTICLE_LET_TEMPLATES = [
  {
    fn: (ps, m, e) =>
      `Porównaj LET ${pGen(ps[0])} i ${pGen(ps[1])} w ${m.phrase} przy ${energyPhrase(e)}.`,
    kw: "\\blet\\b",
  },
];

const INVRNG_SINGLE_TEMPLATES = [
  {
    fn: (p, m, v, u) =>
      `Jaką energię musi mieć ${pNom(p)}, żeby jego zasięg w ${m.phrase} wynosił ${v} ${u}?`,
    kw: "jak(?:ą|iej|a|ie)\\s+energi",
  },
  {
    fn: (p, m, v, u) => `Przy jakiej energii ${pNom(p)} osiągnie zasięg ${v} ${u} w ${m.phrase}?`,
    kw: "jak(?:ą|iej|a|ie)\\s+energi",
  },
  {
    fn: (p, m, v, u) => `Ile energii potrzebuje ${pNom(p)} na zasięg ${v} ${u} w ${m.phrase}?`,
    kw: "ile\\s+energi",
  },
  {
    fn: (p, m, v, u) => `Jaka energia ${pGen(p)} odpowiada zasięgowi ${v} ${u} w ${m.phrase}?`,
    kw: "jak(?:ą|iej|a|ie)\\s+energi",
  },
];
const INVRNG_MULTI_MATERIAL_TEMPLATES = [
  {
    fn: (p, ms, v, u) =>
      `Jaką energię musi mieć ${pNom(p)}, aby uzyskać zasięg ${v} ${u} w ${joinList(ms.map((m) => m.phrase))}?`,
    kw: "jak(?:ą|iej|a|ie)\\s+energi",
  },
];
// Two short questions, not one coordinated list — sidesteps the matcher's per-mention
// particle grammar the same way RECORDING.pl.md's own #42 does ("...? A jon węgla?").
const INVRNG_MULTI_PARTICLE_TEMPLATES = [
  {
    fn: (ps, m, v, u) =>
      `Jaką energię potrzebuje ${pNom(ps[0])} na zasięg ${v} ${u} w ${m.phrase}? A ${pNom(ps[1])}?`,
    kw: "jak(?:ą|iej|a|ie)\\s+energi",
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
    slotTruth: { quantityKeyword: t.kw, particles: [p.bare], materials: [m.bare], energies: [e] },
  };
}
function buildStpMultiEnergy() {
  const p = rng() < 0.4 ? pick(HEAVY_IONS) : PROTON;
  const m = pick(MATERIALS);
  const es = Array.from({ length: rng() < 0.5 ? 2 : 3 }, () => sampleEnergy(p));
  const t = pickStpTemplate(STP_MULTI_ENERGY_TEMPLATES, STP_MULTI_ENERGY_LET_TEMPLATES);
  return {
    text: t.fn(p, m, es),
    slotTruth: { quantityKeyword: t.kw, particles: [p.bare], materials: [m.bare], energies: es },
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
// Assemble the 1000 — identical dedup + inline-validation gate as the English generator,
// just calling checkCandidate/matchIntent with lang: "pl".
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
        : checkCandidate({ id, text: attempt.text }, service, "pl");
    } while (!check.ok && tries < maxTries);
    if (!check.ok) {
      throw new Error(
        `${id}: could not find a valid candidate after ${maxTries} tries. ` +
          `Last attempt: "${attempt.text}" — ${check.reason}`,
      );
    }
    seenText.add(attempt.text);
    i++;
    out.push({
      id,
      text: attempt.text,
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
    console.error(
      "Usage: node --experimental-strip-types scripts/generate-1000-sentences-pl.mjs <outFile>",
    );
    process.exit(1);
  }

  console.log("loading libdedx WASM for inline validation...");
  const service = await loadService();

  const rangeBatch = buildCategory(
    "pl-rng",
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
    "pl-invrng",
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
    "pl-sp",
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
  console.log(`every candidate already validated against the real Polish matcher + WASM inline.`);

  writeFileSync(outFile, JSON.stringify(all, null, 2));
  console.log(`wrote ${outFile}`);
}

main();
