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

/**
 * issue #163 §5.2 forward-compat prep — classifies each `Quantity` as `"forward"` (the answer is
 * a physical value at a given energy) or `"inverse"` (the answer is the energy that reaches a
 * given value). Before this, `compute.ts`, `validate.ts`, `render.ts`, `dedx-web-link.ts`, and
 * `fill-defaults.ts` each independently re-derived the same boolean from the literal quantity
 * names (`quantity === "energyFromRange" || quantity === "energyFromStp"`, repeated verbatim at
 * 6 call sites) — every one an equally-plausible place for a future quantity (electron/ESTAR
 * support already has its plumbing ready per the issue's §5.1; projected range is further out)
 * to be missed and silently take the wrong branch, rather than a compile error. A
 * `Record<Quantity, ...>` keyed on the closed `QUANTITIES` union makes that impossible: adding a
 * quantity without an entry here fails to typecheck.
 *
 * `stoppingPower`/`csdaRange` finer-grained *which-forward-quantity* branches (`matcher.ts`'s
 * target-slot grammar picking range vs stopping-power) aren't replaced by this — they need to
 * know which specific quantity, not just the forward/inverse class. This only consolidates the
 * genuine forward-vs-inverse boolean; `render.ts`'s own which-forward-quantity pick was §5.5's
 * separate fix — `ComputePoint.values` is keyed directly by `Quantity` (`compute.ts`), so
 * `valueText()` reads `point.values[quantity]` instead of a hardcoded field-name ternary.
 */
export const QUANTITY_KIND: Record<Quantity, "forward" | "inverse"> = {
  stoppingPower: "forward",
  csdaRange: "forward",
  energyFromRange: "inverse",
  energyFromStp: "inverse",
};

/**
 * True for a quantity whose answer is the energy that reaches a given `target` value, as opposed
 * to a physical value at a given energy. See `QUANTITY_KIND`'s doc comment. A type predicate (not
 * just a boolean-returning function) so a guard clause built on it — `if (isInverseQuantity(q))
 * return ...;` — narrows `q` to the forward pair for the code after it, the same narrowing
 * `render.ts`'s now-removed local `isInverse()` used to provide directly.
 */
export function isInverseQuantity(
  quantity: Quantity,
): quantity is "energyFromRange" | "energyFromStp" {
  return QUANTITY_KIND[quantity] === "inverse";
}

export const COMPARE_DIMS = ["none", "material", "particle", "program", "energy"] as const;
export type CompareDim = (typeof COMPARE_DIMS)[number];

export const ENERGY_UNITS = ["MeV", "keV", "GeV", "TeV", "MeV/nucl", "MeV/u"] as const;
export type EnergyUnit = (typeof ENERGY_UNITS)[number];

/**
 * issue #163 B1/B2 — closed unit sets for an inverse query's `target`, replacing the
 * previously-free `unit: string`. That freedom is what let the matcher (`matcher.ts`'s
 * `extractRangeTarget`/`extractStpTarget`) emit `"um"` / `"keV/um"` while the converters
 * (`compute.ts`'s `rangeTargetToGcm2`/`stpTargetToMassUnits`) had no branch for either and
 * silently fell through to the wrong unit family (~200× and ~18× errors, both with
 * `confidence: 0.9`/`incomplete: false` — nothing signaled a problem). `RANGE_TARGET_UNITS` /
 * `STP_TARGET_UNITS` are the two producers' *complete* vocabularies; `compute.ts` now switches
 * over them exhaustively (a `never` check), so a unit added to one array without a matching
 * converter branch is a compile error, not a silent wrong answer three files away.
 */
export const RANGE_TARGET_UNITS = ["cm", "mm", "m", "um", "g/cm2"] as const;
export type RangeTargetUnit = (typeof RANGE_TARGET_UNITS)[number];

export const STP_TARGET_UNITS = ["MeV cm2/g", "MeV/cm", "keV/um"] as const;
export type StpTargetUnit = (typeof STP_TARGET_UNITS)[number];

/**
 * issue #163 B5/B6 — the closed set of canonical program *display* names, the third of §4.1's
 * three named cross-layer-drift sites (`TargetSlot.unit` was B1/B2; this and `PROGRAM_RE`'s
 * vocabulary are B5/B6). `matcher.ts` (to decide `intent.program` vs. B6's `unresolved`),
 * `compute.ts` (`PROGRAM_NAME_TO_ID`, exhaustive against this set), and `IntentChips.svelte` (chip
 * re-entry validation) all resolve against the *same* `PROGRAM_ALIASES` table below rather than
 * each keeping their own synonym list, so a program name added to one can't silently drift from
 * what the others recognize.
 */
export const PROGRAM_NAMES = [
  "ASTAR",
  "PSTAR",
  "ESTAR",
  "MSTAR",
  "ICRU73",
  "ICRU73 (old)",
  "ICRU49",
  "Bethe",
  "Bethe-ext",
] as const;
export type ProgramName = (typeof PROGRAM_NAMES)[number];

/** Fold a program name to a lookup key: uppercase, strip everything but A–Z/0–9. */
function normalizeProgramKey(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Synonyms/case variants ("bethe", "libdedx", "icru", "ICRU73OLD") folded onto the canonical
 * `PROGRAM_NAMES` spelling. Deliberately does *not* include `PROGRAM_RE`'s wider match vocabulary
 * (`srim`, `atima`, `geant4`, `fluka`, `nist`) — those are program-shaped words libdedx has no
 * data for at all, exactly the set B6 exists to flag as `unresolved` rather than silently
 * substitute a name from this table for.
 */
const PROGRAM_ALIASES: Readonly<Record<string, ProgramName>> = {
  ASTAR: "ASTAR",
  PSTAR: "PSTAR",
  ESTAR: "ESTAR",
  MSTAR: "MSTAR",
  ICRU73: "ICRU73",
  ICRU73OLD: "ICRU73 (old)",
  ICRU49: "ICRU49",
  ICRU: "ICRU49",
  DEFAULT: "Bethe",
  BETHE: "Bethe",
  LIBDEDX: "Bethe",
  BETHEEXT: "Bethe-ext",
  // issue #163 (found via contracts.test.ts) — "extended" is a plausible full pronunciation of
  // "ext" (matcher.ts's PROGRAM_RE now captures both), so it needs its own normalized key here
  // too; "BETHEEXT" alone doesn't match "Bethe extended" — normalizeProgramKey() strips spaces,
  // not the extra letters.
  BETHEEXTENDED: "Bethe-ext",
};

/**
 * Resolves any case/spacing/separator variant of a program name ("pstar", "Bethe Ext", "icru")
 * to its canonical `ProgramName`, or `null` when libdedx has no such program (an unrecognized name,
 * or a program-shaped word `PROGRAM_RE` matches but this table doesn't cover — `srim`, `nist`, …).
 * The one shared authority every layer (`matcher.ts`, `compute.ts`, `IntentChips.svelte`) resolves
 * a program name string against, so "supported" can never mean something different in one layer
 * than another.
 */
export function resolveProgramName(raw: string): ProgramName | null {
  return PROGRAM_ALIASES[normalizeProgramKey(raw)] ?? null;
}

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
 * `energyFromRange`, or a stopping power for `energyFromStp`. `unit` is the union of both
 * quantities' closed vocabularies (`RangeTargetUnit | StpTargetUnit`) rather than a single
 * `kind`-discriminated shape — which of the two subsets is actually valid is already implied by
 * the surrounding `QueryIntent.quantity`, so a second discriminant field would just repeat that.
 * `compute.ts` narrows with a runtime type guard before its exhaustive per-quantity switch (issue
 * #163 B1/B2).
 */
export interface TargetSlot {
  value: number;
  unit: RangeTargetUnit | StpTargetUnit;
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
  /**
   * issue #163 C7 — the explicit set of programs to fan out over for a `compareDim: "program"`
   * query, analogous to `program` above but for a comparison, where a single scalar can't
   * represent a set. Free strings (not `ProgramName[]`), for the same producer-agnostic reason
   * `program` is: `compute.ts` resolves each one through the shared `resolveProgramName()` at
   * compute time, exactly the way it resolves `program`. Omitted, or present but empty, falls
   * back to `compute.ts`'s legacy particle-keyed triple — the pre-C7 behavior, still exercised by
   * a producer that hasn't set this field (hand-built eval gold, a test that bypasses the
   * matcher). Only meaningful alongside `compareDim: "program"`; ignored otherwise.
   */
  programs?: string[];
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
  "adversarial",
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

/** Energies and target values are physical magnitudes — zero and negative
 * readings are not valid queries (issue #42 §5). */
function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
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
      if (!isPositiveFiniteNumber(e.value)) {
        errors.push(`${path}.energies[${i}].value: must be a positive finite number`);
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
    // issue #163 B1/B2 — was `typeof t.unit === "string"`, which is exactly what let an
    // unhandled unit (`"um"`, `"keV/um"`) reach the compute layer's silent fallthrough. Checking
    // membership in the combined closed set is the schema half of closing that hole; the other
    // half is `compute.ts`'s exhaustive per-quantity switch over the narrower of the two unions.
    const validUnit =
      isPlainObject(t) &&
      typeof t.unit === "string" &&
      ((RANGE_TARGET_UNITS as readonly string[]).includes(t.unit) ||
        (STP_TARGET_UNITS as readonly string[]).includes(t.unit));
    if (!isPlainObject(t) || !isPositiveFiniteNumber(t.value) || !validUnit) {
      errors.push(
        `${path}.target: must be { value: positive number, unit: one of ` +
          `${[...RANGE_TARGET_UNITS, ...STP_TARGET_UNITS].join(" | ")} } when present`,
      );
    }
  }

  if ("program" in value && value.program !== undefined && typeof value.program !== "string") {
    errors.push(`${path}.program: must be a string when present`);
  }

  if (
    "programs" in value &&
    value.programs !== undefined &&
    (!Array.isArray(value.programs) || value.programs.some((p) => typeof p !== "string"))
  ) {
    errors.push(`${path}.programs: must be an array of strings when present`);
  }

  if (!Array.isArray(value.assumptions) || value.assumptions.some((a) => typeof a !== "string")) {
    errors.push(`${path}.assumptions: must be an array of strings`);
  }

  if (!isFiniteNumber(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    errors.push(`${path}.confidence: must be a number in [0, 1]`);
  }

  // Inverse queries require a concrete target; forward queries must not carry
  // one. `target: undefined` counts as "missing" so programmatically-built
  // objects can't slip an inverse quantity through without a real target.
  const q = value.quantity;
  // Cast is safe: an invalid `q` (already flagged above) isn't a QUANTITY_KIND key, so
  // isInverseQuantity() reads it as `undefined === "inverse"` -> false, same as the old
  // `q === "energyFromRange" || q === "energyFromStp"` comparison would for garbage input.
  const needsTarget = isInverseQuantity(q as Quantity);
  const hasTarget = "target" in value && value.target !== undefined;
  if (needsTarget && !hasTarget) {
    errors.push(`${path}.target: required for quantity "${String(q)}"`);
  }
  if (!needsTarget && hasTarget) {
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
 * Whether a raw JSONL line carries a data record. Blank lines and `//`/`#`
 * comment/header lines are not data. This is the single rule every reader of
 * the dataset (validator, tests, CLI script) must share so they agree on what
 * counts as a record.
 */
export function isDataLine(rawLine: string): boolean {
  const line = rawLine.trim();
  return line.length > 0 && !line.startsWith("//") && !line.startsWith("#");
}

/**
 * Parse a JSONL dataset string into records, skipping blank/comment lines.
 * Assumes well-formed JSON (use `validateEvalDataset` to surface parse errors
 * with line numbers); throws if a data line is not valid JSON.
 */
export function parseEvalRecords(jsonl: string): EvalExample[] {
  return jsonl
    .split("\n")
    .filter(isDataLine)
    .map((line) => JSON.parse(line.trim()) as EvalExample);
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
    if (!isDataLine(raw)) return;
    const line = raw.trim();

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
