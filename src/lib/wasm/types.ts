/**
 * Typed surface for the vendored libdedx WebAssembly module.
 *
 * These types mirror dedx_web's `src/lib/wasm/types.ts` and the WASM API
 * contract (`docs/06-wasm-api-contract.md` in dedx_web). They are intentionally
 * free of any aidedx-specific concept (no `QueryIntent`, no alias tables) so the
 * whole `src/lib/wasm/` boundary can be lifted into a shared
 * `@aptg/libdedx-wasm` package later (issue #1 §17) without dragging the
 * NLU/resolver layer along. The higher-level `QueryIntent → numbers` mapping
 * lives one layer up in `src/lib/compute/`.
 *
 * All physics numbers originate in libdedx — never the LLM (issue #1 §4).
 */

/** Energy units the wrapper understands. C calls always use MeV/nucl for ions. */
export type EnergyUnit = "MeV" | "MeV/nucl" | "MeV/u";

/** Native libdedx output units. The wrapper returns mass stopping power and
 * areal CSDA range; display-unit conversion is a caller concern. */
export type StpUnit = "MeV·cm²/g" | "MeV/cm" | "keV/µm";
export type RangeUnit = "g/cm²" | "cm";

/** A stopping-power program (PSTAR, ASTAR, MSTAR, …). */
export interface ProgramEntity {
  /** Numeric id used in C API calls (e.g. PSTAR = 2). */
  id: number;
  /** Human-readable name. */
  name: string;
  /** Version string from `dedx_get_program_version()`. */
  version: string;
}

/** A particle (ion or electron). libdedx calls these "ions"; id is the atomic
 * number Z (or 1001 for the electron). */
export interface ParticleEntity {
  id: number;
  name: string;
  /** Mass number A (nucleon count) from `dedx_get_ion_nucleon_number()`. */
  massNumber: number;
  /** Atomic mass in u from `dedx_get_ion_atom_mass()`. */
  atomicMass: number;
}

/** A target material. id is the libdedx/NIST material number. */
export interface MaterialEntity {
  id: number;
  name: string;
  /** Density in g/cm³ from `dedx_get_density()`. */
  density: number;
  /** True for the materials that are gaseous by default. */
  isGasByDefault: boolean;
}

/** Forward result: stopping power + CSDA range at the input energies. */
export interface CalculationResult {
  /** Input energies in MeV/nucl. */
  energies: number[];
  /** Mass stopping powers in MeV·cm²/g. */
  stoppingPowers: number[];
  /** CSDA ranges in g/cm². */
  csdaRanges: number[];
}

/** Inverse stopping-power lookup result (energy for a given stopping power). */
export interface InverseStpResult {
  energy: number;
  stoppingPower: number;
}

/** Inverse CSDA lookup result (energy for a given range). */
export interface InverseCsdaResult {
  energy: number;
  csdaRange: number;
}

/** Error carrying the numeric libdedx error code. Mirrors `DEDX_ERR_*`. */
export class LibdedxError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "LibdedxError";
    this.code = code;
  }
}

/**
 * The wrapper surface consumed by the compute layer. This is the subset of the
 * full dedx_web contract that aidedx needs: entity lists, forward stopping
 * power / CSDA range (single and multi-program), inverse lookups, and the
 * per-particle / per-material metadata used for energy- and range-unit
 * conversion. Custom-compound and advanced-option paths are intentionally out
 * of scope for this phase (see `docs/wasm.md`).
 */
export interface LibdedxService {
  init(): Promise<void>;

  getPrograms(): ProgramEntity[];
  getParticles(programId: number): ParticleEntity[];
  getMaterials(programId: number): MaterialEntity[];

  getMinEnergy(programId: number, particleId: number): number;
  getMaxEnergy(programId: number, particleId: number): number;

  getDensity(materialId: number): number | undefined;
  getAtomicMass(particleId: number): number;
  getNucleonNumber(particleId: number): number;

  getVersion(): string;

  /** Stopping power + CSDA range at the given energies (MeV/nucl). */
  calculate(
    programId: number,
    particleId: number,
    materialId: number,
    energies: number[],
  ): CalculationResult;

  /** Same as calculate(), across several programs; one failure does not abort
   * the rest. */
  calculateMulti(params: {
    programIds: number[];
    particleId: number;
    materialId: number;
    energies: number[];
  }): Map<number, CalculationResult | LibdedxError>;

  /** Energy (MeV/nucl) for each given CSDA range (g/cm²). */
  getInverseCsda(params: {
    programId: number;
    particleId: number;
    materialId: number;
    ranges: number[];
  }): (InverseCsdaResult | LibdedxError)[];

  /** Energy (MeV/nucl) for each given stopping power (MeV·cm²/g). side: 0 =
   * low-energy branch, 1 = high-energy branch. */
  getInverseStp(params: {
    programId: number;
    particleId: number;
    materialId: number;
    stoppingPowers: number[];
    side: 0 | 1;
  }): (InverseStpResult | LibdedxError)[];

  /** Bragg-peak (maximum) stopping power in MeV·cm²/g. */
  getBraggPeakStp(params: { programId: number; particleId: number; materialId: number }): number;
}

/**
 * The Emscripten module shape used by the wrapper. Only the exports the wrapper
 * actually calls are declared. The build (see `docs/wasm.md`) exports these via
 * `-sEXPORTED_FUNCTIONS` / `-sEXPORTED_RUNTIME_METHODS`.
 */
export interface EmscriptenModule {
  _dedx_get_program_list(): number;
  _dedx_get_ion_list(programId: number): number;
  _dedx_get_material_list(programId: number): number;
  _dedx_get_program_name(programId: number): number;
  _dedx_get_program_version(programId: number): number;
  _dedx_get_ion_name(ionId: number): number;
  _dedx_get_material_name(materialId: number): number;
  _dedx_get_version_string(): number;
  _dedx_get_ion_nucleon_number(ionId: number): number;
  _dedx_get_ion_atom_mass(ionId: number): number;
  _dedx_get_density(materialId: number, errPtr: number): number;
  _dedx_target_is_gas(materialId: number): number;
  _dedx_get_min_energy(programId: number, ionId: number): number;
  _dedx_get_max_energy(programId: number, ionId: number): number;
  _dedx_get_stp_table(
    programId: number,
    particleId: number,
    materialId: number,
    numEnergies: number,
    energies: number,
    stp: number,
  ): number;
  _dedx_get_csda_range_table(
    programId: number,
    particleId: number,
    materialId: number,
    numEnergies: number,
    energies: number,
    csda: number,
  ): number;
  _dedx_get_inverse_stp_flat(
    programId: number,
    particleId: number,
    materialId: number,
    stoppingPower: number,
    side: number,
    errPtr: number,
  ): number;
  _dedx_get_inverse_csda_flat(
    programId: number,
    particleId: number,
    materialId: number,
    range: number,
    errPtr: number,
  ): number;
  _dedx_get_bragg_peak_stp(
    programId: number,
    particleId: number,
    materialId: number,
    errPtr: number,
  ): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  UTF8ToString(ptr: number): string;
  HEAP32: Int32Array;
  HEAPF32: Float32Array;
  HEAPF64: Float64Array;
}

/** An Emscripten ES-module factory: `default(moduleArg) => Promise<Module>`. */
export type LibdedxModuleFactory = (moduleArg?: {
  locateFile?: (path: string) => string;
  print?: (msg: string) => void;
  printErr?: (msg: string) => void;
}) => Promise<EmscriptenModule>;
