/**
 * QueryIntent — the structured slot-filling target for aidedx.
 *
 * This is the single shared source of truth for the schema described in
 * issue #1 §6. Both the deterministic matcher and the LLM fallback emit this
 * exact shape, so all downstream code (resolver, compute, NLG) is identical
 * regardless of which producer ran. The eval set in `eval/intents.jsonl`
 * (issue #3) is hand-labeled against this type and frozen as the regression
 * suite reused by Spikes 1–2.
 *
 * The module is intentionally dependency-free and framework-free so it can be
 * imported by app code, Vitest tests, and the standalone Node validator script
 * alike.
 *
 * Deviation from the §6 draft: an optional `target` slot is added to carry the
 * *given* value of an inverse query (e.g. "what energy gives a 10 cm range in
 * water?" → `target: { value: 10, unit: "cm" }`). The §6 draft listed
 * `energyFromRange` / `energyFromStp` quantities but had nowhere to put the
 * known range / stopping-power value; `target` fills that gap. See
 * `eval/README.md`.
 */

// ---------------------------------------------------------------------------
// Enumerations (kept as `as const` arrays so they double as runtime validators)
// ---------------------------------------------------------------------------

export const QUANTITIES = [
  "stoppingPower",
  "csdaRange",
  "energyFromRange",
  "energyFromStp",
] as const;
export type Quantity = (typeof QUANTITIES)[number];

export const COMPARE_DIMS = ["none", "material", "particle", "program", "energy"] as const;
export type CompareDim = (typeof COMPARE_DIMS)[number];

export const ENERGY_UNITS = ["MeV", "keV", "GeV", "MeV/nucl", "MeV/u"] as const;
export type EnergyUnit = (typeof ENERGY_UNITS)[number];

// ---------------------------------------------------------------------------
// Slot types
// ---------------------------------------------------------------------------

export interface ParticleSlot {
  /** Raw phrase as spoken, e.g. "carbon ion", "proton", "neon". */
  match: string;
  /** Set when an isotope had to be assumed, e.g. "¹²C". */
  isotopeAssumed?: string;
}

export interface MaterialSlot {
  /** Raw phrase as spoken, e.g. "water", "PMMA", "air". */
  match: string;
}

export interface EnergySlot {
  value: number;
  unit: EnergyUnit;
  /**
   * Whether the value was interpreted as per-nucleon. `false` records that a
   * bare energy on a multi-nucleon ion was taken as *total* (and will be
   * divided by A downstream); `true` records an explicit per-nucleon reading.
   * Omitted when the distinction is irrelevant (e.g. protons).
   */
  perNucleonAssumed?: boolean;
}

/**
 * The known value of an inverse query: a range (length / areal density) for
 * `energyFromRange`, or a stopping power for `energyFromStp`. `unit` is a free
 * string because the accepted units differ per quantity (e.g. "cm", "mm",
 * "g/cm2", "MeV/cm", "MeV cm2/g").
 */
export interface TargetSlot {
  value: number;
  unit: string;
}

export interface QueryIntent {
  quantity: Quantity;
  compareDim: CompareDim;
  particles: ParticleSlot[];
  materials: MaterialSlot[];
  energies: EnergySlot[];
  /** Inverse-query input; present only for energyFromRange / energyFromStp. */
  target?: TargetSlot;
  /** Usually omitted → auto-select (reuse dedx_web logic). */
  program?: string;
  /** Human-readable assumption notes, e.g. ["carbon → ¹²C"]. */
  assumptions: string[];
  /** Producer confidence; 1.0 for hand-labeled gold examples. */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Eval dataset record
// ---------------------------------------------------------------------------

export interface EvalExample {
  /** Stable unique id, e.g. "sp-direct-001". */
  id: string;
  /** The natural-language query. */
  text: string;
  /** Recorded-voice clip path; filled locally in Spike 1, null/absent here. */
  audio?: string | null;
  expected: QueryIntent;
  /** Taxonomy tags; every tag must be a member of EVAL_TAGS. */
  tags: string[];
}

/**
 * Controlled tag vocabulary. Keep in sync with `eval/README.md`. Each example
 * carries one quantity tag, one comparison tag, plus any applicable phrasing /
 * unit / ambiguity / special tags.
 */
export const EVAL_TAGS = [
  // phrasing
  "direct",
  "indirect",
  "conversational-filler",
  // quantity
  "quantity-stopping-power",
  "quantity-csda-range",
  "quantity-energy-from-range",
  "quantity-energy-from-stp",
  // comparison
  "single",
  "compare-material",
  "compare-particle",
  "compare-energy",
  "compare-program",
  // units
  "unit-keV",
  "unit-MeV",
  "unit-GeV",
  "unit-mev-per-nucl",
  "unit-mev-per-u",
  "total-vs-per-nucleon",
  // ambiguity / assumptions
  "isotope-ambiguity",
  "has-assumption",
  "program-specified",
  // special
  "stress-test",
  "inverse-query",
  "multi-energy",
] as const;
export type EvalTag = (typeof EVAL_TAGS)[number];

// ---------------------------------------------------------------------------
// Runtime validation (no external dependencies)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate a value against the QueryIntent schema. Returns a list of
 * human-readable error messages; an empty list means the value is valid.
 * `path` prefixes messages so callers can locate the offending field.
 */
export function validateQueryIntent(value: unknown, path = "expected"): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return [`${path}: must be an object`];
  }

  if (!QUANTITIES.includes(value.quantity as Quantity)) {
    errors.push(`${path}.quantity: must be one of ${QUANTITIES.join(" | ")}`);
  }
  if (!COMPARE_DIMS.includes(value.compareDim as CompareDim)) {
    errors.push(`${path}.compareDim: must be one of ${COMPARE_DIMS.join(" | ")}`);
  }

  if (!Array.isArray(value.particles)) {
    errors.push(`${path}.particles: must be an array`);
  } else {
    value.particles.forEach((p, i) => {
      if (!isPlainObject(p) || typeof p.match !== "string" || p.match.length === 0) {
        errors.push(`${path}.particles[${i}].match: must be a non-empty string`);
      } else if ("isotopeAssumed" in p && typeof p.isotopeAssumed !== "string") {
        errors.push(`${path}.particles[${i}].isotopeAssumed: must be a string when present`);
      }
    });
  }

  if (!Array.isArray(value.materials)) {
    errors.push(`${path}.materials: must be an array`);
  } else {
    value.materials.forEach((m, i) => {
      if (!isPlainObject(m) || typeof m.match !== "string" || m.match.length === 0) {
        errors.push(`${path}.materials[${i}].match: must be a non-empty string`);
      }
    });
  }

  if (!Array.isArray(value.energies)) {
    errors.push(`${path}.energies: must be an array`);
  } else {
    value.energies.forEach((e, i) => {
      if (!isPlainObject(e)) {
        errors.push(`${path}.energies[${i}]: must be an object`);
        return;
      }
      if (!isFiniteNumber(e.value)) {
        errors.push(`${path}.energies[${i}].value: must be a finite number`);
      }
      if (!ENERGY_UNITS.includes(e.unit as EnergyUnit)) {
        errors.push(`${path}.energies[${i}].unit: must be one of ${ENERGY_UNITS.join(" | ")}`);
      }
      if ("perNucleonAssumed" in e && typeof e.perNucleonAssumed !== "boolean") {
        errors.push(`${path}.energies[${i}].perNucleonAssumed: must be a boolean when present`);
      }
    });
  }

  if ("target" in value && value.target !== undefined) {
    const t = value.target;
    if (
      !isPlainObject(t) ||
      !isFiniteNumber(t.value) ||
      typeof t.unit !== "string" ||
      t.unit.length === 0
    ) {
      errors.push(`${path}.target: must be { value: number, unit: non-empty string } when present`);
    }
  }

  if ("program" in value && value.program !== undefined && typeof value.program !== "string") {
    errors.push(`${path}.program: must be a string when present`);
  }

  if (!Array.isArray(value.assumptions) || value.assumptions.some((a) => typeof a !== "string")) {
    errors.push(`${path}.assumptions: must be an array of strings`);
  }

  if (!isFiniteNumber(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    errors.push(`${path}.confidence: must be a number in [0, 1]`);
  }

  // Inverse queries require a target; forward queries must not carry one.
  const q = value.quantity;
  const needsTarget = q === "energyFromRange" || q === "energyFromStp";
  if (needsTarget && !("target" in value)) {
    errors.push(`${path}.target: required for quantity "${String(q)}"`);
  }
  if (!needsTarget && "target" in value && value.target !== undefined) {
    errors.push(`${path}.target: only allowed for inverse quantities`);
  }

  return errors;
}

/** Validate a single eval record (id/text/audio/expected/tags + intent). */
export function validateEvalExample(value: unknown, index: number): string[] {
  const where = `example[${index}]`;
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return [`${where}: must be an object`];
  }

  if (typeof value.id !== "string" || value.id.length === 0) {
    errors.push(`${where}.id: must be a non-empty string`);
  }
  if (typeof value.text !== "string" || value.text.trim().length === 0) {
    errors.push(`${where}.text: must be a non-empty string`);
  }
  if (
    "audio" in value &&
    value.audio !== null &&
    value.audio !== undefined &&
    typeof value.audio !== "string"
  ) {
    errors.push(`${where}.audio: must be a string, null, or absent`);
  }

  if (!Array.isArray(value.tags) || value.tags.length === 0) {
    errors.push(`${where}.tags: must be a non-empty array`);
  } else {
    value.tags.forEach((tag) => {
      if (typeof tag !== "string" || !(EVAL_TAGS as readonly string[]).includes(tag)) {
        errors.push(`${where}.tags: unknown tag "${String(tag)}" (not in EVAL_TAGS)`);
      }
    });
  }

  errors.push(...validateQueryIntent(value.expected, `${where}.expected`));
  return errors;
}

export interface ValidationReport {
  ok: boolean;
  count: number;
  errors: string[];
}

/**
 * Parse and validate a whole JSONL dataset string. Checks per-record schema,
 * id uniqueness, and JSON well-formedness. Blank lines and `//`/`#` comment
 * lines are ignored so the file can carry a header.
 */
export function validateEvalDataset(jsonl: string): ValidationReport {
  const errors: string[] = [];
  const seenIds = new Set<string>();
  let count = 0;

  const lines = jsonl.split("\n");
  lines.forEach((raw, lineNo) => {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("//") || line.startsWith("#")) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      errors.push(`line ${lineNo + 1}: invalid JSON (${(err as Error).message})`);
      return;
    }

    const recordErrors = validateEvalExample(parsed, count);
    errors.push(...recordErrors);

    if (isPlainObject(parsed) && typeof parsed.id === "string") {
      if (seenIds.has(parsed.id)) {
        errors.push(`example[${count}].id: duplicate id "${parsed.id}"`);
      }
      seenIds.add(parsed.id);
    }
    count += 1;
  });

  return { ok: errors.length === 0, count, errors };
}
