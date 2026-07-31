import { describe, expect, it } from "vitest";
import type { QueryIntent } from "./query-intent.ts";
import {
  buildDefaultsNotice,
  buildUnresolvedNotice,
  fillMissingSlots,
  isRecoverableIncomplete,
} from "./fill-defaults.ts";

function baseIntent(overrides: Partial<QueryIntent> = {}): QueryIntent {
  return {
    quantity: "stoppingPower",
    compareDim: "none",
    particles: [],
    materials: [],
    energies: [],
    assumptions: [],
    confidence: 0.4,
    ...overrides,
  };
}

describe("isRecoverableIncomplete", () => {
  it("is recoverable when the quantity was confidently recognized but a slot is missing", () => {
    expect(isRecoverableIncomplete({ quantitySource: "direct", incomplete: true })).toBe(true);
    expect(isRecoverableIncomplete({ quantitySource: "indirect", incomplete: true })).toBe(true);
    expect(isRecoverableIncomplete({ quantitySource: "inverse", incomplete: true })).toBe(true);
  });

  it("is not recoverable when the quantity itself was only a guess", () => {
    expect(isRecoverableIncomplete({ quantitySource: "default", incomplete: true })).toBe(false);
  });

  it("is not recoverable when nothing is actually incomplete", () => {
    expect(isRecoverableIncomplete({ quantitySource: "direct", incomplete: false })).toBe(false);
  });
});

describe("fillMissingSlots", () => {
  it("fills a missing material and energy, leaving a recognized particle untouched", () => {
    const intent = baseIntent({ particles: [{ match: "proton" }] });
    const { intent: next, filled } = fillMissingSlots(intent);

    expect(next.particles).toEqual([{ match: "proton" }]);
    expect(next.materials).toEqual([{ match: "water" }]);
    expect(next.energies).toEqual([{ value: 100, unit: "MeV" }]);
    expect(filled.map((f) => f.kind)).toEqual(["material", "energy"]);
  });

  it("fills every forward slot when nothing at all was recognized", () => {
    const { intent: next, filled } = fillMissingSlots(baseIntent());

    expect(next.particles).toEqual([{ match: "proton" }]);
    expect(next.materials).toEqual([{ match: "water" }]);
    expect(next.energies).toEqual([{ value: 100, unit: "MeV" }]);
    expect(filled).toHaveLength(3);
  });

  it("does not touch slots that are already present", () => {
    const intent = baseIntent({
      particles: [{ match: "carbon ion" }],
      materials: [{ match: "PMMA" }],
      energies: [{ value: 240, unit: "keV" }],
    });
    const { intent: next, filled } = fillMissingSlots(intent);

    expect(next).toEqual(intent);
    expect(filled).toEqual([]);
  });

  it("fills a missing target for an energyFromRange query with a range default", () => {
    const intent = baseIntent({ quantity: "energyFromRange", particles: [{ match: "proton" }] });
    const { intent: next, filled } = fillMissingSlots(intent);

    expect(next.target).toEqual({ value: 10, unit: "cm" });
    expect(next.energies).toEqual([]);
    expect(filled.some((f) => f.kind === "target")).toBe(true);
    // Forward-only "energy" slot is never defaulted for an inverse quantity.
    expect(filled.some((f) => f.kind === "energy")).toBe(false);
  });

  it("fills a missing target for an energyFromStp query with a stopping-power default", () => {
    const intent = baseIntent({ quantity: "energyFromStp" });
    const { intent: next } = fillMissingSlots(intent);

    expect(next.target).toEqual({ value: 10, unit: "MeV/cm" });
  });

  it("appends filled-slot notes to assumptions verbatim", () => {
    const { intent: next } = fillMissingSlots(baseIntent({ particles: [{ match: "proton" }] }));
    expect(next.assumptions).toEqual([
      "material not specified → water",
      "energy not specified → 100 MeV",
    ]);
  });

  it("preserves pre-existing assumptions instead of discarding them", () => {
    const intent = baseIntent({
      particles: [{ match: "carbon ion", isotopeAssumed: "¹²C" }],
      assumptions: ["carbon → ¹²C"],
    });
    const { intent: next } = fillMissingSlots(intent);
    expect(next.assumptions).toEqual([
      "carbon → ¹²C",
      "material not specified → water",
      "energy not specified → 100 MeV",
    ]);
  });
});

describe("buildDefaultsNotice", () => {
  it("composes a single readable sentence from the filled-slot notes", () => {
    const notice = buildDefaultsNotice([
      { kind: "material", note: "material not specified → water" },
      { kind: "energy", note: "energy not specified → 100 MeV" },
    ]);
    expect(notice).toBe(
      "Your question was missing some details, so I filled them in: material not specified → water; energy not specified → 100 MeV. Tap a value below to correct it, or try asking again.",
    );
  });
});

describe("buildUnresolvedNotice — issue #163 B3/B6", () => {
  it("names a single unresolved entity", () => {
    const notice = buildUnresolvedNotice([{ kind: "material", phrase: "stainless steel" }]);
    expect(notice).toBe(
      '"stainless steel" isn\'t a material that libdedx has data for. Try a different material, or check the spelling.',
    );
  });

  it("joins multiple same-kind entities and names that one kind", () => {
    const notice = buildUnresolvedNotice([
      { kind: "program", phrase: "SRIM" },
      { kind: "program", phrase: "ATIMA" },
    ]);
    expect(notice).toBe(
      '"SRIM" isn\'t a program that libdedx has data for; "ATIMA" isn\'t a program that libdedx has data for. Try a different program, or check the spelling.',
    );
  });

  it("names every distinct kind present when mixed, not a hardcoded 'particle or material'", () => {
    // Regression guard: this used to key off item *count*, not the actual kinds present, which
    // would have mislabeled a 2-item all-program case as "particle or material".
    const notice = buildUnresolvedNotice([
      { kind: "material", phrase: "stainless steel" },
      { kind: "program", phrase: "SRIM" },
    ]);
    expect(notice).toContain("Try a different material or program, or check the spelling.");
  });
});
