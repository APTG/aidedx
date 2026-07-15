// @vitest-environment node
/**
 * Smoke test for the landing-page example queries (issue #67) — runs each
 * through the real chain (matchQueryIntent → computeIntent against the
 * actual vendored libdedx WASM → renderAnswer) so a future matcher/alias/
 * libdedx change that breaks one of these curated examples fails loudly
 * here instead of silently on the landing page. Mirrors the WASM bootstrap
 * in ../../compute/compute.smoke.test.ts.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { LibdedxServiceImpl } from "../../wasm/libdedx.ts";
import type { LibdedxModuleFactory, LibdedxService } from "../../wasm/types.ts";
import { matchQueryIntent } from "../../intent/matcher.ts";
import { computeIntent } from "../../compute/compute.ts";
import { renderAnswer } from "../../nlg/render.ts";
import { EXAMPLE_QUERIES } from "./example-queries.ts";

const here = dirname(fileURLToPath(import.meta.url));
const wasmDir = resolve(here, "../../../../static/wasm");

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

describe("EXAMPLE_QUERIES", () => {
  it("has exactly 7 curated examples", () => {
    expect(EXAMPLE_QUERIES).toHaveLength(7);
  });

  it.each(EXAMPLE_QUERIES)("resolves and computes cleanly: %s", (text) => {
    const intent = matchQueryIntent(text);
    expect(intent.confidence).toBeGreaterThan(0.5);
    expect(intent.particles.length).toBeGreaterThan(0);
    expect(intent.materials.length).toBeGreaterThan(0);

    const result = computeIntent(intent, service);
    for (const s of result.series) {
      expect(s.error).toBeUndefined();
    }

    const lines = renderAnswer(intent, result);
    expect(lines.length).toBeGreaterThan(0);
  });
});
