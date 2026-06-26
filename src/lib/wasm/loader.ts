/**
 * Lazy loader for the vendored libdedx WASM module.
 *
 * The ~468 KB `.wasm` + `.mjs` are dynamic-imported on first use, so the app
 * shell ships zero WASM in its initial bundle (issue #1 §10). The module is
 * served as a static asset from `static/wasm/`; Emscripten's `locateFile` hook
 * resolves the sibling `.wasm` next to the `.mjs`.
 *
 * The browser entry point is `getService()`. Tests and other Node consumers
 * load the same `.mjs` from disk and build a service via
 * `createService(factory)` — keeping a single construction path.
 */
import { base } from "$app/paths";
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
 * Lazily load the WASM module in the browser and return a cached, initialized
 * service. The dynamic import is deferred so the module is fetched only when a
 * query actually needs a number.
 *
 * @throws Error wrapping any load/compile failure.
 */
export async function getService(): Promise<LibdedxService> {
  if (!servicePromise) {
    servicePromise = (async () => {
      try {
        const factory = (await import(/* @vite-ignore */ `${base}/wasm/libdedx.mjs`))
          .default as LibdedxModuleFactory;
        return await createService(factory, (f) => `${base}/wasm/${f}`);
      } catch (error) {
        servicePromise = null; // allow a later retry
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to load libdedx WASM module: ${message}`, { cause: error });
      }
    })();
  }
  return servicePromise;
}
