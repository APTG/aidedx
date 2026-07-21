/**
 * Pure helpers for patching one slot of a `QueryIntent` after a manual
 * correction (issue #10 trust-loop chips). Each returns a new intent — the
 * original is never mutated. A manual edit supersedes whatever the matcher
 * guessed, so every helper also clears `assumptions` (a stale "carbon → ¹²C"
 * note next to a user-corrected particle would be actively misleading) and
 * sets `confidence: 1` (the user has now confirmed this slot directly).
 */
import type { EnergyUnit, QueryIntent } from "./query-intent.ts";

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

export function withEnergy(
  intent: QueryIntent,
  index: number,
  value: number,
  unit: EnergyUnit,
): QueryIntent {
  const energies = intent.energies.map((e, i) => (i === index ? { ...e, value, unit } : e));
  return withCorrection(intent, { energies });
}

export function withTarget(intent: QueryIntent, value: number, unit: string): QueryIntent {
  return withCorrection(intent, { target: { value, unit } });
}

export function withProgram(intent: QueryIntent, program: string | undefined): QueryIntent {
  const next = withCorrection(intent, {});
  if (program === undefined) delete next.program;
  else next.program = program;
  return next;
}
