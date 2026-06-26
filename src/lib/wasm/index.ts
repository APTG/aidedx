/**
 * Public entry point for the libdedx WASM wrapper.
 *
 * This barrel is the seam that issue #1 §17 plans to extract into a shared
 * `@aptg/libdedx-wasm` package: it exposes the typed service, the loader, and
 * the program constants, and nothing aidedx-specific. The `QueryIntent`-aware
 * layer lives in `src/lib/compute/` and imports from here.
 */
export { getService, createService } from "./loader.ts";
export { LibdedxServiceImpl, PROGRAMS, ELECTRON_ID } from "./libdedx.ts";
export { LibdedxError } from "./types.ts";
export type {
  LibdedxService,
  LibdedxModuleFactory,
  EmscriptenModule,
  ProgramEntity,
  ParticleEntity,
  MaterialEntity,
  CalculationResult,
  InverseStpResult,
  InverseCsdaResult,
  EnergyUnit,
  StpUnit,
  RangeUnit,
} from "./types.ts";
