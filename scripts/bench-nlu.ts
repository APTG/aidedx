/**
 * Text-only NLU generalization benchmark (issue #160 §8).
 *
 *   node scripts/bench-nlu.ts [--show-misses]
 *   pnpm bench:nlu
 *
 * `pnpm coverage:intents` on current `main` reads 100.0% slot | 100.0% exact on *every* tag — the
 * frozen `eval/intents.jsonl` regression suite measures "did we remember to add a row for each bug
 * we already fixed," not "does the grammar generalize to phrasings nobody has written down yet."
 * This script is a second, independent instrument: a generated, seeded, deterministic corpus of
 * sentences whose surface form is (by construction) held out of `eval/intents.jsonl`, run through
 * the real `correctTranscript()` -> `matchIntent()` pipeline (the same two stages a live ASR
 * transcript goes through — see `src/lib/answer/answer-status.svelte.ts`) with **no WASM/libdedx**
 * (this benchmarks NLU, not the physics), plus a mutation/fuzz layer that applies ASR-like
 * corruptions to a subset and measures the resulting accuracy drop. Every example (canonical and
 * mutated alike) goes through `correctTranscript()` — it's a verified no-op on already-clean text
 * (`correct.test.ts`'s "leaves well-formed text untouched"), so this doesn't skew the canonical
 * baseline, and it means a mutation like letter-splitting "MeV" into "Me V" is scored the way it
 * actually reaches the app: corrector first, matcher second — not the matcher alone, which was
 * never meant to recognize that shape by itself.
 *
 * Templates are hand-authored from the physics/user side (real domain vocabulary and natural
 * phrasings), not derived by reading the matcher's regex source — a generator written the latter
 * way would only prove the matcher agrees with itself. Ground truth (`expected`) for every
 * generated example is built directly from the sampled slot values (which particle/material/
 * energy/quantity the template used), the same convention `eval/intents.jsonl`'s hand labels
 * follow — never reverse-engineered from `matchIntent()`'s own output, which would be circular.
 *
 * Reuses `src/lib/intent/coverage.ts`'s `runCoverage()`/`formatReport()` unchanged: both are
 * already generic over `EvalExample[]`, already compute per-tag slot/exact accuracy, per-field
 * misses, and confidence calibration, and don't require tags to be `EVAL_TAGS` members (only
 * `validateEvalExample` — used for the frozen `eval/intents.jsonl` file — enforces that). So a
 * generated corpus tagged with bench-specific phenomenon/mutation tags works unchanged.
 *
 * Scope: English only for v1. Polish needs its own hand-authored templates — `pl.ts` differs from
 * `en.ts` in *shape* (coordination words, inflection), not just vocabulary — left as follow-up.
 *
 * This is a *reported, non-blocking* metric, same convention as `coverage-intents.ts`: always
 * exits 0.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { correctTranscript } from "../src/lib/asr/correct/core.ts";
import { formatReport, runCoverage } from "../src/lib/intent/coverage.ts";
import {
  parseEvalRecords,
  type EnergyUnit,
  type EvalExample,
  type Quantity,
  type TargetSlot,
} from "../src/lib/intent/query-intent.ts";

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — deterministic, reproducible across runs.
// ---------------------------------------------------------------------------
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(20260812);

/** Indexed access under `noUncheckedIndexedAccess` — throws instead of asserting, for indices
 * this module always knows are in range by construction (non-empty pools, `length - 1`, …). */
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`index ${i} out of range (length ${arr.length})`);
  return v;
}

function pick<T>(arr: readonly T[]): T {
  return at(arr, Math.floor(rng() * arr.length));
}
function pickN<T>(arr: readonly T[], n: number): T[] {
  const pool = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    out.push(at(pool.splice(Math.floor(rng() * pool.length), 1), 0));
  }
  return out;
}
function joinList(words: string[]): string {
  if (words.length === 1) return at(words, 0);
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(", ")}, and ${at(words, words.length - 1)}`;
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

interface ParticlePool {
  /** Singular mention, e.g. "a 100 MeV proton". */
  phrase: string;
  /** Plural/coordinated-list mention, e.g. "protons", "carbon-12" (bare, shared "ions" head). */
  listForm: string;
  /** Multi-nucleon particles must always be phrased with an explicit per-nucleon energy — a bare
   * energy on one triggers matcher.ts's total→per-nucleon conversion note, which this benchmark's
   * ground truth deliberately doesn't model (that's `eval/intents.jsonl`'s "has-assumption"/
   * "isotope-ambiguity" territory, out of scope here). */
  perNucleon: boolean;
  /** True when `listForm` needs a shared trailing "ions" in a coordinated list. */
  sharedIonHead: boolean;
}

const PROTON: ParticlePool = {
  phrase: "proton",
  listForm: "protons",
  perNucleon: false,
  sharedIonHead: false,
};
const LIGHT_PARTICLES: ParticlePool[] = [
  { phrase: "alpha particle", listForm: "alpha particles", perNucleon: true, sharedIonHead: false },
  { phrase: "deuteron", listForm: "deuterons", perNucleon: true, sharedIonHead: false },
];
const HEAVY_IONS: ParticlePool[] = [
  { phrase: "carbon-12 ion", listForm: "carbon-12", perNucleon: true, sharedIonHead: true },
  { phrase: "nitrogen-14 ion", listForm: "nitrogen-14", perNucleon: true, sharedIonHead: true },
  { phrase: "oxygen-16 ion", listForm: "oxygen-16", perNucleon: true, sharedIonHead: true },
  { phrase: "neon-20 ion", listForm: "neon-20", perNucleon: true, sharedIonHead: true },
  { phrase: "silicon-28 ion", listForm: "silicon-28", perNucleon: true, sharedIonHead: true },
];
const MULTI_NUCLEON = [...LIGHT_PARTICLES, ...HEAVY_IONS];

const MATERIALS = ["water", "PMMA", "aluminum", "air", "bone", "silicon", "tissue", "polyethylene"];

const MEV_VALUES = [50, 60, 80, 100, 120, 150, 180, 200, 250, 300];
const KEV_VALUES = [200, 300, 500, 800];
const GEV_VALUES = [1, 2, 3, 5];
const MEV_PER_NUCL_VALUES = [80, 100, 150, 200, 250, 300];
const RANGE_TARGETS_CM = [2, 5, 8, 10, 12, 15, 20];
const STP_TARGETS_KEVUM = [5, 10, 20, 50, 80, 100];
const STP_TARGETS_MEVCM2G = [2, 5, 8, 10, 15];

const PROGRAMS = ["PSTAR", "ASTAR", "ICRU73", "Bethe"];

/** Real physics-domain synonyms for "stopping power" — the same vocabulary `DIRECT_STOPPING`
 * recognizes, used here because it's the actual terminology users say, not because it was read out
 * of the regex (see module doc comment on the "hard discipline" this benchmark follows). */
const STOPPING_POWER_KEYWORDS = [
  "stopping power",
  "mass stopping power",
  "dE/dx",
  "energy loss",
  "specific ionization",
  "Bethe-Bloch value",
  "retarding force",
  "energy deposition",
];
const RANGE_KEYWORDS = ["range", "CSDA range"];

interface EnergyDraw {
  value: number;
  unit: EnergyUnit;
  perNucleonAssumed?: boolean;
  text: string;
}

function energyFor(particle: ParticlePool): EnergyDraw {
  if (particle.perNucleon) {
    const value = pick(MEV_PER_NUCL_VALUES);
    return { value, unit: "MeV/nucl", perNucleonAssumed: true, text: `${value} MeV per nucleon` };
  }
  const r = rng();
  if (r < 0.15) {
    const value = pick(KEV_VALUES);
    return { value, unit: "keV", text: `${value} keV` };
  }
  if (r < 0.3) {
    const value = pick(GEV_VALUES);
    return { value, unit: "GeV", text: `${value} GeV` };
  }
  const value = pick(MEV_VALUES);
  return { value, unit: "MeV", text: `${value} MeV` };
}

/** A same-unit multi-energy list, protons only (keeps unit/perNucleon bookkeeping simple —
 * compareDim: "energy" is about the energy axis, not particle mass class). */
function energyListForProtons(n: number): { draws: EnergyDraw[]; text: string } {
  const values = pickN(MEV_VALUES, n).sort((a, b) => a - b);
  const draws = values.map((value) => ({ value, unit: "MeV" as const, text: `${value} MeV` }));
  return { draws, text: joinList(draws.map((d) => d.text)) };
}

function coordinatedParticleText(particles: ParticlePool[]): string {
  if (particles.every((p) => p.sharedIonHead)) {
    return `${joinList(particles.map((p) => p.listForm))} ions`;
  }
  return joinList(particles.map((p) => p.listForm));
}

// ---------------------------------------------------------------------------
// Example builder
// ---------------------------------------------------------------------------

let nextId = 1;

/** Ground truth is built directly from the sampled slots — never from matchIntent()'s own output. */
function makeExample(
  text: string,
  quantity: Quantity,
  particles: { match: string }[],
  materials: { match: string }[],
  energies: EnergyDraw[],
  tags: string[],
  opts: { target?: TargetSlot; program?: string } = {},
): EvalExample {
  return {
    id: `bench-${String(nextId++).padStart(4, "0")}`,
    text,
    tags,
    expected: {
      quantity,
      compareDim: tags.includes("compare-material")
        ? "material"
        : tags.includes("compare-particle")
          ? "particle"
          : tags.includes("compare-energy")
            ? "energy"
            : "none",
      particles,
      materials,
      energies: energies.map((e) => {
        const slot: { value: number; unit: EnergyUnit; perNucleonAssumed?: boolean } = {
          value: e.value,
          unit: e.unit,
        };
        if (e.perNucleonAssumed !== undefined) slot.perNucleonAssumed = e.perNucleonAssumed;
        return slot;
      }),
      target: opts.target,
      program: opts.program,
      assumptions: [],
      confidence: 1,
    },
  };
}

// ---------------------------------------------------------------------------
// Templates — each produces one canonical example per call. Grouped by phenomenon.
// ---------------------------------------------------------------------------

type Builder = () => EvalExample;

const builders: Builder[] = [];

// --- direct keywords: stoppingPower ---------------------------------------------------------
for (const kw of STOPPING_POWER_KEYWORDS) {
  builders.push(() => {
    const particle = PROTON;
    const material = pick(MATERIALS);
    const energy = energyFor(particle);
    const text = `What is the ${kw} of a ${energy.text} ${particle.phrase} in ${material}?`;
    return makeExample(
      text,
      "stoppingPower",
      [{ match: particle.phrase }],
      [{ match: material }],
      [energy],
      ["direct", "quantity-stopping-power", "single"],
    );
  });
  builders.push(() => {
    const particle = pick(MULTI_NUCLEON);
    const material = pick(MATERIALS);
    const energy = energyFor(particle);
    const text = `${kw.charAt(0).toUpperCase()}${kw.slice(1)} of a ${energy.text} ${particle.phrase} in ${material}.`;
    return makeExample(
      text,
      "stoppingPower",
      [{ match: particle.phrase }],
      [{ match: material }],
      [energy],
      ["direct", "quantity-stopping-power", "single", "isotope-notation"],
    );
  });
}

// --- direct keywords: csdaRange --------------------------------------------------------------
for (const kw of RANGE_KEYWORDS) {
  builders.push(() => {
    const particle = pick([PROTON, ...LIGHT_PARTICLES]);
    const material = pick(MATERIALS);
    const energy = energyFor(particle);
    const text = `What is the ${kw} of a ${energy.text} ${particle.phrase} in ${material}?`;
    return makeExample(
      text,
      "csdaRange",
      [{ match: particle.phrase }],
      [{ match: material }],
      [energy],
      ["direct", "quantity-csda-range", "single"],
    );
  });
  builders.push(() => {
    const particle = PROTON;
    const material = pick(MATERIALS);
    const energy = energyFor(particle);
    const text = `Determine the ${kw} of ${energy.text} ${particle.listForm} in ${material}, please.`;
    return makeExample(
      text,
      "csdaRange",
      [{ match: particle.listForm }],
      [{ match: material }],
      [energy],
      ["direct", "quantity-csda-range", "single"],
    );
  });
}

// --- LET terminology --------------------------------------------------------------------------
builders.push(() => {
  const particle = pick([PROTON, ...MULTI_NUCLEON]);
  const material = pick(MATERIALS);
  const energy = energyFor(particle);
  const text = `What's the LET of a ${energy.text} ${particle.phrase} in ${material}?`;
  return makeExample(
    text,
    "stoppingPower",
    [{ match: particle.phrase }],
    [{ match: material }],
    [energy],
    ["direct", "quantity-stopping-power", "single", "let-terminology"],
  );
});
builders.push(() => {
  const particle = PROTON;
  const material = pick(MATERIALS);
  const energy = energyFor(particle);
  const text = `What is the linear energy transfer of a ${energy.text} ${particle.phrase} in ${material}?`;
  return makeExample(
    text,
    "stoppingPower",
    [{ match: particle.phrase }],
    [{ match: material }],
    [energy],
    ["direct", "quantity-stopping-power", "single", "let-terminology"],
  );
});

// --- indirect idioms: csdaRange -----------------------------------------------------------------
const CSDA_IDIOM_TEMPLATES = [
  (e: string, p: string, m: string) => `How far will a ${e} ${p} travel through ${m}?`,
  (e: string, p: string, m: string) => `How deep does a ${e} ${p} penetrate into ${m}?`,
  (e: string, p: string, m: string) =>
    `Before coming to rest, how far does a ${e} ${p} get through ${m}?`,
  (e: string, p: string, m: string) => `Roughly how far would a ${e} ${p} make it into ${m}?`,
  (e: string, p: string, m: string) => `What's the penetration depth of a ${e} ${p} in ${m}?`,
];
for (const fn of CSDA_IDIOM_TEMPLATES) {
  builders.push(() => {
    const particle = pick([PROTON, ...LIGHT_PARTICLES]);
    const material = pick(MATERIALS);
    const energy = energyFor(particle);
    const text = fn(energy.text, particle.phrase, material);
    return makeExample(
      text,
      "csdaRange",
      [{ match: particle.phrase }],
      [{ match: material }],
      [energy],
      ["indirect", "quantity-csda-range", "single"],
    );
  });
}

// --- indirect idioms: stoppingPower --------------------------------------------------------------
const STP_IDIOM_TEMPLATES = [
  (e: string, p: string, m: string) => `How quickly does a ${e} ${p} lose energy in ${m}?`,
  (e: string, p: string, m: string) => `At what rate does a ${e} ${p} shed energy in ${m}?`,
  (e: string, p: string, m: string) =>
    `How much energy does a ${e} ${p} lose per centimeter in ${m}?`,
];
for (const fn of STP_IDIOM_TEMPLATES) {
  builders.push(() => {
    const particle = pick([PROTON, ...LIGHT_PARTICLES]);
    const material = pick(MATERIALS);
    const energy = energyFor(particle);
    const text = fn(energy.text, particle.phrase, material);
    return makeExample(
      text,
      "stoppingPower",
      [{ match: particle.phrase }],
      [{ match: material }],
      [energy],
      ["indirect", "quantity-stopping-power", "single"],
    );
  });
}

// --- inverse: energyFromRange -------------------------------------------------------------------
builders.push(() => {
  const particle = PROTON;
  const material = pick(MATERIALS);
  const targetCm = pick(RANGE_TARGETS_CM);
  const text = `What energy gives a ${targetCm} cm range for ${particle.listForm} in ${material}?`;
  return makeExample(
    text,
    "energyFromRange",
    [{ match: particle.listForm }],
    [{ match: material }],
    [],
    ["direct", "quantity-energy-from-range", "single", "inverse-query"],
    { target: { value: targetCm, unit: "cm" } },
  );
});
builders.push(() => {
  const particle = PROTON;
  const material = pick(MATERIALS);
  const targetCm = pick(RANGE_TARGETS_CM);
  const text = `Which ${particle.phrase} energy stops at ${targetCm} cm in ${material}?`;
  return makeExample(
    text,
    "energyFromRange",
    [{ match: particle.phrase }],
    [{ match: material }],
    [],
    ["indirect", "quantity-energy-from-range", "single", "inverse-query"],
    { target: { value: targetCm, unit: "cm" } },
  );
});

// --- inverse: energyFromStp ---------------------------------------------------------------------
builders.push(() => {
  const particle = PROTON;
  const material = pick(MATERIALS);
  const targetKevUm = pick(STP_TARGETS_KEVUM);
  const text = `What energy corresponds to a stopping power of ${targetKevUm} keV/um for ${particle.listForm} in ${material}?`;
  return makeExample(
    text,
    "energyFromStp",
    [{ match: particle.listForm }],
    [{ match: material }],
    [],
    ["direct", "quantity-energy-from-stp", "single", "inverse-query"],
    { target: { value: targetKevUm, unit: "keV/um" } },
  );
});
builders.push(() => {
  const particle = PROTON;
  const material = pick(MATERIALS);
  const targetMevCm2g = pick(STP_TARGETS_MEVCM2G);
  const text = `What ${particle.phrase} energy gives a mass stopping power of ${targetMevCm2g} MeV cm2/g in ${material}?`;
  return makeExample(
    text,
    "energyFromStp",
    [{ match: particle.phrase }],
    [{ match: material }],
    [],
    ["direct", "quantity-energy-from-stp", "single", "inverse-query"],
    { target: { value: targetMevCm2g, unit: "MeV cm2/g" } },
  );
});

// --- compare-material ------------------------------------------------------------------------
for (const kw of [...STOPPING_POWER_KEYWORDS.slice(0, 3), ...RANGE_KEYWORDS]) {
  const quantity = RANGE_KEYWORDS.includes(kw) ? "csdaRange" : "stoppingPower";
  builders.push(() => {
    const particle = PROTON;
    const materials = pickN(MATERIALS, 2);
    const energy = energyFor(particle);
    const text = `Compare the ${kw} of ${particle.listForm} in ${materials[0]} and ${materials[1]} at ${energy.text}.`;
    return makeExample(
      text,
      quantity,
      [{ match: particle.listForm }],
      materials.map((m) => ({ match: m })),
      [energy],
      [
        "direct",
        `quantity-${quantity === "csdaRange" ? "csda-range" : "stopping-power"}`,
        "compare-material",
      ],
    );
  });
}
builders.push(() => {
  const particle = PROTON;
  const materials = pickN(MATERIALS, 3);
  const energy = energyFor(particle);
  const text = `What is the stopping power of ${particle.listForm} in ${materials[0]}, ${materials[1]}, and ${materials[2]} at ${energy.text}?`;
  return makeExample(
    text,
    "stoppingPower",
    [{ match: particle.listForm }],
    materials.map((m) => ({ match: m })),
    [energy],
    ["direct", "quantity-stopping-power", "compare-material"],
  );
});

// --- compare-particle (always per-nucleon phrasing — see ParticlePool.perNucleon doc) ---------
// Pairs are drawn from a single sub-pool (both LIGHT_PARTICLES or both HEAVY_IONS), never mixed:
// coordinatedParticleText() only appends the shared "ions" head when *every* member needs one, so
// a mixed pair (e.g. "deuterons and oxygen-16") would leave the bare-isotope member with no head
// word at all — a template bug, not a matcher one (verified: "alpha particles and deuterons" and
// "carbon-12 and neon-20 ions" both resolve correctly on their own).
function pickMultiNucleonPair(): ParticlePool[] {
  const pool = rng() < 0.3 ? LIGHT_PARTICLES : HEAVY_IONS;
  return pickN(pool, 2);
}
for (const quantity of ["stoppingPower", "csdaRange"] as const) {
  builders.push(() => {
    const particles = pickMultiNucleonPair();
    const material = pick(MATERIALS);
    const energy = energyFor(at(particles, 0));
    const kw = quantity === "stoppingPower" ? "stopping power" : "range";
    const text = `Compare the ${kw} of ${coordinatedParticleText(particles)} in ${material} at ${energy.text}.`;
    return makeExample(
      text,
      quantity,
      particles.map((p) => ({ match: p.listForm })),
      [{ match: material }],
      [energy],
      [
        "direct",
        `quantity-${quantity === "csdaRange" ? "csda-range" : "stopping-power"}`,
        "compare-particle",
      ],
    );
  });
}

// --- compare-energy (protons only, same unit) --------------------------------------------------
for (const quantity of ["stoppingPower", "csdaRange"] as const) {
  builders.push(() => {
    const particle = PROTON;
    const material = pick(MATERIALS);
    const { draws, text: energyText } = energyListForProtons(3);
    const kw = quantity === "stoppingPower" ? "stopping power" : "range";
    const text = `What are the ${kw} at ${energyText} for ${particle.listForm} in ${material}?`;
    return makeExample(
      text,
      quantity,
      [{ match: particle.listForm }],
      [{ match: material }],
      draws,
      [
        "direct",
        `quantity-${quantity === "csdaRange" ? "csda-range" : "stopping-power"}`,
        "compare-energy",
      ],
    );
  });
}

// --- unit variants ------------------------------------------------------------------------------
builders.push(() => {
  const particle = PROTON;
  const material = pick(MATERIALS);
  const value = pick(KEV_VALUES);
  const text = `What is the stopping power of a ${value} keV ${particle.phrase} in ${material}?`;
  return makeExample(
    text,
    "stoppingPower",
    [{ match: particle.phrase }],
    [{ match: material }],
    [{ value, unit: "keV", text: `${value} keV` }],
    ["direct", "quantity-stopping-power", "single", "unit-keV"],
  );
});
builders.push(() => {
  const particle = PROTON;
  const material = pick(MATERIALS);
  const value = pick(GEV_VALUES);
  const text = `What is the range of a ${value} GeV ${particle.phrase} in ${material}?`;
  return makeExample(
    text,
    "csdaRange",
    [{ match: particle.phrase }],
    [{ match: material }],
    [{ value, unit: "GeV", text: `${value} GeV` }],
    ["direct", "quantity-csda-range", "single", "unit-GeV"],
  );
});
builders.push(() => {
  const particle = pick(HEAVY_IONS);
  const material = pick(MATERIALS);
  const value = pick(MEV_PER_NUCL_VALUES);
  const text = `What is the range of a ${value} MeV/u ${particle.phrase} in ${material}?`;
  return makeExample(
    text,
    "csdaRange",
    [{ match: particle.phrase }],
    [{ match: material }],
    [{ value, unit: "MeV/u", perNucleonAssumed: true, text: `${value} MeV/u` }],
    ["direct", "quantity-csda-range", "single", "unit-mev-per-u"],
  );
});

// --- program-specified ---------------------------------------------------------------------------
builders.push(() => {
  const particle = PROTON;
  const material = pick(MATERIALS);
  const energy = energyFor(particle);
  const program = pick(PROGRAMS);
  const text = `Using ${program}, what is the stopping power of a ${energy.text} ${particle.phrase} in ${material}?`;
  return makeExample(
    text,
    "stoppingPower",
    [{ match: particle.phrase }],
    [{ match: material }],
    [energy],
    ["direct", "quantity-stopping-power", "single", "program-specified"],
    { program },
  );
});

// ---------------------------------------------------------------------------
// Mutation / fuzz layer — ASR-like corruptions applied on top of a canonical example's text.
// Ground truth (`expected`) is unchanged: mutations are surface-form only.
// ---------------------------------------------------------------------------

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const TEENS = [
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** Spells out an integer 0-999 as words — the inverse of matcher.ts's composeHundreds/
 * composeTensOnes, used here to construct adversarial input, not to normalize it. */
function numberToWords(n: number): string {
  if (n < 10) return at(ONES, n);
  if (n < 20) return at(TEENS, n - 10);
  if (n < 100) {
    const tens = at(TENS, Math.floor(n / 10));
    const ones = n % 10;
    return ones === 0 ? tens : `${tens} ${at(ONES, ones)}`;
  }
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const head = `${ONES[hundreds]} hundred`;
  return rest === 0 ? head : `${head} and ${numberToWords(rest)}`;
}

function spellOutNumbers(text: string): string {
  return text.replace(/\b\d+\b/g, (m) => numberToWords(Number(m)));
}

function dropArticles(text: string): string {
  return text.replace(/\b(a|an|the)\s+/gi, "");
}

function glueUnitToNumber(text: string): string {
  return text.replace(/(\d+(?:\.\d+)?)\s+(MeV|keV|GeV|TeV|cm|mm)\b/g, "$1$2");
}

function splitUnitLetters(text: string): string {
  return text
    .replace(/\bMeV\b/g, "Me V")
    .replace(/\bkeV\b/g, "ke V")
    .replace(/\bGeV\b/g, "Ge V");
}

function dropListConnector(text: string): string {
  return text.replace(/ and /, " ");
}

const MUTATIONS: ReadonlyArray<{
  kind: string;
  fn: (t: string) => string;
  onlyIf?: (t: string) => boolean;
}> = [
  { kind: "drop-article", fn: dropArticles },
  { kind: "spell-out-numbers", fn: spellOutNumbers },
  { kind: "glue-unit-to-number", fn: glueUnitToNumber },
  { kind: "split-unit-letters", fn: splitUnitLetters, onlyIf: (t) => /\b(MeV|keV|GeV)\b/.test(t) },
  { kind: "drop-list-connector", fn: dropListConnector, onlyIf: (t) => / and /.test(t) },
];

function applyMutations(canonical: EvalExample[]): EvalExample[] {
  const mutated: EvalExample[] = [];
  for (const ex of canonical) {
    for (const { kind, fn, onlyIf } of MUTATIONS) {
      if (onlyIf && !onlyIf(ex.text)) continue;
      const text = fn(ex.text);
      if (text === ex.text) continue;
      mutated.push({
        ...ex,
        id: `${ex.id}-mut-${kind}`,
        text,
        tags: [...ex.tags, `mutation:${kind}`],
      });
    }
  }
  return mutated;
}

// ---------------------------------------------------------------------------
// Corpus assembly
// ---------------------------------------------------------------------------

const SAMPLES_PER_TEMPLATE = 16;

function buildCanonicalCorpus(): EvalExample[] {
  const out: EvalExample[] = [];
  for (const build of builders) {
    for (let i = 0; i < SAMPLES_PER_TEMPLATE; i++) out.push(build());
  }
  return out;
}

// A subset of canonical examples gets every applicable mutation — keeps total corpus size
// manageable while still exercising every mutation kind broadly.
const MUTATION_SAMPLE_STRIDE = 3;

function main(): void {
  const canonicalRaw = buildCanonicalCorpus();
  const mutationSubset = canonicalRaw.filter((_, i) => i % MUTATION_SAMPLE_STRIDE === 0);
  const mutatedRaw = applyMutations(mutationSubset);

  // Everything that actually gets matched runs through correctTranscript() first, same as a real
  // ASR transcript would — see module doc comment.
  const runCorrector = (examples: EvalExample[]): EvalExample[] =>
    examples.map((e) => ({ ...e, text: correctTranscript(e.text).text }));
  const canonical = runCorrector(canonicalRaw);
  const mutated = runCorrector(mutatedRaw);
  const corpus = [...canonical, ...mutated];

  // Held-out check compares the CORRECTED text — the form that actually reaches matchIntent() —
  // against eval/intents.jsonl. Checking the pre-correction text instead would wrongly count a
  // generated sentence as "held out" even when correctTranscript() happens to turn it into an
  // exact match for a frozen eval sentence (e.g. a unit-mishearing fix landing on frozen wording).
  const evalPath = fileURLToPath(new URL("../eval/intents.jsonl", import.meta.url));
  const frozenTexts = new Set(parseEvalRecords(readFileSync(evalPath, "utf-8")).map((e) => e.text));
  const heldOut = corpus.filter((e) => !frozenTexts.has(e.text));
  const overlapping = corpus.length - heldOut.length;

  const showMisses = process.argv.includes("--show-misses");

  console.log(
    `Generated corpus: ${corpus.length} examples (${canonical.length} canonical, ` +
      `${mutated.length} mutated), seed 20260812.`,
  );
  console.log(
    `Held out of eval/intents.jsonl: ${heldOut.length}/${corpus.length} ` +
      `(${((100 * heldOut.length) / corpus.length).toFixed(1)}%, ${overlapping} overlapping by exact text)\n`,
  );

  console.log(formatReport(runCoverage(corpus), { showMisses }));

  console.log("--- Held-out only (the number that actually tracks generalization) ---");
  const heldOutReport = runCoverage(heldOut);
  console.log(
    `slot coverage       ${heldOutReport.slotMatches}/${heldOutReport.total}  ` +
      `${((100 * heldOutReport.slotMatches) / heldOutReport.total).toFixed(1)}%`,
  );
  console.log(
    `exact-intent        ${heldOutReport.exactMatches}/${heldOutReport.total}  ` +
      `${((100 * heldOutReport.exactMatches) / heldOutReport.total).toFixed(1)}%\n`,
  );

  console.log("--- Mutation degradation (canonical baseline vs. each corruption kind) ---");
  const canonicalReport = runCoverage(canonical);
  const baselinePct = (100 * canonicalReport.exactMatches) / canonicalReport.total;
  console.log(
    `  ${"canonical (baseline)".padEnd(24)} ${baselinePct.toFixed(1).padStart(5)}%  (${canonicalReport.total})`,
  );
  for (const { kind } of MUTATIONS) {
    const subset = mutated.filter((e) => e.tags.includes(`mutation:${kind}`));
    if (subset.length === 0) continue;
    const report = runCoverage(subset);
    const pct = (100 * report.exactMatches) / report.total;
    const delta = pct - baselinePct;
    console.log(
      `  ${kind.padEnd(24)} ${pct.toFixed(1).padStart(5)}%  (${report.total})  ` +
        `${delta <= 0 ? "" : "+"}${delta.toFixed(1)}pp`,
    );
  }

  // Reported metric: never gate CI.
  process.exit(0);
}

main();
