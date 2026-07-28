import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { matchQueryIntent } from "./matcher.ts";
import { validateQueryIntent } from "./query-intent.ts";
import type { Lang } from "./lang/types.ts";

/**
 * Every canonical sentence from `eval/datagen-sentences.json` (issue #130 Part 1), both
 * languages, run through `matchQueryIntent`. This is the same empirical-validation role
 * matcher.pl.test.ts's SENTENCES array plays for `eval/RECORDING.pl.md` — the JSON file
 * (and its human-readable twin, `eval/RECORDING.datagen.md`) is the source of truth, this
 * test only asserts the matcher agrees with it.
 */
interface SlotTruth {
  particles: string[];
  materials: string[];
  isInverse?: boolean;
}
interface DatagenRecord {
  id: string;
  quantity: string;
  en: { canonical: string; slotTruth: SlotTruth };
  pl: { canonical: string; slotTruth: SlotTruth };
}

const path = resolve(process.cwd(), "eval/datagen-sentences.json");
const records = JSON.parse(readFileSync(path, "utf-8")) as DatagenRecord[];

const cases: ReadonlyArray<{
  id: string;
  lang: Lang;
  text: string;
  quantity: string;
  slotTruth: SlotTruth;
}> = records.flatMap((r) => [
  {
    id: `${r.id}-en`,
    lang: "en" as Lang,
    text: r.en.canonical,
    quantity: r.quantity,
    slotTruth: r.en.slotTruth,
  },
  {
    id: `${r.id}-pl`,
    lang: "pl" as Lang,
    text: r.pl.canonical,
    quantity: r.quantity,
    slotTruth: r.pl.slotTruth,
  },
]);

describe("datagen sentence set — matcher agrees with eval/datagen-sentences.json", () => {
  for (const c of cases) {
    it(`${c.id}: ${c.text}`, () => {
      const intent = matchQueryIntent(c.text, c.lang);
      expect(intent.quantity).toBe(c.quantity);
      expect(intent.particles.length).toBe(c.slotTruth.particles.length);
      expect(intent.materials.length).toBe(c.slotTruth.materials.length);
      if (c.slotTruth.isInverse) {
        expect(intent.target).toBeDefined();
      } else {
        expect(intent.energies.length).toBeGreaterThan(0);
      }
      expect(validateQueryIntent(intent, c.id)).toEqual([]);
    });
  }
});
