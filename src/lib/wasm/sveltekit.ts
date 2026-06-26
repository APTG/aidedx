/**
 * SvelteKit entry point for the libdedx WASM wrapper.
 *
 * This is the only file in `src/lib/wasm/` that depends on SvelteKit: it reads
 * the app `base` path from `$app/paths` and hands it to the framework-free
 * `loadService()`. Keeping the host dependency isolated here lets the rest of
 * `src/lib/wasm/` extract cleanly into `@aptg/libdedx-wasm` (issue #1 §17).
 *
 * App code should import `getService` from here (`$lib/wasm/sveltekit`).
 */
import { base } from "$app/paths";
import { loadService } from "./loader.ts";
import type { LibdedxService } from "./types.ts";

/** Lazily load and cache the libdedx service, resolving assets against `base`. */
export function getService(): Promise<LibdedxService> {
  return loadService(base);
}
