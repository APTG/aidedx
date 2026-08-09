import { describe, expect, it } from "vitest";
import { correctTranscript } from "../asr/correct/core.ts";
import { INDIRECT_IDIOMS } from "./lang/en.ts";
import { matchIntent, matchQueryIntent } from "./matcher.ts";
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

  it("reads the acronym 'LET' as stopping power", () => {
    const { intent, quantitySource } = matchIntent("What is the LET of a 100 MeV proton in water?");
    expect(intent.quantity).toBe("stoppingPower");
    expect(quantitySource).toBe("direct");
  });

  it("reads spelled-out 'linear energy transfer' as stopping power, not an inverse query", () => {
    // The substring "energy" must not trip inverse detection here.
    const { intent, quantitySource } = matchIntent(
      "What is the linear energy transfer of 80 MeV protons in water?",
    );
    expect(intent.quantity).toBe("stoppingPower");
    expect(quantitySource).toBe("direct");
  });

  it("detects energyFromStp from an inverse LET-with-unit query", () => {
    const intent = matchQueryIntent("What energy gives an LET of 2 keV/µm in water for protons?");
    expect(intent.quantity).toBe("energyFromStp");
  });

  it("does not mistake the verb 'let' for the LET quantity", () => {
    // Lowercase "let" is the ordinary verb; only the all-caps acronym is the physics term.
    expect(matchQueryIntent("Let me know the range of a 100 MeV proton in water.").quantity).toBe(
      "csdaRange",
    );
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

  it("recognizes TeV (issue #151)", () => {
    expect(matchQueryIntent("Range of a 5 TeV proton in water.").energies[0]).toEqual({
      value: 5,
      unit: "TeV",
    });
  });

  it("converts a per-nucleon TeV value to MeV/nucl", () => {
    expect(
      matchQueryIntent("Range of carbon ions in water at 0.001 TeV per nucleon.").energies[0],
    ).toEqual({ value: 1000, unit: "MeV/nucl", perNucleonAssumed: true });
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

  it("does not flag a bare energy on a proton (A=1, total and per-nucleon coincide)", () => {
    expect(matchQueryIntent("Range of 10 MeV protons in air?").energies[0]).toEqual({
      value: 10,
      unit: "MeV",
    });
  });

  it("flags a bare energy on a named A>1 particle even without an assumed isotope (issue #163 B7)", () => {
    // Alpha/deuteron/triton have a *fixed*, not assumed, isotope — `isotopeAssumed` is never set
    // for them, but compute.ts still divides their bare energy by A, so the same disclosure a
    // bare "carbon ion" already gets must fire here too, not just when isotopeAssumed is set.
    const alpha = matchQueryIntent("Range of 20 MeV alpha particles in air?");
    expect(alpha.energies[0]).toEqual({ value: 20, unit: "MeV", perNucleonAssumed: false });
    expect(alpha.assumptions).toContain("20 MeV taken as total → 5 MeV/nucl");

    const deuteron = matchQueryIntent("Range of 20 MeV deuterons in water?");
    expect(deuteron.energies[0]).toEqual({ value: 20, unit: "MeV", perNucleonAssumed: false });
    expect(deuteron.assumptions).toContain("20 MeV taken as total → 10 MeV/nucl");

    const triton = matchQueryIntent("Range of 20 MeV tritons in water?");
    expect(triton.energies[0]).toEqual({ value: 20, unit: "MeV", perNucleonAssumed: false });
    expect(triton.assumptions).toContain("20 MeV taken as total → 6.667 MeV/nucl");
  });

  it("formats the per-nucleon assumption note to 4 significant figures, not raw 1e-6 precision (issue #163 B7)", () => {
    // Previously round()'s 1e-6 precision leaked straight into the note text: "33.333333
    // MeV/nucl" instead of a physicist-readable "33.33 MeV/nucl".
    const intent = matchQueryIntent("Stopping power of a 400 MeV carbon ion in water.");
    expect(intent.assumptions).toContain("400 MeV taken as total → 33.33 MeV/nucl");
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

// Issue #26 — quantity-synonym table + matcher quick fixes.
describe("issue #26 — expanded quantity-synonym vocabulary", () => {
  it.each([
    "What is the specific ionisation of 40 MeV protons in water?",
    "What is the specific ionization of 40 MeV protons in water?",
    "What is the Bethe-Bloch value for 100 MeV protons in water?",
    "What is the Bethe Bloch value for 100 MeV protons in water?",
    "What is the retarding force on 30 MeV protons in silicon?",
    "What is the energy deposition of 50 MeV protons in water?",
    "What is the energy deposition density of 50 MeV protons in water?",
    "What is the dose per micrometer of 20 MeV alpha particles in tissue?",
    "How much energy is deposited per micrometer by 100 MeV protons in PMMA?",
  ])("reads %s as stoppingPower", (text) => {
    expect(matchQueryIntent(text).quantity).toBe("stoppingPower");
  });

  it("does not mistake 'energy deposition' for an inverse solve-for-energy query", () => {
    const { intent, quantitySource } = matchIntent(
      "What is the energy deposition density of 50 MeV protons in water?",
    );
    expect(intent.quantity).toBe("stoppingPower");
    expect(quantitySource).toBe("direct");
  });
});

describe("issue #26 — spelled-out numbers", () => {
  it("parses 'one GeV' as an energy value", () => {
    expect(matchQueryIntent("What is the range of one GeV protons in water?").energies).toEqual([
      { value: 1, unit: "GeV" },
    ]);
  });

  it("parses 'three MeV' as an energy value", () => {
    // Also correctly flagged as taken-as-total (issue #163 B7) — alpha is A=4.
    expect(
      matchQueryIntent("Stopping power of three MeV alpha particles in air?").energies,
    ).toEqual([{ value: 3, unit: "MeV", perNucleonAssumed: false }]);
  });

  it("does not shift spans for unrelated text around the spelled-out number", () => {
    const intent = matchQueryIntent("Range of one GeV protons in water?");
    expect(intent.particles).toEqual([{ match: "protons" }]);
    expect(intent.materials).toEqual([{ match: "water" }]);
  });
});

describe("issue #122 — spelled-out tens and hundreds (NeMo Parakeet has no ASR ITN)", () => {
  it("parses a standalone spelled-out tens word ('sixty')", () => {
    expect(matchQueryIntent("How far will a sixty MeV proton travel in water?").energies).toEqual([
      { value: 60, unit: "MeV" },
    ]);
  });

  it("composes a spelled-out tens+ones compound ('fifty eight') into digits (issue #156)", () => {
    expect(
      matchQueryIntent("What is the range of fifty eight MeV protons in water?").energies,
    ).toEqual([{ value: 58, unit: "MeV" }]);
  });

  it("composes 'X hundred and Y' into digits", () => {
    expect(
      matchQueryIntent("What is the CSDA range of a one hundred and fifty MeV proton in water?")
        .energies,
    ).toEqual([{ value: 150, unit: "MeV" }]);
  });

  it("composes 'X hundred Y' (no 'and') into digits", () => {
    expect(matchQueryIntent("Range of one hundred fifty MeV protons in water.").energies).toEqual([
      { value: 150, unit: "MeV" },
    ]);
  });

  it("composes a bare 'X hundred' into digits", () => {
    expect(
      matchQueryIntent("Stopping power of five hundred keV protons in water.").energies,
    ).toEqual([{ value: 500, unit: "keV" }]);
  });

  it("does not shift spans for unrelated text around a composed hundred", () => {
    const intent = matchQueryIntent(
      "Compare the stopping power of one hundred MeV protons in water and bone.",
    );
    expect(intent.particles).toEqual([{ match: "protons" }]);
    expect(intent.materials).toEqual([{ match: "water" }, { match: "bone" }]);
  });

  it("composes a spelled-out decimal ('three point six')", () => {
    const intent = matchQueryIntent(
      "What is the range of a carbon ion with three point six GeV total energy in water?",
    );
    expect(intent.energies).toEqual([{ value: 3.6, unit: "GeV", perNucleonAssumed: false }]);
  });

  it("composes a spelled-out decimal with a tens+ones whole part ('fifty eight point four', issue #156)", () => {
    const intent = matchQueryIntent(
      "What is the range of fifty eight point four MeV protons in water?",
    );
    expect(intent.energies).toEqual([{ value: 58.4, unit: "MeV" }]);
  });

  it("accepts 'dot' as a decimal connector, same as 'point' (issue #156)", () => {
    const intent = matchQueryIntent(
      "What is the range of fifty eight dot four MeV protons in water?",
    );
    expect(intent.energies).toEqual([{ value: 58.4, unit: "MeV" }]);
  });

  it("composes a leading spelled-out decimal with no whole part ('point five' -> 0.5, issue #156)", () => {
    expect(
      matchQueryIntent("What is the range of point five MeV protons in water?").energies,
    ).toEqual([{ value: 0.5, unit: "MeV" }]);
    expect(
      matchQueryIntent("What is the range of dot five MeV protons in water?").energies,
    ).toEqual([{ value: 0.5, unit: "MeV" }]);
  });

  it("composes a decimal mixing a spelled 'point'/'dot' with a literal digit fraction ('point 5' -> 0.5, issue #156)", () => {
    expect(matchQueryIntent("What is the range of point 5 MeV protons in water?").energies).toEqual(
      [{ value: 0.5, unit: "MeV" }],
    );
    expect(matchQueryIntent("Stopping power of point 2 MeV protons in water?").energies).toEqual([
      { value: 0.2, unit: "MeV" },
    ]);
  });

  it("composes 'X hundred Y-Z' (a tens+ones remainder after hundreds) into digits (issue #163 B4)", () => {
    // Previously: composeHundreds() ran first and consumed "two hundred thirty" as 200 + a
    // single-word remainder "thirty" (30), leaving "five" as an orphaned word with no adjacent
    // tens word left to compose with — extractEnergies()'s number grammar then picked up
    // whichever bare digit ended up next to "MeV" (5, not 235).
    expect(
      matchQueryIntent("Range of a two hundred thirty five MeV proton in water.").energies,
    ).toEqual([{ value: 235, unit: "MeV" }]);
    expect(
      matchQueryIntent("Range of a nine hundred ninety nine MeV proton in water.").energies,
    ).toEqual([{ value: 999, unit: "MeV" }]);
  });

  it("still composes 'X hundred and Y-Z' with 'and' before a tens+ones remainder (issue #163 B4)", () => {
    expect(
      matchQueryIntent("Range of a one hundred and thirty five MeV proton in water.").energies,
    ).toEqual([{ value: 135, unit: "MeV" }]);
  });

  it("issue #163 C5(b) — a spelled-out hundreds list keeps every member instead of collapsing to none", () => {
    // Pre-fix: composeHundreds()'s remainder greedily consumed "and two" ("two" is itself a
    // NUMBER_WORDS entry) as this match's remainder, collapsing "one hundred and two hundred" to
    // "102" and stranding a bare "hundred" no number+unit grammar could reach — energies came back
    // empty and the query silently defaulted to 100 MeV instead of comparing 100 and 200.
    expect(
      matchQueryIntent("Compare the range of a proton in water at one hundred and two hundred MeV.")
        .energies,
    ).toEqual([
      { value: 100, unit: "MeV" },
      { value: 200, unit: "MeV" },
    ]);
    expect(
      matchQueryIntent(
        "Compare the range of a proton in water at three hundred and four hundred MeV.",
      ).energies,
    ).toEqual([
      { value: 300, unit: "MeV" },
      { value: 400, unit: "MeV" },
    ]);
    // Control (issue #163 re-audit): a genuine "and <tens/ones>" remainder must still compose.
    expect(
      matchQueryIntent("Range of a one hundred and fifty MeV proton in water.").energies,
    ).toEqual([{ value: 150, unit: "MeV" }]);
  });

  it("recognizes a spelled-out length-target unit ('centimeters')", () => {
    const intent = matchQueryIntent(
      "What energy gives a 10 centimeters range in water for protons?",
    );
    expect(intent.quantity).toBe("energyFromRange");
    expect(intent.target).toEqual({ value: 10, unit: "cm" });
  });

  it("recognizes spelled-out millimeters/micrometers the same way", () => {
    expect(
      matchQueryIntent("What energy gives a 5 millimeters range in water for protons?").target,
    ).toEqual({ value: 5, unit: "mm" });
    expect(
      matchQueryIntent("What energy gives a 200 micrometers range in water for protons?").target,
    ).toEqual({ value: 200, unit: "um" });
  });

  it("issue #163 C5(a) — recognizes a metre range target ('m'/'meters'/'metres')", () => {
    // Pre-fix: RANGE_TARGET_UNITS/compute.ts/IntentChips all already handled "m" — only this
    // producer's LENGTH_TARGET_RE had no m|meters?|metres? alternative, so a metre target could
    // never be extracted and the query silently fell back to fillMissingSlots()'s "target not
    // specified -> 10 cm" banner despite the user having named one.
    expect(matchQueryIntent("What proton energy gives a 3 m range in water?").target).toEqual({
      value: 3,
      unit: "m",
    });
    expect(
      matchQueryIntent("What proton energy gives a range of 2 meters in water?").target,
    ).toEqual({ value: 2, unit: "m" });
    expect(
      matchQueryIntent("What proton energy gives a range of 2 metres in water?").target,
    ).toEqual({ value: 2, unit: "m" });
  });
});

describe("issue #26 — unhyphenated isotope mentions", () => {
  it("resolves 'helium 3 ion' (space, not hyphen) as a particle, not a material", () => {
    const intent = matchQueryIntent("Range of a helium 3 ion in water at 40 MeV?");
    expect(intent.particles).toEqual([{ match: "helium 3 ion" }]);
    expect(intent.materials).toEqual([{ match: "water" }]);
  });

  it("resolves 'carbon 13 ions' (space, not hyphen)", () => {
    const intent = matchQueryIntent("Range of carbon 13 ions in water at 200 MeV per nucleon?");
    expect(intent.particles).toEqual([{ match: "carbon 13 ions" }]);
  });

  it("resolves a comma-separated isotope mention ('helium, three ions') — a real Whisper mistranscription of 'helium-3 ions'", () => {
    const intent = matchQueryIntent(
      "to determine the range of two MeV helium, three ions in water.",
    );
    expect(intent.particles).toEqual([{ match: "helium, 3 ions" }]);
    expect(intent.materials).toEqual([{ match: "water" }]);
  });
});

describe("issue #26 — dedup repeated resolved entities", () => {
  it("collapses a repeated material mention (ASR echo) instead of reading it as a comparison", () => {
    const intent = matchQueryIntent("What is the range of 40 MeV protons in Lucite? Lucite.");
    expect(intent.materials).toEqual([{ match: "Lucite" }]);
    expect(intent.compareDim).toBe("none");
  });

  it("collapses two aliases of the same material (PMMA/Lucite) rather than treating them as distinct", () => {
    const intent = matchQueryIntent(
      "Compare the stopping power of 100 MeV protons in PMMA and Lucite.",
    );
    expect(intent.materials).toHaveLength(1);
    expect(intent.compareDim).toBe("none");
  });

  it("still keeps two genuinely different isotopes of the same element distinct", () => {
    const intent = matchQueryIntent(
      "Compare the range of carbon-12 ions and carbon-13 ions in water at 200 MeV per nucleon.",
    );
    expect(intent.particles).toHaveLength(2);
    expect(intent.compareDim).toBe("particle");
  });
});

describe("issue #132 — dedup repeated energy mentions", () => {
  // A "compare A and B, both stated at the same energy" phrasing repeats the shared energy
  // once per particle clause — two *identical* energy mentions, not two distinct ones. Before
  // this fix, that duplicate tipped `decideCompareDim` to "energy" instead of "particle", and
  // `computeIntent`'s `compareDim: "energy"` branch only ever resolves `particles[0]` —
  // silently computing the first particle's value twice and never touching the second.
  it("collapses a duplicate energy mention so a 2-particle range comparison resolves as such", () => {
    const intent = matchQueryIntent(
      "Compare the range of a 200 MeV per nucleon carbon-12 ion and a 200 MeV per nucleon neon-20 ion in water.",
    );
    expect(intent.particles).toHaveLength(2);
    expect(intent.energies).toHaveLength(1);
    expect(intent.compareDim).toBe("particle");
  });

  it("same fix for a stopping-power comparison stated as 'a 100 MeV X and a 100 MeV Y'", () => {
    const intent = matchQueryIntent(
      "Compare the stopping power of a 100 MeV proton and a 100 MeV carbon-12 ion in water.",
    );
    expect(intent.particles).toHaveLength(2);
    expect(intent.energies).toHaveLength(1);
    expect(intent.compareDim).toBe("particle");
  });

  it("still keeps a genuine multi-energy comparison as compareDim energy", () => {
    const intent = matchQueryIntent(
      "What is the range of protons in water at 100 MeV, 150 MeV, and 200 MeV?",
    );
    expect(intent.energies).toHaveLength(3);
    expect(intent.compareDim).toBe("energy");
  });

  it("collapses three repeated mentions of the same energy the same way as two", () => {
    const intent = matchQueryIntent(
      "Compare the range of a 50 MeV proton, a 50 MeV deuteron, and a 50 MeV triton in water.",
    );
    expect(intent.particles).toHaveLength(3);
    expect(intent.energies).toHaveLength(1);
    expect(intent.compareDim).toBe("particle");
  });
});

describe("issue #26 — hyphenated length/energy grammar", () => {
  it("accepts a hyphenated length target ('10-cm range')", () => {
    const intent = matchQueryIntent("What energy gives a 10-cm range in water for protons?");
    expect(intent.quantity).toBe("energyFromRange");
    expect(intent.target).toEqual({ value: 10, unit: "cm" });
  });

  it("accepts a hyphenated energy ('10-MeV proton')", () => {
    expect(matchQueryIntent("Range of a 10-MeV proton in water.").energies).toEqual([
      { value: 10, unit: "MeV" },
    ]);
  });
});

describe("issue #26 — fuzzy quantity-keyword tolerance", () => {
  it("reads a typo'd 'Stoping power' as stoppingPower", () => {
    const { intent, quantitySource } = matchIntent(
      "What is the stoping power of 40 MeV protons in water?",
    );
    expect(intent.quantity).toBe("stoppingPower");
    expect(quantitySource).toBe("indirect");
  });

  it("does not fuzzy-match unrelated text", () => {
    expect(matchQueryIntent("What is the range of 40 MeV protons in water?").quantity).toBe(
      "csdaRange",
    );
  });
});

describe("issue #103 — bughunt regressions", () => {
  it("keeps every member of a coordinated isotope list, not just the one before the head noun", () => {
    const intent = matchQueryIntent("Range of neon-20 and carbon-12 ions at 100 MeV in water.");
    expect(intent.particles).toEqual([{ match: "neon-20" }, { match: "carbon-12" }]);
    expect(intent.compareDim).toBe("particle");
  });

  it("keeps both isotopes of the same element in a coordinated list", () => {
    const intent = matchQueryIntent("Compare carbon-12 and carbon-13 ions at 100 MeV in water.");
    expect(intent.particles).toEqual([{ match: "carbon-12" }, { match: "carbon-13" }]);
    expect(intent.compareDim).toBe("particle");
  });

  it("drops only the negative member of a shared-unit energy list, not the whole list", () => {
    const intent = matchQueryIntent("Range of protons at -50, 100, and 200 MeV in water.");
    expect(intent.energies).toEqual([
      { value: 100, unit: "MeV" },
      { value: 200, unit: "MeV" },
    ]);
  });

  it("reads a forward 'what energy is lost per length' idiom as stoppingPower, not inverse", () => {
    const intent = matchQueryIntent(
      "What energy is lost per centimeter by a 100 MeV proton in water?",
    );
    expect(intent.quantity).toBe("stoppingPower");
    expect(intent.energies).toEqual([{ value: 100, unit: "MeV" }]);
  });

  it("still reads a genuine inverse query with a different subject between 'energy' and 'lose'", () => {
    const intent = matchQueryIntent("Which energy makes a proton lose 2 MeV per cm in PMMA?");
    expect(intent.quantity).toBe("energyFromStp");
    expect(intent.target).toEqual({ value: 2, unit: "MeV/cm" });
  });
});

describe("issue #163 B3 — unresolved (named but unrecognized) particles/materials", () => {
  it("flags a named particle libdedx has no data for, instead of leaving it silently empty", () => {
    const { intent, unresolved } = matchIntent("range of muons in water at 100 MeV");
    expect(intent.particles).toEqual([]);
    expect(unresolved).toEqual([{ kind: "particle", phrase: "muons" }]);
  });

  it("flags a second unrecognized particle example ('pions')", () => {
    const { unresolved } = matchIntent("range of pions in water at 100 MeV");
    expect(unresolved).toEqual([{ kind: "particle", phrase: "pions" }]);
  });

  it("flags a named material libdedx has no data for ('stainless steel')", () => {
    const { intent, unresolved } = matchIntent(
      "stopping power of 100 MeV protons in stainless steel",
    );
    expect(intent.materials).toEqual([]);
    expect(unresolved).toEqual([{ kind: "material", phrase: "stainless steel" }]);
  });

  it("flags a single-word unrecognized material ('unobtanium')", () => {
    const { unresolved } = matchIntent("stopping power of 100 MeV protons in unobtanium");
    expect(unresolved).toEqual([{ kind: "material", phrase: "unobtanium" }]);
  });

  it("does not flag anything when both particle and material genuinely aren't mentioned", () => {
    // "stopping power of a proton" — no material, no energy — must still fall through to
    // fill-defaults.ts's ordinary "not specified" behavior, not this new path.
    const { unresolved } = matchIntent("stopping power of a proton");
    expect(unresolved).toEqual([]);
  });

  it("does not flag a normal query where the material resolves fine", () => {
    const { unresolved } = matchIntent("range of protons in water at 100 MeV");
    expect(unresolved).toEqual([]);
  });

  it("does not misfire on non-material 'in ...' idioms ('in general', 'in theory')", () => {
    expect(matchIntent("range of protons in general").unresolved).toEqual([]);
    expect(matchIntent("stopping power of protons in theory").unresolved).toEqual([]);
  });

  it("never overrides an already-successful match — unresolved stays empty once particles resolve", () => {
    // Regression guard: this detector must only ever run when the real scan found nothing.
    const { intent, unresolved } = matchIntent(
      "stopping power of 100 MeV protons in stainless steel and water",
    );
    expect(intent.materials).toEqual([{ match: "water" }]);
    expect(unresolved).toEqual([]);
  });

  it("flags a particle named with a leading article ('a muon'), not just the bare plural", () => {
    // Copilot review on PR #166: "a"/"an"/"the" are themselves in MATERIAL_STOPWORDS, so without
    // stripping the leading article first, the bare stopword-leading-phrase reject silently
    // swallowed exactly this — the most natural way to name a single unknown particle.
    const { unresolved } = matchIntent("range of a muon in water at 100 MeV");
    expect(unresolved).toEqual([{ kind: "particle", phrase: "muon" }]);
  });

  it("flags a material named with a leading article ('an unobtanium')", () => {
    const { unresolved } = matchIntent("stopping power of 100 MeV protons in an unobtanium");
    expect(unresolved).toEqual([{ kind: "material", phrase: "unobtanium" }]);
  });
});

describe("issue #163 B5 — matcher sets intent.program for a single explicit request", () => {
  it("sets intent.program when exactly one supported program is named", () => {
    const { intent } = matchIntent("Using PSTAR, what is the range of 150 MeV protons in water?");
    expect(intent.program).toBe("PSTAR");
    expect(intent.compareDim).toBe("none");
  });

  it("resolves a different alias to its canonical spelling ('With ASTAR' -> 'ASTAR')", () => {
    const { intent } = matchIntent(
      "With ASTAR, give me the stopping power of 5 MeV alpha particles in air.",
    );
    expect(intent.program).toBe("ASTAR");
  });

  it("recognizes 'ICRU49'/'ICRU73' as whole tokens, not just bare 'ICRU' (Copilot review on PR #167)", () => {
    // \b(icru)\b alone doesn't match "icru49" — there's no word boundary between "u" and "4".
    // Pre-fix, these silently detected zero program mentions and fell through to auto-select.
    expect(
      matchIntent("Using ICRU49, what is the range of 150 MeV protons in water?").intent.program,
    ).toBe("ICRU49");
    expect(
      matchIntent("Using ICRU73, what is the range of 150 MeV protons in water?").intent.program,
    ).toBe("ICRU73");
  });

  it("leaves intent.program unset when no program is named", () => {
    const { intent } = matchIntent("range of 100 MeV protons in water");
    expect(intent.program).toBeUndefined();
  });

  it("leaves intent.program unset (not just the first name) when 2+ supported programs are named — that's compareDim: program's territory", () => {
    const { intent } = matchIntent(
      "Compare the range of 150 MeV protons in water using ASTAR and PSTAR.",
    );
    expect(intent.compareDim).toBe("program");
    expect(intent.program).toBeUndefined();
  });

  it("does not mistake the Bethe-Bloch formula's own name for a request to use the Bethe program", () => {
    const { intent, unresolved } = matchIntent(
      "What is the Bethe-Bloch value for 100 MeV protons in water?",
    );
    expect(intent.program).toBeUndefined();
    expect(unresolved).toEqual([]);
  });

  it("still recognizes a genuine bare 'Bethe' program request", () => {
    const { intent } = matchIntent("Using Bethe, what is the range of 100 MeV protons in water?");
    expect(intent.program).toBe("Bethe");
  });

  it("issue #163 C3 — recognizes 'ICRU 73'/'ICRU-73' (separated) the same as abutted 'ICRU73'", () => {
    // Regression from PR #167's own `icru(?:49|73)?` widening: a space or hyphen between "icru"
    // and the digits matched only the bare "icru" branch, silently resolving to ICRU49 instead of
    // the ICRU73 actually named.
    expect(
      matchIntent("Using ICRU 73, what is the range of 400 MeV/u carbon ions in water?").intent
        .program,
    ).toBe("ICRU73");
    expect(
      matchIntent("Using ICRU-73, what is the range of 400 MeV/u carbon ions in water?").intent
        .program,
    ).toBe("ICRU73");
    expect(
      matchIntent("Using ICRU 49, what is the range of 150 MeV protons in water?").intent.program,
    ).toBe("ICRU49");
  });
});

describe("issue #163 B6 — unresolved (program-shaped but unsupported) program names", () => {
  it("flags a single unsupported program instead of silently ignoring it", () => {
    const { intent, unresolved } = matchIntent(
      "Using SRIM, what is the range of 100 MeV protons in water?",
    );
    expect(intent.program).toBeUndefined();
    expect(unresolved).toEqual([{ kind: "program", phrase: "SRIM" }]);
  });

  it("flags two unsupported programs instead of silently fanning out over three unrelated ones", () => {
    // The exact issue #163 B6 example: pre-fix, this computed PSTAR/ICRU49/Bethe unremarked.
    const { intent, unresolved } = matchIntent(
      "Compare SRIM and ATIMA for the range of 100 MeV protons in water.",
    );
    expect(intent.compareDim).toBe("none");
    expect(unresolved).toEqual(
      expect.arrayContaining([
        { kind: "program", phrase: "SRIM" },
        { kind: "program", phrase: "ATIMA" },
      ]),
    );
  });

  it("flags the unsupported name and does not fall back to the one supported program when both are named", () => {
    const { intent, unresolved } = matchIntent(
      "Compare SRIM and PSTAR for the range of 100 MeV protons in water.",
    );
    expect(intent.program).toBeUndefined();
    expect(intent.compareDim).not.toBe("program");
    expect(unresolved).toEqual([{ kind: "program", phrase: "SRIM" }]);
  });

  it("issue #163 C3 — flags an ICRU number libdedx doesn't have instead of silently aliasing it to ICRU49", () => {
    // Pre-fix: "ICRU 90" matched only the bare "icru" branch (no separator support) and resolved
    // straight to ICRU49, unremarked — worse than the plain-SRIM case above, since ICRU is also a
    // real, otherwise-valid program name.
    const { intent, unresolved } = matchIntent(
      "Using ICRU 90, what is the range of 150 MeV protons in water?",
    );
    expect(intent.program).toBeUndefined();
    expect(unresolved).toEqual([{ kind: "program", phrase: "ICRU 90" }]);
  });
});

describe("issue #169 — 'energy loss' misread as an inverse query", () => {
  it("reads 'What is the energy loss of X' as stoppingPower, not energyFromRange", () => {
    // Pre-fix: detectInverse() ran first (matchIntent's "inverse takes precedence"), and
    // asksForEnergy()'s "<=3 words between wh-word and energy" regex fired on "what is the
    // energy" even though "energy loss" is itself a DIRECT_STOPPING synonym — the query never
    // reached detectForwardQuantity() at all, so it silently misread as energyFromRange with no
    // target extracted (bench:nlu found this as a 100%-reproducible template failure).
    const intent = matchQueryIntent("What is the energy loss of a 100 MeV proton in water?");
    expect(intent.quantity).toBe("stoppingPower");
    expect(intent.energies).toEqual([{ value: 100, unit: "MeV" }]);
    expect(intent.target).toBeUndefined();
  });

  it("still reads a genuine 'which energy makes X lose Y' inverse query correctly", () => {
    // Regression guard for the fix's scope: BLANK_BEFORE_INVERSE_RE now also blanks bare
    // "energy loss", but must not blank this differently-worded genuine inverse query (already
    // covered above in "issue #103 — bughunt regressions", repeated here for locality with the
    // new "energy loss" case it sits right next to).
    const intent = matchQueryIntent("Which energy makes a proton lose 2 MeV per cm in PMMA?");
    expect(intent.quantity).toBe("energyFromStp");
    expect(intent.target).toEqual({ value: 2, unit: "MeV/cm" });
  });
});

describe("issue #169 — phonetic pass no longer misreads 'get' as 'LET'", () => {
  it("keeps a 'how far does X get through Y' idiom as csdaRange through the full corrector+matcher pipeline", () => {
    // Pre-fix: applyPhoneticPass() (src/lib/asr/correct/core.ts) silently rewrote "get" to "LET"
    // (edit distance 1, "get" wasn't in PHONETIC_STOPWORDS) before the text ever reached the
    // matcher, flipping the intended csdaRange idiom to stoppingPower.
    const text = "Before coming to rest, how far does a 250 MeV proton get through water?";
    const corrected = correctTranscript(text);
    expect(corrected.text).toBe(text);
    expect(corrected.substitutions).toEqual([]);
    expect(matchQueryIntent(corrected.text).quantity).toBe("csdaRange");
  });
});
