// @vitest-environment node
/**
 * Smoke compute tests — drive the *real* vendored libdedx WASM end to end and
 * assert that `computeIntent()` returns libdedx numbers (never the LLM) for the
 * cases called out in issue #6 and issue #1 §7.
 *
 * These load the actual `static/wasm/libdedx.mjs` from disk in a Node
 * environment (Emscripten built with ENVIRONMENT='web,node'), so they verify
 * the whole chain: alias resolution → energy conversion → program selection →
 * WASM call. If the WASM is missing/incompatible the suite fails loudly rather
 * than silently skipping.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { LibdedxServiceImpl } from "../wasm/libdedx.ts";
import type { LibdedxModuleFactory, LibdedxService } from "../wasm/types.ts";
import { computeIntent, energyToMeVPerNucl } from "./compute.ts";
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

/** Assert a value is present and return it narrowed (avoids `!` assertions). */
function req<T>(v: T | undefined | null, msg = "expected a value"): T {
  if (v === undefined || v === null) throw new Error(msg);
  return v;
}

/** Minimal intent builder with the schema's required fields filled in. */
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

describe("libdedx WASM module", () => {
  it("loads and reports programs + a sane water reference", () => {
    expect(service.getPrograms().length).toBeGreaterThan(0);
    // PSTAR (2) H₂O (276) at 100 MeV/nucl ≈ 7.29 MeV·cm²/g (contract §10.7).
    const r = service.calculate(2, 1, 276, [100]);
    expect(r.stoppingPowers[0]).toBeCloseTo(7.29, 1);
  });
});

describe("computeIntent — issue #6 smoke cases", () => {
  it("range of 40 MeV protons in PMMA → libdedx CSDA range", () => {
    const result = computeIntent(
      intent({
        quantity: "csdaRange",
        particles: [{ match: "protons" }],
        materials: [{ match: "PMMA" }],
        energies: [{ value: 40, unit: "MeV" }],
      }),
      service,
    );

    expect(result.series).toHaveLength(1);
    const s = req(result.series[0]);
    const p = req(s.points[0]);
    expect(s.error).toBeUndefined();
    expect(s.particle.id).toBe(1); // hydrogen / proton
    expect(s.material.id).toBe(223); // PMMA
    expect(s.program.name).toBe("PSTAR");
    expect(p.energyMeVPerNucl).toBeCloseTo(40, 5);
    // NIST PSTAR PMMA @ 40 MeV ≈ 1.52 g/cm²; libdedx gives ~1.529.
    expect(p.csdaRange).toBeCloseTo(1.529, 2);
    expect(p.stoppingPower).toBeCloseTo(14.48, 1);
    expect(result.libdedxVersion).toBeTypeOf("string");
  });

  it("§7.1: 240 keV (total) carbon ion in water → 20 keV/nucl, libdedx number", () => {
    const result = computeIntent(
      intent({
        quantity: "csdaRange",
        particles: [{ match: "carbon ion", isotopeAssumed: "¹²C" }],
        materials: [{ match: "water" }],
        energies: [{ value: 240, unit: "keV", perNucleonAssumed: false }],
        assumptions: ["carbon → ¹²C", "240 keV taken as total → 20 keV/nucl"],
      }),
      service,
    );

    const s = req(result.series[0]);
    const p = req(s.points[0]);
    expect(s.error).toBeUndefined();
    expect(s.particle.id).toBe(6); // carbon
    expect(s.particle.massNumber).toBe(12); // ¹²C assumed
    expect(s.material.id).toBe(276); // water
    expect(s.program.name).toBe("MSTAR");
    // 240 keV total / A=12 = 0.02 MeV/nucl.
    expect(p.energyMeVPerNucl).toBeCloseTo(0.02, 6);
    expect(req(p.csdaRange)).toBeGreaterThan(0);
    expect(Number.isFinite(req(p.csdaRange))).toBe(true);
  });

  it("§7.2: compare stopping power of neon ions in water and air at 100 MeV/nucl", () => {
    const result = computeIntent(
      intent({
        quantity: "stoppingPower",
        compareDim: "material",
        particles: [{ match: "neon ions", isotopeAssumed: "²⁰Ne" }],
        materials: [{ match: "water" }, { match: "air" }],
        energies: [{ value: 100, unit: "MeV/nucl", perNucleonAssumed: true }],
        assumptions: ["neon → ²⁰Ne"],
      }),
      service,
    );

    expect(result.compareDim).toBe("material");
    expect(result.series).toHaveLength(2);
    const water = req(result.series[0]);
    const air = req(result.series[1]);
    const waterStp = req(req(water.points[0]).stoppingPower);
    const airStp = req(req(air.points[0]).stoppingPower);
    expect(water.material.id).toBe(276);
    expect(air.material.id).toBe(104);
    expect(req(water.points[0]).energyMeVPerNucl).toBeCloseTo(100, 5);
    // Distinct, positive, finite libdedx stopping powers per material.
    expect(waterStp).toBeGreaterThan(0);
    expect(airStp).toBeGreaterThan(0);
    expect(waterStp).not.toBeCloseTo(airStp, 1);
  });

  it("inverse: energy that gives a known proton range round-trips", () => {
    const forward = computeIntent(
      intent({
        quantity: "csdaRange",
        particles: [{ match: "protons" }],
        materials: [{ match: "water" }],
        energies: [{ value: 100, unit: "MeV" }],
      }),
      service,
    );
    const rangeGcm2 = req(req(forward.series[0]).points[0]).csdaRange;
    expect(req(rangeGcm2)).toBeGreaterThan(0);

    const inverse = computeIntent(
      intent({
        quantity: "energyFromRange",
        particles: [{ match: "protons" }],
        materials: [{ match: "water" }],
        energies: [],
        target: { value: req(rangeGcm2), unit: "g/cm2" },
      }),
      service,
    );
    const s = req(inverse.series[0]);
    expect(s.error).toBeUndefined();
    expect(req(req(s.points[0]).energy)).toBeCloseTo(100, 0);
  });

  it("stoppingPower queries skip the CSDA integrator (no csdaRange)", () => {
    const result = computeIntent(
      intent({
        quantity: "stoppingPower",
        particles: [{ match: "protons" }],
        materials: [{ match: "water" }],
        energies: [{ value: 100, unit: "MeV" }],
      }),
      service,
    );
    const point = req(req(result.series[0]).points[0]);
    expect(point.stoppingPower).toBeGreaterThan(0);
    expect(point.csdaRange).toBeUndefined();
  });

  it("reports a per-series error for out-of-range energy instead of throwing", () => {
    const result = computeIntent(
      intent({
        quantity: "csdaRange",
        particles: [{ match: "protons" }],
        materials: [{ match: "water" }],
        // PSTAR tops out at 10 GeV/nucl; 10 TeV is far past it.
        energies: [{ value: 10_000_000, unit: "MeV" }],
      }),
      service,
    );
    const s = req(result.series[0]);
    expect(s.error).toMatch(/outside the valid range/);
    expect(s.points).toHaveLength(0);
  });

  it("honors an explicit program name regardless of separators/case", () => {
    const result = computeIntent(
      intent({
        quantity: "csdaRange",
        particles: [{ match: "protons" }],
        materials: [{ match: "water" }],
        energies: [{ value: 150, unit: "MeV" }],
        program: "bethe ext",
      }),
      service,
    );
    // "bethe ext" / "bethe_ext" / "BETHE-EXT" all fold to Bethe-ext, not the
    // auto-selected PSTAR.
    expect(req(result.series[0]).program.name).toBe("Bethe-ext");
  });
});

describe("energyToMeVPerNucl", () => {
  it("passes MeV/nucl through unchanged", () => {
    expect(energyToMeVPerNucl({ value: 100, unit: "MeV/nucl" }, 20, 19.99)).toBe(100);
  });
  it("divides total MeV by mass number", () => {
    expect(
      energyToMeVPerNucl({ value: 1200, unit: "MeV", perNucleonAssumed: false }, 12, 12),
    ).toBeCloseTo(100, 6);
  });
  it("treats absolute energy on a proton (A=1) as per-nucleon", () => {
    expect(energyToMeVPerNucl({ value: 40, unit: "MeV" }, 1, 1.0079)).toBe(40);
  });
  it("converts keV total to MeV/nucl", () => {
    expect(
      energyToMeVPerNucl({ value: 240, unit: "keV", perNucleonAssumed: false }, 12, 12),
    ).toBeCloseTo(0.02, 6);
  });
});
