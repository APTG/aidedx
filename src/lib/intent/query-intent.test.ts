import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVAL_TAGS,
  validateEvalDataset,
  validateQueryIntent,
  type QueryIntent,
} from "./query-intent.js";

// Resolved from the project root (Vitest's cwd) so it works regardless of how
// import.meta.url is scheme-mangled by the test runtime.
const jsonl = readFileSync(resolve(process.cwd(), "eval/intents.jsonl"), "utf-8");

describe("eval/intents.jsonl", () => {
  const report = validateEvalDataset(jsonl);

  it("contains no schema violations", () => {
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("has at least 100 validated examples", () => {
    expect(report.count).toBeGreaterThanOrEqual(100);
  });

  it("includes both §7 stress-test sentences", () => {
    const lines = jsonl
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { text: string; tags: string[] });
    const stress = lines.filter((l) => l.tags.includes("stress-test"));
    expect(stress).toHaveLength(2);
    const texts = stress.map((s) => s.text);
    expect(texts.some((t) => t.includes("240 keV carbon ion"))).toBe(true);
    expect(texts.some((t) => t.toLowerCase().includes("neon ions in water and air"))).toBe(true);
  });

  it("uses only tags from the documented taxonomy", () => {
    const lines = jsonl
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { tags: string[] });
    const used = new Set(lines.flatMap((l) => l.tags));
    for (const tag of used) {
      expect(EVAL_TAGS).toContain(tag);
    }
  });

  it("covers every required category from issue #3", () => {
    const lines = jsonl
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { tags: string[] });
    const used = new Set(lines.flatMap((l) => l.tags));
    const required = [
      "direct",
      "indirect",
      "conversational-filler",
      "compare-material",
      "compare-particle",
      "compare-energy",
      "unit-keV",
      "unit-MeV",
      "unit-GeV",
      "unit-mev-per-nucl",
      "unit-mev-per-u",
      "total-vs-per-nucleon",
      "isotope-ambiguity",
      "inverse-query",
      "stress-test",
    ];
    for (const tag of required) {
      expect(used).toContain(tag);
    }
  });
});

describe("validateQueryIntent", () => {
  const valid: QueryIntent = {
    quantity: "stoppingPower",
    compareDim: "none",
    particles: [{ match: "proton" }],
    materials: [{ match: "water" }],
    energies: [{ value: 40, unit: "MeV" }],
    assumptions: [],
    confidence: 1,
  };

  it("accepts a well-formed intent", () => {
    expect(validateQueryIntent(valid)).toEqual([]);
  });

  it("rejects an unknown quantity", () => {
    const errors = validateQueryIntent({ ...valid, quantity: "bananas" });
    expect(errors.some((e) => e.includes("quantity"))).toBe(true);
  });

  it("rejects a bad energy unit", () => {
    const errors = validateQueryIntent({ ...valid, energies: [{ value: 1, unit: "joules" }] });
    expect(errors.some((e) => e.includes("unit"))).toBe(true);
  });

  it("requires a target for inverse quantities", () => {
    const errors = validateQueryIntent({ ...valid, quantity: "energyFromRange", energies: [] });
    expect(errors.some((e) => e.includes("target"))).toBe(true);
  });

  it("rejects a target on a forward quantity", () => {
    const errors = validateQueryIntent({ ...valid, target: { value: 10, unit: "cm" } });
    expect(errors.some((e) => e.includes("target"))).toBe(true);
  });

  it("rejects out-of-range confidence", () => {
    const errors = validateQueryIntent({ ...valid, confidence: 2 });
    expect(errors.some((e) => e.includes("confidence"))).toBe(true);
  });
});
