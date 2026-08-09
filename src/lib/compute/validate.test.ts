/**
 * Deterministic (non-WASM) tests for `validateIntent()`'s issue #163 B10 target round-trip
 * check, using a hand-built fake `LibdedxService`. `validate.smoke.test.ts` exercises this same
 * check against the real vendored WASM (and is where the "does the WASM itself ever silently
 * saturate a target" question belongs) — this file exists because the real WASM's
 * `getInverseStp` happens to bounds-check cleanly (returns a `LibdedxError`) for every
 * out-of-range stopping-power target tried there, so the "solve succeeds but doesn't actually
 * reproduce the target" branch has no known real-WASM reproduction for `energyFromStp`. A fake
 * service lets that branch be exercised directly and deterministically, for both quantities,
 * without depending on a WASM implementation detail that could change.
 */
import { describe, expect, it, vi } from "vitest";
import {
  LibdedxError,
  type CalculationResult,
  type InverseCsdaResult,
  type InverseStpResult,
  type LibdedxService,
  type MaterialEntity,
  type ParticleEntity,
} from "../wasm/types.ts";
import { validateIntent } from "./validate.ts";
import type { QueryIntent } from "../intent/query-intent.ts";

const PROTON: ParticleEntity = { id: 1, name: "Hydrogen", massNumber: 1, atomicMass: 1.008 };
const WATER: MaterialEntity = {
  id: 276,
  name: "Water, Liquid",
  density: 1,
  isGasByDefault: false,
};

/** Throws when called — every fake-service method not relevant to the path under test uses this,
 * so an accidental call outside that path fails the test loudly instead of returning a silently
 * wrong default. */
function notImplemented(name: string): () => never {
  return () => {
    throw new Error(`fakeService: ${name} not implemented`);
  };
}

/** A minimal `LibdedxService` covering only what `validateIntent()`'s inverse-target path calls:
 * `getParticles`/`getMaterials` (the combination check), `getDensity`, and whichever of
 * `getInverseCsda`/`getInverseStp` + `calculate` the round-trip check needs. */
function fakeService(overrides: Partial<LibdedxService> = {}): LibdedxService {
  return {
    init: vi.fn(),
    getPrograms: vi.fn(notImplemented("getPrograms")),
    getParticles: vi.fn(() => [PROTON]),
    getMaterials: vi.fn(() => [WATER]),
    getMinEnergy: vi.fn(notImplemented("getMinEnergy")),
    getMaxEnergy: vi.fn(notImplemented("getMaxEnergy")),
    getDensity: vi.fn(() => 1),
    getAtomicMass: vi.fn(notImplemented("getAtomicMass")),
    getNucleonNumber: vi.fn(notImplemented("getNucleonNumber")),
    getVersion: vi.fn(notImplemented("getVersion")),
    calculate: vi.fn(notImplemented("calculate")),
    calculateMulti: vi.fn(notImplemented("calculateMulti")),
    getInverseCsda: vi.fn(notImplemented("getInverseCsda")),
    getInverseStp: vi.fn(notImplemented("getInverseStp")),
    getBraggPeakStp: vi.fn(notImplemented("getBraggPeakStp")),
    ...overrides,
  };
}

function intent(partial: Partial<QueryIntent>): QueryIntent {
  return {
    quantity: "energyFromRange",
    compareDim: "none",
    particles: [{ match: "proton" }],
    materials: [{ match: "water" }],
    energies: [],
    program: "PSTAR",
    assumptions: [],
    confidence: 1,
    ...partial,
  };
}

function calcResult(partial: Partial<CalculationResult>): CalculationResult {
  return { energies: [], stoppingPowers: [], csdaRanges: [], ...partial };
}

describe("validateIntent — issue #163 B10 target round-trip (fake service)", () => {
  it("flags an energyFromRange target whose solved energy doesn't actually reproduce it", () => {
    const service = fakeService({
      getInverseCsda: vi.fn((): (InverseCsdaResult | LibdedxError)[] => [
        { energy: 9999, csdaRange: 30 },
      ]),
      calculate: vi.fn(() => calcResult({ csdaRanges: [12] })), // doesn't reproduce the "30" target
    });

    const v = validateIntent(
      intent({ quantity: "energyFromRange", target: { value: 30, unit: "g/cm2" } }),
      service,
    );

    expect(v.plausible).toBe(false);
    expect(v.issues).toEqual([
      expect.objectContaining({
        slot: "target",
        message:
          "Solving for the energy that gives a range of 30 g/cm² for Hydrogen in Water (liquid) actually reaches 12 g/cm² — the result may not be reliable",
      }),
    ]);
  });

  it("does not flag an energyFromRange target whose solved energy reproduces it within tolerance", () => {
    const service = fakeService({
      getInverseCsda: vi.fn((): (InverseCsdaResult | LibdedxError)[] => [
        { energy: 100, csdaRange: 30 },
      ]),
      calculate: vi.fn(() => calcResult({ csdaRanges: [30.1] })), // within the 2% tolerance
    });

    const v = validateIntent(
      intent({ quantity: "energyFromRange", target: { value: 30, unit: "g/cm2" } }),
      service,
    );

    expect(v).toEqual({ plausible: true, issues: [] });
  });

  it("flags an energyFromStp target whose solved energy doesn't actually reproduce it", () => {
    const service = fakeService({
      getInverseStp: vi.fn((): (InverseStpResult | LibdedxError)[] => [
        { energy: 5, stoppingPower: 40 },
      ]),
      calculate: vi.fn(() => calcResult({ stoppingPowers: [4] })), // 10x off — not a rounding slip
    });

    const v = validateIntent(
      intent({ quantity: "energyFromStp", target: { value: 40, unit: "MeV cm2/g" } }),
      service,
    );

    expect(v.plausible).toBe(false);
    expect(v.issues).toEqual([
      expect.objectContaining({
        slot: "target",
        message:
          "Solving for the energy that gives a stopping power of 40 MeV·cm²/g for Hydrogen in Water (liquid) actually reaches 4 MeV·cm²/g — the result may not be reliable",
      }),
    ]);
  });

  it("does not flag when the inverse solve itself returns a LibdedxError (defers to computeIntent's own error)", () => {
    const service = fakeService({
      getInverseCsda: vi.fn(() => [new LibdedxError(-1, "out of range")]),
      // Must not even be reached — the round-trip check returns as soon as the solve fails.
      calculate: vi.fn(notImplemented("calculate")),
    });

    const v = validateIntent(
      intent({ quantity: "energyFromRange", target: { value: 30, unit: "g/cm2" } }),
      service,
    );

    expect(v).toEqual({ plausible: true, issues: [] });
  });
});
