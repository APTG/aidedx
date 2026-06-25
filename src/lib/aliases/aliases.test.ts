import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ELEMENTS } from "./elements.ts";
import { MATERIALS, MATERIAL_ALIAS_INDEX, MATERIAL_BY_ID } from "./materials.ts";
import { PARTICLES, PARTICLE_ALIAS_INDEX, ELECTRON_ID } from "./particles.ts";
import { normalizeText, formatIsotope, boundedLevenshtein } from "./normalize.ts";
import { resolveMaterial, resolveParticle } from "./lookup.ts";
import { parseEvalRecords } from "../intent/query-intent.ts";
import {
  buildMaterialArtifact,
  buildParticleArtifact,
  serialize,
} from "../../../scripts/generate-aliases.ts";

describe("normalizeText", () => {
  it("lower-cases and trims", () => {
    expect(normalizeText("  WATER ")).toBe("water");
  });

  it("collapses punctuation, hyphens, and underscores to single spaces", () => {
    expect(normalizeText("Bone, Cortical (ICRP)")).toBe("bone cortical icrp");
    expect(normalizeText("carbon-13")).toBe("carbon 13");
    expect(normalizeText("TISSUE_EQUIVALENT_GAS")).toBe("tissue equivalent gas");
  });

  it("folds super/subscript digits to ASCII and keeps Greek letters", () => {
    expect(normalizeText("¹²C")).toBe("12c");
    expect(normalizeText("²⁰Ne")).toBe("20ne");
    expect(normalizeText("α")).toBe("α");
  });

  it("strips diacritics", () => {
    expect(normalizeText("Café")).toBe("cafe");
  });
});

describe("formatIsotope", () => {
  it("renders mass numbers as superscripts", () => {
    expect(formatIsotope(12, "C")).toBe("¹²C");
    expect(formatIsotope(4, "He")).toBe("⁴He");
    expect(formatIsotope(40, "Ar")).toBe("⁴⁰Ar");
  });
});

describe("boundedLevenshtein", () => {
  it("returns exact distances within the cap", () => {
    expect(boundedLevenshtein("water", "water", 2)).toBe(0);
    expect(boundedLevenshtein("watr", "water", 2)).toBe(1);
    expect(boundedLevenshtein("kitten", "sitting", 3)).toBe(3);
  });

  it("short-circuits past the cap", () => {
    expect(boundedLevenshtein("abc", "xyzxyz", 1)).toBe(2);
  });
});

describe("canonical catalogues", () => {
  it("covers every libdedx particle id (Z=1..118 + electron)", () => {
    expect(PARTICLES).toHaveLength(119);
    for (let z = 1; z <= 118; z++) {
      expect(PARTICLES.some((p) => p.id === z)).toBe(true);
    }
    expect(PARTICLES.some((p) => p.id === ELECTRON_ID)).toBe(true);
  });

  it("covers elemental targets and the curated compound list", () => {
    // 98 elements + the 149 compounds copied from dedx_web.
    expect(MATERIALS.filter((m) => m.kind === "element")).toHaveLength(98);
    expect(MATERIAL_BY_ID.get(276)?.name).toBe("Water (liquid)");
    expect(MATERIAL_BY_ID.get(223)?.name).toBe("PMMA (Plexiglass)");
    expect(MATERIAL_BY_ID.get(906)?.name).toBe("Graphite");
  });

  it("every alias resolves to a real canonical entry", () => {
    for (const id of MATERIAL_ALIAS_INDEX.values()) {
      expect(MATERIAL_BY_ID.has(id)).toBe(true);
    }
    const particleIds = new Set(PARTICLES.map((p) => p.id));
    for (const entry of PARTICLE_ALIAS_INDEX.values()) {
      expect(particleIds.has(entry.id)).toBe(true);
    }
  });

  it("alias keys are already normalized (idempotent)", () => {
    for (const key of MATERIAL_ALIAS_INDEX.keys()) expect(normalizeText(key)).toBe(key);
    for (const key of PARTICLE_ALIAS_INDEX.keys()) expect(normalizeText(key)).toBe(key);
  });
});

describe("resolveMaterial", () => {
  it("maps the PMMA trade-name family to ICRU PMMA (223)", () => {
    for (const name of ["PMMA", "Lucite", "Perspex", "Plexiglas", "Plexiglass", "acrylic"]) {
      expect(resolveMaterial(name)?.id).toBe(223);
    }
  });

  it("maps water and air", () => {
    expect(resolveMaterial("water")?.id).toBe(276);
    expect(resolveMaterial("liquid water")?.id).toBe(276);
    expect(resolveMaterial("water vapor")?.id).toBe(277);
    expect(resolveMaterial("air")?.id).toBe(104);
  });

  it("maps elements by name, symbol, and spelling variant", () => {
    expect(resolveMaterial("gold")?.id).toBe(79);
    expect(resolveMaterial("Au")?.id).toBe(79);
    expect(resolveMaterial("aluminum")?.id).toBe(13);
    expect(resolveMaterial("aluminium")?.id).toBe(13);
    expect(resolveMaterial("graphite")?.id).toBe(906);
  });

  it("strips decorative suffixes (target/absorber)", () => {
    expect(resolveMaterial("water target")?.id).toBe(276);
    expect(resolveMaterial("aluminium absorber")?.id).toBe(13);
  });

  it("tolerates typos via the fuzzy fallback", () => {
    const m = resolveMaterial("watr");
    expect(m?.id).toBe(276);
    expect(m?.matchKind).toBe("fuzzy");
  });

  it("never silently resolves the ambiguous word 'glass' to a wrong variant", () => {
    // Three 'Glass (...)' compounds collide, so the auto base is dropped and a
    // deliberate default (Pyrex) is the only resolution.
    expect(resolveMaterial("glass")?.id).toBe(169);
  });

  it("returns null for unknown phrases", () => {
    expect(resolveMaterial("unobtainium")).toBeNull();
    expect(resolveMaterial("")).toBeNull();
  });
});

describe("resolveParticle", () => {
  it("maps proton/alpha/electron names without assuming an isotope", () => {
    const proton = resolveParticle("protons");
    expect(proton).toMatchObject({ id: 1, massNumber: 1, isotopeAssumed: false });
    const alpha = resolveParticle("alpha particle");
    expect(alpha).toMatchObject({ id: 2, massNumber: 4, isotope: "⁴He", isotopeAssumed: false });
    const e = resolveParticle("electron");
    expect(e).toMatchObject({ id: ELECTRON_ID, isotope: "", isotopeAssumed: false });
  });

  it("assumes the most-abundant isotope for a bare element name", () => {
    expect(resolveParticle("carbon ions")).toMatchObject({
      id: 6,
      massNumber: 12,
      isotope: "¹²C",
      isotopeAssumed: true,
    });
    expect(resolveParticle("neon ion")).toMatchObject({
      id: 10,
      isotope: "²⁰Ne",
      isotopeAssumed: true,
    });
    expect(resolveParticle("helium")).toMatchObject({
      id: 2,
      isotope: "⁴He",
      isotopeAssumed: true,
    });
  });

  it("parses explicit isotopes without an assumption", () => {
    expect(resolveParticle("carbon-13 ions")).toMatchObject({
      id: 6,
      massNumber: 13,
      isotope: "¹³C",
      isotopeAssumed: false,
      matchKind: "isotope",
    });
    expect(resolveParticle("helium-3 ion")).toMatchObject({ id: 2, massNumber: 3, isotope: "³He" });
    expect(resolveParticle("13C")).toMatchObject({ id: 6, massNumber: 13 });
    expect(resolveParticle("C-13")).toMatchObject({ id: 6, massNumber: 13 });
  });

  it("maps deuteron and triton to the correct hydrogen isotope", () => {
    expect(resolveParticle("deuterons")).toMatchObject({
      id: 1,
      massNumber: 2,
      isotopeAssumed: false,
    });
    expect(resolveParticle("triton")).toMatchObject({
      id: 1,
      massNumber: 3,
      isotopeAssumed: false,
    });
  });

  it("disambiguates the proton/phosphorus symbol clash by case", () => {
    // Lower-case "p" is the proton; upper-case "P" is the phosphorus symbol.
    expect(resolveParticle("p")).toMatchObject({ id: 1, isotopeAssumed: false });
    expect(resolveParticle("protons")).toMatchObject({ id: 1 });
    expect(resolveParticle("P")).toMatchObject({ id: 15, isotopeAssumed: true });
    expect(resolveParticle("P ions")).toMatchObject({ id: 15 });
  });

  it("tolerates typos via the fuzzy fallback", () => {
    const p = resolveParticle("protn");
    expect(p?.id).toBe(1);
    expect(p?.matchKind).toBe("fuzzy");
  });

  it("returns null for unknown phrases", () => {
    expect(resolveParticle("phlogiston")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Coverage gate: every material/particle phrase used in the eval set must
// resolve. This is the issue's "Done when" criterion.
// ---------------------------------------------------------------------------
describe("eval-set coverage", () => {
  const jsonl = readFileSync(resolve(process.cwd(), "eval/intents.jsonl"), "utf-8");
  const records = parseEvalRecords(jsonl);

  const materialPhrases = [
    ...new Set(records.flatMap((r) => r.expected.materials.map((m) => m.match))),
  ];
  const particlePhrases = [
    ...new Set(records.flatMap((r) => r.expected.particles.map((p) => p.match))),
  ];

  it.each(materialPhrases)("resolves eval material %q", (phrase) => {
    expect(resolveMaterial(phrase)).not.toBeNull();
  });

  it.each(particlePhrases)("resolves eval particle %q", (phrase) => {
    expect(resolveParticle(phrase)).not.toBeNull();
  });

  it("reproduces the eval set's assumed-isotope labels for named ions", () => {
    // Where the eval records an "<element> → <isotope>" assumption, our default
    // isotope must match the labelled value.
    // Match only "<element> → <isotope>" notes; the isotope side starts with
    // superscript digits (e.g. "carbon → ¹²C"), which excludes energy notes
    // like "3.6 GeV taken as total → 300 MeV/nucl".
    const re = /^([a-z]+) → ([⁰¹²³⁴⁵⁶⁷⁸⁹]+[A-Za-z]+)$/;
    const elementToIsotope = new Map<string, string>();
    for (const r of records) {
      for (const a of r.expected.assumptions) {
        const m = re.exec(a);
        if (m && m[1] && m[2]) elementToIsotope.set(m[1].toLowerCase(), m[2]);
      }
    }
    expect(elementToIsotope.size).toBeGreaterThan(0);
    for (const [element, isotope] of elementToIsotope) {
      const resolved = resolveParticle(`${element} ion`);
      expect(resolved, `${element} ion`).not.toBeNull();
      expect(resolved?.isotope, `${element} → ${isotope}`).toBe(isotope);
    }
  });
});

// ---------------------------------------------------------------------------
// The committed JSON artifacts must match what the generator would produce.
// ---------------------------------------------------------------------------
describe("JSON artifacts are up to date", () => {
  it("static/aliases/materials.json matches the TS tables", () => {
    const committed = readFileSync(
      resolve(process.cwd(), "static/aliases/materials.json"),
      "utf-8",
    );
    expect(committed).toBe(serialize(buildMaterialArtifact()));
  });

  it("static/aliases/particles.json matches the TS tables", () => {
    const committed = readFileSync(
      resolve(process.cwd(), "static/aliases/particles.json"),
      "utf-8",
    );
    expect(committed).toBe(serialize(buildParticleArtifact()));
  });
});

describe("element seed sanity", () => {
  it("has 118 elements with unique Z and the documented defaults", () => {
    expect(ELEMENTS).toHaveLength(118);
    expect(new Set(ELEMENTS.map((e) => e.z)).size).toBe(118);
    expect(ELEMENTS.find((e) => e.z === 6)?.defaultMassNumber).toBe(12);
    expect(ELEMENTS.find((e) => e.z === 18)?.defaultMassNumber).toBe(40);
  });
});
