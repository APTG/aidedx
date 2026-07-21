import { describe, expect, it } from "vitest";
import type { QueryIntent } from "./query-intent.ts";
import {
  withEnergy,
  withMaterialMatch,
  withParticleMatch,
  withProgram,
  withTarget,
} from "./edit-intent.ts";

function baseIntent(overrides: Partial<QueryIntent> = {}): QueryIntent {
  return {
    quantity: "stoppingPower",
    compareDim: "none",
    particles: [{ match: "helium-4", isotopeAssumed: "⁴He" }],
    materials: [{ match: "watre" }],
    energies: [{ value: 214, unit: "keV" }],
    assumptions: ["heard: watre → read as: water"],
    confidence: 0.7,
    ...overrides,
  };
}

describe("withParticleMatch", () => {
  it("patches the particle at the given index and clears isotopeAssumed", () => {
    const intent = baseIntent();
    const next = withParticleMatch(intent, 0, "alpha particle");
    expect(next.particles[0]).toEqual({ match: "alpha particle" });
    // `isotopeAssumed` must be *omitted*, not present-with-value-undefined —
    // validateQueryIntent() rejects the latter (`"isotopeAssumed" in p`
    // requires a string once the key exists at all).
    expect(Object.hasOwn(next.particles[0] ?? {}, "isotopeAssumed")).toBe(false);
  });

  it("does not mutate the original intent", () => {
    const intent = baseIntent();
    withParticleMatch(intent, 0, "alpha particle");
    expect(intent.particles[0]?.match).toBe("helium-4");
  });

  it("clears assumptions and sets confidence to 1", () => {
    const next = withParticleMatch(baseIntent(), 0, "alpha particle");
    expect(next.assumptions).toEqual([]);
    expect(next.confidence).toBe(1);
  });
});

describe("withMaterialMatch", () => {
  it("patches the material at the given index", () => {
    const next = withMaterialMatch(baseIntent(), 0, "water");
    expect(next.materials[0]).toEqual({ match: "water" });
  });

  it("does not mutate the original intent", () => {
    const intent = baseIntent();
    withMaterialMatch(intent, 0, "water");
    expect(intent.materials[0]?.match).toBe("watre");
  });
});

describe("withEnergy", () => {
  it("patches value and unit at the given index, keeping other fields", () => {
    const intent = baseIntent({
      energies: [{ value: 214, unit: "keV", perNucleonAssumed: false }],
    });
    const next = withEnergy(intent, 0, 240, "keV");
    expect(next.energies[0]).toEqual({ value: 240, unit: "keV", perNucleonAssumed: false });
  });

  it("does not mutate the original intent", () => {
    const intent = baseIntent();
    withEnergy(intent, 0, 240, "MeV");
    expect(intent.energies[0]).toEqual({ value: 214, unit: "keV" });
  });
});

describe("withTarget", () => {
  it("sets the target slot", () => {
    const next = withTarget(baseIntent(), 10, "cm");
    expect(next.target).toEqual({ value: 10, unit: "cm" });
  });
});

describe("withProgram", () => {
  it("sets the program field", () => {
    const next = withProgram(baseIntent(), "PSTAR");
    expect(next.program).toBe("PSTAR");
  });

  it("clears the program field when given undefined", () => {
    const next = withProgram(baseIntent({ program: "PSTAR" }), undefined);
    expect(next.program).toBeUndefined();
  });
});
