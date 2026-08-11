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
import { isInverseQuantity, type EnergySlot, type QueryIntent } from "../intent/query-intent.ts";
import {
  resolveMaterial,
  resolveParticle,
  type MaterialMatch,
  type ParticleMatch,
} from "../aliases/lookup.ts";
import { ELECTRON_ID } from "../wasm/libdedx.ts";
import { LibdedxError, type LibdedxService } from "../wasm/types.ts";
import { formatEnergyPerNucleon, formatSignificant } from "../format.ts";
import {
  atomicMassForConversion,
  energyToMeVPerNucl,
  programName,
  programSupportsCombination,
  rangeTargetToGcm2,
  resolveProgramId,
  stpTargetToMassUnits,
} from "./compute.ts";

export type PlausibilitySlot = "particle" | "material" | "energy" | "target";

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
const ENERGY_UNIT_MAGNITUDE_FAMILY = ["keV", "MeV", "GeV", "TeV"] as const;

/**
 * When `energy` falls outside [min, max] MeV/nucl, check whether reading its raw number in a
 * different magnitude unit (keV/MeV/GeV/TeV) would land inside the grid instead — issue #29's
 * "unit-suspect first" ask: a misheard magnitude prefix is far likelier than a genuinely
 * out-of-range number. Restricted to the absolute units; "MeV/nucl"/"MeV/u" are already an
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

/** Relative tolerance for `checkTargetRoundTrip()`'s solve-then-verify comparison — loose enough
 * to absorb ordinary grid/interpolation slack, tight enough that a magnitude-order regression
 * (B1/B2 were ~200x and ~18x) still trips it by a wide margin. */
const TARGET_ROUND_TRIP_TOLERANCE = 0.02;

function withinTolerance(achieved: number, target: number): boolean {
  // A non-finite or zero target can't be evaluated meaningfully — don't flag what this check
  // can't actually judge (`Number.isFinite`/`=== 0` guards, not evidence of a real problem).
  if (!Number.isFinite(achieved) || !Number.isFinite(target) || target === 0) return true;
  return Math.abs(achieved - target) / Math.abs(target) <= TARGET_ROUND_TRIP_TOLERANCE;
}

/**
 * issue #163 B10 — round-trips an inverse query's target: solve for the energy libdedx thinks
 * reaches it, forward-compute at that energy, and confirm the result actually reproduces the
 * target. Closed unit types (B1/B2) and the quantity-aware target-unit chip guard (C6) already
 * prevent the *unit* confusion that originally motivated this, but nothing before this checked
 * the *solve* itself — a future regression in `rangeTargetToGcm2()`/`stpTargetToMassUnits()`, a
 * bad density lookup, or a WASM precision issue would all still report `plausible: true` without
 * it. Both the conversion and both WASM calls can throw or return a `LibdedxError` for reasons
 * unrelated to plausibility (missing density, energy out of range) — those already surface louder
 * elsewhere (`computeIntent()`'s own `series.error`), so this quietly skips (returns null) rather
 * than raising a second, weaker copy of the same failure. Compared in libdedx's own native units
 * (g/cm², MeV·cm²/g) rather than the target's stated unit — the round trip itself is the point,
 * not a re-display of the answer.
 */
function checkTargetRoundTrip(
  intent: QueryIntent,
  particle: ParticleMatch,
  material: MaterialMatch,
  programId: number,
  service: LibdedxService,
): PlausibilityIssue | null {
  const target = intent.target;
  if (!target) return null;
  const density = service.getDensity(material.id);
  try {
    if (intent.quantity === "energyFromRange") {
      const targetGcm2 = rangeTargetToGcm2(target, density);
      const [solved] = service.getInverseCsda({
        programId,
        particleId: particle.id,
        materialId: material.id,
        ranges: [targetGcm2],
      });
      if (!solved || solved instanceof LibdedxError) return null;
      const forward = service.calculate(programId, particle.id, material.id, [solved.energy], {
        computeCsda: true,
      });
      const achievedGcm2 = forward.csdaRanges[0];
      if (achievedGcm2 === undefined || withinTolerance(achievedGcm2, targetGcm2)) return null;
      return {
        slot: "target",
        message: `Solving for the energy that gives a range of ${formatSignificant(targetGcm2)} g/cm² for ${particle.name} in ${material.name} actually reaches ${formatSignificant(achievedGcm2)} g/cm² — the result may not be reliable`,
      };
    }
    if (intent.quantity === "energyFromStp") {
      const targetMassStp = stpTargetToMassUnits(target, density);
      const [solved] = service.getInverseStp({
        programId,
        particleId: particle.id,
        materialId: material.id,
        stoppingPowers: [targetMassStp],
        side: 1,
      });
      if (!solved || solved instanceof LibdedxError) return null;
      const forward = service.calculate(programId, particle.id, material.id, [solved.energy], {
        computeCsda: false,
      });
      const achievedMassStp = forward.stoppingPowers[0];
      if (achievedMassStp === undefined || withinTolerance(achievedMassStp, targetMassStp)) {
        return null;
      }
      return {
        slot: "target",
        message: `Solving for the energy that gives a stopping power of ${formatSignificant(targetMassStp)} MeV·cm²/g for ${particle.name} in ${material.name} actually reaches ${formatSignificant(achievedMassStp)} MeV·cm²/g — the result may not be reliable`,
      };
    }
  } catch {
    // Conversion/WASM failure — not this check's job to flag a second time (see doc comment).
    return null;
  }
  return null;
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
 * input was intentional. Four checks:
 *
 *  1. isotope existence — every particle mention, via the bound above.
 *  2. particle/material/program combination — see `activePairsFor()`.
 *  3. energy within the tabulated grid — forward queries only, and only once (2) checked out for
 *     that pair (an unsupported program's [min, max] is meaningless, not evidence about the
 *     energy itself).
 *  4. issue #163 B10 — for an inverse query instead of (3), a target round-trip: see
 *     `checkTargetRoundTrip()`. Forward queries have nothing to round-trip (the energy *is* the
 *     given value); inverse queries have nothing (3) can check (there's no `energies` list to
 *     bound-check — the energy is what's being solved for), which is exactly the gap that let
 *     both B1 and B2 report `plausible: true` before the closed unit types (B1/B2) and the
 *     quantity-aware target-unit chip guard (C6) closed the *unit* half of it.
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

  const isInverse = isInverseQuantity(intent.quantity);

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

    if (isInverse) {
      const issue = checkTargetRoundTrip(intent, particle, material, programId, service);
      if (issue) issues.push(issue);
      continue;
    }
    if (intent.energies.length === 0) continue;
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
