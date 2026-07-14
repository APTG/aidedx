import { describe, expect, it } from "vitest";
import { INDIRECT_IDIOMS, matchIntent, matchQueryIntent } from "./matcher.ts";
import { validateQueryIntent } from "./query-intent.ts";

describe("quantity detection", () => {
  it("reads a direct stopping-power keyword", () => {
    const { intent, quantitySource } = matchIntent(
      "What is the stopping power of 40 MeV protons in water?",
    );
    expect(intent.quantity).toBe("stoppingPower");
    expect(quantitySource).toBe("direct");
  });

  it("reads dE/dx as stopping power", () => {
    expect(matchQueryIntent("dE/dx of 3 MeV deuterons in silicon.").quantity).toBe("stoppingPower");
  });

  it("reads a direct range keyword", () => {
    expect(matchQueryIntent("Range of 200 MeV protons in water.").quantity).toBe("csdaRange");
  });

  it("resolves an indirect 'how far … travel' idiom to range", () => {
    const { intent, quantitySource, idiom } = matchIntent(
      "How far will a 60 MeV proton travel in water?",
    );
    expect(intent.quantity).toBe("csdaRange");
    expect(quantitySource).toBe("indirect");
    expect(idiom).toBeDefined();
  });

  it("resolves an indirect 'how quickly … lose energy' idiom to stopping power", () => {
    expect(
      matchQueryIntent("How quickly does a 5 MeV alpha lose energy going through tissue?").quantity,
    ).toBe("stoppingPower");
  });

  it("does not mistake 'at what rate … shed energy' for an inverse query", () => {
    const { intent, quantitySource } = matchIntent(
      "At what rate does a 30 MeV proton shed energy as it moves through aluminum?",
    );
    expect(intent.quantity).toBe("stoppingPower");
    expect(quantitySource).toBe("indirect");
    expect(intent.energies).toEqual([{ value: 30, unit: "MeV" }]);
  });
});

describe("inverse queries", () => {
  it("detects energyFromRange with a length target and no energy slot", () => {
    const intent = matchQueryIntent("What energy gives a 10 cm range in water for protons?");
    expect(intent.quantity).toBe("energyFromRange");
    expect(intent.target).toEqual({ value: 10, unit: "cm" });
    expect(intent.energies).toEqual([]);
  });

  it("normalizes an areal-density target unit", () => {
    expect(
      matchQueryIntent("What energy do I need for a 2 g/cm2 range of protons in water?").target,
    ).toEqual({ value: 2, unit: "g/cm2" });
  });

  it("detects energyFromStp from a stopping-power target", () => {
    const intent = matchQueryIntent(
      "At what proton energy is the stopping power in water 5 MeV/cm?",
    );
    expect(intent.quantity).toBe("energyFromStp");
    expect(intent.target).toEqual({ value: 5, unit: "MeV/cm" });
  });
});

describe("energy + unit parsing", () => {
  it("keeps keV and GeV units", () => {
    expect(matchQueryIntent("Stopping power of 500 keV protons in water.").energies[0]).toEqual({
      value: 500,
      unit: "keV",
    });
    expect(matchQueryIntent("Range of a 2 GeV proton in iron.").energies[0]).toEqual({
      value: 2,
      unit: "GeV",
    });
  });

  it("records an explicit per-nucleon reading", () => {
    expect(matchQueryIntent("Range of carbon ions in water at 290 MeV/u.").energies[0]).toEqual({
      value: 290,
      unit: "MeV/u",
      perNucleonAssumed: true,
    });
  });

  it("treats a bare energy on a heavy ion as total and records the assumption", () => {
    const intent = matchQueryIntent("Stopping power of a 1200 MeV carbon ion in water.");
    expect(intent.energies[0]).toEqual({ value: 1200, unit: "MeV", perNucleonAssumed: false });
    expect(intent.assumptions).toContain("1200 MeV taken as total → 100 MeV/nucl");
  });

  it("converts a per-nucleon value to MeV when the base unit is keV or GeV", () => {
    // The schema's only per-nucleon units are MeV-based, so the magnitude must
    // be converted, not just relabelled.
    expect(matchQueryIntent("Range of carbon ions in water at 500 keV/u.").energies[0]).toEqual({
      value: 0.5,
      unit: "MeV/u",
      perNucleonAssumed: true,
    });
    expect(
      matchQueryIntent("Range of carbon ions in water at 1.2 GeV per nucleon.").energies[0],
    ).toEqual({ value: 1200, unit: "MeV/nucl", perNucleonAssumed: true });
  });

  it("does not flag a bare energy on a named light particle", () => {
    expect(matchQueryIntent("Range of 10 MeV alpha particles in air?").energies[0]).toEqual({
      value: 10,
      unit: "MeV",
    });
  });

  it("drops a negative energy instead of silently treating it as positive", () => {
    const { intent, incomplete } = matchIntent("Range of -100 MeV protons in water.");
    expect(intent.energies).toEqual([]);
    expect(incomplete).toBe(true);
    expect(intent.confidence).toBeLessThan(0.55);
  });

  it("does not let a dropped negative energy leak into material matching", () => {
    // "MeV" from the rejected "-100 MeV" span must not be re-mined as a
    // material now that it's no longer consumed by a valid energy slot.
    const intent = matchQueryIntent("Range of -100 MeV protons in water.");
    expect(intent.materials).toEqual([{ match: "water" }]);
  });

  it("does not mistake a hyphenated range's dash for a negative sign", () => {
    // The "-" here separates two numbers ("100-200") rather than negating
    // one; only "200 MeV" matches the number grammar, and it must be kept
    // as a real energy, not dropped as if it were "-200 MeV".
    const { intent, incomplete } = matchIntent("Stopping power of 100-200 MeV protons in water.");
    expect(intent.energies).toEqual([{ value: 200, unit: "MeV" }]);
    expect(incomplete).toBe(false);
  });

  it("does not mistake a spaced hyphenated range's dash for a negative sign", () => {
    const { intent, incomplete } = matchIntent("Stopping power of 100 - 200 MeV protons in water.");
    expect(intent.energies).toEqual([{ value: 200, unit: "MeV" }]);
    expect(incomplete).toBe(false);
  });
});

describe("isotope resolution", () => {
  it("assumes the dominant isotope for a bare element ion", () => {
    const intent = matchQueryIntent("Range of 90 MeV per nucleon carbon ions in water.");
    expect(intent.particles[0]).toEqual({ match: "carbon ions", isotopeAssumed: "¹²C" });
    expect(intent.assumptions).toContain("carbon → ¹²C");
  });
});

describe("comparison dimension", () => {
  it("compare-material from two materials", () => {
    const intent = matchQueryIntent(
      "Compare the stopping power of 100 MeV protons in water and bone.",
    );
    expect(intent.compareDim).toBe("material");
    expect(intent.materials).toHaveLength(2);
  });

  it("compare-particle from a coordinated list (serial comma)", () => {
    const intent = matchQueryIntent(
      "Compare stopping power of protons, helium, and carbon ions in water at 150 MeV per nucleon.",
    );
    expect(intent.compareDim).toBe("particle");
    expect(intent.particles.map((p) => p.match)).toEqual(["protons", "helium", "carbon"]);
  });

  it("compare-energy from a shared-unit value list", () => {
    const intent = matchQueryIntent("Stopping power of protons in PMMA at 50, 100, and 150 MeV.");
    expect(intent.compareDim).toBe("energy");
    expect(intent.energies.map((e) => e.value)).toEqual([50, 100, 150]);
  });

  it("compare-program from two program names, leaving slots singular", () => {
    const intent = matchQueryIntent(
      "Compare the range of 150 MeV protons in water using ASTAR and PSTAR.",
    );
    expect(intent.compareDim).toBe("program");
    expect(intent.particles).toHaveLength(1);
    expect(intent.materials).toHaveLength(1);
  });

  it("single when exactly one entity per dimension", () => {
    expect(matchQueryIntent("What is the range of 40 MeV protons in PMMA?").compareDim).toBe(
      "none",
    );
  });
});

describe("conversational filler is tolerated", () => {
  it("strips politeness and still fills every slot", () => {
    const intent = matchQueryIntent(
      "Hey, I was just wondering, what's the range of 40 MeV protons in water?",
    );
    expect(intent.quantity).toBe("csdaRange");
    expect(intent.compareDim).toBe("none");
    expect(intent.particles).toEqual([{ match: "protons" }]);
    expect(intent.materials).toEqual([{ match: "water" }]);
  });
});

describe("output is schema-valid", () => {
  const samples = [
    "What is the stopping power of 40 MeV protons in water?",
    "What energy gives a 10 cm range in water for protons?",
    "I am curious how far in water the 240 keV carbon ion will go",
  ];
  for (const text of samples) {
    it(`produces a valid QueryIntent for: ${text}`, () => {
      expect(validateQueryIntent(matchQueryIntent(text), "intent")).toEqual([]);
    });
  }
});

describe("indirect-idiom table", () => {
  it("is non-empty and every entry maps to a real quantity", () => {
    expect(INDIRECT_IDIOMS.length).toBeGreaterThan(0);
    for (const { pattern, quantity } of INDIRECT_IDIOMS) {
      expect(pattern).toBeInstanceOf(RegExp);
      expect(["stoppingPower", "csdaRange", "energyFromRange", "energyFromStp"]).toContain(
        quantity,
      );
    }
  });
});
