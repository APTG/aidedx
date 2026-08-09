// @vitest-environment node
/**
 * Smoke tests for `validateIntent()` (issue #29) — drive the *real* vendored libdedx WASM so
 * plausibility bounds are checked against actual tabulated data, not a stub. Mirrors
 * `compute.smoke.test.ts`'s WASM bootstrap.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { LibdedxServiceImpl } from "../wasm/libdedx.ts";
import type { LibdedxModuleFactory, LibdedxService } from "../wasm/types.ts";
import { computeIntent } from "./compute.ts";
import { buildReAskNotice, validateIntent } from "./validate.ts";
import type { QueryIntent } from "../intent/query-intent.ts";

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

/** Minimal intent builder with the schema's required fields filled in. */
function intent(partial: Partial<QueryIntent>): QueryIntent {
  return {
    quantity: "stoppingPower",
    compareDim: "none",
    particles: [],
    materials: [],
    energies: [],
    assumptions: [],
    confidence: 1,
    ...partial,
  };
}

describe("validateIntent — isotope plausibility", () => {
  it("flags carbon-30 (issue #29's own example) even though computeIntent computes it silently", () => {
    const bad = intent({
      particles: [{ match: "carbon-30 ions" }],
      materials: [{ match: "water" }],
      energies: [{ value: 100, unit: "MeV/nucl", perNucleonAssumed: true }],
    });

    const v = validateIntent(bad, service);
    expect(v.plausible).toBe(false);
    expect(v.issues).toContainEqual(
      expect.objectContaining({
        slot: "particle",
        index: 0,
        message: expect.stringMatching(/C.*not a plausible isotope/),
      }),
    );

    // The load-bearing justification for this module: without it, this exact input computes a
    // confident, real-looking number with no error at all.
    const result = computeIntent(bad, service);
    expect(result.series[0]?.error).toBeUndefined();
    expect(result.series[0]?.points[0]?.stoppingPower).toBeGreaterThan(0);
  });

  it("passes a real isotope (carbon-13)", () => {
    const v = validateIntent(
      intent({
        particles: [{ match: "carbon-13 ion" }],
        materials: [{ match: "water" }],
        energies: [{ value: 100, unit: "MeV/nucl", perNucleonAssumed: true }],
      }),
      service,
    );
    expect(v).toEqual({ plausible: true, issues: [] });
  });

  it("passes a bare proton", () => {
    const v = validateIntent(
      intent({
        particles: [{ match: "proton" }],
        materials: [{ match: "water" }],
        energies: [{ value: 100, unit: "MeV" }],
      }),
      service,
    );
    expect(v).toEqual({ plausible: true, issues: [] });
  });

  it("skips an unresolvable particle rather than throwing (computeIntent's own concern)", () => {
    const v = validateIntent(
      intent({
        particles: [{ match: "unobtainium" }],
        materials: [{ match: "water" }],
        energies: [{ value: 100, unit: "MeV" }],
      }),
      service,
    );
    expect(v).toEqual({ plausible: true, issues: [] });
  });
});

describe("validateIntent — particle/material/program combination", () => {
  it("flags an explicit program that doesn't support the particle (PSTAR is proton-only)", () => {
    const v = validateIntent(
      intent({
        particles: [{ match: "carbon-13 ion" }],
        materials: [{ match: "water" }],
        energies: [{ value: 100, unit: "MeV/nucl", perNucleonAssumed: true }],
        program: "PSTAR",
      }),
      service,
    );
    expect(v.plausible).toBe(false);
    expect(v.issues).toContainEqual(
      expect.objectContaining({
        slot: "particle",
        index: 0,
        message: "Carbon has no data under PSTAR",
      }),
    );
  });

  it("attributes a material-side gap to the material slot even in a singleton (compareDim: none) query", () => {
    // Regression case: PSTAR supports protons everywhere except Boron (dedx_web#845, see
    // compute.ts). A singleton query has only one particle/material pair, so this must not be
    // hard-attributed to "particle" just because that's the slot a comparison would vary.
    const v = validateIntent(
      intent({
        particles: [{ match: "proton" }],
        materials: [{ match: "boron" }],
        energies: [{ value: 40, unit: "MeV" }],
        program: "PSTAR",
      }),
      service,
    );
    expect(v.plausible).toBe(false);
    expect(v.issues).toEqual([
      { slot: "material", index: 0, message: "Boron has no data under PSTAR for Hydrogen" },
    ]);
  });

  it("attributes the failing combination to the actual bad particle in a compareDim: particle list", () => {
    const v = validateIntent(
      intent({
        compareDim: "particle",
        particles: [{ match: "proton" }, { match: "carbon-13 ion" }],
        materials: [{ match: "water" }],
        energies: [{ value: 100, unit: "MeV/nucl", perNucleonAssumed: true }],
        program: "PSTAR",
      }),
      service,
    );
    expect(v.issues).toHaveLength(1);
    expect(v.issues[0]).toMatchObject({ slot: "particle", index: 1 });
  });

  it("attributes a material-side gap to the varying material's own index in a compareDim: material list", () => {
    const v = validateIntent(
      intent({
        compareDim: "material",
        particles: [{ match: "proton" }],
        materials: [{ match: "water" }, { match: "boron" }],
        energies: [{ value: 40, unit: "MeV" }],
        program: "PSTAR",
      }),
      service,
    );
    // Water is fine under PSTAR; only Boron (index 1) is flagged.
    expect(v.issues).toEqual([
      { slot: "material", index: 1, message: "Boron has no data under PSTAR for Hydrogen" },
    ]);
  });

  it("dedupes a particle-side gap that would otherwise repeat once per material in a compareDim: material list", () => {
    const v = validateIntent(
      intent({
        compareDim: "material",
        particles: [{ match: "carbon-13 ion" }],
        materials: [{ match: "water" }, { match: "air" }],
        energies: [{ value: 100, unit: "MeV/nucl", perNucleonAssumed: true }],
        program: "PSTAR",
      }),
      service,
    );
    // Carbon is unsupported by PSTAR regardless of material — one issue, not one per material.
    expect(v.issues).toEqual([
      { slot: "particle", index: 0, message: "Carbon has no data under PSTAR" },
    ]);
  });

  it("passes when the program is auto-selected, even for calcium (MSTAR falls back to Bethe)", () => {
    const v = validateIntent(
      intent({
        particles: [{ match: "calcium ions" }],
        materials: [{ match: "water" }],
        energies: [{ value: 100, unit: "MeV/nucl", perNucleonAssumed: true }],
      }),
      service,
    );
    expect(v).toEqual({ plausible: true, issues: [] });
  });

  it("does not check combination validity for compareDim: program (comparing across programs is the point)", () => {
    const v = validateIntent(
      intent({
        compareDim: "program",
        particles: [{ match: "carbon-13 ion" }],
        materials: [{ match: "water" }],
        energies: [{ value: 100, unit: "MeV/nucl", perNucleonAssumed: true }],
      }),
      service,
    );
    expect(v).toEqual({ plausible: true, issues: [] });
  });
});

describe("validateIntent — energy within the tabulated grid (unit-suspect first)", () => {
  it("flags an out-of-range energy and suggests the adjacent unit that would land in range", () => {
    const v = validateIntent(
      intent({
        particles: [{ match: "proton" }],
        materials: [{ match: "water" }],
        energies: [{ value: 0.001, unit: "MeV" }], // PSTAR floor is ~1 keV; 0.001 GeV = 1 MeV lands fine.
      }),
      service,
    );
    expect(v.plausible).toBe(false);
    expect(v.issues[0]).toMatchObject({ slot: "energy", index: 0 });
    expect(v.issues[0]?.suggestion).toBe("Did you mean 0.001 GeV?");
  });

  it("includes TeV in the magnitude-family suggestion (issue #151)", () => {
    const v = validateIntent(
      intent({
        particles: [{ match: "proton" }],
        materials: [{ match: "water" }],
        // 0.000001 TeV = 1 MeV, well inside the grid; the bare MeV reading is far out of range.
        energies: [{ value: 0.000001, unit: "MeV" }],
      }),
      service,
    );
    expect(v.plausible).toBe(false);
    expect(v.issues[0]?.suggestion).toBe("Did you mean 0.000001 TeV?");
  });

  it("passes an energy within the grid", () => {
    const v = validateIntent(
      intent({
        particles: [{ match: "proton" }],
        materials: [{ match: "water" }],
        energies: [{ value: 100, unit: "MeV" }],
      }),
      service,
    );
    expect(v).toEqual({ plausible: true, issues: [] });
  });

  it("skips the forward energy-bounds check for inverse queries (there's nothing given to check)", () => {
    // The (3) energy-bounds check above is forward-only by construction — there's no
    // `intent.energies` entry to bound-check on an inverse query. issue #163 B10's round-trip
    // check is the inverse-query counterpart; see the dedicated describe block below for it.
    const v = validateIntent(
      intent({
        quantity: "energyFromRange",
        particles: [{ match: "proton" }],
        materials: [{ match: "water" }],
        energies: [],
        target: { value: 10, unit: "cm" },
      }),
      service,
    );
    expect(v).toEqual({ plausible: true, issues: [] });
  });
});

describe("validateIntent — issue #163 B10: inverse-query target round-trip", () => {
  it("does not flag an ordinary, reachable range target", () => {
    const v = validateIntent(
      intent({
        quantity: "energyFromRange",
        particles: [{ match: "proton" }],
        materials: [{ match: "water" }],
        energies: [],
        target: { value: 10, unit: "cm" },
      }),
      service,
    );
    expect(v).toEqual({ plausible: true, issues: [] });
  });

  it("does not flag an ordinary, reachable stopping-power target", () => {
    const v = validateIntent(
      intent({
        quantity: "energyFromStp",
        particles: [{ match: "proton" }],
        materials: [{ match: "water" }],
        energies: [],
        target: { value: 7.29, unit: "MeV cm2/g" },
      }),
      service,
    );
    expect(v).toEqual({ plausible: true, issues: [] });
  });

  it("flags a range target so far outside the tabulated grid that the solve can't actually reach it", () => {
    // issue #163 B10's own motivating example — pre-fix, this absurd target (100,000 km) was
    // silently `plausible: true`; validateIntent() had no target check of any kind.
    const v = validateIntent(
      intent({
        quantity: "energyFromRange",
        particles: [{ match: "proton" }],
        materials: [{ match: "water" }],
        energies: [],
        target: { value: 10_000_000, unit: "cm" },
      }),
      service,
    );
    expect(v.plausible).toBe(false);
    expect(v.issues).toContainEqual(
      expect.objectContaining({
        slot: "target",
        message: expect.stringContaining("actually reaches") as unknown as string,
      }),
    );
  });

  it("does not double-report a stopping-power target libdedx's own solver already rejects", () => {
    // Unlike getInverseCsda (which silently saturates and echoes the requested range back — the
    // exact case the test above catches), getInverseStp cleanly returns a LibdedxError for a
    // stopping power this far outside the tabulated grid. checkTargetRoundTrip() defers to that
    // (computeIntent()'s own series.error surfaces it) rather than raising a second, weaker
    // plausibility issue on top of a solve that already failed loudly.
    const v = validateIntent(
      intent({
        quantity: "energyFromStp",
        particles: [{ match: "proton" }],
        materials: [{ match: "water" }],
        energies: [],
        target: { value: 100_000, unit: "MeV cm2/g" },
      }),
      service,
    );
    expect(v).toEqual({ plausible: true, issues: [] });
  });

  it("does not flag anything when the particle/material/program combination is already unsupported", () => {
    // The combination check ((2) above) already reports this loudly — the round-trip check must
    // not also try to solve for a combination it knows has no data, which would either throw
    // (caught and swallowed, so harmless) or, worse, produce a second, redundant issue.
    const v = validateIntent(
      intent({
        quantity: "energyFromRange",
        particles: [{ match: "electron" }],
        materials: [{ match: "water" }],
        energies: [],
        target: { value: 10, unit: "cm" },
      }),
      service,
    );
    // Electron mentions are skipped entirely (see validateIntent()'s own doc comment) — this is
    // really just confirming that skip still holds for the inverse path too.
    expect(v).toEqual({ plausible: true, issues: [] });
  });
});

describe("buildReAskNotice — issue #10 targeted re-ask (pure formatter, no WASM needed)", () => {
  it("appends the suggestion when present", () => {
    expect(
      buildReAskNotice({
        slot: "energy",
        index: 0,
        message: "240 keV is outside the valid range",
        suggestion: "Did you mean 240 MeV?",
      }),
    ).toBe("240 keV is outside the valid range. Did you mean 240 MeV?");
  });

  it("falls back to a generic prompt (worded to fit a non-numeric slot too) when there is no suggestion", () => {
    expect(
      buildReAskNotice({
        slot: "particle",
        index: 0,
        message: "Carbon-30 is not a plausible isotope of Carbon (Z=6)",
      }),
    ).toBe(
      "Carbon-30 is not a plausible isotope of Carbon (Z=6). Please double-check this before trusting the result.",
    );
  });
});
