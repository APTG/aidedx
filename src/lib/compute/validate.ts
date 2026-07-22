/**
 * validateIntent() — physics-plausibility gate between NLU and compute (issue #29).
 *
 * A resolved `QueryIntent` can still be *confidently wrong* in ways `computeIntent()` has no
 * reason to reject: a non-existent isotope ("carbon-30"), a particle/material/program
 * combination libdedx has no tables for under an explicitly named program, or an energy that's
 * outside the tabulated grid because a unit got misheard ("240 keV" as "240 MeV"). Today
 * `computeIntent()` either throws (unresolvable entities) or silently returns a real-looking
 * number — neither path flags "this input itself looks physically implausible." This module is
 * read-only against `compute.ts`/libdedx: it never mutates a `ComputeResult`, and it's a
 * separate, additive call — callers decide independently whether to run it before, after, or
 * instead of `computeIntent()`.
 *
 * The exact width of "plausible" (isotope bound, whether unresolvable programs should be
 * treated as harder errors) is flagged in the issue as needing physicist sign-off later — that's
 * a threshold-tuning follow-up, not a blocker to this v1: libdedx already exposes the hard data
 * (`getMinEnergy`/`getMaxEnergy`, `getParticles`/`getMaterials`) the checks below need.
 */
import type { EnergySlot, QueryIntent } from "../intent/query-intent.ts";
import { resolveMaterial, resolveParticle } from "../aliases/lookup.ts";
import { ELECTRON_ID } from "../wasm/libdedx.ts";
import type { LibdedxService } from "../wasm/types.ts";
import { formatEnergyPerNucleon } from "../format.ts";
import {
  atomicMassForConversion,
  energyToMeVPerNucl,
  programName,
  programSupportsCombination,
  resolveProgramId,
} from "./compute.ts";

export type PlausibilitySlot = "particle" | "material" | "energy";

export interface PlausibilityIssue {
  slot: PlausibilitySlot;
  /** Index into `intent.particles` / `intent.materials` / `intent.energies`, matching `slot`. */
  index?: number;
  message: string;
  /** A concrete alternate reading worth offering the user, e.g. a re-unitized energy. */
  suggestion?: string;
}

export interface ValidationResult {
  plausible: boolean;
  issues: PlausibilityIssue[];
}

/**
 * Real isotopes satisfy Z <= A (a nuclide can't have fewer nucleons than protons) and, on the
 * heavy side, stay within roughly A <= 3Z + 10 — checked against periodictable.com's known-
 * isotope tables for H, He, C, O, Ca, Fe and Wikipedia's isotopes-of-uranium list (27 known
 * isotopes span A=214 to A=242; this bound's ceiling for Z=92 is A<=286, comfortably above that
 * real max). This is a coarse "impossible vs merely exotic" gate, not a
 * per-element nuclide chart: wide enough to never reject a real (if rare) isotope libdedx would
 * otherwise compute fine, but tight enough to catch a grossly wrong one (carbon-30, A=30,
 * against carbon's real max of A=22 and this bound's A<=28).
 */
function isPlausibleIsotope(atomicNumber: number, massNumber: number): boolean {
  return massNumber >= atomicNumber && massNumber <= 3 * atomicNumber + 10;
}

/** Magnitude-prefix units eligible for the "wrong unit, not wrong number" reframing below. */
const ENERGY_UNIT_MAGNITUDE_FAMILY = ["keV", "MeV", "GeV"] as const;

/**
 * When `energy` falls outside [min, max] MeV/nucl, check whether reading its raw number in a
 * different magnitude unit (keV/MeV/GeV) would land inside the grid instead — issue #29's
 * "unit-suspect first" ask: a misheard magnitude prefix is far likelier than a genuinely
 * out-of-range number. Restricted to the three absolute units; "MeV/nucl"/"MeV/u" are already an
 * explicit per-nucleon reading from the parser, not a plausible ASR magnitude confusion.
 */
function suggestAlternateUnit(
  energy: EnergySlot,
  massNumber: number,
  atomicMass: number,
  min: number,
  max: number,
): string | undefined {
  if (!(ENERGY_UNIT_MAGNITUDE_FAMILY as readonly string[]).includes(energy.unit)) {
    return undefined;
  }
  for (const altUnit of ENERGY_UNIT_MAGNITUDE_FAMILY) {
    if (altUnit === energy.unit) continue;
    const meVPerNucl = energyToMeVPerNucl(
      {
        value: energy.value,
        unit: altUnit,
        ...(energy.perNucleonAssumed !== undefined
          ? { perNucleonAssumed: energy.perNucleonAssumed }
          : {}),
      },
      massNumber,
      atomicMass,
    );
    if (meVPerNucl >= min && meVPerNucl <= max) return altUnit;
  }
  return undefined;
}

/**
 * One (particle, material) pair to plausibility-check, plus each side's real position in
 * `intent.particles` / `intent.materials` — used to attribute a combination failure to whichever
 * side is actually unsupported (see `validateIntent()`), not to whichever side `compareDim`
 * happens to be varying.
 */
interface ActivePair {
  particleMatch: string;
  materialMatch: string;
  particleIndex: number;
  materialIndex: number;
}

/**
 * Mirrors `computeIntent()`'s own fan-out — which (particle, material) pairs are actually used
 * depends on `compareDim` (e.g. `compareDim: "particle"` fixes `materials[0]` and varies every
 * particle) — so the combination/energy checks below never flag a slot compute would never
 * touch. `compareDim: "program"` is deliberately excluded: it compares across programs
 * including ones expected to lack the combination, which is already a normal per-series result
 * there (see `forwardSeries`'s soft `error`), not a plausibility problem.
 */
function activePairsFor(intent: QueryIntent): ActivePair[] {
  const firstParticle = intent.particles[0];
  const firstMaterial = intent.materials[0];
  if (intent.compareDim === "material" && firstParticle) {
    return intent.materials.map((m, materialIndex) => ({
      particleMatch: firstParticle.match,
      materialMatch: m.match,
      particleIndex: 0,
      materialIndex,
    }));
  }
  if (intent.compareDim === "particle" && firstMaterial) {
    return intent.particles.map((p, particleIndex) => ({
      particleMatch: p.match,
      materialMatch: firstMaterial.match,
      particleIndex,
      materialIndex: 0,
    }));
  }
  if (intent.compareDim !== "program" && firstParticle && firstMaterial) {
    return [
      {
        particleMatch: firstParticle.match,
        materialMatch: firstMaterial.match,
        particleIndex: 0,
        materialIndex: 0,
      },
    ];
  }
  return [];
}

/**
 * Drops exact (slot, index, message) repeats — the same underlying fact can otherwise surface
 * once per pair, e.g. a particle unsupported by the selected program fails identically against
 * every material in a `compareDim: "material"` list.
 */
function dedupeIssues(issues: PlausibilityIssue[]): PlausibilityIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.slot}:${issue.index}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Physics-plausibility gate: everything here is a *soft* signal (an issues list, never a throw)
 * so a caller can still fall through to `computeIntent()` once the user confirms an odd-looking
 * input was intentional. Three checks, matching the issue's three named slots:
 *
 *  1. isotope existence — every particle mention, via the bound above.
 *  2. particle/material/program combination — see `activePairsFor()`.
 *  3. energy within the tabulated grid — forward queries only (inverse queries solve *for*
 *     energy; there's nothing given to check) and only once (2) checked out for that pair (an
 *     unsupported program's [min, max] is meaningless, not evidence about the energy itself).
 *
 * Unresolvable particles/materials are silently skipped: `computeIntent()` already throws a
 * clear `ComputeError` for those, and duplicating that here would just be a second, weaker copy
 * of the same message. Electron mentions are skipped for the same reason (rejected elsewhere).
 */
export function validateIntent(intent: QueryIntent, service: LibdedxService): ValidationResult {
  const issues: PlausibilityIssue[] = [];

  intent.particles.forEach((p, index) => {
    const resolved = resolveParticle(p.match);
    if (!resolved || resolved.id === ELECTRON_ID) return;
    if (!isPlausibleIsotope(resolved.id, resolved.massNumber)) {
      issues.push({
        slot: "particle",
        index,
        message: `${resolved.isotope || `${resolved.name}-${resolved.massNumber}`} is not a plausible isotope of ${resolved.name} (Z=${resolved.id})`,
      });
    }
  });

  const isInverse = intent.quantity === "energyFromRange" || intent.quantity === "energyFromStp";

  for (const pair of activePairsFor(intent)) {
    const particle = resolveParticle(pair.particleMatch);
    const material = resolveMaterial(pair.materialMatch);
    if (!particle || particle.id === ELECTRON_ID || !material) continue;

    const programId = resolveProgramId(intent, particle, material.id, service);
    if (!programSupportsCombination(service, programId, particle.id, material.id)) {
      // Attribute to whichever side is actually missing from the program's own tables — e.g.
      // proton + Boron under PSTAR is a *material* gap (PSTAR supports protons everywhere else),
      // not a particle problem, even though the particle slot is what a singleton query varies.
      const name = programName(programId);
      const particleOk = service.getParticles(programId).some((p) => p.id === particle.id);
      const materialOk = service.getMaterials(programId).some((m) => m.id === material.id);
      if (!particleOk) {
        issues.push({
          slot: "particle",
          index: pair.particleIndex,
          message: `${particle.name} has no data under ${name}`,
        });
      }
      if (!materialOk) {
        issues.push({
          slot: "material",
          index: pair.materialIndex,
          message: `${material.name} has no data under ${name} for ${particle.name}`,
        });
      }
      continue;
    }

    if (isInverse || intent.energies.length === 0) continue;
    const min = service.getMinEnergy(programId, particle.id);
    const max = service.getMaxEnergy(programId, particle.id);
    const atomicMass = atomicMassForConversion(particle, service);
    intent.energies.forEach((e, index) => {
      const meVPerNucl = energyToMeVPerNucl(e, particle.massNumber, atomicMass);
      if (meVPerNucl >= min && meVPerNucl <= max) return;
      const altUnit = suggestAlternateUnit(e, particle.massNumber, atomicMass, min, max);
      issues.push({
        slot: "energy",
        index,
        message: `${e.value} ${e.unit} is outside the valid range ${formatEnergyPerNucleon(min, particle.massNumber)} to ${formatEnergyPerNucleon(max, particle.massNumber)} for ${particle.name} in ${material.name}`,
        ...(altUnit ? { suggestion: `Did you mean ${e.value} ${altUnit}?` } : {}),
      });
    });
  }

  const deduped = dedupeIssues(issues);
  return { plausible: deduped.length === 0, issues: deduped };
}

/** Composes the user-facing banner text for a single-issue targeted re-ask (issue #10). */
export function buildReAskNotice(issue: PlausibilityIssue): string {
  return issue.suggestion
    ? `${issue.message}. ${issue.suggestion}`
    : `${issue.message}. Please double-check this before trusting the result.`;
}
