/**
 * Public entry point for the libdedx WASM wrapper.
 *
 * This barrel is the seam that issue #1 §17 plans to extract into a shared
 * `@aptg/libdedx-wasm` package: it exposes the typed service, the framework-free
 * loader, and the program constants, and nothing aidedx- or host-specific. The
 * SvelteKit-bound `getService()` lives in `./sveltekit.ts` (imported by app
 * code as `$lib/wasm/sveltekit`); the `QueryIntent`-aware layer lives in
 * `src/lib/compute/`.
 */
export { createService, loadService } from "./loader.ts";
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
