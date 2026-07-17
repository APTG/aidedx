import { describe, expect, it } from "vitest";
import { EN_RULES } from "./en.ts";
import { applyRules, correctTranscript } from "./core.ts";

describe("EN_RULES", () => {
  it("is non-empty and every rule has a label, a RegExp pattern, and a string replacement", () => {
    expect(EN_RULES.length).toBeGreaterThan(0);
    for (const rule of EN_RULES) {
      expect(typeof rule.label).toBe("string");
      expect(rule.label.length).toBeGreaterThan(0);
      expect(rule.pattern).toBeInstanceOf(RegExp);
      expect(typeof rule.replacement).toBe("string");
    }
  });
});

describe("correctTranscript — leaves well-formed text untouched", () => {
  it("is a no-op on a clean, already-correct query", () => {
    const text = "What is the range of 100 MeV protons in water?";
    expect(correctTranscript(text)).toBe(text);
  });
});

describe("correctTranscript — number/unit mishearings", () => {
  it("fixes glued mm/ml/mv/ma/mb before a particle word to MeV", () => {
    expect(correctTranscript("how far will a 60mm proton go")).toBe(
      "how far will a 60 MeV proton go",
    );
    expect(correctTranscript("150mv alpha in water")).toBe("150 MeV alpha in water");
  });

  it("does not treat a particle word that is only a prefix of a longer word as a match", () => {
    // "ion" is a particle word, but must not fire inside "ionization" — the
    // particle-word group is word-bounded specifically to prevent this.
    expect(correctTranscript("10mm ionization observed")).toBe("10mm ionization observed");
    expect(correctTranscript("5mm ironclad shield")).toBe("5mm ironclad shield");
  });

  it("fixes a bare glued MeV/keV mishearing", () => {
    expect(correctTranscript("100mEV protons in silicon")).toBe("100 MeV protons in silicon");
    expect(correctTranscript("240K EV protons")).toBe("240 keV protons");
  });

  it("expands spelled-out numbers and 'free' as 'three'", () => {
    expect(correctTranscript("two hundred and forty MeV protons in water")).toBe(
      "240 MeV protons in water",
    );
    expect(correctTranscript("free MeV protons in bone")).toBe("3 MeV protons in bone");
  });

  it("fixes atmev and the GeV word-boundary split", () => {
    expect(correctTranscript("atmev protons in water")).toBe("80 MeV protons in water");
    expect(correctTranscript("1G EV protons")).toBe("1 GeV protons");
  });

  it("fixes the hyphenated length target and word-form cm/mm", () => {
    expect(correctTranscript("10-cm range")).toBe("10 cm range");
    expect(correctTranscript("5 centimeters range")).toBe("5 cm range");
    expect(correctTranscript("3 millimeter range")).toBe("3 mm range");
  });
});

describe("correctTranscript — per-nucleon phonetic variants", () => {
  it("normalizes the napelion/nutlion/nukleon family to 'per nucleon'", () => {
    expect(correctTranscript("per napelion energy loss")).toBe("per nucleon energy loss");
    expect(correctTranscript("per nutlion energy loss")).toBe("per nucleon energy loss");
    expect(correctTranscript("pernucleon value")).toBe("per nucleon value");
  });

  it("normalizes 'per u' to '/u' (leaves the preceding space — a known quirk of the ported rule)", () => {
    expect(correctTranscript("290 MeV per u")).toBe("290 MeV /u");
  });

  it("normalizes 'MeV per year/you' to 'MeV/u'", () => {
    expect(correctTranscript("MeV per year")).toBe("MeV/u");
    expect(correctTranscript("MeV per you")).toBe("MeV/u");
  });
});

describe("correctTranscript — particle and material phonetic variants", () => {
  it("normalizes deuteron phonetic variants", () => {
    expect(correctTranscript("dutrons in water")).toBe("deuterons in water");
    expect(correctTranscript("deuterans in bone")).toBe("deuterons in bone");
  });

  it("normalizes 'carbon isle/aisle' to 'carbon ion'", () => {
    expect(correctTranscript("carbon isle in water")).toBe("carbon ion in water");
  });

  it("normalizes material phonetic variants", () => {
    expect(correctTranscript("pmmea target")).toBe("PMMA target");
    expect(correctTranscript("silicone target")).toBe("silicon target");
    expect(correctTranscript("loose site target")).toBe("Lucite target");
  });
});

describe("correctTranscript — quantity/program-name phonetic variants", () => {
  it("normalizes range/stopping-power/compare phonetic variants", () => {
    expect(correctTranscript("rains of protons")).toBe("range of protons");
    expect(correctTranscript("stop in power of protons")).toBe("stopping power of protons");
    expect(correctTranscript("comparis protons and alphas")).toBe("compare protons and alphas");
  });

  it("normalizes dE/dx spoken-letter and punctuation variants", () => {
    expect(correctTranscript("de slash dx of protons")).toBe("dE/dx of protons");
    expect(correctTranscript("the edx value")).toBe("dE/dx value");
    expect(correctTranscript("de-dx value")).toBe("dE/dx value");
  });

  it("normalizes ASTAR/PSTAR phonetic and spacing variants", () => {
    expect(correctTranscript("astor value")).toBe("ASTAR value");
    expect(correctTranscript("a-star value")).toBe("ASTAR value");
    expect(correctTranscript("p star value")).toBe("PSTAR value");
  });
});

describe("applyRules", () => {
  it("applies rules in order, each seeing the previous rule's output", () => {
    const rules = [
      { label: "a-to-b", pattern: /a/g, replacement: "b" },
      { label: "b-to-c", pattern: /b/g, replacement: "c" },
    ];
    expect(applyRules("a", rules)).toBe("c");
  });

  it("returns the input unchanged when given no rules", () => {
    expect(applyRules("hello", [])).toBe("hello");
  });
});
