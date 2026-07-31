import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildQuantityLexiconArtifact, serialize } from "../../../../scripts/generate-lexicon.ts";
import { DIRECT_STOPPING, DIRECT_RANGE, mentionsStoppingPowerSynonym } from "../lang/en.ts";

describe("static/lexicon/quantity-en.json is up to date", () => {
  it("matches what the generator would produce from the TS tables", () => {
    const committed = readFileSync(
      resolve(process.cwd(), "static/lexicon/quantity-en.json"),
      "utf-8",
    );
    expect(committed).toBe(serialize(buildQuantityLexiconArtifact()));
  });
});

// Confirms the consolidation (issue #160 §9a) preserved matching behavior — en.ts's regexes are
// now built from this module's data rather than hand-inlined, but must still recognize the same
// phrasings. matcher.test.ts is the exhaustive regression suite; these are a handful of direct
// smoke checks colocated with the data they exercise.
describe("en.ts regexes built from the shared lexicon", () => {
  it("DIRECT_STOPPING still recognizes every physics synonym", () => {
    for (const phrase of [
      "stopping power",
      "mass stopping power",
      "electronic stopping power",
      "dE/dx",
      "de/dx",
      "energy loss",
      "specific ionisation",
      "specific ionization",
      "bethe-bloch",
      "bethe bloch",
      "retarding force",
      "energy deposition",
      "energy deposition density",
      "dose per micrometer",
    ]) {
      expect(DIRECT_STOPPING.test(phrase), phrase).toBe(true);
    }
  });

  it("DIRECT_RANGE still recognizes csda/range", () => {
    expect(DIRECT_RANGE.test("csda range")).toBe(true);
    expect(DIRECT_RANGE.test("range")).toBe(true);
  });

  it("mentionsStoppingPowerSynonym still recognizes LET case-sensitively and the spelled-out phrase", () => {
    expect(mentionsStoppingPowerSynonym("let of a proton", "LET of a proton")).toBe(true);
    expect(mentionsStoppingPowerSynonym("let me know the range", "Let me know the range")).toBe(
      false,
    );
    expect(
      mentionsStoppingPowerSynonym(
        "linear energy transfer of a proton",
        "linear energy transfer of a proton",
      ),
    ).toBe(true);
  });
});
