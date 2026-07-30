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

  it("fixes a bare glued TeV mishearing without falling into the MeV fuzzy pass (issue #151)", () => {
    // Before this rule existed, applyPhoneticPass's edit-distance lookup found "TeV" is
    // distance-1 from "MeV" in LEXICON and silently rewrote it — a silent 10^6 unit error with
    // no error surfaced. This explicit rule must claim "TeV" before the fuzzy pass ever runs.
    expect(correctText("5 TeV protons in water")).toBe("5 TeV protons in water");
    expect(correctText("5 T EV protons in water")).toBe("5 TeV protons in water");
  });

  it("fixes the hyphenated length target and word-form cm/mm", () => {
    expect(correctText("10-cm range")).toBe("10 cm range");
    expect(correctText("5 centimeters range")).toBe("5 cm range");
    expect(correctText("3 millimeter range")).toBe("3 mm range");
  });
});

describe("correctTranscript — letter-spelled energy units (issue #118)", () => {
  it("fixes the hyphenated letter-spelling confirmed in real transcripts (docs/unit-pronunciation-asr.md §1, rng-0573)", () => {
    expect(correctText("100 M-E-V per nucleon")).toBe("100 MeV per nucleon");
  });

  it("fixes hyphenated keV/GeV letter-spellings", () => {
    expect(correctText("500 K-E-V protons in silicon")).toBe("500 keV protons in silicon");
    expect(correctText("3 G-E-V protons in air")).toBe("3 GeV protons in air");
  });

  it("fixes fully-spelled-out letter names (scripts/generate-unit-probe.py's 'letters' rendering)", () => {
    expect(correctText("150 em e v protons in water")).toBe("150 MeV protons in water");
    expect(correctText("500 kay e v protons in silicon")).toBe("500 keV protons in silicon");
    expect(correctText("3 gee e v protons in air")).toBe("3 GeV protons in air");
  });

  it("does not treat an unrelated unit like 'km' as a letter-spelled energy unit", () => {
    expect(correctText("the target is 100 km wide")).toBe("the target is 100 km wide");
  });

  it("fixes a letter-spelled TeV (issue #151)", () => {
    expect(correctText("5 T-E-V protons in water")).toBe("5 TeV protons in water");
    expect(correctText("5 tee e vee protons in water")).toBe("5 TeV protons in water");
  });

  it("fixes a letter-spelled unit after a spelled-out number (issue #147)", () => {
    // sherpa-onnx/Parakeet-v3 (no ASR inverse-text-normalization) spoke both "twenty" and
    // "MeV" as words, splitting the unit into "Me V" — every rule above originally required a
    // literal digit immediately before the unit, so this combination slipped through untouched
    // and silently produced a "No match" on Android (the bug this test guards against).
    expect(correctText("Range of twenty Me V proton in silicon.")).toBe(
      "Range of twenty MeV proton in silicon.",
    );
    expect(correctText("Stopping power of twenty Me V proton in silicon.")).toBe(
      "Stopping power of twenty MeV proton in silicon.",
    );
  });
});

describe("correctTranscript — spoken-expanded energy-unit readings (issue #151)", () => {
  it("recognizes 'kilo/mega/giga/tera electronvolt' readings even on perfectly clean text", () => {
    expect(correctText("500 kiloelectronvolt protons in water")).toBe("500 keV protons in water");
    expect(correctText("1 megaelectronvolt protons in water")).toBe("1 MeV protons in water");
    expect(correctText("300 gigaelectronvolt protons in water")).toBe("300 GeV protons in water");
    expect(correctText("5 teraelectronvolt protons in water")).toBe("5 TeV protons in water");
  });

  it("handles the spaced/'of'-filler variants seen in real transcripts (dg-22)", () => {
    expect(correctText("1 giga electron of volt proton in water")).toBe("1 GeV proton in water");
    expect(correctText("300 mega electron volt proton in water")).toBe("300 MeV proton in water");
  });

  it("accepts the 'elektron' spelling variant (real Parakeet-v3 transcript, dg-44)", () => {
    // Parakeet-v3's multilingual model bled the correct-Polish "elektron" spelling into an
    // otherwise-English utterance — docs/android-datagen-bench.md §4.7.
    expect(correctText("200 mega elektronovolt per nucleon carbon ion in water")).toBe(
      "200 MeV per nucleon carbon ion in water",
    );
    expect(correctText("500 kilo elektronovolt proton in water")).toBe("500 keV proton in water");
  });
});

describe("correctTranscript — spelled-out hundred-compounds before a unit (issue #153)", () => {
  // NUMBER_PREFIX_SRC previously stopped at a bare number word ("five"), so a spelled-out
  // "hundred" compound directly before a unit-mishearing or expanded-reading rule never matched
  // at all — real Parakeet-v3 transcripts (no ASR inverse-text-normalization, so every number
  // comes out as words, "hundred" included), docs/android-datagen-bench.md §4.7 dg-04/dg-11/dg-43.
  it("recognizes an expanded-reading unit after a bare 'X hundred'", () => {
    expect(correctText("uh five hundred kilo electronovolt proton in water")).toBe(
      "uh five hundred keV proton in water",
    );
    expect(correctText("a one hundred mega electronovolt proton in water")).toBe(
      "a one hundred MeV proton in water",
    );
  });

  it("recognizes an expanded-reading unit after 'X hundred' with an 'of'-filler and per-nucleon suffix", () => {
    expect(
      correctText("a three hundred mega electron o volt per nucleon carbon ion in water"),
    ).toBe("a three hundred MeV per nucleon carbon ion in water");
  });

  it("recognizes 'X hundred and Y' before a unit", () => {
    expect(correctText("three hundred and fifty kev protons in bone")).toBe(
      "three hundred and fifty keV protons in bone",
    );
  });

  it("also widens the plain bare-unit mishearing rules, not just the expanded-reading ones", () => {
    expect(correctText("one hundred kev protons in water")).toBe(
      "one hundred keV protons in water",
    );
  });

  it("still leaves an unrelated 'hundred' phrase alone", () => {
    expect(correctText("a hundred years from now")).toBe("a hundred years from now");
  });

  it("does not treat a number word as a substring inside a longer word before 'hundred' (code review)", () => {
    // HUNDRED_RUN_SRC originally had no \b word boundaries, so "one" inside "sh[one]" followed
    // by a literal " hundred" was matched as a phantom "one hundred" — the same class of bug
    // composeHundreds() in matcher.ts already guards against with its own \b boundaries. Testing
    // the regex directly (not correctText()'s output) because a later, independent case-fixing
    // rule (kev-case) would otherwise mask the difference: it converts a bare "kev" regardless
    // of any number prefix, so the buggy and fixed regex produce the same *final text* here even
    // though only the fixed one is correctly refusing to match at all.
    const kevExpanded = EN_RULES.find((r) => r.label === "kev-expanded");
    if (!kevExpanded) throw new Error("kev-expanded rule missing from EN_RULES");
    const freshTest = (str: string) =>
      new RegExp(kevExpanded.pattern.source, kevExpanded.pattern.flags).test(str);
    expect(freshTest("shone hundred kilo electronovolt proton in water")).toBe(false);
    expect(freshTest("one hundred kilo electronovolt proton in water")).toBe(true);
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

  it("normalizes 'Watt energy' as 'what energy' (issue #122 — NeMo Parakeet homophone)", () => {
    expect(correctText("Watt energy gives a 10 cm range in water for protons")).toBe(
      "what energy gives a 10 cm range in water for protons",
    );
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

  it("does not corrupt an already-correct alphanumeric program name like 'Geant4' (review)", () => {
    // The tokenizer must include trailing digits in a token — "Geant4" split
    // as "Geant" + "4" left the "4" outside the match span, so a fuzzy match
    // against the "Geant4" canonical replaced only "Geant" and left the
    // original "4" behind, corrupting the text into "Geant44".
    const text = "simulated using Geant4 with libdedx";
    expect(applyPhoneticPass(text)).toEqual({ text, substitutions: [] });
  });

  it("runs after the regex fast path inside correctTranscript, fixing what the fast path leaves behind", () => {
    const result = correctTranscript("100 NEV protons in water");
    expect(result.text).toBe("100 MeV protons in water");
    expect(result.substitutions).toEqual([{ heard: "NEV", readAs: "MeV", slot: "unit" }]);
  });
});
