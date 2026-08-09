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
import {
  RANGE_TARGET_UNITS,
  STP_TARGET_UNITS,
  resolveProgramName,
  type CompareDim,
  type ProgramName,
  type Quantity,
  type QueryIntent,
  type RangeTargetUnit,
  type StpTargetUnit,
} from "../intent/query-intent.ts";
import { resolveMaterial, resolveParticle } from "../aliases/lookup.ts";
import { particleById } from "../aliases/particles.ts";
import { PROGRAMS, ELECTRON_ID } from "../wasm/libdedx.ts";
import { LibdedxError, type LibdedxService } from "../wasm/types.ts";
import { formatEnergyPerNucleon } from "../format.ts";

/** Raised when an intent cannot be mapped to a libdedx computation. */
export class ComputeError extends Error {
  /**
   * issue #163 B9 — a short, physicist-facing rephrasing of this error, for the sites where
   * `message` is a developer-facing diagnostic (an internal invariant name like `compareDim`)
   * rather than something meant to reach the answer box. `answer-status.svelte.ts` prefers this
   * over `message` when set; every other throw site leaves it unset and falls back to `message`
   * unchanged, exactly as before this existed.
   */
  readonly userMessage?: string;
  constructor(message: string, userMessage?: string) {
    super(message);
    this.name = "ComputeError";
    if (userMessage !== undefined) this.userMessage = userMessage;
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
  /**
   * Material density in g/cm³ from `service.getDensity()`, when available.
   * Lets the NLG layer convert libdedx's native mass-normalized units
   * (MeV·cm²/g, g/cm²) to physical ones (keV/µm, a length) for display —
   * see `render.ts`'s `valueText()`. Undefined when the lookup failed for
   * this material; callers fall back to the native unit in that case.
   */
  density?: number;
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

/**
 * issue #163 B5/B6 — `Record<ProgramName, ...>` (not a loose `Record<string, ...>` with synonym
 * keys baked in) makes this exhaustive against the shared `PROGRAM_NAMES` union from
 * query-intent.ts: a program name added there without an entry here is a compile error, closing
 * §4.1's "PROGRAM_RE's name list vs `PROGRAM_NAME_TO_ID`'s keys" drift. Synonym/case folding
 * ("bethe_ext", "ICRU") happens once, in the shared `resolveProgramName()`, before a name ever
 * reaches this table.
 */
const PROGRAM_NAME_TO_ID: Record<ProgramName, number> = {
  ASTAR: PROGRAMS.ASTAR,
  PSTAR: PROGRAMS.PSTAR,
  ESTAR: PROGRAMS.ESTAR,
  MSTAR: PROGRAMS.MSTAR,
  ICRU73: PROGRAMS.ICRU73,
  "ICRU73 (old)": PROGRAMS.ICRU73_OLD,
  ICRU49: PROGRAMS.ICRU49,
  Bethe: PROGRAMS.DEFAULT,
  "Bethe-ext": PROGRAMS.BETHE_EXT00,
};

const PROGRAM_ID_TO_NAME: Record<number, ProgramName> = {
  [PROGRAMS.ASTAR]: "ASTAR",
  [PROGRAMS.PSTAR]: "PSTAR",
  [PROGRAMS.ESTAR]: "ESTAR",
  [PROGRAMS.MSTAR]: "MSTAR",
  [PROGRAMS.ICRU73]: "ICRU73",
  [PROGRAMS.ICRU73_OLD]: "ICRU73 (old)",
  [PROGRAMS.ICRU49]: "ICRU49",
  [PROGRAMS.DEFAULT]: "Bethe",
  [PROGRAMS.BETHE_EXT00]: "Bethe-ext",
};

export function programName(id: number): string {
  return PROGRAM_ID_TO_NAME[id] ?? `program ${id}`;
}

/**
 * Sets `series.density` only when defined. `ComputeSeries.density` is
 * optional under `exactOptionalPropertyTypes`, which treats an explicit
 * `undefined` assignment as an error — a missing density (getDensity()
 * failed for that material) must be an absent key, not a key holding
 * `undefined`.
 */
function withDensity(series: ComputeSeries, density: number | undefined): ComputeSeries {
  if (density !== undefined) series.density = density;
  return series;
}

/**
 * True when `programId` has tabulated data for both `particleId` and
 * `materialId`, per libdedx's own ion/material-availability lists for that
 * program (`getParticles()` / `getMaterials()`). Two independent gaps hit
 * this: a program's material table may be missing one element (PSTAR has no
 * Boron data) while its ion table is missing a whole particle regardless of
 * material (MSTAR only tabulates Z=2..18 — helium through argon — so it has
 * no calcium/heavier-ion data at all, see docs/tts-eval-1000.md §2.2).
 */
export function programSupportsCombination(
  service: LibdedxService,
  programId: number,
  particleId: number,
  materialId: number,
): boolean {
  return (
    service.getParticles(programId).some((p) => p.id === particleId) &&
    service.getMaterials(programId).some((m) => m.id === materialId)
  );
}

const PROTON_ID = 1;
const HELIUM_ID = 2;
const CARBON_ID = 6;

/**
 * Auto-select chain per particle, deliberately mirroring dedx_web's own
 * Auto-select resolution byte-for-byte (`entity-availability.svelte.ts`'s
 * `AUTO_SELECT_CHAIN`/`DEFAULT_AUTO_SELECT_CHAIN`). This is what lets a
 * dedx_web calculator link stay in Basic mode — which always auto-selects,
 * never honoring an explicit `program=` (dedx_web#816) — and still land on
 * the exact program aidedx already computed with, instead of the two
 * projects' auto-select heuristics silently disagreeing (issue #116).
 */
const AUTO_SELECT_CHAIN: Record<number, number[]> = {
  [PROTON_ID]: [PROGRAMS.ICRU49, PROGRAMS.PSTAR],
  [HELIUM_ID]: [PROGRAMS.ICRU49, PROGRAMS.ASTAR],
  [CARBON_ID]: [PROGRAMS.ICRU73, PROGRAMS.ICRU73_OLD, PROGRAMS.MSTAR],
};
const DEFAULT_AUTO_SELECT_CHAIN = [PROGRAMS.ICRU73, PROGRAMS.ICRU73_OLD, PROGRAMS.MSTAR];

/**
 * Auto-select a stopping-power program for a particle, walking
 * `AUTO_SELECT_CHAIN` exactly the way dedx_web's own Auto-select does,
 * including its energy-aware fallthrough (dedx_web#871/#872): a heavy ion
 * below one chain candidate's energy floor (e.g. Boron below ICRU 73's
 * 0.025 MeV/nucleon floor) falls through to the next candidate that covers
 * it (typically MSTAR) instead of getting stuck "out of range" on a program
 * that can't actually serve the requested energy.
 *
 * `energyMevPerNucl` is optional — omit it (or pass a value outside every
 * candidate's range) to get the energy-blind "first chain member with any
 * tabulated data" behavior, matching dedx_web's own fallback when no energy
 * hint is available yet.
 *
 * Falls back to the general Bethe (`DEFAULT`) program only when *no* chain
 * candidate has any tabulated data at all for the particle+material pair —
 * e.g. proton + Boron, where a stale libdedx materials-availability table
 * used to falsely claim PSTAR covered Boron/Ni/Zr/In/Gd/Ta (fixed upstream
 * by libdedx#144 / dedx_web#845); or calcium and heavier ions, which neither
 * ICRU 73 nor MSTAR tabulate at all regardless of material or energy
 * (docs/tts-eval-1000.md §2.2). This is a deliberate deviation from
 * dedx_web's own "first available program in the whole matrix" fallback:
 * DEFAULT's adaptive CSDA integrator can recurse unboundedly at very low
 * energies, so it's only risked here for combinations nothing else can
 * compute anyway.
 */
export function autoProgramForParticle(
  particleId: number,
  materialId: number,
  service: LibdedxService,
  energyMevPerNucl?: number,
): number {
  const chain = AUTO_SELECT_CHAIN[particleId] ?? DEFAULT_AUTO_SELECT_CHAIN;
  const available = chain.filter((pid) =>
    programSupportsCombination(service, pid, particleId, materialId),
  );
  if (energyMevPerNucl !== undefined && Number.isFinite(energyMevPerNucl)) {
    const inRange = available.find((pid) => {
      const min = service.getMinEnergy(pid, particleId);
      const max = service.getMaxEnergy(pid, particleId);
      return energyMevPerNucl >= min && energyMevPerNucl <= max;
    });
    if (inRange !== undefined) return inRange;
  }
  return available[0] ?? PROGRAMS.DEFAULT;
}

/**
 * Candidate programs to fan out over for a `compareDim: "program"` query.
 *
 * issue #163 C7 — `intent.programs` (set by `matcher.ts` whenever it detected 2+ *supported*
 * program names — B5's `program` is the analogous 1-name case) is honored first when present: it
 * resolves every name through the shared `resolveProgramName()`, same as `resolveProgramId()`
 * does for the singular `program`. Before this, every `compareDim: "program"` query — regardless
 * of which programs were actually named — silently fanned out over this hardcoded, particle-keyed
 * triple instead: a query naming PSTAR got ICRU49/Bethe in its place and PSTAR dropped entirely.
 * The triple survives as the fallback for a producer that hasn't set `intent.programs` yet
 * (hand-built eval gold, a test that bypasses the matcher) or names nothing this resolves.
 */
function compareProgramsForParticle(particleId: number, intent: QueryIntent): number[] {
  if (intent.programs && intent.programs.length > 0) {
    const ids = intent.programs
      .map((name) => resolveProgramName(name))
      .filter((name): name is ProgramName => name !== null)
      .map((name) => PROGRAM_NAME_TO_ID[name]);
    if (ids.length > 0) return ids;
  }
  if (particleId === PROTON_ID) return [PROGRAMS.PSTAR, PROGRAMS.ICRU49, PROGRAMS.DEFAULT];
  if (particleId === HELIUM_ID) return [PROGRAMS.ASTAR, PROGRAMS.ICRU49, PROGRAMS.DEFAULT];
  return [PROGRAMS.MSTAR, PROGRAMS.ICRU73, PROGRAMS.DEFAULT];
}

/**
 * Energy hint (MeV/nucleon) fed to `autoProgramForParticle()`'s energy-aware
 * chain walk — the intent's first energy row, mirroring dedx_web's own
 * "resolve against row 0 only" simplification (dedx_web#871). `undefined`
 * for inverse queries (`intent.energies` is empty; the target is a
 * range/stopping-power value, not an energy) or when the intent genuinely
 * has no energy yet — `autoProgramForParticle()` falls back to its
 * energy-blind chain walk in that case.
 */
function firstEnergyHintMeVPerNucl(
  intent: QueryIntent,
  particle: { id: number; massNumber: number },
  service: LibdedxService,
): number | undefined {
  const first = intent.energies[0];
  if (!first) return undefined;
  const atomicMass = atomicMassForConversion(particle, service);
  return energyToMeVPerNucl(first, particle.massNumber, atomicMass);
}

/**
 * issue #163 B5 "latent follow-on" — `intent.program` is a free `string` (other producers besides
 * `matcher.ts` may supply loosely-formatted names), so this still has to resolve it rather than
 * assume it's already canonical. What changed is the *unresolved* case: it used to fall straight
 * through to auto-select, silently computing with a different program than the one named and
 * labelling the answer as if that had been auto-selected all along — the same silent-fallthrough
 * shape B1/B2 had for target units. `matcher.ts`'s own B5/B6 fix means this only ever receives an
 * unresolvable name from a producer that bypassed that validation, so throwing here is the loud
 * failure that shape of bug deserves, not a quieter one three files downstream.
 */
export function resolveProgramId(
  intent: QueryIntent,
  particle: { id: number; massNumber: number },
  materialId: number,
  service: LibdedxService,
): number {
  if (intent.program) {
    const resolved = resolveProgramName(intent.program);
    if (!resolved) {
      throw new ComputeError(`"${intent.program}" is not a program libdedx has data for`);
    }
    return PROGRAM_NAME_TO_ID[resolved];
  }
  const energyHint = firstEnergyHintMeVPerNucl(intent, particle, service);
  return autoProgramForParticle(particle.id, materialId, service, energyHint);
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
      else if (energy.unit === "TeV") mev = energy.value * 1_000_000;
      // "MeV" and anything else fall through as already-MeV.
      return energy.perNucleonAssumed === true ? mev : mev / a;
    }
  }
}

function isRangeTargetUnit(unit: string): unit is RangeTargetUnit {
  return (RANGE_TARGET_UNITS as readonly string[]).includes(unit);
}
function isStpTargetUnit(unit: string): unit is StpTargetUnit {
  return (STP_TARGET_UNITS as readonly string[]).includes(unit);
}

/**
 * issue #163 B1 — converts every non-areal `RangeTargetUnit` to centimetres. A plain `Record`
 * keyed by the closed unit type (same exhaustiveness idiom `nlg/dedx-web-link.ts`'s
 * `ENERGY_UNIT_TO_DEDXWEB` already uses): TypeScript requires every member of
 * `Exclude<RangeTargetUnit, "g/cm2">` to have an entry, so a unit added to `RANGE_TARGET_UNITS`
 * without a conversion here is a compile error. `"um"` is the one this table exists for — its
 * absence (silently falling through to `"cm"`, a ~200× error) was the original bug.
 */
const RANGE_TARGET_UNIT_TO_CM: Record<
  Exclude<RangeTargetUnit, "g/cm2">,
  (value: number) => number
> = {
  cm: (v) => v,
  mm: (v) => v / 10,
  m: (v) => v * 100,
  um: (v) => v / 10_000,
};

/** Convert an inverse-query range target to g/cm² (the native libdedx unit). Throws
 * `ComputeError` for a stopping-power unit passed by mistake (`intent.target.unit`'s static type
 * is the wider `RangeTargetUnit | StpTargetUnit`) or a missing density, rather than guessing.
 * Exported for `validate.ts`'s issue #163 B10 round-trip check, which needs the exact same
 * conversion `inverseSeries()` below uses — a second, independently-written copy would be exactly
 * the kind of cross-layer drift §4.1 warns about. */
export function rangeTargetToGcm2(
  target: { value: number; unit: RangeTargetUnit | StpTargetUnit },
  density: number | undefined,
): number {
  if (!isRangeTargetUnit(target.unit)) {
    throw new ComputeError(`"${target.unit}" is a stopping-power unit, not a range unit`);
  }
  if (target.unit === "g/cm2") return target.value;
  if (!density || density <= 0) {
    throw new ComputeError(`Need material density to convert range "${target.unit}" to g/cm²`);
  }
  return RANGE_TARGET_UNIT_TO_CM[target.unit](target.value) * density;
}

/**
 * issue #163 B2 — converts every non-mass `StpTargetUnit` to MeV·cm²/g, density-dependent, same
 * exhaustiveness idiom as `RANGE_TARGET_UNIT_TO_CM` above. `"keV/um"`'s factor is
 * `format.ts`'s `stoppingPowerToKevPerUm()` inverted (`kevPerUm = massStpMevCm2PerG * density *
 * 0.1`) — its absence (silently falling through to "treat as already MeV·cm²/g") was the original
 * ~18×-in-water bug, sharper here than B1 because the *forward* direction renders stopping power
 * in keV/µm (`render.ts`'s `valueText()`), so the app answers in a unit it couldn't read back.
 */
const STP_TARGET_UNIT_TO_MASS_UNITS: Record<
  Exclude<StpTargetUnit, "MeV cm2/g">,
  (value: number, densityGPerCm3: number) => number
> = {
  "MeV/cm": (v, density) => v / density,
  "keV/um": (v, density) => v / (density * 0.1),
};

/** Convert an inverse-query stopping-power target to MeV·cm²/g (native unit). Throws
 * `ComputeError` for a range unit passed by mistake or a missing density. Exported for the same
 * `validate.ts` B10 reason as `rangeTargetToGcm2()` above. */
export function stpTargetToMassUnits(
  target: { value: number; unit: RangeTargetUnit | StpTargetUnit },
  density: number | undefined,
): number {
  if (!isStpTargetUnit(target.unit)) {
    throw new ComputeError(`"${target.unit}" is a range unit, not a stopping-power unit`);
  }
  if (target.unit === "MeV cm2/g") return target.value;
  if (!density || density <= 0) {
    throw new ComputeError(`Need material density to convert "${target.unit}" to MeV·cm²/g`);
  }
  return STP_TARGET_UNIT_TO_MASS_UNITS[target.unit](target.value, density);
}

/**
 * Atomic mass (in u) for the `MeV/u` <-> `MeV/nucl` conversion ratio in
 * `energyToMeVPerNucl`. `service.getAtomicMass()` is keyed on the particle's
 * element (Z) only, so it always returns that element's *default*-isotope
 * atomic mass — valid when `massNumber` actually is that default (e.g.
 * alpha/He-4), but wrong for any other isotope the resolver can produce
 * (deuteron, triton, helium-3, an explicit "carbon-13", …), where the
 * numerator would describe a different nuclide than the denominator (issue
 * #103: "100 MeV/u deuteron" was computing ~half the intended energy). Those
 * cases fall back to the isotope's own mass number — off by only the small
 * (≤1%) mass-excess libdedx's table would otherwise correct for, instead of a
 * wrong-isotope factor. A proton (`massNumber <= 1`) short-circuits to that
 * same fallback without ever calling `getAtomicMass()` — the ratio is ≈1
 * regardless, and this avoids a WASM call on the hot path.
 */
export function atomicMassForConversion(
  particle: { id: number; massNumber: number },
  service: LibdedxService,
): number {
  if (particle.massNumber <= 1) return particle.massNumber > 0 ? particle.massNumber : 1;
  const isDefaultIsotope = particleById(particle.id)?.defaultMassNumber === particle.massNumber;
  return isDefaultIsotope ? service.getAtomicMass(particle.id) : particle.massNumber;
}

function energiesMeVPerNucl(
  intent: QueryIntent,
  particle: ResolvedParticle,
  service: LibdedxService,
): number[] {
  const atomicMass = atomicMassForConversion(particle, service);
  return intent.energies.map((e) => energyToMeVPerNucl(e, particle.massNumber, atomicMass));
}

/**
 * Check every energy lies within libdedx's supported [min, max] for this
 * (program, particle). Returns an error message, or null when all are valid.
 * Validating up front gives a clear per-series error and avoids invoking the
 * (potentially expensive/recursive) WASM paths on out-of-range input.
 *
 * `min`/`max` come back from libdedx as raw MeV/nucl floats (e.g.
 * `0.0002500000118743628`) — `formatEnergyPerNucleon` auto-scales each bound
 * to whichever of keV/MeV/GeV/nucl reads best, so the message is a readable
 * "valid range is X to Y" rather than a bracket of raw floats (issue #42 §4).
 */
function energyBoundsError(
  service: LibdedxService,
  programId: number,
  particle: ResolvedParticle,
  energies: number[],
): string | null {
  const min = service.getMinEnergy(programId, particle.id);
  const max = service.getMaxEnergy(programId, particle.id);
  for (const e of energies) {
    if (!Number.isFinite(e)) return `Energy ${e} is not a finite number`;
    if (e < min || e > max) {
      return `Energy ${formatEnergyPerNucleon(e, particle.massNumber)} is outside the valid range ${formatEnergyPerNucleon(min, particle.massNumber)} to ${formatEnergyPerNucleon(max, particle.massNumber)} for this program/particle`;
    }
  }
  return null;
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
  withDensity(base, service.getDensity(material.id));
  const boundsError = energyBoundsError(service, programId, particle, energies);
  if (boundsError) {
    base.error = boundsError;
    return base;
  }
  // Stopping-power queries don't need the CSDA integrator; skip it.
  const computeCsda = quantity !== "stoppingPower";
  try {
    const result = service.calculate(programId, particle.id, material.id, energies, {
      computeCsda,
    });
    // stoppingPowers / csdaRanges are aligned 1:1 with energies by the wrapper.
    base.points = result.energies.map((e, i) => {
      const point: ComputePoint = {
        energyMeVPerNucl: e,
        stoppingPower: result.stoppingPowers[i] ?? Number.NaN,
      };
      if (computeCsda) point.csdaRange = result.csdaRanges[i] ?? Number.NaN;
      return point;
    });
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
  }
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
  const density = service.getDensity(material.id);
  const base: ComputeSeries = {
    label,
    particle,
    material,
    program: { id: programId, name: programName(programId) },
    points: [],
  };
  withDensity(base, density);
  if (!intent.target) {
    base.error = `Inverse quantity "${quantity}" requires a target value`;
    return base;
  }
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

/** Plural form of a `CompareDim` for the B9 user-facing message below — "energy" -> "energies",
 * everything else already reads fine with a trailing "s". */
function pluralCompareDim(dim: CompareDim): string {
  return dim === "energy" ? "energies" : `${dim}s`;
}

/**
 * issue #163 B9 — the friendly counterpart to the raw "compareDim X but N present" assert below,
 * which names an internal concept (`compareDim`) a physicist reading the answer box was never
 * introduced to. `overflow` is whichever slot actually has more than one entry — the one
 * `compareDim` isn't already varying — so the message names *both* dimensions the query mixed,
 * not just the one that happened to trip the assert.
 */
function ambiguousCompareMessage(
  compareDim: CompareDim,
  overflow: "particle" | "material",
  count: number,
): string {
  const overflowPlural = overflow === "particle" ? "particles" : "materials";
  return (
    `This looks like a comparison across both ${pluralCompareDim(compareDim)} and ` +
    `${count} ${overflowPlural}, which I can't answer in one go. Try asking about a single ` +
    `${overflow}, or ask separately for each one.`
  );
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
    for (const m of intent.materials) {
      const material = resolveMaterialOrThrow(m.match);
      // Resolved per material: the same particle can need different programs
      // across materials (e.g. proton in water → ICRU49, proton in Boron → Bethe).
      const programId = resolveProgramId(intent, particle, material.id, service);
      series.push(build(particle, material, programId, material.name));
    }
  } else if (intent.compareDim === "particle") {
    const material = resolveMaterialOrThrow(reqFirst(intent.materials, "material").match);
    for (const p of intent.particles) {
      const particle = resolveParticleOrThrow(p.match);
      const programId = resolveProgramId(intent, particle, material.id, service);
      series.push(build(particle, material, programId, particle.isotope || particle.name));
    }
  } else if (intent.compareDim === "program") {
    const particle = resolveParticleOrThrow(reqFirst(intent.particles, "particle").match);
    const material = resolveMaterialOrThrow(reqFirst(intent.materials, "material").match);
    for (const programId of compareProgramsForParticle(particle.id, intent)) {
      series.push(build(particle, material, programId, programName(programId)));
    }
  } else {
    // "none" and "energy": a single series; energy comparisons carry multiple
    // points via the energies list. Both read only particles[0]/materials[0] — correct
    // *only* because the matcher guarantees compareDim is "particle"/"material" whenever
    // there's more than one distinct entity of that kind (issue #132's root cause was that
    // guarantee not holding for a duplicate-energy phrasing, since fixed at the source in
    // src/lib/intent/matcher.ts). Asserted here too, defensively: silently reading
    // particles[0]/materials[0] while more entities exist is exactly how #132 produced a
    // plausible-looking wrong answer instead of a loud failure, so a future matcher
    // regression should hit this error, not repeat that silently.
    if (intent.particles.length > 1) {
      throw new ComputeError(
        `compareDim "${intent.compareDim}" but ${intent.particles.length} particles present — only the first would be computed`,
        ambiguousCompareMessage(intent.compareDim, "particle", intent.particles.length),
      );
    }
    if (intent.materials.length > 1) {
      throw new ComputeError(
        `compareDim "${intent.compareDim}" but ${intent.materials.length} materials present — only the first would be computed`,
        ambiguousCompareMessage(intent.compareDim, "material", intent.materials.length),
      );
    }
    const particle = resolveParticleOrThrow(reqFirst(intent.particles, "particle").match);
    const material = resolveMaterialOrThrow(reqFirst(intent.materials, "material").match);
    const programId = resolveProgramId(intent, particle, material.id, service);
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
