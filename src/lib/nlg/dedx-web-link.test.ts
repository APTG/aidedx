import { describe, expect, it } from "vitest";
import { buildDedxWebCalculatorUrl } from "./dedx-web-link.ts";
import type { QueryIntent } from "../intent/query-intent.ts";
import type { ComputeResult, ComputeSeries } from "../compute/compute.ts";

function intent(partial: Partial<QueryIntent>): QueryIntent {
  return {
    quantity: "stoppingPower",
    compareDim: "none",
    particles: [{ match: "proton" }],
    materials: [{ match: "water" }],
    energies: [{ value: 100, unit: "MeV" }],
    assumptions: [],
    confidence: 0.97,
    ...partial,
  };
}

function series(partial: Partial<ComputeSeries> = {}): ComputeSeries {
  return {
    label: "water",
    particle: { id: 1, name: "Hydrogen", massNumber: 1, isotope: "" },
    material: { id: 276, name: "Water, Liquid" },
    program: { id: 2, name: "PSTAR" },
    points: [{ energyMeVPerNucl: 100, stoppingPower: 7.29 }],
    ...partial,
  };
}

function result(partial: Partial<ComputeResult> = {}): ComputeResult {
  return {
    quantity: "stoppingPower",
    compareDim: "none",
    series: [series()],
    assumptions: [],
    libdedxVersion: "1.4.0",
    ...partial,
  };
}

const BASE = "https://aptg.github.io/web_dev/calculator";

function paramsOf(url: string | null): URLSearchParams {
  if (url === null) throw new Error("expected buildDedxWebCalculatorUrl() to return a URL");
  return new URL(url).searchParams;
}

describe("buildDedxWebCalculatorUrl", () => {
  it("builds a Basic-mode forward URL for a single MeV energy, no explicit program", () => {
    const url = buildDedxWebCalculatorUrl(intent({}), result());
    expect(url).toBe(`${BASE}?urlv=3&particle=1&material=276&mode=basic&energies=100&uanchor=MeV`);
  });

  it("emits a per-row :unit suffix for a keV energy, anchored on MeV", () => {
    const i = intent({ energies: [{ value: 240, unit: "keV" }] });
    const url = buildDedxWebCalculatorUrl(i, result());
    const params = paramsOf(url);
    expect(params.get("energies")).toBe("240:keV");
    expect(params.get("uanchor")).toBe("MeV");
  });

  it("emits a per-row :unit suffix for a GeV energy, anchored on MeV", () => {
    const i = intent({ energies: [{ value: 1, unit: "GeV" }] });
    const url = buildDedxWebCalculatorUrl(i, result());
    const params = paramsOf(url);
    expect(params.get("energies")).toBe("1:GeV");
    expect(params.get("uanchor")).toBe("MeV");
  });

  it("anchors on MeV/nucl with no per-row suffix when the energy is already per-nucleon", () => {
    const i = intent({ energies: [{ value: 100, unit: "MeV/nucl", perNucleonAssumed: true }] });
    const url = buildDedxWebCalculatorUrl(i, result());
    const params = paramsOf(url);
    expect(params.get("energies")).toBe("100");
    expect(params.get("uanchor")).toBe("MeV/nucl");
  });

  it("anchors on MeV/u with no per-row suffix", () => {
    const i = intent({ energies: [{ value: 50, unit: "MeV/u" }] });
    const url = buildDedxWebCalculatorUrl(i, result());
    const params = paramsOf(url);
    expect(params.get("uanchor")).toBe("MeV/u");
  });

  it("joins multiple energy rows (compareDim: energy) with ~", () => {
    const i = intent({
      compareDim: "energy",
      energies: [
        { value: 100, unit: "MeV" },
        { value: 200, unit: "MeV" },
      ],
    });
    const url = buildDedxWebCalculatorUrl(i, result());
    const params = paramsOf(url);
    expect(params.get("energies")).toBe("100~200");
  });

  it("returns null for a forward query with no energies, rather than emitting a blank energies=", () => {
    const i = intent({ energies: [] });
    expect(buildDedxWebCalculatorUrl(i, result())).toBeNull();
  });

  it("returns null when energies mix anchor families that can't share one uanchor=", () => {
    // MeV/nucl has no per-row-suffix escape hatch against a MeV anchor (only
    // keV/GeV do) — emitting this would silently misrepresent the second row.
    const i = intent({
      compareDim: "energy",
      energies: [
        { value: 100, unit: "MeV" },
        { value: 50, unit: "MeV/nucl" },
      ],
    });
    expect(buildDedxWebCalculatorUrl(i, result())).toBeNull();
  });

  it("builds an inverse energyFromRange URL with a supported length unit", () => {
    const i = intent({
      quantity: "energyFromRange",
      energies: [],
      target: { value: 10, unit: "cm" },
    });
    const url = buildDedxWebCalculatorUrl(i, result({ quantity: "energyFromRange" }));
    const params = paramsOf(url);
    expect(params.get("imode")).toBe("csda");
    expect(params.get("lookups")).toBe("10:cm");
    expect(params.get("iunit")).toBe("cm");
    expect(params.get("energies")).toBeNull();
    expect(params.get("uanchor")).toBeNull();
  });

  it("returns null for an energyFromRange target in g/cm2 (no dedx_web equivalent)", () => {
    const i = intent({
      quantity: "energyFromRange",
      energies: [],
      target: { value: 5, unit: "g/cm2" },
    });
    expect(buildDedxWebCalculatorUrl(i, result({ quantity: "energyFromRange" }))).toBeNull();
  });

  it.each([
    ["keV/um", "kev-um"],
    ["MeV/cm", "mev-cm"],
    ["MeV cm2/g", "mev-cm2-g"],
  ])("maps energyFromStp target unit %s to dedx_web token %s", (aidedxUnit, dedxWebToken) => {
    const i = intent({
      quantity: "energyFromStp",
      energies: [],
      target: { value: 15, unit: aidedxUnit },
    });
    const url = buildDedxWebCalculatorUrl(i, result({ quantity: "energyFromStp" }));
    const params = paramsOf(url);
    expect(params.get("imode")).toBe("stp");
    expect(params.get("lookups")).toBe(`15:${dedxWebToken}`);
    expect(params.get("iunit")).toBe(dedxWebToken);
  });

  it("returns null when an inverse query has no target", () => {
    const i = intent({ quantity: "energyFromRange", energies: [] });
    expect(buildDedxWebCalculatorUrl(i, result({ quantity: "energyFromRange" }))).toBeNull();
  });

  it.each(["material", "particle", "program"] as const)(
    "returns null for a compareDim: %s comparison, regardless of quantity",
    (compareDim) => {
      const i = intent({ compareDim });
      expect(buildDedxWebCalculatorUrl(i, result({ compareDim }))).toBeNull();
    },
  );

  it("returns null when the first series errored", () => {
    const r = result({ series: [series({ error: "energy out of range" })] });
    expect(buildDedxWebCalculatorUrl(intent({}), r)).toBeNull();
  });

  it("returns null when there is no series at all", () => {
    const r = result({ series: [] });
    expect(buildDedxWebCalculatorUrl(intent({}), r)).toBeNull();
  });

  it("omits program= and uses Basic mode when the program was auto-selected (issue #116)", () => {
    // Auto-selected — no intent.program — so aidedx trusts dedx_web's own
    // Auto-select (now mirroring autoProgramForParticle() exactly, dedx_web
    // #871/#872) to independently land on the same program. No program= is
    // emitted at all: Basic mode ignores it anyway (dedx_web#816), and
    // emitting a stale/misleading one would be worse than omitting it.
    const i = intent({});
    const r = result({ series: [series({ program: { id: 4, name: "MSTAR" } })] });
    const url = buildDedxWebCalculatorUrl(i, r);
    const params = paramsOf(url);
    expect(params.get("mode")).toBe("basic");
    expect(params.get("program")).toBeNull();
  });

  it("emits mode=advanced&program=<id> when the user named an explicit program", () => {
    // Basic mode has no program selector at all — an explicit program choice
    // (e.g. "using Bethe") has no Basic-mode equivalent, so this always needs
    // Advanced mode to stick, regardless of what Auto-select would pick.
    const i = intent({ program: "bethe" });
    const r = result({ series: [series({ program: { id: 100, name: "Bethe" } })] });
    const url = buildDedxWebCalculatorUrl(i, r);
    const params = paramsOf(url);
    expect(params.get("mode")).toBe("advanced");
    expect(params.get("program")).toBe("100");
  });
});
