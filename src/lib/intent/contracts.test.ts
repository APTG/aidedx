/**
 * issue #163 §4.1 — the instrument the audit's whole cross-layer-drift argument was building
 * toward. Every closed-union fix so far (B1/B2's `RANGE_TARGET_UNITS`/`STP_TARGET_UNITS`, B5/B6's
 * `PROGRAM_NAMES`) made the *consumer* side exhaustive: `compute.ts` now has a compile error if a
 * unit/program is added to the union without a matching converter/id-map entry. That closes half
 * the drift. The other half — whether the *producer* (`matcher.ts`'s regex grammar) can actually
 * *emit* every member of the union it's allowed to — has no type-level check at all, because a
 * regex's match set isn't something TypeScript can verify against a union of string literals.
 *
 * This file is that missing check, run at test time instead of compile time: for every member of
 * `RANGE_TARGET_UNITS`, `STP_TARGET_UNITS`, and `PROGRAM_NAMES`, assert the matcher produces it
 * from a representative natural-language phrase. Writing it surfaced two real, previously-
 * undiscovered gaps on the first run — `"ICRU73 (old)"` and `"Bethe-ext"` were both unreachable
 * via any phrase (see matcher.ts's own doc comments on `PROGRAM_RE` for the fix) — which is
 * exactly the failure mode §4.1 predicted: a member added to a closed union with no test ever
 * checking the producer side can silently never be producible.
 *
 * Deliberately excludes `ENERGY_UNITS`: `matcher.ts`'s `spellOutNumbers()`/`extractEnergies()`
 * grammar already has direct, dense coverage in `matcher.test.ts` for every energy unit (plain,
 * spelled-out, and per-nucleon forms) — duplicating that here would just be a second, weaker copy.
 * This file is for the two vocabularies whose producer side has never been exercised unit-by-unit
 * in one place before.
 */
import { describe, expect, it } from "vitest";
import { matchQueryIntent } from "./matcher.ts";
import {
  PROGRAM_NAMES,
  RANGE_TARGET_UNITS,
  STP_TARGET_UNITS,
  type ProgramName,
  type RangeTargetUnit,
  type StpTargetUnit,
} from "./query-intent.ts";

describe("contracts — matcher can produce every RangeTargetUnit (energyFromRange target)", () => {
  const PHRASE_FOR_UNIT: Record<RangeTargetUnit, string> = {
    cm: "a 10 cm range",
    mm: "a 10 mm range",
    m: "a 10 m range",
    um: "a 10 um range",
    "g/cm2": "a 10 g/cm2 range",
  };

  it.each(RANGE_TARGET_UNITS)("target unit %s is producible", (unit) => {
    const intent = matchQueryIntent(`What proton energy gives ${PHRASE_FOR_UNIT[unit]} in water?`);
    expect(intent.quantity).toBe("energyFromRange");
    expect(intent.target).toEqual({ value: 10, unit });
  });
});

describe("contracts — matcher can produce every StpTargetUnit (energyFromStp target)", () => {
  const PHRASE_FOR_UNIT: Record<StpTargetUnit, string> = {
    "MeV cm2/g": "a stopping power of 5 MeV cm2/g",
    "MeV/cm": "a stopping power of 5 MeV/cm",
    "keV/um": "a stopping power of 5 keV/um",
  };

  it.each(STP_TARGET_UNITS)("target unit %s is producible", (unit) => {
    const intent = matchQueryIntent(`What proton energy gives ${PHRASE_FOR_UNIT[unit]} in water?`);
    expect(intent.quantity).toBe("energyFromStp");
    expect(intent.target).toEqual({ value: 5, unit });
  });
});

describe("contracts — matcher can produce every PROGRAM_NAMES entry (intent.program)", () => {
  const PHRASE_FOR_PROGRAM: Record<ProgramName, string> = {
    ASTAR: "Using ASTAR",
    PSTAR: "Using PSTAR",
    ESTAR: "Using ESTAR",
    MSTAR: "Using MSTAR",
    ICRU73: "Using ICRU73",
    "ICRU73 (old)": "Using ICRU73 old",
    ICRU49: "Using ICRU49",
    Bethe: "Using Bethe",
    "Bethe-ext": "Using Bethe ext",
  };

  it.each(PROGRAM_NAMES)("program %s is producible from a single-mention phrase", (name) => {
    const intent = matchQueryIntent(
      `${PHRASE_FOR_PROGRAM[name]}, what is the range of 100 MeV protons in water?`,
    );
    expect(intent.program).toBe(name);
  });
});
