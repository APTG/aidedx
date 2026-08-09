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
import {
  atomicMassForConversion,
  computeIntent,
  energyToMeVPerNucl,
  ComputeError,
} from "./compute.ts";
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
    // ICRU49 comes first in the auto-select chain (mirroring dedx_web's own
    // Auto-select, issue #116) and covers this energy, so it wins over PSTAR.
    expect(s.program.name).toBe("ICRU49");
    expect(p.energyMeVPerNucl).toBeCloseTo(40, 5);
    // NIST PSTAR PMMA @ 40 MeV ≈ 1.52 g/cm²; libdedx's ICRU49 table gives ~1.529 too.
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

  it("issue #151: 5 TeV proton in water reports a clean out-of-range error, not a silent MeV answer", () => {
    const result = computeIntent(
      intent({
        quantity: "csdaRange",
        particles: [{ match: "protons" }],
        materials: [{ match: "water" }],
        energies: [{ value: 5, unit: "TeV" }],
      }),
      service,
    );
    const s = req(result.series[0]);
    expect(s.error).toMatch(/outside the valid range/);
    expect(s.points).toHaveLength(0);
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

  it("threads material density through a forward series so render.ts can convert units", () => {
    const result = computeIntent(
      intent({
        quantity: "csdaRange",
        particles: [{ match: "protons" }],
        materials: [{ match: "water" }],
        energies: [{ value: 100, unit: "MeV" }],
      }),
      service,
    );
    const s = req(result.series[0]);
    // NIST liquid water density is 1 g/cm³.
    expect(req(s.density)).toBeCloseTo(1, 2);
  });

  it("formats the out-of-range energy error with scaled units instead of raw floats", () => {
    const result = computeIntent(
      intent({
        quantity: "csdaRange",
        particles: [{ match: "protons" }],
        materials: [{ match: "water" }],
        energies: [{ value: 10_000_000, unit: "MeV" }],
      }),
      service,
    );
    const s = req(result.series[0]);
    expect(s.error).toMatch(/outside the valid range .+ to .+ for this program\/particle/);
    // A = 1 (protons) drop the "/nucl" suffix (issue #66) — plain keV/MeV/GeV.
    expect(s.error).toMatch(/\d (?:ke|Me|Ge)V/);
    expect(s.error).not.toMatch(/\/nucl/);
    expect(s.error).not.toMatch(/\[[\d.]/); // no more raw "[0.00025, 250]" bracket
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

  it("issue #163 B5 latent follow-on: an unresolvable program name throws instead of silently auto-selecting", () => {
    // matcher.ts's own B5/B6 fix means this shape only reaches here from a producer that bypassed
    // that validation (a hand-built intent, a future LLM producer) — it must fail loudly, not
    // silently compute with whichever program auto-select happens to pick and label the answer as
    // if that had been the request all along. Thrown directly out of computeIntent(), the same
    // "can't even start building a series" shape as resolveParticleOrThrow()/
    // resolveMaterialOrThrow() and issue #132's compareDim assert — answer-status.svelte.ts's
    // existing try/catch around computeIntent() already surfaces this as an inline error.
    expect(() =>
      computeIntent(
        intent({
          quantity: "csdaRange",
          particles: [{ match: "protons" }],
          materials: [{ match: "water" }],
          energies: [{ value: 150, unit: "MeV" }],
          program: "SRIM",
        }),
        service,
      ),
    ).toThrow(/"SRIM" is not a program libdedx has data for/);
  });

  it("issue #163 C7: compareDim 'program' honors intent.programs — the exact set named, not a hardcoded triple", () => {
    // Pre-fix: compareProgramsForParticle() ignored which programs were actually named and always
    // returned a hardcoded, particle-keyed triple — "Compare ASTAR and PSTAR..." for a proton
    // silently computed PSTAR/ICRU49/Bethe (ASTAR isn't even in the proton triple) instead of the
    // two programs the user asked to compare.
    const result = computeIntent(
      intent({
        quantity: "csdaRange",
        compareDim: "program",
        particles: [{ match: "protons" }],
        materials: [{ match: "water" }],
        energies: [{ value: 150, unit: "MeV" }],
        programs: ["ASTAR", "Bethe"],
      }),
      service,
    );
    expect(result.series.map((s) => s.program.name)).toEqual(["ASTAR", "Bethe"]);
  });

  it("issue #163 C7: falls back to the legacy particle-keyed triple when intent.programs is absent", () => {
    // Back-compat for a producer that hasn't set intent.programs yet (hand-built eval gold, a
    // test that bypasses the matcher) — the pre-C7 behavior must still work.
    const result = computeIntent(
      intent({
        quantity: "csdaRange",
        compareDim: "program",
        particles: [{ match: "protons" }],
        materials: [{ match: "water" }],
        energies: [{ value: 150, unit: "MeV" }],
      }),
      service,
    );
    expect(result.series.map((s) => s.program.name)).toEqual(["PSTAR", "ICRU49", "Bethe"]);
  });

  it("falls back to Bethe for proton + Boron, where PSTAR has no tabulated data (dedx_web#845)", () => {
    const result = computeIntent(
      intent({
        quantity: "stoppingPower",
        particles: [{ match: "protons" }],
        materials: [{ match: "boron" }],
        energies: [{ value: 40, unit: "MeV" }],
      }),
      service,
    );
    const s = req(result.series[0]);
    expect(s.error).toBeUndefined();
    expect(s.material.id).toBe(5); // elemental Boron
    expect(s.program.name).toBe("Bethe");
    expect(req(req(s.points[0]).stoppingPower)).toBeGreaterThan(0);
  });

  it("falls back to Bethe for calcium and heavier ions, which MSTAR doesn't tabulate at all (docs/tts-eval-1000.md §2.2)", () => {
    const result = computeIntent(
      intent({
        quantity: "csdaRange",
        particles: [{ match: "calcium ions" }],
        materials: [{ match: "water" }],
        energies: [{ value: 100, unit: "MeV/nucl" }],
      }),
      service,
    );
    const s = req(result.series[0]);
    const p = req(s.points[0]);
    expect(s.error).toBeUndefined();
    expect(s.particle.id).toBe(20); // calcium
    expect(s.program.name).toBe("Bethe");
    expect(p.stoppingPower).toBeGreaterThan(0);
    expect(p.csdaRange).toBeGreaterThan(0);
  });

  it("uses ICRU73 for argon at a typical energy, mirroring dedx_web's Auto-select chain (issue #116)", () => {
    const result = computeIntent(
      intent({
        quantity: "stoppingPower",
        particles: [{ match: "argon ions" }],
        materials: [{ match: "water" }],
        energies: [{ value: 100, unit: "MeV/nucl" }],
      }),
      service,
    );
    const s = req(result.series[0]);
    expect(s.error).toBeUndefined();
    expect(s.program.name).toBe("ICRU73");
  });

  it("falls through to MSTAR for argon below ICRU73's energy floor (dedx_web#871/#872)", () => {
    const result = computeIntent(
      intent({
        quantity: "stoppingPower",
        particles: [{ match: "argon ions" }],
        materials: [{ match: "water" }],
        // ICRU 73's floor for argon is 0.025 MeV/nucl; MSTAR's is 0.001.
        energies: [{ value: 0.005, unit: "MeV/nucl" }],
      }),
      service,
    );
    const s = req(result.series[0]);
    expect(s.error).toBeUndefined();
    expect(s.program.name).toBe("MSTAR");
  });
});

describe("computeIntent — issue #132 particle-comparison regression", () => {
  it("computes two genuinely different particles when compareDim is particle", () => {
    const result = computeIntent(
      intent({
        quantity: "csdaRange",
        compareDim: "particle",
        particles: [
          { match: "carbon-12 ion", isotopeAssumed: "¹²C" },
          { match: "neon-20 ion", isotopeAssumed: "²⁰Ne" },
        ],
        materials: [{ match: "water" }],
        energies: [{ value: 200, unit: "MeV/nucl", perNucleonAssumed: true }],
      }),
      service,
    );

    expect(result.series).toHaveLength(2);
    const carbon = req(result.series[0]);
    const neon = req(result.series[1]);
    expect(carbon.particle.id).toBe(6); // carbon
    expect(neon.particle.id).toBe(10); // neon
    const carbonRange = req(req(carbon.points[0]).csdaRange);
    const neonRange = req(req(neon.points[0]).csdaRange);
    expect(Number.isFinite(carbonRange)).toBe(true);
    expect(Number.isFinite(neonRange)).toBe(true);
    // The actual bug (issue #132): before the fix, a mis-detected `compareDim: "energy"`
    // silently produced this same carbon value twice, never resolving neon at all.
    expect(carbonRange).not.toBeCloseTo(neonRange, 1);
  });

  it("throws rather than silently reading particles[0] if compareDim is wrongly not particle", () => {
    // Directly exercises the defensive guard added in src/lib/compute/compute.ts's
    // "none"/"energy" branch — constructing the exact malformed shape issue #132's bug
    // produced (2 particles, but compareDim left at the default) so a future regression in
    // the matcher's compareDim selection fails loudly here instead of silently computing the
    // wrong answer again.
    expect(() =>
      computeIntent(
        intent({
          quantity: "csdaRange",
          compareDim: "none",
          particles: [{ match: "carbon-12 ion" }, { match: "neon-20 ion" }],
          materials: [{ match: "water" }],
          energies: [{ value: 200, unit: "MeV/nucl", perNucleonAssumed: true }],
        }),
        service,
      ),
    ).toThrow(/2 particles present/);
  });

  it("issue #163 B9: the compareDim assert carries a physicist-facing userMessage, not just the raw diagnostic", () => {
    // Pre-fix: the raw "compareDim \"energy\" but 2 materials present — only the first would be
    // computed" string reached the user verbatim (answer-status.svelte.ts's catch block just used
    // error.message). Reproduces the exact issue #163 B9 query shape: 2 materials AND 2 energies,
    // where the matcher picks compareDim: "energy" (higher priority) and materials overflow.
    try {
      computeIntent(
        intent({
          quantity: "csdaRange",
          compareDim: "energy",
          particles: [{ match: "protons" }],
          materials: [{ match: "water" }, { match: "PMMA" }],
          energies: [
            { value: 100, unit: "MeV" },
            { value: 200, unit: "MeV" },
          ],
        }),
        service,
      );
      expect.unreachable("computeIntent should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ComputeError);
      const e = error as ComputeError;
      expect(e.message).toMatch(/compareDim "energy" but 2 materials present/);
      expect(e.userMessage).toBe(
        "This looks like a comparison across both energies and 2 materials, which I can't answer " +
          "in one go. Try asking about a single material, or ask separately for each one.",
      );
    }
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
  it("converts TeV total to MeV/nucl (issue #151)", () => {
    expect(
      energyToMeVPerNucl({ value: 0.000012, unit: "TeV", perNucleonAssumed: false }, 12, 12),
    ).toBeCloseTo(1, 6);
  });
});

describe("atomicMassForConversion — issue #103", () => {
  it("uses libdedx's atomic mass for the default isotope (alpha, He-4)", () => {
    // He's default isotope IS He-4, so service.getAtomicMass(2) is valid here.
    expect(atomicMassForConversion({ id: 2, massNumber: 4 }, service)).toBeCloseTo(4.0, 1);
  });

  it("falls back to the isotope's own mass number for a non-default isotope (deuteron)", () => {
    // Z=1's default isotope is H-1; service.getAtomicMass(1) would wrongly describe H-1's
    // mass here, not the deuteron's — the fallback keeps the conversion factor close to 1
    // instead of off by a wrong-isotope factor (~1.008/2 ≈ 0.5).
    expect(atomicMassForConversion({ id: 1, massNumber: 2 }, service)).toBe(2);
  });

  it("falls back to the isotope's own mass number for helium-3 (helion)", () => {
    // Z=2's default isotope is He-4; service.getAtomicMass(2) would wrongly describe He-4's
    // mass here (~4.0026/3 ≈ 1.33), not He-3's.
    expect(atomicMassForConversion({ id: 2, massNumber: 3 }, service)).toBe(3);
  });

  it("a deuteron's 100 MeV/u lands close to 100 MeV/nucl, not ~50", () => {
    const result = computeIntent(
      intent({
        quantity: "csdaRange",
        particles: [{ match: "deuteron" }],
        materials: [{ match: "water" }],
        energies: [{ value: 100, unit: "MeV/u" }],
      }),
      service,
    );
    const point = req(result.series[0]?.points[0]);
    expect(point.energyMeVPerNucl).toBeGreaterThan(95);
    expect(point.energyMeVPerNucl).toBeLessThan(105);
  });
});
