/**
 * Pure helpers for patching one slot of a `QueryIntent` after a manual
 * correction (issue #10 trust-loop chips). Each returns a new intent — the
 * original is never mutated. A manual edit supersedes whatever the matcher
 * guessed, so every helper also clears `assumptions` (a stale "carbon → ¹²C"
 * note next to a user-corrected particle would be actively misleading) and
 * sets `confidence: 1` (the user has now confirmed this slot directly).
 */
import type { EnergyUnit, QueryIntent, RangeTargetUnit, StpTargetUnit } from "./query-intent.ts";

function withCorrection(intent: QueryIntent, patch: Partial<QueryIntent>): QueryIntent {
  return { ...intent, ...patch, assumptions: [], confidence: 1 };
}

export function withParticleMatch(intent: QueryIntent, index: number, match: string): QueryIntent {
  // Omitting isotopeAssumed (rather than setting it undefined) clears it —
  // it was derived from the old, mis-heard match text and no longer applies.
  const particles = intent.particles.map((p, i) => (i === index ? { match } : p));
  return withCorrection(intent, { particles });
}

export function withMaterialMatch(intent: QueryIntent, index: number, match: string): QueryIntent {
  const materials = intent.materials.map((m, i) => (i === index ? { match } : m));
  return withCorrection(intent, { materials });
}

// issue #163 C1 — an explicit per-nucleon unit (MeV/nucl, MeV/u); every other unit is an absolute
// (total) energy reading. `withEnergy()` must re-derive `perNucleonAssumed` from the *new* unit,
// not carry over the old one: `{...e, value, unit}` used to keep whatever flag the *previous* unit
// had, so switching a heavy-ion energy's unit from "MeV/u" to "MeV" left `perNucleonAssumed: true`
// attached to a now-absolute unit — `energyToMeVPerNucl()`'s default branch reads that flag and
// skipped the ÷A division entirely, a silent 76x error on carbon (`plausible: true` throughout,
// since `validateIntent()` has no target/energy-reading check for this). The fix must not depend
// on the particle's mass number: a single energy can be shared across several particles in a
// comparison (`compareDim: "particle"`), each with their own A, and `perNucleonAssumed` only ever
// says how to *read* the unit, not what any one particle does with it downstream.
const EXPLICIT_PER_NUCLEON_UNITS: ReadonlySet<EnergyUnit> = new Set(["MeV/nucl", "MeV/u"]);

export function withEnergy(
  intent: QueryIntent,
  index: number,
  value: number,
  unit: EnergyUnit,
): QueryIntent {
  const energies = intent.energies.map((e, i) =>
    i === index ? { value, unit, perNucleonAssumed: EXPLICIT_PER_NUCLEON_UNITS.has(unit) } : e,
  );
  return withCorrection(intent, { energies });
}

// issue #163 B1/B2 — `unit` is the closed set now, not a free string; the one caller
// (`IntentChips.svelte`'s `commitTarget`, a free-text chip edit) validates the user's typed unit
// against `RANGE_TARGET_UNITS`/`STP_TARGET_UNITS` before calling this, the same "validate at the
// system boundary" spot every other free-text chip edit in that component already uses.
export function withTarget(
  intent: QueryIntent,
  value: number,
  unit: RangeTargetUnit | StpTargetUnit,
): QueryIntent {
  return withCorrection(intent, { target: { value, unit } });
}

export function withProgram(intent: QueryIntent, program: string | undefined): QueryIntent {
  const next = withCorrection(intent, {});
  if (program === undefined) delete next.program;
  else next.program = program;
  return next;
}
