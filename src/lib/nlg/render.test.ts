import { describe, expect, it } from "vitest";
import { formatNumber, renderAnswer } from "./render.ts";
import type { QueryIntent } from "../intent/query-intent.ts";
import type { ComputeResult, ComputeSeries } from "../compute/compute.ts";

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

function series(overrides: Partial<ComputeSeries> = {}): ComputeSeries {
  return {
    label: "series",
    particle: { id: 1, name: "Hydrogen", massNumber: 1, isotope: "¹H" },
    material: { id: 276, name: "Water, Liquid" },
    program: { id: 2, name: "PSTAR" },
    points: [{ energyMeVPerNucl: 40, stoppingPower: 14.48, csdaRange: 1.529 }],
    ...overrides,
  };
}

function result(overrides: Partial<ComputeResult> = {}): ComputeResult {
  return {
    quantity: "csdaRange",
    compareDim: "none",
    series: [series()],
    assumptions: [],
    libdedxVersion: "1.4.0",
    ...overrides,
  };
}

describe("formatNumber", () => {
  it("rounds to 4 significant figures", () => {
    expect(formatNumber(1.42899)).toBe("1.429");
  });
  it("does not pad trailing zeros", () => {
    expect(formatNumber(100)).toBe("100");
    expect(formatNumber(7.29)).toBe("7.29");
  });
  it("handles zero", () => {
    expect(formatNumber(0)).toBe("0");
  });
  it("falls back to 'n/a' for non-finite values", () => {
    expect(formatNumber(Number.NaN)).toBe("n/a");
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("n/a");
  });
});

describe("renderAnswer — single (compareDim: none)", () => {
  it("renders a CSDA range sentence with value, unit, and program", () => {
    const i = intent({
      quantity: "csdaRange",
      particles: [{ match: "protons" }],
      materials: [{ match: "PMMA" }],
      energies: [{ value: 40, unit: "MeV" }],
    });
    const r = result({
      quantity: "csdaRange",
      series: [
        series({ points: [{ energyMeVPerNucl: 40, csdaRange: 1.529, stoppingPower: 14.48 }] }),
      ],
    });

    expect(renderAnswer(i, r)).toEqual([
      "The CSDA range of 40 MeV protons in PMMA is 1.529 g/cm² (PSTAR).",
    ]);
  });

  it("renders a stopping-power sentence using the mass-stopping-power unit", () => {
    const i = intent({
      quantity: "stoppingPower",
      particles: [{ match: "proton" }],
      materials: [{ match: "water" }],
      energies: [{ value: 100, unit: "MeV" }],
    });
    const r = result({
      quantity: "stoppingPower",
      series: [series({ points: [{ energyMeVPerNucl: 100, stoppingPower: 7.289 }] })],
    });

    expect(renderAnswer(i, r)).toEqual([
      "The stopping power of 100 MeV proton in water is 7.289 MeV·cm²/g (PSTAR).",
    ]);
  });

  it("renders stopping power in keV/µm when the series carries a density (issue #42 §2)", () => {
    const i = intent({
      quantity: "stoppingPower",
      particles: [{ match: "proton" }],
      materials: [{ match: "water" }],
      energies: [{ value: 100, unit: "MeV" }],
    });
    const r = result({
      quantity: "stoppingPower",
      series: [series({ density: 1, points: [{ energyMeVPerNucl: 100, stoppingPower: 7.289 }] })],
    });

    expect(renderAnswer(i, r)).toEqual([
      "The stopping power of 100 MeV proton in water is 0.7289 keV/µm (PSTAR).",
    ]);
  });

  it("renders CSDA range auto-scaled to a physical length when the series carries a density (issue #42 §3)", () => {
    const i = intent({
      quantity: "csdaRange",
      particles: [{ match: "protons" }],
      materials: [{ match: "PMMA" }],
      energies: [{ value: 40, unit: "MeV" }],
    });
    const r = result({
      quantity: "csdaRange",
      series: [
        series({
          density: 1.19,
          points: [{ energyMeVPerNucl: 40, csdaRange: 1.529, stoppingPower: 14.48 }],
        }),
      ],
    });

    expect(renderAnswer(i, r)).toEqual([
      "The CSDA range of 40 MeV protons in PMMA is 1.285 cm (PSTAR).",
    ]);
  });

  it("falls back to native libdedx units (MeV·cm²/g, g/cm²) when no density is available", () => {
    const i = intent({
      quantity: "csdaRange",
      particles: [{ match: "protons" }],
      materials: [{ match: "PMMA" }],
      energies: [{ value: 40, unit: "MeV" }],
    });
    const r = result({
      quantity: "csdaRange",
      // No `density` override — the series() helper's base omits the key
      // entirely, matching a real getDensity() lookup that failed for this
      // material (exactOptionalPropertyTypes forbids an explicit `undefined`).
      series: [series({ points: [{ energyMeVPerNucl: 40, csdaRange: 1.529 }] })],
    });

    expect(renderAnswer(i, r)).toEqual([
      "The CSDA range of 40 MeV protons in PMMA is 1.529 g/cm² (PSTAR).",
    ]);
  });

  it("renders an energyFromRange sentence, echoing the target as given", () => {
    const i = intent({
      quantity: "energyFromRange",
      particles: [{ match: "protons" }],
      materials: [{ match: "water" }],
      energies: [],
      target: { value: 10, unit: "cm" },
    });
    const r = result({
      quantity: "energyFromRange",
      series: [series({ points: [{ energyMeVPerNucl: 100, energy: 100 }] })],
    });

    expect(renderAnswer(i, r)).toEqual([
      "The energy for protons in water to reach a range of 10 cm is 100 MeV/nucl (PSTAR).",
    ]);
  });

  it("renders an energyFromStp sentence", () => {
    const i = intent({
      quantity: "energyFromStp",
      particles: [{ match: "carbon ion" }],
      materials: [{ match: "water" }],
      energies: [],
      target: { value: 7.29, unit: "MeV/cm" },
    });
    const r = result({
      quantity: "energyFromStp",
      series: [
        series({
          program: { id: 16, name: "MSTAR" },
          points: [{ energyMeVPerNucl: 12, energy: 12 }],
        }),
      ],
    });

    expect(renderAnswer(i, r)).toEqual([
      "The energy for carbon ion in water to reach a stopping power of 7.29 MeV/cm is 12 MeV/nucl (MSTAR).",
    ]);
  });

  it("renders an inline error instead of crashing when the series failed", () => {
    const i = intent({
      quantity: "csdaRange",
      particles: [{ match: "protons" }],
      materials: [{ match: "water" }],
      energies: [{ value: 10_000_000, unit: "MeV" }],
    });
    const r = result({
      quantity: "csdaRange",
      series: [
        series({ points: [], error: "Energy 10000000 MeV/nucl is outside the valid range" }),
      ],
    });

    expect(renderAnswer(i, r)).toEqual([
      "Couldn't compute the CSDA range of 10000000 MeV protons in water: Energy 10000000 MeV/nucl is outside the valid range",
    ]);
  });

  it("treats a NaN value as absent instead of printing 'n/a'", () => {
    // compute.ts's forwardSeries fills a missing wrapper value with
    // `Number.NaN` (not `undefined`) when there's no series-level error.
    const i = intent({
      quantity: "csdaRange",
      particles: [{ match: "protons" }],
      materials: [{ match: "water" }],
      energies: [{ value: 40, unit: "MeV" }],
    });
    const r = result({
      quantity: "csdaRange",
      series: [series({ points: [{ energyMeVPerNucl: 40, csdaRange: Number.NaN }] })],
    });

    expect(renderAnswer(i, r)).toEqual(["Couldn't compute an answer for that query."]);
  });

  it("appends a note line when the intent carries assumptions", () => {
    const i = intent({
      quantity: "csdaRange",
      particles: [{ match: "carbon ion", isotopeAssumed: "¹²C" }],
      materials: [{ match: "water" }],
      energies: [{ value: 240, unit: "keV" }],
    });
    const r = result({
      quantity: "csdaRange",
      series: [series({ points: [{ energyMeVPerNucl: 0.02, csdaRange: 0.0001234 }] })],
      assumptions: ["carbon → ¹²C", "240 keV taken as total → 20 keV/nucl"],
    });

    const lines = renderAnswer(i, r);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("Note: carbon → ¹²C; 240 keV taken as total → 20 keV/nucl.");
  });
});

describe("renderAnswer — comparisons", () => {
  it("renders a by-material list, echoing each material's own match text", () => {
    const i = intent({
      quantity: "stoppingPower",
      compareDim: "material",
      particles: [{ match: "neon ions", isotopeAssumed: "²⁰Ne" }],
      materials: [{ match: "water" }, { match: "air" }],
      energies: [{ value: 100, unit: "MeV/nucl", perNucleonAssumed: true }],
    });
    const r = result({
      quantity: "stoppingPower",
      compareDim: "material",
      series: [
        series({
          material: { id: 276, name: "Water, Liquid" },
          program: { id: 16, name: "MSTAR" },
          points: [{ energyMeVPerNucl: 100, stoppingPower: 8.5 }],
        }),
        series({
          material: { id: 104, name: "Air, Dry" },
          program: { id: 16, name: "MSTAR" },
          points: [{ energyMeVPerNucl: 100, stoppingPower: 6.1 }],
        }),
      ],
    });

    expect(renderAnswer(i, r)).toEqual([
      "Stopping power of 100 MeV/nucl neon ions, by material:",
      "- water: 8.5 MeV·cm²/g (MSTAR)",
      "- air: 6.1 MeV·cm²/g (MSTAR)",
    ]);
  });

  it("renders a by-material comparison in keV/µm using each series' own density", () => {
    const i = intent({
      quantity: "stoppingPower",
      compareDim: "material",
      particles: [{ match: "neon ions", isotopeAssumed: "²⁰Ne" }],
      materials: [{ match: "water" }, { match: "air" }],
      energies: [{ value: 100, unit: "MeV/nucl", perNucleonAssumed: true }],
    });
    const r = result({
      quantity: "stoppingPower",
      compareDim: "material",
      series: [
        series({
          density: 1,
          material: { id: 276, name: "Water, Liquid" },
          program: { id: 16, name: "MSTAR" },
          points: [{ energyMeVPerNucl: 100, stoppingPower: 8.5 }],
        }),
        series({
          density: 1.2,
          material: { id: 104, name: "Air, Dry" },
          program: { id: 16, name: "MSTAR" },
          points: [{ energyMeVPerNucl: 100, stoppingPower: 6.1 }],
        }),
      ],
    });

    expect(renderAnswer(i, r)).toEqual([
      "Stopping power of 100 MeV/nucl neon ions, by material:",
      "- water: 0.85 keV/µm (MSTAR)",
      "- air: 0.732 keV/µm (MSTAR)",
    ]);
  });

  it("renders a by-particle list", () => {
    const i = intent({
      quantity: "csdaRange",
      compareDim: "particle",
      particles: [{ match: "protons" }, { match: "carbon ions", isotopeAssumed: "¹²C" }],
      materials: [{ match: "water" }],
      energies: [{ value: 100, unit: "MeV" }],
    });
    const r = result({
      quantity: "csdaRange",
      compareDim: "particle",
      series: [
        series({
          program: { id: 2, name: "PSTAR" },
          points: [{ energyMeVPerNucl: 100, csdaRange: 7.7 }],
        }),
        series({
          program: { id: 16, name: "MSTAR" },
          points: [{ energyMeVPerNucl: 8.33, csdaRange: 0.28 }],
        }),
      ],
    });

    expect(renderAnswer(i, r)).toEqual([
      "CSDA range in water at 100 MeV, by particle:",
      "- protons: 7.7 g/cm² (PSTAR)",
      "- carbon ions: 0.28 g/cm² (MSTAR)",
    ]);
  });

  it("renders a by-program list, labeling each line with the series' resolved program", () => {
    const i = intent({
      quantity: "csdaRange",
      compareDim: "program",
      particles: [{ match: "protons" }],
      materials: [{ match: "water" }],
      energies: [{ value: 100, unit: "MeV" }],
    });
    const r = result({
      quantity: "csdaRange",
      compareDim: "program",
      series: [
        series({
          program: { id: 2, name: "PSTAR" },
          points: [{ energyMeVPerNucl: 100, csdaRange: 7.7 }],
        }),
        series({
          program: { id: 6, name: "ICRU49" },
          points: [{ energyMeVPerNucl: 100, csdaRange: 7.65 }],
        }),
      ],
    });

    expect(renderAnswer(i, r)).toEqual([
      "CSDA range of 100 MeV protons in water, by program:",
      "- PSTAR: 7.7 g/cm² (PSTAR)",
      "- ICRU49: 7.65 g/cm² (ICRU49)",
    ]);
  });

  it("renders a by-energy list from the single multi-point series compute.ts returns", () => {
    const i = intent({
      quantity: "stoppingPower",
      compareDim: "energy",
      particles: [{ match: "protons" }],
      materials: [{ match: "water" }],
      energies: [
        { value: 50, unit: "MeV" },
        { value: 100, unit: "MeV" },
      ],
    });
    const r = result({
      quantity: "stoppingPower",
      compareDim: "energy",
      series: [
        series({
          points: [
            { energyMeVPerNucl: 50, stoppingPower: 12.45 },
            { energyMeVPerNucl: 100, stoppingPower: 7.289 },
          ],
        }),
      ],
    });

    expect(renderAnswer(i, r)).toEqual([
      "Stopping power of protons in water, by energy:",
      "- 50 MeV: 12.45 MeV·cm²/g (PSTAR)",
      "- 100 MeV: 7.289 MeV·cm²/g (PSTAR)",
    ]);
  });

  it("keeps the good legs of a comparison and marks only the failed one", () => {
    const i = intent({
      quantity: "stoppingPower",
      compareDim: "material",
      particles: [{ match: "protons" }],
      materials: [{ match: "water" }, { match: "unobtainium" }],
      energies: [{ value: 100, unit: "MeV" }],
    });
    const r = result({
      quantity: "stoppingPower",
      compareDim: "material",
      series: [
        series({ points: [{ energyMeVPerNucl: 100, stoppingPower: 7.289 }] }),
        series({ points: [], error: "Could not resolve material" }),
      ],
    });

    expect(renderAnswer(i, r)).toEqual([
      "Stopping power of 100 MeV protons, by material:",
      "- water: 7.289 MeV·cm²/g (PSTAR)",
      "- unobtainium: couldn't compute (Could not resolve material)",
    ]);
  });

  it("renders a single error line when the whole energy-compare series failed", () => {
    const i = intent({
      quantity: "csdaRange",
      compareDim: "energy",
      particles: [{ match: "protons" }],
      materials: [{ match: "water" }],
      energies: [
        { value: 50, unit: "MeV" },
        { value: 10_000_000, unit: "MeV" },
      ],
    });
    const r = result({
      quantity: "csdaRange",
      compareDim: "energy",
      series: [
        series({ points: [], error: "Energy 10000000 MeV/nucl is outside the valid range" }),
      ],
    });

    expect(renderAnswer(i, r)).toEqual([
      "CSDA range of protons in water, by energy:",
      "- couldn't compute: Energy 10000000 MeV/nucl is outside the valid range",
    ]);
  });

  it("marks a leg 'couldn't compute' when its value is NaN, even without a series error", () => {
    const i = intent({
      quantity: "stoppingPower",
      compareDim: "material",
      particles: [{ match: "protons" }],
      materials: [{ match: "water" }, { match: "air" }],
      energies: [{ value: 100, unit: "MeV" }],
    });
    const r = result({
      quantity: "stoppingPower",
      compareDim: "material",
      series: [
        series({ points: [{ energyMeVPerNucl: 100, stoppingPower: 7.289 }] }),
        series({ points: [{ energyMeVPerNucl: 100, stoppingPower: Number.NaN }] }),
      ],
    });

    expect(renderAnswer(i, r)).toEqual([
      "Stopping power of 100 MeV protons, by material:",
      "- water: 7.289 MeV·cm²/g (PSTAR)",
      "- air: couldn't compute",
    ]);
  });
});
