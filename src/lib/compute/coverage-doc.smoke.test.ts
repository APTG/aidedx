// @vitest-environment node
/**
 * Freshness guard for docs/coverage.md (issue #163 §8 Phase 5) — mirrors
 * `aliases.test.ts`'s "JSON artifacts are up to date" check. Loads the *real* vendored libdedx
 * WASM (same bootstrap as `compute.smoke.test.ts`) so the committed doc is checked against actual
 * program/particle/material availability, not a stub.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { LibdedxServiceImpl } from "../wasm/libdedx.ts";
import type { LibdedxModuleFactory, LibdedxService } from "../wasm/types.ts";
import { buildCoverageDoc } from "../../../scripts/generate-coverage-doc.ts";

const here = dirname(fileURLToPath(import.meta.url));
const wasmDir = resolve(here, "../../../static/wasm");

let service: LibdedxService;

beforeAll(async () => {
  const mjsUrl = pathToFileURL(join(wasmDir, "libdedx.mjs")).href;
  const factory = (await import(/* @vite-ignore */ mjsUrl)).default as LibdedxModuleFactory;
  const module = await factory({
    locateFile: (f: string) => join(wasmDir, f),
    print: () => {},
    printErr: () => {},
  });
  service = new LibdedxServiceImpl(module);
  await service.init();
});

describe("docs/coverage.md is up to date", () => {
  it("matches what generate-coverage-doc.ts would produce against the real WASM", () => {
    const committed = readFileSync(resolve(process.cwd(), "docs/coverage.md"), "utf-8");
    expect(committed).toBe(buildCoverageDoc(service));
  });
});
