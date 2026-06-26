/**
 * Coverage harness for the deterministic matcher (issue #5).
 *
 * Runs {@link matchIntent} over the hand-labeled eval set and measures how much
 * of it the deterministic half gets right — the empirical answer to "how much
 * LLM do we actually need". It reports:
 *   - exact-intent accuracy (all slots incl. assumptions) and a softer
 *     slots-only figure (entity identity, ignoring raw phrasing/assumptions),
 *   - a per-tag breakdown so each phenomenon (indirect, compare-*, inverse, …)
 *     can be scoped independently,
 *   - confidence calibration (does a higher confidence mean a likelier hit?),
 *   - the explicit list of misses — the candidates a future LLM must cover.
 *
 * Comparison is intentionally *semantic*, not string-equality: particles and
 * materials are compared by the libdedx entity they resolve to (via the alias
 * tables) so that a correct "carbon" vs the gold's "carbon ions" is not counted
 * as a miss. The raw `match` phrasing is cosmetic; the resolved entity is not.
 */
import { resolveMaterial, resolveParticle } from "../aliases/index.ts";
import { matchIntent } from "./matcher.ts";
import type { EvalExample, QueryIntent } from "./query-intent.ts";

// ---------------------------------------------------------------------------
// Field-level comparison
// ---------------------------------------------------------------------------

/** Per-field verdicts for one example (true = matches the gold label). */
export interface FieldVerdicts {
  quantity: boolean;
  compareDim: boolean;
  particles: boolean;
  materials: boolean;
  energies: boolean;
  target: boolean;
  assumptions: boolean;
}

export interface ExampleResult {
  id: string;
  text: string;
  tags: string[];
  predicted: QueryIntent;
  expected: QueryIntent;
  fields: FieldVerdicts;
  /** All slots match (quantity/compareDim/particles/materials/energies/target). */
  slotMatch: boolean;
  /** slotMatch *and* assumptions match — the strict exact-intent verdict. */
  exactMatch: boolean;
  confidence: number;
}

function eqParticles(a: QueryIntent["particles"], b: QueryIntent["particles"]): boolean {
  if (a.length !== b.length) return false;
  return a.every((pa, i) => {
    const pb = b[i];
    if (!pb) return false;
    const ra = resolveParticle(pa.match);
    const rb = resolveParticle(pb.match);
    // Compare by resolved entity when both resolve; else fall back to phrasing.
    if (ra && rb) {
      return (
        ra.id === rb.id &&
        ra.massNumber === rb.massNumber &&
        Boolean(pa.isotopeAssumed) === Boolean(pb.isotopeAssumed)
      );
    }
    return pa.match.toLowerCase() === pb.match.toLowerCase();
  });
}

function eqMaterials(a: QueryIntent["materials"], b: QueryIntent["materials"]): boolean {
  if (a.length !== b.length) return false;
  return a.every((ma, i) => {
    const mb = b[i];
    if (!mb) return false;
    const ra = resolveMaterial(ma.match);
    const rb = resolveMaterial(mb.match);
    if (ra && rb) return ra.id === rb.id;
    return ma.match.toLowerCase() === mb.match.toLowerCase();
  });
}

function eqEnergies(a: QueryIntent["energies"], b: QueryIntent["energies"]): boolean {
  if (a.length !== b.length) return false;
  return a.every((ea, i) => {
    const eb = b[i];
    if (!eb) return false;
    return (
      ea.value === eb.value && ea.unit === eb.unit && ea.perNucleonAssumed === eb.perNucleonAssumed
    );
  });
}

/** Normalize a target unit for tolerant comparison ("g/cm2" == "G/CM2"). */
function normUnit(u: string): string {
  return u.toLowerCase().replace(/\s+/g, "");
}

function eqTarget(a: QueryIntent["target"], b: QueryIntent["target"]): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.value === b.value && normUnit(a.unit) === normUnit(b.unit);
}

function eqAssumptions(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
}

/** Compare one matcher output against its gold label. */
export function compareIntent(predicted: QueryIntent, expected: QueryIntent): FieldVerdicts {
  return {
    quantity: predicted.quantity === expected.quantity,
    compareDim: predicted.compareDim === expected.compareDim,
    particles: eqParticles(predicted.particles, expected.particles),
    materials: eqMaterials(predicted.materials, expected.materials),
    energies: eqEnergies(predicted.energies, expected.energies),
    target: eqTarget(predicted.target, expected.target),
    assumptions: eqAssumptions(predicted.assumptions, expected.assumptions),
  };
}

/** Run the matcher on one example and produce its result row. */
export function evaluateExample(example: EvalExample): ExampleResult {
  const { intent } = matchIntent(example.text);
  const fields = compareIntent(intent, example.expected);
  const slotMatch =
    fields.quantity &&
    fields.compareDim &&
    fields.particles &&
    fields.materials &&
    fields.energies &&
    fields.target;
  return {
    id: example.id,
    text: example.text,
    tags: example.tags,
    predicted: intent,
    expected: example.expected,
    fields,
    slotMatch,
    exactMatch: slotMatch && fields.assumptions,
    confidence: intent.confidence,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface TagStat {
  tag: string;
  total: number;
  slot: number;
  exact: number;
}

export interface CalibrationBucket {
  label: string;
  lo: number;
  hi: number;
  total: number;
  exact: number;
}

export interface CoverageReport {
  total: number;
  slotMatches: number;
  exactMatches: number;
  /** Count of each field that was wrong, across all examples. */
  fieldMisses: Record<keyof FieldVerdicts, number>;
  tagStats: TagStat[];
  calibration: CalibrationBucket[];
  misses: ExampleResult[];
  results: ExampleResult[];
}

const FIELD_KEYS: ReadonlyArray<keyof FieldVerdicts> = [
  "quantity",
  "compareDim",
  "particles",
  "materials",
  "energies",
  "target",
  "assumptions",
];

const CALIBRATION_BANDS: ReadonlyArray<{ label: string; lo: number; hi: number }> = [
  { label: "[0.90, 1.00]", lo: 0.9, hi: 1.0001 },
  { label: "[0.80, 0.90)", lo: 0.8, hi: 0.9 },
  { label: "[0.50, 0.80)", lo: 0.5, hi: 0.8 },
  { label: "[0.00, 0.50)", lo: 0.0, hi: 0.5 },
];

/** Evaluate every example and aggregate into a full coverage report. */
export function runCoverage(examples: EvalExample[]): CoverageReport {
  const results = examples.map(evaluateExample);

  const fieldMisses = Object.fromEntries(FIELD_KEYS.map((k) => [k, 0])) as Record<
    keyof FieldVerdicts,
    number
  >;
  for (const r of results) {
    for (const k of FIELD_KEYS) if (!r.fields[k]) fieldMisses[k]++;
  }

  // Per-tag breakdown.
  const tagMap = new Map<string, TagStat>();
  for (const r of results) {
    for (const tag of r.tags) {
      const s = tagMap.get(tag) ?? { tag, total: 0, slot: 0, exact: 0 };
      s.total++;
      if (r.slotMatch) s.slot++;
      if (r.exactMatch) s.exact++;
      tagMap.set(tag, s);
    }
  }
  const tagStats = [...tagMap.values()].sort((a, b) => a.tag.localeCompare(b.tag));

  // Confidence calibration.
  const calibration: CalibrationBucket[] = CALIBRATION_BANDS.map((b) => {
    const inBand = results.filter((r) => r.confidence >= b.lo && r.confidence < b.hi);
    return {
      label: b.label,
      lo: b.lo,
      hi: b.hi,
      total: inBand.length,
      exact: inBand.filter((r) => r.exactMatch).length,
    };
  });

  return {
    total: results.length,
    slotMatches: results.filter((r) => r.slotMatch).length,
    exactMatches: results.filter((r) => r.exactMatch).length,
    fieldMisses,
    tagStats,
    calibration,
    misses: results.filter((r) => !r.exactMatch),
    results,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pct(n: number, d: number): string {
  if (d === 0) return "  n/a";
  return `${((100 * n) / d).toFixed(1).padStart(5)}%`;
}

/** Which gold fields a miss got wrong, as a compact "particles, energies" list. */
function missReasons(r: ExampleResult): string {
  return FIELD_KEYS.filter((k) => !r.fields[k]).join(", ");
}

/** Render a full human-readable report (used by the CLI and snapshot tests). */
export function formatReport(report: CoverageReport, opts: { showMisses?: boolean } = {}): string {
  const { total, slotMatches, exactMatches } = report;
  const lines: string[] = [];

  lines.push("Deterministic NLU coverage — eval/intents.jsonl");
  lines.push("=".repeat(56));
  lines.push(`examples            ${total}`);
  lines.push(
    `slot coverage       ${slotMatches}/${total}  ${pct(slotMatches, total)}   (entity identity; ignores phrasing & assumptions)`,
  );
  lines.push(
    `exact-intent        ${exactMatches}/${total}  ${pct(exactMatches, total)}   (all slots + assumptions)`,
  );
  lines.push("");

  lines.push("Field accuracy (share of examples with that field correct):");
  for (const k of FIELD_KEYS) {
    const ok = total - report.fieldMisses[k];
    lines.push(`  ${k.padEnd(12)} ${pct(ok, total)}  (${ok}/${total})`);
  }
  lines.push("");

  lines.push("Per-tag breakdown (slot | exact):");
  for (const s of report.tagStats) {
    lines.push(
      `  ${s.tag.padEnd(26)} ${pct(s.slot, s.total)} | ${pct(s.exact, s.total)}  (${s.total})`,
    );
  }
  lines.push("");

  lines.push("Confidence calibration (exact-match rate per predicted-confidence band):");
  for (const b of report.calibration) {
    lines.push(`  ${b.label}   ${pct(b.exact, b.total)}  (${b.exact}/${b.total})`);
  }
  lines.push("");

  if (opts.showMisses) {
    lines.push(`Misses — ${report.misses.length} LLM-fallback candidate(s):`);
    for (const r of report.misses) {
      lines.push(`  ✗ ${r.id.padEnd(14)} [${missReasons(r)}]`);
      lines.push(`      ${r.text}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
