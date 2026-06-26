/**
 * Compute step: turn a resolved `QueryIntent` into real libdedx numbers.
 *
 * This is the layer that bridges aidedx's NLU/alias world (issue #3 schema +
 * issue #4 alias tables) to the vendored libdedx WASM wrapper (`src/lib/wasm/`).
 * It is deliberately kept separate from the wrapper so the wrapper stays
 * extractable as `@aptg/libdedx-wasm` (issue #1 §17) with no dependency on
 * `QueryIntent`.
 *
 * Responsibilities:
 *  - resolve each particle/material phrase to a libdedx id (alias tables);
 *  - convert energies to MeV/nucl, honoring the total-vs-per-nucleon assumption
 *    recorded on the intent (issue #1 §7);
 *  - auto-select a stopping-power program per particle (or honor an explicit one);
 *  - fan out over the comparison dimension (material / particle / program / energy);
 *  - call the wrapper for forward (stopping power, CSDA range) and inverse
 *    (energy-from-range, energy-from-stp) quantities.
 *
 * Every number returned originates in libdedx — never the LLM (issue #1 §4).
 */
import type { CompareDim, Quantity, QueryIntent } from "../intent/query-intent.ts";
import { resolveMaterial, resolveParticle } from "../aliases/lookup.ts";
import { PROGRAMS, ELECTRON_ID } from "../wasm/libdedx.ts";
import { LibdedxError, type LibdedxService } from "../wasm/types.ts";

/** Raised when an intent cannot be mapped to a libdedx computation. */
export class ComputeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputeError";
  }
}

export interface ResolvedParticle {
  id: number;
  name: string;
  /** Mass number A of the (assumed) isotope, from the alias resolver. */
  massNumber: number;
  /** Isotope label, e.g. "¹²C"; empty for protons / the electron. */
  isotope: string;
}

export interface ResolvedMaterial {
  id: number;
  name: string;
}

/** One evaluated point along the energy axis. */
export interface ComputePoint {
  /** Energy in MeV/nucl actually handed to libdedx. */
  energyMeVPerNucl: number;
  /** Forward: mass stopping power in MeV·cm²/g. */
  stoppingPower?: number;
  /** Forward: CSDA range in g/cm². */
  csdaRange?: number;
  /** Inverse: resolved energy in MeV/nucl. */
  energy?: number;
}

/** One (particle, material, program) curve. Comparison queries return several. */
export interface ComputeSeries {
  /** Short label distinguishing this series in a comparison (e.g. "Water"). */
  label: string;
  particle: ResolvedParticle;
  material: ResolvedMaterial;
  program: { id: number; name: string };
  points: ComputePoint[];
  /** Set when this series failed (e.g. energy out of range); points may be empty. */
  error?: string;
}

export interface ComputeResult {
  quantity: Quantity;
  compareDim: CompareDim;
  series: ComputeSeries[];
  /** Assumptions carried from the intent (isotope defaults, energy reading…). */
  assumptions: string[];
  /** libdedx version string, for provenance display. */
  libdedxVersion: string;
}

const PROGRAM_NAME_TO_ID: Record<string, number> = {
  ASTAR: PROGRAMS.ASTAR,
  PSTAR: PROGRAMS.PSTAR,
  ESTAR: PROGRAMS.ESTAR,
  MSTAR: PROGRAMS.MSTAR,
  ICRU73: PROGRAMS.ICRU73,
  ICRU49: PROGRAMS.ICRU49,
  ICRU: PROGRAMS.ICRU49,
  DEFAULT: PROGRAMS.DEFAULT,
  BETHE: PROGRAMS.DEFAULT,
  "BETHE-EXT": PROGRAMS.BETHE_EXT00,
  LIBDEDX: PROGRAMS.DEFAULT,
};

const PROGRAM_ID_TO_NAME: Record<number, string> = {
  [PROGRAMS.ASTAR]: "ASTAR",
  [PROGRAMS.PSTAR]: "PSTAR",
  [PROGRAMS.ESTAR]: "ESTAR",
  [PROGRAMS.MSTAR]: "MSTAR",
  [PROGRAMS.ICRU73]: "ICRU73",
  [PROGRAMS.ICRU49]: "ICRU49",
  [PROGRAMS.DEFAULT]: "Bethe",
  [PROGRAMS.BETHE_EXT00]: "Bethe-ext",
};

function programName(id: number): string {
  return PROGRAM_ID_TO_NAME[id] ?? `program ${id}`;
}

/**
 * Auto-select a stopping-power program for a particle, mirroring dedx_web's
 * "Auto" behavior closely enough for the deterministic path:
 *   proton → PSTAR, alpha → ASTAR, heavier ions → MSTAR.
 * The general Bethe (`DEFAULT`) program is avoided as an auto pick because its
 * adaptive CSDA integrator can recurse unboundedly at very low energies.
 */
export function autoProgramForParticle(particleId: number): number {
  if (particleId === 1) return PROGRAMS.PSTAR;
  if (particleId === 2) return PROGRAMS.ASTAR;
  return PROGRAMS.MSTAR;
}

/** Candidate programs to fan out over for a `compareDim: "program"` query. */
function compareProgramsForParticle(particleId: number): number[] {
  if (particleId === 1) return [PROGRAMS.PSTAR, PROGRAMS.ICRU49, PROGRAMS.DEFAULT];
  if (particleId === 2) return [PROGRAMS.ASTAR, PROGRAMS.ICRU49, PROGRAMS.DEFAULT];
  return [PROGRAMS.MSTAR, PROGRAMS.ICRU73, PROGRAMS.DEFAULT];
}

function resolveProgramId(intent: QueryIntent, particleId: number): number {
  if (intent.program) {
    const id = PROGRAM_NAME_TO_ID[intent.program.toUpperCase()];
    if (id !== undefined) return id;
  }
  return autoProgramForParticle(particleId);
}

/** First element of a known-non-empty array, without a non-null assertion. */
function reqFirst<T>(arr: T[], what: string): T {
  const v = arr[0];
  if (v === undefined) throw new ComputeError(`Intent has no ${what}`);
  return v;
}

function resolveParticleOrThrow(match: string): ResolvedParticle {
  const p = resolveParticle(match);
  if (!p) throw new ComputeError(`Could not resolve particle "${match}"`);
  if (p.id === ELECTRON_ID) {
    throw new ComputeError("Electron stopping powers are not available in libdedx v1.4.0");
  }
  return { id: p.id, name: p.name, massNumber: p.massNumber, isotope: p.isotope };
}

function resolveMaterialOrThrow(match: string): ResolvedMaterial {
  const mat = resolveMaterial(match);
  if (!mat) throw new ComputeError(`Could not resolve material "${match}"`);
  return { id: mat.id, name: mat.name };
}

/**
 * Convert one intent energy to MeV/nucl for the given particle.
 *
 * - explicit per-nucleon units (MeV/nucl) pass through;
 * - MeV/u is rescaled by atomicMass / massNumber;
 * - absolute units (MeV / keV / GeV) are treated as total energy and divided by
 *   the mass number unless the intent marked them per-nucleon. For protons
 *   (A = 1) total and per-nucleon coincide.
 */
export function energyToMeVPerNucl(
  energy: { value: number; unit: string; perNucleonAssumed?: boolean },
  massNumber: number,
  atomicMass: number,
): number {
  const a = massNumber > 0 ? massNumber : 1;
  switch (energy.unit) {
    case "MeV/nucl":
      return energy.value;
    case "MeV/u":
      return (energy.value * (atomicMass > 0 ? atomicMass : a)) / a;
    default: {
      let mev = energy.value;
      if (energy.unit === "keV") mev = energy.value / 1000;
      else if (energy.unit === "GeV") mev = energy.value * 1000;
      // "MeV" and anything else fall through as already-MeV.
      return energy.perNucleonAssumed === true ? mev : mev / a;
    }
  }
}

/** Convert an inverse-query range target to g/cm² (the native libdedx unit). */
function rangeTargetToGcm2(
  target: { value: number; unit: string },
  density: number | undefined,
): number {
  const unit = target.unit.toLowerCase().replace(/\s+/g, "");
  if (unit === "g/cm2" || unit === "g/cm²" || unit === "gcm-2") return target.value;
  // length units need a density to become areal.
  let cm: number;
  if (unit === "mm") cm = target.value / 10;
  else if (unit === "m") cm = target.value * 100;
  else cm = target.value; // "cm" (default)
  if (!density || density <= 0) {
    throw new ComputeError(`Need material density to convert range "${target.unit}" to g/cm²`);
  }
  return cm * density;
}

/** Convert an inverse-query stopping-power target to MeV·cm²/g (native unit). */
function stpTargetToMassUnits(
  target: { value: number; unit: string },
  density: number | undefined,
): number {
  const unit = target.unit.toLowerCase().replace(/\s+/g, "");
  if (unit === "mev·cm²/g" || unit === "mevcm2/g" || unit === "mevcm²/g") return target.value;
  if (unit === "mev/cm") {
    if (!density || density <= 0) {
      throw new ComputeError("Need material density to convert MeV/cm to MeV·cm²/g");
    }
    return target.value / density;
  }
  return target.value; // assume mass stopping power if unitless/unknown
}

function energiesMeVPerNucl(
  intent: QueryIntent,
  particle: ResolvedParticle,
  service: LibdedxService,
): number[] {
  const atomicMass =
    particle.massNumber > 1 ? service.getAtomicMass(particle.id) : particle.massNumber;
  return intent.energies.map((e) => energyToMeVPerNucl(e, particle.massNumber, atomicMass));
}

/** Build a forward series (stopping power + CSDA range) for one combination. */
function forwardSeries(
  service: LibdedxService,
  quantity: Quantity,
  particle: ResolvedParticle,
  material: ResolvedMaterial,
  programId: number,
  energies: number[],
  label: string,
): ComputeSeries {
  const base: ComputeSeries = {
    label,
    particle,
    material,
    program: { id: programId, name: programName(programId) },
    points: [],
  };
  try {
    const result = service.calculate(programId, particle.id, material.id, energies);
    // stoppingPowers / csdaRanges are aligned 1:1 with energies by the wrapper.
    base.points = result.energies.map((e, i) => ({
      energyMeVPerNucl: e,
      stoppingPower: result.stoppingPowers[i] ?? Number.NaN,
      csdaRange: result.csdaRanges[i] ?? Number.NaN,
    }));
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
  }
  void quantity;
  return base;
}

/** Build an inverse series (energy from range or from stopping power). */
function inverseSeries(
  service: LibdedxService,
  quantity: Quantity,
  intent: QueryIntent,
  particle: ResolvedParticle,
  material: ResolvedMaterial,
  programId: number,
  label: string,
): ComputeSeries {
  const base: ComputeSeries = {
    label,
    particle,
    material,
    program: { id: programId, name: programName(programId) },
    points: [],
  };
  if (!intent.target) {
    base.error = `Inverse quantity "${quantity}" requires a target value`;
    return base;
  }
  const density = service.getDensity(material.id);
  try {
    if (quantity === "energyFromRange") {
      const range = rangeTargetToGcm2(intent.target, density);
      const [r] = service.getInverseCsda({
        programId,
        particleId: particle.id,
        materialId: material.id,
        ranges: [range],
      });
      if (!r || r instanceof LibdedxError) {
        base.error = r instanceof LibdedxError ? r.message : "Inverse CSDA lookup failed";
      } else {
        base.points = [{ energyMeVPerNucl: r.energy, energy: r.energy, csdaRange: range }];
      }
    } else {
      const stp = stpTargetToMassUnits(intent.target, density);
      // High-energy branch (side = 1) is the conventional default for a given
      // stopping power above the Bragg peak's low-energy twin.
      const [r] = service.getInverseStp({
        programId,
        particleId: particle.id,
        materialId: material.id,
        stoppingPowers: [stp],
        side: 1,
      });
      if (!r || r instanceof LibdedxError) {
        base.error = r instanceof LibdedxError ? r.message : "Inverse STP lookup failed";
      } else {
        base.points = [{ energyMeVPerNucl: r.energy, energy: r.energy, stoppingPower: stp }];
      }
    }
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
  }
  return base;
}

/**
 * Compute libdedx numbers for a `QueryIntent`. The intent's `compareDim`
 * controls how many series are returned (one per varied material / particle /
 * program; energy comparisons stay a single series with multiple points).
 *
 * Per-series failures (out-of-range energy, missing density) are reported on
 * `series.error` rather than thrown, so a comparison with one bad leg still
 * returns the good ones. Structural problems (unresolved entities) throw
 * `ComputeError`.
 */
export function computeIntent(intent: QueryIntent, service: LibdedxService): ComputeResult {
  const isInverse = intent.quantity === "energyFromRange" || intent.quantity === "energyFromStp";

  if (intent.particles.length === 0) throw new ComputeError("Intent has no particle");
  if (intent.materials.length === 0) throw new ComputeError("Intent has no material");
  if (!isInverse && intent.energies.length === 0) throw new ComputeError("Intent has no energy");

  const series: ComputeSeries[] = [];

  const buildForward = (
    particle: ResolvedParticle,
    material: ResolvedMaterial,
    programId: number,
    label: string,
  ) =>
    forwardSeries(
      service,
      intent.quantity,
      particle,
      material,
      programId,
      energiesMeVPerNucl(intent, particle, service),
      label,
    );
  const buildInverse = (
    particle: ResolvedParticle,
    material: ResolvedMaterial,
    programId: number,
    label: string,
  ) => inverseSeries(service, intent.quantity, intent, particle, material, programId, label);
  const build = isInverse ? buildInverse : buildForward;

  if (intent.compareDim === "material") {
    const particle = resolveParticleOrThrow(reqFirst(intent.particles, "particle").match);
    const programId = resolveProgramId(intent, particle.id);
    for (const m of intent.materials) {
      const material = resolveMaterialOrThrow(m.match);
      series.push(build(particle, material, programId, material.name));
    }
  } else if (intent.compareDim === "particle") {
    const material = resolveMaterialOrThrow(reqFirst(intent.materials, "material").match);
    for (const p of intent.particles) {
      const particle = resolveParticleOrThrow(p.match);
      const programId = resolveProgramId(intent, particle.id);
      series.push(build(particle, material, programId, particle.isotope || particle.name));
    }
  } else if (intent.compareDim === "program") {
    const particle = resolveParticleOrThrow(reqFirst(intent.particles, "particle").match);
    const material = resolveMaterialOrThrow(reqFirst(intent.materials, "material").match);
    for (const programId of compareProgramsForParticle(particle.id)) {
      series.push(build(particle, material, programId, programName(programId)));
    }
  } else {
    // "none" and "energy": a single series; energy comparisons carry multiple
    // points via the energies list.
    const particle = resolveParticleOrThrow(reqFirst(intent.particles, "particle").match);
    const material = resolveMaterialOrThrow(reqFirst(intent.materials, "material").match);
    const programId = resolveProgramId(intent, particle.id);
    series.push(build(particle, material, programId, material.name));
  }

  return {
    quantity: intent.quantity,
    compareDim: intent.compareDim,
    series,
    assumptions: intent.assumptions,
    libdedxVersion: service.getVersion(),
  };
}
