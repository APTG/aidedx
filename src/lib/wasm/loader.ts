/**
 * Framework-free lazy loader for the vendored libdedx WASM module.
 *
 * The ~468 KB `.wasm` + `.mjs` are dynamic-imported on first use, so the app
 * shell ships zero WASM in its initial bundle (issue #1 §10). The module is
 * served as a static asset from `static/wasm/`; Emscripten's `locateFile` hook
 * resolves the sibling `.wasm` next to the `.mjs`.
 *
 * This file deliberately has no SvelteKit (or any host) dependency so it can
 * move into a shared `@aptg/libdedx-wasm` package (issue #1 §17). The
 * SvelteKit-specific entry point that supplies the base path lives in
 * `sveltekit.ts`.
 */
import { LibdedxServiceImpl } from "./libdedx.ts";
import type { LibdedxModuleFactory, LibdedxService } from "./types.ts";

let servicePromise: Promise<LibdedxService> | null = null;

/**
 * Build and initialize a service from an already-loaded Emscripten factory.
 * `locateFile` tells Emscripten where the sibling `.wasm` lives.
 */
export async function createService(
  factory: LibdedxModuleFactory,
  locateFile: (path: string) => string,
): Promise<LibdedxService> {
  const module = await factory({ locateFile, print: () => {}, printErr: () => {} });
  const service = new LibdedxServiceImpl(module);
  await service.init();
  return service;
}

/**
 * Lazily load the WASM module from `${baseUrl}/wasm/` and return a cached,
 * initialized service. `baseUrl` is the app's base path (e.g. SvelteKit's
 * `base`); pass `""` when the app is served from the domain root. The dynamic
 * import is deferred so the module is fetched only when a query needs a number.
 *
 * @throws Error wrapping any load/compile failure.
 */
export async function loadService(baseUrl: string): Promise<LibdedxService> {
  if (!servicePromise) {
    servicePromise = (async () => {
      try {
        const factory = (await import(/* @vite-ignore */ `${baseUrl}/wasm/libdedx.mjs`))
          .default as LibdedxModuleFactory;
        return await createService(factory, (f) => `${baseUrl}/wasm/${f}`);
      } catch (error) {
        servicePromise = null; // allow a later retry
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to load libdedx WASM module: ${message}`, { cause: error });
      }
    })();
  }
  return servicePromise;
}
