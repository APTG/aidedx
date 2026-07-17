import { describe, expect, it } from "vitest";
import { EN_RULES, LEXICON } from "./en.ts";
import { applyPhoneticPass, applyRules, correctTranscript } from "./core.ts";

/** Convenience wrapper for tests that only care about the corrected text. */
function correctText(text: string): string {
  return correctTranscript(text).text;
}

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

describe("LEXICON", () => {
  it("is non-empty and every entry has a known slot and a non-empty canonical form", () => {
    expect(LEXICON.length).toBeGreaterThan(0);
    for (const entry of LEXICON) {
      expect(["unit", "quantity", "program"]).toContain(entry.slot);
      expect(entry.canonical.length).toBeGreaterThan(0);
    }
  });
});

describe("correctTranscript — leaves well-formed text untouched", () => {
  it("is a no-op on a clean, already-correct query", () => {
    const text = "What is the range of 100 MeV protons in water?";
    expect(correctTranscript(text)).toEqual({ text, substitutions: [] });
  });
});

describe("correctTranscript — number/unit mishearings", () => {
  it("fixes glued mm/ml/mv/ma/mb before a particle word to MeV", () => {
    expect(correctText("how far will a 60mm proton go")).toBe("how far will a 60 MeV proton go");
    expect(correctText("150mv alpha in water")).toBe("150 MeV alpha in water");
  });

  it("does not treat a particle word that is only a prefix of a longer word as a match", () => {
    // "ion" is a particle word, but must not fire inside "ionization" — the
    // particle-word group is word-bounded specifically to prevent this.
    expect(correctText("10mm ionization observed")).toBe("10mm ionization observed");
    expect(correctText("5mm ironclad shield")).toBe("5mm ironclad shield");
  });

  it("fixes a bare glued MeV/keV mishearing", () => {
    expect(correctText("100mEV protons in silicon")).toBe("100 MeV protons in silicon");
    expect(correctText("240K EV protons")).toBe("240 keV protons");
  });

  it("expands spelled-out numbers and 'free' as 'three'", () => {
    expect(correctText("two hundred and forty MeV protons in water")).toBe(
      "240 MeV protons in water",
    );
    expect(correctText("free MeV protons in bone")).toBe("3 MeV protons in bone");
  });

  it("fixes atmev and the GeV word-boundary split", () => {
    expect(correctText("atmev protons in water")).toBe("80 MeV protons in water");
    expect(correctText("1G EV protons")).toBe("1 GeV protons");
  });

  it("fixes the hyphenated length target and word-form cm/mm", () => {
    expect(correctText("10-cm range")).toBe("10 cm range");
    expect(correctText("5 centimeters range")).toBe("5 cm range");
    expect(correctText("3 millimeter range")).toBe("3 mm range");
  });
});

describe("correctTranscript — per-nucleon phonetic variants", () => {
  it("normalizes the napelion/nutlion/nukleon family to 'per nucleon'", () => {
    expect(correctText("per napelion energy loss")).toBe("per nucleon energy loss");
    expect(correctText("per nutlion energy loss")).toBe("per nucleon energy loss");
    expect(correctText("pernucleon value")).toBe("per nucleon value");
  });

  it("normalizes 'per u' to '/u' (leaves the preceding space — a known quirk of the ported rule)", () => {
    expect(correctText("290 MeV per u")).toBe("290 MeV /u");
  });

  it("normalizes 'MeV per year/you' to 'MeV/u'", () => {
    expect(correctText("MeV per year")).toBe("MeV/u");
    expect(correctText("MeV per you")).toBe("MeV/u");
  });
});

describe("correctTranscript — particle and material phonetic variants", () => {
  it("normalizes deuteron phonetic variants", () => {
    expect(correctText("dutrons in water")).toBe("deuterons in water");
    expect(correctText("deuterans in bone")).toBe("deuterons in bone");
  });

  it("normalizes 'carbon isle/aisle' to 'carbon ion'", () => {
    expect(correctText("carbon isle in water")).toBe("carbon ion in water");
  });

  it("normalizes material phonetic variants", () => {
    expect(correctText("pmmea target")).toBe("PMMA target");
    expect(correctText("silicone target")).toBe("silicon target");
    expect(correctText("loose site target")).toBe("Lucite target");
  });
});

describe("correctTranscript — quantity/program-name phonetic variants (regex fast path)", () => {
  it("normalizes range/stopping-power/compare phonetic variants", () => {
    expect(correctText("rains of protons")).toBe("range of protons");
    expect(correctText("stop in power of protons")).toBe("stopping power of protons");
    expect(correctText("comparis protons and alphas")).toBe("compare protons and alphas");
  });

  it("normalizes dE/dx spoken-letter and punctuation variants", () => {
    expect(correctText("de slash dx of protons")).toBe("dE/dx of protons");
    expect(correctText("the edx value")).toBe("dE/dx value");
    expect(correctText("de-dx value")).toBe("dE/dx value");
  });

  it("normalizes ASTAR/PSTAR phonetic and spacing variants", () => {
    expect(correctText("astor value")).toBe("ASTAR value");
    expect(correctText("a-star value")).toBe("ASTAR value");
    expect(correctText("p star value")).toBe("PSTAR value");
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

describe("applyPhoneticPass — issue #28", () => {
  it("fixes a unit mishearing not covered by any regex rule (e.g. 'NEV' for MeV)", () => {
    const result = applyPhoneticPass("100 NEV protons in water");
    expect(result.text).toBe("100 MeV protons in water");
    expect(result.substitutions).toEqual([{ heard: "NEV", readAs: "MeV", slot: "unit" }]);
  });

  it("only looks at a unit candidate directly after a number", () => {
    // "NEV" is close to "MeV" by edit distance, but with no preceding number
    // there is no unit slot to fill — must be left alone.
    expect(applyPhoneticPass("the NEV budget report").text).toBe("the NEV budget report");
  });

  it("fixes a quantity keyword typo not covered by any regex rule", () => {
    const result = applyPhoneticPass("What is the stoping power of protons in water?");
    expect(result.text).toBe("What is the stopping power of protons in water?");
    expect(result.substitutions).toEqual([
      { heard: "stoping power", readAs: "stopping power", slot: "quantity" },
    ]);
  });

  it("fixes a program-name mishearing not covered by any regex rule", () => {
    const result = applyPhoneticPass("computed with ectar");
    expect(result.text).toBe("computed with ESTAR");
    expect(result.substitutions).toEqual([{ heard: "ectar", readAs: "ESTAR", slot: "program" }]);
  });

  it("does not alter ordinary short words near a number (false-positive guard)", () => {
    expect(applyPhoneticPass("100 kg of shielding").text).toBe("100 kg of shielding");
  });

  it("does not treat common material/particle words as program-name mishearings", () => {
    expect(applyPhoneticPass("range of protons in air and bone").text).toBe(
      "range of protons in air and bone",
    );
  });

  it("is a no-op on already-correct domain text", () => {
    const text = "What is the CSDA range of 100 MeV protons in water using ASTAR?";
    expect(applyPhoneticPass(text)).toEqual({ text, substitutions: [] });
  });

  it("runs after the regex fast path inside correctTranscript, fixing what the fast path leaves behind", () => {
    const result = correctTranscript("100 NEV protons in water");
    expect(result.text).toBe("100 MeV protons in water");
    expect(result.substitutions).toEqual([{ heard: "NEV", readAs: "MeV", slot: "unit" }]);
  });
});
