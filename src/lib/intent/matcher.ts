/**
 * Deterministic NLU matcher for aidedx (issue #5, Spike 2 — deterministic half).
 *
 * Turns a natural-language query into a {@link QueryIntent} using only a
 * hand-written grammar plus the libdedx synonym/alias tables — no model. It is
 * the lower, certain half of the planned hybrid (deterministic ⊕ LLM) NLU: the
 * coverage harness (`coverage.ts`) measures exactly how far this gets over the
 * eval set, which is the empirical justification for how much LLM we still need.
 *
 * Pipeline (each stage is a small, independently testable function):
 *   1. quantity        — direct keywords, an indirect-idiom table, and the
 *                        inverse-query ("what energy gives …") detector.
 *   2. energies/target — number+unit grammar with per-nucleon-vs-total handling.
 *   3. particles       — named particles, "<element> ion(s)" heads, and
 *                        coordinated lists ("carbon and neon ions").
 *   4. materials       — n-gram scan resolved against the material alias table.
 *   5. compareDim      — entity multiplicity + program-name detection.
 *   6. resolver        — fuzzy-match slots to real libdedx entities, fill
 *                        `assumptions[]` (isotope defaults, total→per-nucleon)
 *                        and a calibrated `confidence`.
 *
 * Both this matcher and the future LLM emit the *same* QueryIntent shape, so all
 * downstream code (resolver, compute, NLG) is producer-agnostic.
 */
import {
  resolveMaterial,
  resolveParticle,
  type MaterialMatch,
  type ParticleMatch,
} from "../aliases/index.ts";
import type {
  CompareDim,
  EnergySlot,
  EnergyUnit,
  MaterialSlot,
  ParticleSlot,
  Quantity,
  QueryIntent,
  TargetSlot,
} from "./query-intent.ts";

// ---------------------------------------------------------------------------
// Result type — the intent plus a little provenance the harness/tests can read.
// ---------------------------------------------------------------------------

/** How the quantity was decided, for confidence weighting and debugging. */
export type QuantitySource = "direct" | "indirect" | "inverse" | "default";

export interface MatchResult {
  intent: QueryIntent;
  /** Which strategy fixed the quantity slot. */
  quantitySource: QuantitySource;
  /** The indirect-idiom phrase that fired, if any (for traceability). */
  idiom?: string;
  /** True when a required slot could not be filled (a likely LLM-fallback). */
  incomplete: boolean;
}

interface Span {
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// 1. Quantity — direct keywords, indirect idioms, inverse queries
// ---------------------------------------------------------------------------

/**
 * Indirect-idiom table: phrasings that imply a quantity without naming it.
 * These are the cases the issue flags as "the LLM's job"; the deterministic
 * matcher leans on this table to claw back the common, formulaic ones.
 */
export const INDIRECT_IDIOMS: ReadonlyArray<{ pattern: RegExp; quantity: Quantity }> = [
  // csdaRange — "how far / deep / thick … will go / travel / stop / come to rest".
  { pattern: /\bhow far\b/, quantity: "csdaRange" },
  { pattern: /\bhow deep\b/, quantity: "csdaRange" },
  { pattern: /\bhow thick\b/, quantity: "csdaRange" },
  { pattern: /\bpenetration depth\b/, quantity: "csdaRange" },
  { pattern: /\bpenetrat(?:e|es|ing|ion)\b/, quantity: "csdaRange" },
  { pattern: /\bcome to rest\b/, quantity: "csdaRange" },
  { pattern: /\bcomes to rest\b/, quantity: "csdaRange" },
  { pattern: /\bbefore stopping\b/, quantity: "csdaRange" },
  { pattern: /\b(?:will|can|does|do)\b[^.?!]*\btravel\b/, quantity: "csdaRange" },
  { pattern: /\bshorter distance\b/, quantity: "csdaRange" },
  { pattern: /\bgo(?:es)? in\b/, quantity: "csdaRange" },
  { pattern: /\bget into\b/, quantity: "csdaRange" },
  { pattern: /\bmake it\b/, quantity: "csdaRange" },
  // stoppingPower — "how quickly / at what rate … loses / sheds energy per length".
  { pattern: /\blose[s]? energy\b/, quantity: "stoppingPower" },
  { pattern: /\bshed[s]? energy\b/, quantity: "stoppingPower" },
  { pattern: /\bslowed down\b/, quantity: "stoppingPower" },
  { pattern: /\bat what rate\b/, quantity: "stoppingPower" },
  { pattern: /\bhow quickly\b/, quantity: "stoppingPower" },
  {
    pattern: /\blose[s]?\b[^.?!]*\bper\s+(?:centimeter|millimeter|cm|mm|unit length)\b/,
    quantity: "stoppingPower",
  },
  {
    pattern: /\b(?:per|after)\s+(?:each\s+)?(?:centimeter|millimeter|cm|mm|unit length)\b/,
    quantity: "stoppingPower",
  },
];

const DIRECT_STOPPING =
  /\b(?:mass\s+|electronic\s+)?stopping power\b|\bde\s*\/\s*dx\b|\benergy loss\b/i;
const DIRECT_RANGE = /\bcsda\b|\brange\b/i;

/** Detect an inverse ("solve for energy") query and which kind. */
function detectInverse(lower: string): Quantity | null {
  // The query must ask for *energy* as the answer: "what energy", "which proton
  // energy", "what carbon ion energy" — i.e. ≤3 plain words between the wh-word
  // and "energy". This rejects "at what rate … shed energy" (a forward query).
  const asksForEnergy =
    /\b(?:what|which)\s+(?:[a-z]+\s+){0,3}energy\b/.test(lower) || /\bhow energetic\b/.test(lower);
  if (!asksForEnergy) return null;
  const isStp =
    /\bstopping power\b/.test(lower) ||
    /\bmev\s*\/\s*cm\b/.test(lower) ||
    /\bmev\s*cm2\s*\/\s*g\b/.test(lower) ||
    /\bkev\s*\/\s*[uµ]m\b/.test(lower) ||
    /\blose[s]?\b[^.?!]*\bmev per cm\b/.test(lower) ||
    /\bmev per cm\b/.test(lower);
  return isStp ? "energyFromStp" : "energyFromRange";
}

/** Decide the forward quantity (non-inverse) and how it was found. */
function detectForwardQuantity(lower: string): {
  quantity: Quantity;
  source: QuantitySource;
  idiom?: string;
} {
  // Strong direct keywords win first: "stopping power" / "dE/dx" then "range".
  if (DIRECT_STOPPING.test(lower)) return { quantity: "stoppingPower", source: "direct" };
  if (DIRECT_RANGE.test(lower)) return { quantity: "csdaRange", source: "direct" };

  for (const { pattern, quantity } of INDIRECT_IDIOMS) {
    const m = pattern.exec(lower);
    if (m) return { quantity, source: "indirect", idiom: m[0] };
  }

  // Last resort: a bare "stops/stopped … in <length>" reads as range.
  if (/\bstop(?:s|ped)?\b/.test(lower))
    return { quantity: "csdaRange", source: "indirect", idiom: "stop" };

  // Unknown — default to range but flag low confidence via "default" source.
  return { quantity: "csdaRange", source: "default" };
}

// ---------------------------------------------------------------------------
// 2. Energies and inverse-query target
// ---------------------------------------------------------------------------

/** Map a base unit token + optional per-nucleon suffix to the schema enum. */
function toEnergyUnit(base: string, perNuclSuffix?: string): EnergyUnit {
  if (perNuclSuffix) return perNuclSuffix === "u" || perNuclSuffix === "amu" ? "MeV/u" : "MeV/nucl";
  const b = base.toLowerCase();
  if (b === "kev") return "keV";
  if (b === "gev") return "GeV";
  return "MeV";
}

/**
 * Resolve a raw number + base unit + optional per-nucleon suffix to the schema's
 * `{ value, unit }`. The only per-nucleon units in the schema are MeV-based
 * (`MeV/nucl`, `MeV/u`), so a keV/GeV value that carries a per-nucleon suffix is
 * converted to MeV to preserve magnitude: "500 keV/u" → `{ 0.5, "MeV/u" }`,
 * "1.2 GeV/nucl" → `{ 1200, "MeV/nucl" }`. A forward (non-per-nucleon) value
 * keeps its stated unit untouched.
 */
function toEnergyValueUnit(
  rawValue: number,
  base: string,
  suffix?: string,
): { value: number; unit: EnergyUnit } {
  const unit = toEnergyUnit(base, suffix);
  if (suffix === undefined) return { value: rawValue, unit };
  const b = base.toLowerCase();
  const value = b === "kev" ? rawValue / 1000 : b === "gev" ? rawValue * 1000 : rawValue;
  return { value: round(value), unit };
}

const PER_NUCL = "(?:\\s*\\/\\s*(nucleon|nucl|amu|u)|\\s+per\\s+(nucleon|nucl|amu|u))?";
const ENERGY_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(gev|mev|kev)\\b${PER_NUCL}`, "gi");
// Connector between list members, allowing a serial-comma "X, Y, and Z".
const LIST_SEP_SRC =
  "(?:\\s*,\\s*(?:and\\s+|or\\s+)?|\\s+and\\s+|\\s+or\\s+|\\s+versus\\s+|\\s+vs\\.?\\s+)";
const LIST_SPLIT_RE = new RegExp(LIST_SEP_SRC, "i");
// A coordinated list of values sharing one trailing unit: "100 and 200 MeV",
// "50, 100, and 150 MeV", "100 and 400 MeV per nucleon".
const ENERGY_LIST_RE = new RegExp(
  `((?:\\d+(?:\\.\\d+)?${LIST_SEP_SRC})+\\d+(?:\\.\\d+)?)\\s*(gev|mev|kev)\\b${PER_NUCL}`,
  "gi",
);

interface RawEnergy {
  value: number;
  unit: EnergyUnit;
  perNucleon: boolean;
  span: Span;
}

/** Extract every "<number> <unit>[/nucleon]" energy, in reading order. */
function extractEnergies(text: string): RawEnergy[] {
  const out: RawEnergy[] = [];
  const consumed: Span[] = [];

  // Shared-unit lists first, so the trailing "<num> <unit>" isn't also matched
  // as a lone energy below.
  for (const m of text.matchAll(ENERGY_LIST_RE)) {
    const start = m.index ?? 0;
    const span = { start, end: start + m[0].length };
    const base = m[2] ?? "mev";
    const suffix = (m[3] ?? m[4])?.toLowerCase();
    const rawValues = (m[1] ?? "").split(LIST_SPLIT_RE).filter(Boolean).map(Number);
    for (const raw of rawValues) {
      const { value, unit } = toEnergyValueUnit(raw, base, suffix);
      out.push({ value, unit, perNucleon: suffix !== undefined, span });
    }
    consumed.push(span);
  }

  for (const m of text.matchAll(ENERGY_RE)) {
    const start = m.index ?? 0;
    const span = { start, end: start + m[0].length };
    if (consumed.some((s) => span.start < s.end && s.start < span.end)) continue;
    const base = m[2] ?? "mev";
    const suffix = (m[3] ?? m[4])?.toLowerCase();
    const { value, unit } = toEnergyValueUnit(Number(m[1]), base, suffix);
    out.push({ value, unit, perNucleon: suffix !== undefined, span });
  }

  return out.sort((a, b) => a.span.start - b.span.start);
}

/** Convert an energy value to MeV (for the total→per-nucleon assumption note). */
function toMeV(value: number, unit: EnergyUnit): number {
  if (unit === "keV") return value / 1000;
  if (unit === "GeV") return value * 1000;
  return value; // MeV, MeV/nucl, MeV/u
}

const LENGTH_TARGET_RE =
  /(\d+(?:\.\d+)?)\s*(g\s*\/\s*cm\s*\^?\s*2|g\s*cm\s*\^?\s*-?\s*2|mm|cm|[uµ]m|micron[s]?)\b/i;

interface RawTarget {
  slot: TargetSlot;
  span: Span;
}

/** Extract the given range for an `energyFromRange` query. */
function extractRangeTarget(text: string): RawTarget | null {
  const m = LENGTH_TARGET_RE.exec(text);
  if (!m) return null;
  const raw = (m[2] ?? "").toLowerCase().replace(/\s+/g, "");
  let unit = raw;
  if (raw.startsWith("g/cm") || raw.startsWith("gcm")) unit = "g/cm2";
  else if (raw === "micron" || raw === "microns" || raw === "µm") unit = "um";
  const start = m.index ?? 0;
  return { slot: { value: Number(m[1]), unit }, span: { start, end: start + m[0].length } };
}

const STP_TARGET_RES: ReadonlyArray<{ re: RegExp; unit: string }> = [
  { re: /(\d+(?:\.\d+)?)\s*mev\s*cm2\s*\/\s*g\b/i, unit: "MeV cm2/g" },
  { re: /(\d+(?:\.\d+)?)\s*mev\s*\/\s*cm\b/i, unit: "MeV/cm" },
  { re: /(\d+(?:\.\d+)?)\s*mev\s+per\s+cm\b/i, unit: "MeV/cm" },
  { re: /(\d+(?:\.\d+)?)\s*kev\s*\/\s*[uµ]m\b/i, unit: "keV/um" },
];

/** Extract the given stopping power for an `energyFromStp` query. */
function extractStpTarget(text: string): RawTarget | null {
  for (const { re, unit } of STP_TARGET_RES) {
    const m = re.exec(text);
    if (m) {
      const start = m.index ?? 0;
      return { slot: { value: Number(m[1]), unit }, span: { start, end: start + m[0].length } };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. Particles
// ---------------------------------------------------------------------------

interface RawParticle {
  match: string;
  resolved: ParticleMatch;
  span: Span;
}

// A coordinated list sharing a trailing head: "carbon and neon ions",
// "protons, helium, and carbon ions". Requires ≥1 connector so it only fires on
// genuine lists; single "<element> ion(s)" is handled separately below.
const PARTICLE_LIST_RE = new RegExp(
  `((?:[a-z][a-z-]*${LIST_SEP_SRC})+[a-z][a-z-]*)\\s+(ions?|particles?|nuclei|nucleus)\\b`,
  "gi",
);
// A single "<element/isotope> ion(s)/particle(s)/nuclei" head.
const PARTICLE_HEAD_RE = /\b([a-z][a-z]*(?:-\d{1,3})?)\s+(ions?|particles?|nuclei|nucleus)\b/gi;
// Standalone named particles whose isotope is fixed by the name.
const NAMED_PARTICLE_RE =
  /\b(protons?|deuterons?|tritons?|alpha particles?|alphas?|helions?|electrons?|positrons?|beta minus|betas?)\b/gi;

function overlaps(a: Span, spans: Span[]): boolean {
  return spans.some((s) => a.start < s.end && s.start < a.end);
}

/** Resolve a phrase to a particle, returning the raw match + resolution. */
function tryParticle(match: string, start: number): RawParticle | null {
  const resolved = resolveParticle(match);
  if (!resolved) return null;
  return { match: match.trim(), resolved, span: { start, end: start + match.length } };
}

function extractParticles(text: string): RawParticle[] {
  const found: RawParticle[] = [];
  const consumed: Span[] = [];

  // Coordinated lists first — they subsume any inner single/named matches.
  for (const m of text.matchAll(PARTICLE_LIST_RE)) {
    const listStart = m.index ?? 0;
    const listText = m[1] ?? "";
    const members = listText.split(LIST_SPLIT_RE).filter(Boolean);
    // Resolve each member; a member like "alpha"/"protons" resolves on its own,
    // a bare element ("carbon") resolves to its ion via the alias table.
    const resolvedMembers: RawParticle[] = [];
    let cursor = listStart;
    let ok = true;
    for (const member of members) {
      const at = text.toLowerCase().indexOf(member.toLowerCase(), cursor);
      const rp = tryParticle(member, at >= 0 ? at : listStart);
      if (!rp) {
        ok = false;
        break;
      }
      if (at >= 0) cursor = at + member.length;
      resolvedMembers.push(rp);
    }
    if (ok && resolvedMembers.length >= 2) {
      found.push(...resolvedMembers);
      consumed.push({ start: listStart, end: listStart + m[0].length });
    }
  }

  // Single "<element> ion(s)" heads not already inside a list.
  for (const m of text.matchAll(PARTICLE_HEAD_RE)) {
    const span = { start: m.index ?? 0, end: (m.index ?? 0) + m[0].length };
    if (overlaps(span, consumed)) continue;
    const rp = tryParticle(m[0], span.start);
    if (rp) {
      found.push(rp);
      consumed.push(span);
    }
  }

  // Standalone named particles (proton, alpha, deuteron, …).
  for (const m of text.matchAll(NAMED_PARTICLE_RE)) {
    const span = { start: m.index ?? 0, end: (m.index ?? 0) + m[0].length };
    if (overlaps(span, consumed)) continue;
    const rp = tryParticle(m[0], span.start);
    if (rp) {
      found.push(rp);
      consumed.push(span);
    }
  }

  return found.sort((a, b) => a.span.start - b.span.start);
}

// ---------------------------------------------------------------------------
// 4. Materials — n-gram scan resolved against the alias table
// ---------------------------------------------------------------------------

interface RawMaterial {
  match: string;
  resolved: MaterialMatch;
  span: Span;
}

// Words that never start/own a material phrase; kept short to avoid eating real
// multi-word names. Numbers are excluded by the \p{L} requirement below.
const MATERIAL_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "into",
  "through",
  "for",
  "at",
  "and",
  "or",
  "to",
  "is",
  "what",
  "whats",
  "how",
  "does",
  "do",
  "much",
  "energy",
  "per",
  "compare",
  "versus",
  "vs",
  "range",
  "stopping",
  "power",
  "dedx",
  "loss",
  "lose",
  "loses",
  "deep",
  "far",
  "thick",
  "proton",
  "protons",
  "alpha",
  "alphas",
  "ion",
  "ions",
  "particle",
  "particles",
  "nucleon",
  "with",
  "using",
  "both",
  "model",
  "models",
  "please",
  "me",
  "give",
  "it",
  "go",
  "goes",
]);

const MAX_NGRAM = 3;

/** Scan unconsumed token windows (1..3 words) for known materials, longest-first. */
function extractMaterials(text: string, consumed: Span[]): RawMaterial[] {
  const tokenRe = /[\p{L}][\p{L}\d-]*/gu;
  const tokens: { word: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(tokenRe)) {
    const start = m.index ?? 0;
    tokens.push({ word: m[0], start, end: start + m[0].length });
  }

  const out: RawMaterial[] = [];
  const used: Span[] = [...consumed];

  for (let n = MAX_NGRAM; n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const first = tokens[i];
      const last = tokens[i + n - 1];
      if (!first || !last) continue;
      const span = { start: first.start, end: last.end };
      if (overlaps(span, used)) continue;
      // A 1-gram that is a stopword can never be a material on its own; and a
      // 1- or 2-char token (a stray "s"/"I", or an element *symbol* like "U")
      // is never a material *name* in this domain — real names are ≥3 chars.
      if (n === 1 && MATERIAL_STOPWORDS.has(first.word.toLowerCase())) continue;
      if (n === 1 && first.word.length < 3) continue;
      const phrase = text.slice(span.start, span.end);
      const resolved = resolveMaterial(phrase);
      if (!resolved) continue;
      // Never accept a *fuzzy* single-word hit: any 4-letter English verb
      // ("puts", "need") sits within edit distance of some element name. Typo
      // tolerance is kept for multi-word phrases, where collisions are rare.
      if (n === 1 && resolved.matchKind === "fuzzy") continue;
      if (resolved.matchKind === "fuzzy" && phrase.replace(/\s/g, "").length < 4) continue;
      out.push({ match: phrase, resolved, span });
      used.push(span);
    }
  }

  return out.sort((a, b) => a.span.start - b.span.start);
}

// ---------------------------------------------------------------------------
// 5. compareDim — program names, then entity multiplicity
// ---------------------------------------------------------------------------

const PROGRAM_RE =
  /\b(astar|pstar|estar|mstar|srim|atima|libdedx|geant4?|fluka|bethe|icru|nist)\b/gi;

function detectPrograms(lower: string): Set<string> {
  const progs = new Set<string>();
  for (const m of lower.matchAll(PROGRAM_RE)) {
    const name = m[1];
    if (name) progs.add(name.toLowerCase());
  }
  return progs;
}

function decideCompareDim(
  programs: Set<string>,
  particles: number,
  materials: number,
  energies: number,
): CompareDim {
  if (programs.size >= 2) return "program";
  if (energies >= 2) return "energy";
  if (materials >= 2) return "material";
  if (particles >= 2) return "particle";
  return "none";
}

// ---------------------------------------------------------------------------
// 6. Resolver — assumptions and confidence
// ---------------------------------------------------------------------------

/** Lowercase element name from a resolved particle, e.g. "Carbon" → "carbon". */
function elementName(p: ParticleMatch): string {
  return p.name.toLowerCase();
}

/** Per-nucleon value + unit for a total→per-nucleon assumption note. */
function perNucleon(value: number, unit: EnergyUnit, a: number): { value: number; unit: string } {
  if (unit === "keV") return { value: round(value / a), unit: "keV/nucl" };
  // MeV and GeV both express the per-nucleon figure in MeV/nucl.
  return { value: round(toMeV(value, unit) / a), unit: "MeV/nucl" };
}

/** Trim floating-point fuzz so 84/12 prints as 7, not 6.999999999999999. */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Top-level matcher
// ---------------------------------------------------------------------------

/** Run the deterministic matcher over a query, returning intent + provenance. */
export function matchIntent(text: string): MatchResult {
  const lower = text.toLowerCase();

  // 1. Quantity (inverse takes precedence — it changes how energies are read).
  const inverse = detectInverse(lower);
  const fwd = inverse ? null : detectForwardQuantity(lower);
  const quantity: Quantity = inverse ? inverse : fwd ? fwd.quantity : "csdaRange";
  const source: QuantitySource = inverse ? "inverse" : fwd ? fwd.source : "default";

  // 2. Particles and energies/target first, so their spans are not re-mined as
  //    materials (e.g. "carbon" in "carbon ions", "u" in "MeV/u", "cm" in a
  //    "10 cm" range target — all of which alias to element symbols).
  const rawParticles = extractParticles(text);

  // Inverse queries carry no energy slot — only a target.
  let rawEnergies: RawEnergy[] = [];
  let target: TargetSlot | undefined;
  let targetSpan: Span | undefined;
  if (quantity === "energyFromRange") {
    const t = extractRangeTarget(text);
    if (t) ({ slot: target, span: targetSpan } = t);
  } else if (quantity === "energyFromStp") {
    const t = extractStpTarget(text);
    if (t) ({ slot: target, span: targetSpan } = t);
  } else {
    rawEnergies = extractEnergies(text);
  }

  // 3. Materials — over the spans not already claimed by particles/energies.
  const consumedSpans: Span[] = [
    ...rawParticles.map((p) => p.span),
    ...rawEnergies.map((e) => e.span),
  ];
  if (targetSpan) consumedSpans.push(targetSpan);
  const rawMaterials = extractMaterials(text, consumedSpans);

  // 4. compareDim from program names + entity multiplicity.
  const programs = detectPrograms(lower);
  const compareDim = decideCompareDim(
    programs,
    rawParticles.length,
    rawMaterials.length,
    rawEnergies.length,
  );

  // 5. Assemble slots, assumptions, confidence.
  const assumptions: string[] = [];
  let fuzzy = 0;

  const particles: ParticleSlot[] = rawParticles.map((p) => {
    if (p.resolved.matchKind === "fuzzy") fuzzy++;
    const slot: ParticleSlot = { match: p.match };
    if (p.resolved.isotopeAssumed && p.resolved.isotope) {
      slot.isotopeAssumed = p.resolved.isotope;
      assumptions.push(`${elementName(p.resolved)} → ${p.resolved.isotope}`);
    }
    return slot;
  });

  const materials: MaterialSlot[] = rawMaterials.map((m) => {
    if (m.resolved.matchKind === "fuzzy") fuzzy++;
    return { match: m.match };
  });

  // The first element-named, multi-nucleon ion governs total→per-nucleon reads.
  const heavyIon = rawParticles.find((p) => p.resolved.isotopeAssumed && p.resolved.massNumber > 1);

  const energies: EnergySlot[] = rawEnergies.map((e) => {
    const slot: EnergySlot = { value: e.value, unit: e.unit };
    if (e.perNucleon) {
      slot.perNucleonAssumed = true;
    } else if (heavyIon) {
      // A bare energy on a heavy ion is read as *total* and flagged.
      slot.perNucleonAssumed = false;
      const pn = perNucleon(e.value, e.unit, heavyIon.resolved.massNumber);
      assumptions.push(`${e.value} ${e.unit} taken as total → ${pn.value} ${pn.unit}`);
    }
    return slot;
  });

  // Required-slot completeness check (drives both `incomplete` and confidence).
  const needsEnergy = quantity !== "energyFromRange" && quantity !== "energyFromStp";
  const needsTarget = !needsEnergy;
  const incomplete =
    particles.length === 0 ||
    materials.length === 0 ||
    (needsEnergy && energies.length === 0) ||
    (needsTarget && target === undefined);

  const confidence = scoreConfidence(source, fuzzy, incomplete);

  const intent: QueryIntent = {
    quantity,
    compareDim,
    particles,
    materials,
    energies,
    assumptions,
    confidence,
  };
  if (target !== undefined) intent.target = target;

  const result: MatchResult = { intent, quantitySource: source, incomplete };
  if (!inverse && fwd?.idiom) result.idiom = fwd.idiom;
  return result;
}

/** Convenience wrapper when only the intent is needed. */
export function matchQueryIntent(text: string): QueryIntent {
  return matchIntent(text).intent;
}

/**
 * Map provenance to a calibrated confidence in [0, 1]. The weights are
 * deliberately simple and monotone so the harness's calibration plot is
 * interpretable: direct > inverse > indirect, every fuzzy resolution discounts,
 * and a missing required slot caps confidence low.
 */
function scoreConfidence(source: QuantitySource, fuzzy: number, incomplete: boolean): number {
  const base =
    source === "direct" ? 0.97 : source === "inverse" ? 0.9 : source === "indirect" ? 0.82 : 0.5;
  let c = base * Math.pow(0.8, fuzzy);
  if (incomplete) c = Math.min(c, 0.4);
  return round(Math.max(0, Math.min(1, c)));
}
