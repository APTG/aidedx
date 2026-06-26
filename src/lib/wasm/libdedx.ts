/**
 * Thin TypeScript wrapper over the vendored libdedx WASM module.
 *
 * Ported from dedx_web's `src/lib/wasm/libdedx.ts`, trimmed to the surface
 * aidedx needs (forward stopping power / CSDA range, inverse lookups, entity
 * lists) and stripped of dedx_web's UI-only dependencies (friendly-name tables,
 * spline CSDA integration, MeV/u helpers — the last is inlined here). The ABI
 * matches the binaries in `static/wasm/`; keep this file in lock-step with the
 * exported-functions list in the build script (see `docs/wasm.md`).
 *
 * Numbers come from libdedx only — never the LLM (issue #1 §4).
 */
import {
  LibdedxError,
  type CalculationResult,
  type EmscriptenModule,
  type InverseCsdaResult,
  type InverseStpResult,
  type LibdedxService,
  type MaterialEntity,
  type ParticleEntity,
  type ProgramEntity,
} from "./types.ts";

/** Stopping-power program ids — maps to the C enum in libdedx `dedx.h`. */
export const PROGRAMS = {
  ASTAR: 1,
  PSTAR: 2,
  ESTAR: 3,
  MSTAR: 4,
  ICRU73_OLD: 5,
  ICRU73: 6,
  ICRU49: 7,
  ICRU: 9,
  DEFAULT: 100,
  BETHE_EXT00: 101,
} as const;

/** Programs that must not surface as user-selectable (internal auto-selector). */
const EXCLUDED_PROGRAMS = new Set<number>([PROGRAMS.ICRU]);

/** Electron particle id; ESTAR-only and not implemented in libdedx v1.4.0. */
export const ELECTRON_ID = 1001;

/** Read a sentinel-terminated int32 array from the WASM heap (stops at ≤ 0). */
function readIdList(heap: Int32Array, ptr: number, maxLen = 600): number[] {
  if (ptr === 0) return [];
  const result: number[] = [];
  const idx0 = ptr >>> 2;
  for (let i = 0; i < maxLen; i++) {
    const v = heap[idx0 + i];
    if (v === undefined || v <= 0) break;
    result.push(v);
  }
  return result;
}

/** "WATER" / "POLYETHYLENE_TEREPHTHALATE" → "Water" / "Polyethylene Terephthalate". */
function toTitleCase(raw: string): string {
  return raw
    .toLowerCase()
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export class LibdedxServiceImpl implements LibdedxService {
  private module: EmscriptenModule;
  private programs: ProgramEntity[] = [];
  private particles = new Map<number, ParticleEntity[]>();
  private materials = new Map<number, MaterialEntity[]>();

  constructor(module: EmscriptenModule) {
    this.module = module;
  }

  async init(): Promise<void> {
    const m = this.module;
    const heap = m.HEAP32;

    for (const id of readIdList(heap, m._dedx_get_program_list())) {
      if (EXCLUDED_PROGRAMS.has(id)) continue;
      this.programs.push({
        id,
        name: m.UTF8ToString(m._dedx_get_program_name(id)),
        version: m.UTF8ToString(m._dedx_get_program_version(id)),
      });
    }

    const errPtr = m._malloc(4);
    try {
      for (const prog of this.programs) {
        const particles: ParticleEntity[] = [];
        for (const id of readIdList(heap, m._dedx_get_ion_list(prog.id))) {
          const raw = m.UTF8ToString(m._dedx_get_ion_name(id));
          particles.push({
            id,
            name: id === ELECTRON_ID ? "Electron" : toTitleCase(raw),
            massNumber: m._dedx_get_ion_nucleon_number(id),
            atomicMass: m._dedx_get_ion_atom_mass(id),
          });
        }
        this.particles.set(prog.id, particles);

        const materials: MaterialEntity[] = [];
        for (const id of readIdList(heap, m._dedx_get_material_list(prog.id))) {
          // Reset the shared error slot per call; store NaN rather than a
          // bogus value if libdedx signals a density error for this material.
          m.HEAP32[errPtr >>> 2] = 0;
          const density = m._dedx_get_density(id, errPtr);
          const densityOk = (m.HEAP32[errPtr >>> 2] ?? 0) === 0;
          materials.push({
            id,
            name: toTitleCase(m.UTF8ToString(m._dedx_get_material_name(id))),
            density: densityOk ? density : Number.NaN,
            isGasByDefault: m._dedx_target_is_gas(id) !== 0,
          });
        }
        this.materials.set(prog.id, materials);
      }
    } finally {
      m._free(errPtr);
    }
  }

  getPrograms(): ProgramEntity[] {
    return this.programs;
  }

  getParticles(programId: number): ParticleEntity[] {
    return this.particles.get(programId) ?? [];
  }

  getMaterials(programId: number): MaterialEntity[] {
    return this.materials.get(programId) ?? [];
  }

  getMinEnergy(programId: number, particleId: number): number {
    return this.module._dedx_get_min_energy(programId, particleId);
  }

  getMaxEnergy(programId: number, particleId: number): number {
    return this.module._dedx_get_max_energy(programId, particleId);
  }

  getNucleonNumber(particleId: number): number {
    return this.module._dedx_get_ion_nucleon_number(particleId);
  }

  getAtomicMass(particleId: number): number {
    return this.module._dedx_get_ion_atom_mass(particleId);
  }

  getDensity(materialId: number): number | undefined {
    const m = this.module;
    const errPtr = m._malloc(4);
    try {
      m.HEAP32[errPtr >>> 2] = 0;
      const density = m._dedx_get_density(materialId, errPtr);
      if ((m.HEAP32[errPtr >>> 2] ?? 0) !== 0) return undefined;
      return density;
    } finally {
      m._free(errPtr);
    }
  }

  getVersion(): string {
    return this.module.UTF8ToString(this.module._dedx_get_version_string());
  }

  calculate(
    programId: number,
    particleId: number,
    materialId: number,
    energies: number[],
    options?: { computeCsda?: boolean },
  ): CalculationResult {
    const m = this.module;
    const n = energies.length;
    // CSDA range comes from an adaptive integrator that is much costlier than
    // the STP table lookup (and can recurse at very low energies); skip it when
    // the caller only needs stopping power.
    const wantCsda = options?.computeCsda !== false;
    // energies + stopping powers are float32; CSDA ranges are float64.
    const energiesPtr = m._malloc(n * 4);
    const stpPtr = m._malloc(n * 4);
    const csdaPtr = wantCsda ? m._malloc(n * 8) : 0;
    try {
      for (let i = 0; i < n; i++) {
        m.HEAPF32[energiesPtr / 4 + i] = energies[i] ?? 0;
        m.HEAPF32[stpPtr / 4 + i] = 0;
        if (wantCsda) m.HEAPF64[csdaPtr / 8 + i] = 0;
      }

      const stpErr = m._dedx_get_stp_table(
        programId,
        particleId,
        materialId,
        n,
        energiesPtr,
        stpPtr,
      );
      if (stpErr !== 0) throw new LibdedxError(stpErr, "WASM STP calculation failed");

      const stoppingPowers: number[] = [];
      for (let i = 0; i < n; i++) {
        stoppingPowers.push(m.HEAPF32[stpPtr / 4 + i] ?? 0);
      }

      if (!wantCsda) {
        return { energies: [...energies], stoppingPowers, csdaRanges: [] };
      }

      const csdaErr = m._dedx_get_csda_range_table(
        programId,
        particleId,
        materialId,
        n,
        energiesPtr,
        csdaPtr,
      );
      if (csdaErr !== 0) throw new LibdedxError(csdaErr, "WASM CSDA calculation failed");

      const csdaRanges: number[] = [];
      for (let i = 0; i < n; i++) {
        csdaRanges.push(m.HEAPF64[csdaPtr / 8 + i] ?? 0);
      }
      return { energies: [...energies], stoppingPowers, csdaRanges };
    } finally {
      m._free(energiesPtr);
      m._free(stpPtr);
      if (csdaPtr !== 0) m._free(csdaPtr);
    }
  }

  calculateMulti({
    programIds,
    particleId,
    materialId,
    energies,
  }: {
    programIds: number[];
    particleId: number;
    materialId: number;
    energies: number[];
  }): Map<number, CalculationResult | LibdedxError> {
    const results = new Map<number, CalculationResult | LibdedxError>();
    for (const programId of programIds) {
      try {
        results.set(programId, this.calculate(programId, particleId, materialId, energies));
      } catch (e) {
        results.set(programId, e instanceof LibdedxError ? e : new LibdedxError(-1, String(e)));
      }
    }
    return results;
  }

  getInverseCsda({
    programId,
    particleId,
    materialId,
    ranges,
  }: {
    programId: number;
    particleId: number;
    materialId: number;
    ranges: number[];
  }): (InverseCsdaResult | LibdedxError)[] {
    const m = this.module;
    const results: (InverseCsdaResult | LibdedxError)[] = [];
    const errPtr = m._malloc(4);
    try {
      for (const range of ranges) {
        m.HEAP32[errPtr >>> 2] = 0;
        const energy = m._dedx_get_inverse_csda_flat(
          programId,
          particleId,
          materialId,
          range,
          errPtr,
        );
        const errCode = m.HEAP32[errPtr >>> 2] ?? 0;
        if (errCode !== 0) {
          results.push(new LibdedxError(errCode, `Inverse CSDA lookup failed for range=${range}`));
        } else if (energy < 0) {
          results.push(new LibdedxError(-1, `Inverse CSDA returned invalid energy ${energy}`));
        } else {
          results.push({ energy, csdaRange: range });
        }
      }
    } finally {
      m._free(errPtr);
    }
    return results;
  }

  getInverseStp({
    programId,
    particleId,
    materialId,
    stoppingPowers,
    side,
  }: {
    programId: number;
    particleId: number;
    materialId: number;
    stoppingPowers: number[];
    side: 0 | 1;
  }): (InverseStpResult | LibdedxError)[] {
    const m = this.module;
    const results: (InverseStpResult | LibdedxError)[] = [];
    const errPtr = m._malloc(4);
    try {
      for (const stp of stoppingPowers) {
        m.HEAP32[errPtr >>> 2] = 0;
        const energy = m._dedx_get_inverse_stp_flat(
          programId,
          particleId,
          materialId,
          stp,
          side,
          errPtr,
        );
        const errCode = m.HEAP32[errPtr >>> 2] ?? 0;
        if (errCode !== 0) {
          results.push(new LibdedxError(errCode, `Inverse STP lookup failed for stp=${stp}`));
        } else if (energy < 0) {
          // A negative sentinel means no solution on this branch.
          results.push(
            new LibdedxError(-1, `Inverse STP returned invalid energy ${energy} for stp=${stp}`),
          );
        } else {
          results.push({ energy, stoppingPower: stp });
        }
      }
    } finally {
      m._free(errPtr);
    }
    return results;
  }

  getBraggPeakStp({
    programId,
    particleId,
    materialId,
  }: {
    programId: number;
    particleId: number;
    materialId: number;
  }): number {
    const m = this.module;
    const errPtr = m._malloc(4);
    try {
      m.HEAP32[errPtr >>> 2] = 0;
      const stp = m._dedx_get_bragg_peak_stp(programId, particleId, materialId, errPtr);
      const errCode = m.HEAP32[errPtr >>> 2] ?? 0;
      if (errCode !== 0) throw new LibdedxError(errCode, "Bragg peak STP lookup failed");
      return stp;
    } finally {
      m._free(errPtr);
    }
  }
}
