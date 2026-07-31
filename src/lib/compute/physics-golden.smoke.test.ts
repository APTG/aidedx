// @vitest-environment node
/**
 * Physics golden-file test (issue #163 §6.5): "All 5 [CI] gates pass, and none of B1–B10 is
 * detectable by any of them. The gates verify *form* ... Nothing verifies *physics*." This suite
 * is that missing check — canonical query → expected-number pairs, asserted against the real
 * vendored WASM the same way `compute.smoke.test.ts` does, spanning every accepted inverse-query
 * target unit (§4.1's closed unions) plus the text-parsing bugs (B4, B7). Every pair here fails
 * loudly on the pre-fix behaviour described in issue #163 §2:
 *  - B1: a µm range target silently computed as centimetres (~200× error)
 *  - B2: a keV/µm stopping-power target silently computed as MeV·cm²/g (~18× error in water)
 *  - B4: a spelled-out hundreds+tens/ones remainder ("two hundred thirty five") collapsing to "5"
 *  - B7: the total→per-nucleon energy split silently applied but only *disclosed* for some A>1
 *    particles (isotope-assumed ions), not others (named light ions: deuteron/triton/alpha)
 *
 * The exact numeric expectations for the text-driven cases below are the same figures issue #163
 * quotes as "Correct (same program, same WASM)" — reproduced independently here via
 * `matchIntent()` → `computeIntent()`, not copied from the matcher's own output.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { LibdedxServiceImpl } from "../wasm/libdedx.ts";
import type { LibdedxModuleFactory, LibdedxService } from "../wasm/types.ts";
import { computeIntent } from "./compute.ts";
import { matchIntent } from "../intent/matcher.ts";
import type { QueryIntent, RangeTargetUnit, StpTargetUnit } from "../intent/query-intent.ts";

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

/** Assert a value is present and return it narrowed (avoids `!` assertions). */
function req<T>(v: T | undefined | null, msg = "expected a value"): T {
  if (v === undefined || v === null) throw new Error(msg);
  return v;
}

function intent(partial: Partial<QueryIntent>): QueryIntent {
  return {
    quantity: "csdaRange",
    compareDim: "none",
    particles: [],
    materials: [],
    energies: [],
    assumptions: [],
    confidence: 1,
    ...partial,
  };
}

describe("physics golden file — B1: every RangeTargetUnit round-trips to the same energy", () => {
  // A 100 MeV proton in water is the reference: forward-compute its CSDA range once, express that
  // same physical range in each accepted unit, then run the *inverse* query and confirm it
  // recovers ~100 MeV. Before the fix, "um" silently fell through to "cm" in
  // `rangeTargetToGcm2()` — a target expressed in um would come back ~10,000x too small a
  // distance, i.e. a wildly wrong recovered energy, not ~100 MeV.
  let referenceRangeGcm2: number;
  let density: number;

  beforeAll(() => {
    const forward = computeIntent(
      intent({
        quantity: "csdaRange",
        particles: [{ match: "protons" }],
        materials: [{ match: "water" }],
        energies: [{ value: 100, unit: "MeV" }],
      }),
      service,
    );
    referenceRangeGcm2 = req(req(forward.series[0]).points[0]).csdaRange as number;
    density = req(req(forward.series[0]).density);
  });

  it.each<[RangeTargetUnit, (linearCm: number, gcm2: number) => number]>([
    ["cm", (linearCm) => linearCm],
    ["mm", (linearCm) => linearCm * 10],
    ["m", (linearCm) => linearCm / 100],
    ["um", (linearCm) => linearCm * 10_000],
    ["g/cm2", (_linearCm, gcm2) => gcm2],
  ])("target unit %s recovers ~100 MeV", (unit, toTargetValue) => {
    const linearCm = referenceRangeGcm2 / density;
    const value = toTargetValue(linearCm, referenceRangeGcm2);
    const result = computeIntent(
      intent({
        quantity: "energyFromRange",
        particles: [{ match: "protons" }],
        materials: [{ match: "water" }],
        energies: [],
        target: { value, unit },
      }),
      service,
    );
    const s = req(result.series[0]);
    expect(s.error).toBeUndefined();
    expect(req(req(s.points[0]).energy)).toBeCloseTo(100, 0);
  });
});

describe("physics golden file — B2: every StpTargetUnit round-trips to the same energy", () => {
  // Same round-trip idea as B1, for stopping-power targets. Before the fix, "keV/um" silently fell
  // through `stpTargetToMassUnits()`'s "assume already MeV·cm²/g" default — off by
  // density × 10 (18× in water) instead of recovering ~100 MeV.
  let referenceStpMevCm2PerG: number;
  let density: number;

  beforeAll(() => {
    const forward = computeIntent(
      intent({
        quantity: "stoppingPower",
        particles: [{ match: "protons" }],
        materials: [{ match: "water" }],
        energies: [{ value: 100, unit: "MeV" }],
      }),
      service,
    );
    referenceStpMevCm2PerG = req(req(forward.series[0]).points[0]).stoppingPower as number;
    density = req(req(forward.series[0]).density);
  });

  it.each<[StpTargetUnit, (massStp: number, density: number) => number]>([
    ["MeV cm2/g", (massStp) => massStp],
    ["MeV/cm", (massStp, d) => massStp * d],
    ["keV/um", (massStp, d) => massStp * d * 0.1],
  ])("target unit %s recovers ~100 MeV", (unit, toTargetValue) => {
    const value = toTargetValue(referenceStpMevCm2PerG, density);
    const result = computeIntent(
      intent({
        quantity: "energyFromStp",
        particles: [{ match: "protons" }],
        materials: [{ match: "water" }],
        energies: [],
        target: { value, unit },
      }),
      service,
    );
    const s = req(result.series[0]);
    expect(s.error).toBeUndefined();
    expect(req(req(s.points[0]).energy)).toBeCloseTo(100, 0);
  });
});

describe("physics golden file — B1/B2: issue #163's own quoted measured numbers", () => {
  // These reproduce the exact "Correct (same program, same WASM)" figures from issue #163 §2,
  // driven end to end from natural-language text (matchIntent -> computeIntent), not from a
  // hand-built intent. If B1/B2 regress, these come back ~200x / ~18x off, not merely imprecise.
  it.each([
    ["What proton energy gives a 500 micrometer range in water?", 6.012],
    ["What energy proton has a range of 300 micrometers in water?", 4.485],
    ["What proton energy stops after 100 mm in water?", 115.7], // control: mm always worked
  ])("%s -> ~%f MeV", (query, expectedMev) => {
    const match = matchIntent(query as string);
    const result = computeIntent(match.intent, service);
    const s = req(result.series[0]);
    expect(s.error).toBeUndefined();
    expect(req(req(s.points[0]).energy)).toBeCloseTo(expectedMev as number, 1);
  });

  it.each([
    ["What energy proton has a stopping power of 8 keV/um in water?", 4.925],
    ["What energy proton has a stopping power of 80 MeV/cm in water?", 4.925], // control, same physical value
  ])("%s -> ~%f MeV", (query, expectedMev) => {
    const match = matchIntent(query as string);
    const result = computeIntent(match.intent, service);
    const s = req(result.series[0]);
    expect(s.error).toBeUndefined();
    expect(req(req(s.points[0]).energy)).toBeCloseTo(expectedMev as number, 2);
  });
});

describe("physics golden file — B4: spelled-out hundreds+tens/ones parse to the same physics as digits", () => {
  it.each([
    ["range of a two hundred thirty five MeV proton in water", "range of a 235 MeV proton in water"],
    [
      "range of a nine hundred ninety nine MeV proton in water",
      "range of a 999 MeV proton in water",
    ],
    [
      "range of a one hundred and thirty five MeV proton in water",
      "range of a 135 MeV proton in water",
    ],
  ])("%s computes the identical CSDA range as %s", (spelled, digits) => {
    const spelledResult = computeIntent(matchIntent(spelled).intent, service);
    const digitsResult = computeIntent(matchIntent(digits).intent, service);
    const spelledRange = req(req(spelledResult.series[0]).points[0]).csdaRange;
    const digitsRange = req(req(digitsResult.series[0]).points[0]).csdaRange;
    expect(req(spelledRange)).toBeCloseTo(req(digitsRange), 6);
    expect(req(spelledRange)).toBeGreaterThan(0);
  });
});

describe("physics golden file — B7: total energy is divided by A, and disclosed, for every named A>1 particle", () => {
  it.each([
    ["range of 20 MeV alpha particles in air", 4, 5, "5 MeV/nucl"],
    ["range of 20 MeV deuteron in water", 2, 10, "10 MeV/nucl"],
    ["range of 20 MeV triton in water", 3, 20 / 3, "6.667 MeV/nucl"],
  ])("%s divides by A=%i to %f MeV/nucl and discloses it", (query, _a, expectedMevPerNucl, noteFragment) => {
    const match = matchIntent(query as string);
    expect(match.intent.assumptions.some((a) => a.includes(noteFragment as string))).toBe(true);
    const result = computeIntent(match.intent, service);
    const s = req(result.series[0]);
    expect(s.error).toBeUndefined();
    const p = req(s.points[0]);
    expect(p.energyMeVPerNucl).toBeCloseTo(expectedMevPerNucl as number, 3);
    expect(req(p.csdaRange)).toBeGreaterThan(0);
  });

  it("formats the disclosure note to 4 significant figures, not raw 1e-6 float noise", () => {
    const match = matchIntent("stopping power of a 400 MeV carbon ion in water");
    expect(match.intent.assumptions).toContain("400 MeV taken as total → 33.33 MeV/nucl");
    const result = computeIntent(match.intent, service);
    const s = req(result.series[0]);
    expect(s.error).toBeUndefined();
    const p = req(s.points[0]);
    expect(p.energyMeVPerNucl).toBeCloseTo(400 / 12, 6);
    expect(req(p.stoppingPower)).toBeGreaterThan(0);
  });
});
