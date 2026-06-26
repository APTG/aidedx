import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compareIntent, evaluateExample, formatReport, runCoverage } from "./coverage.ts";
import { parseEvalRecords, type QueryIntent } from "./query-intent.ts";

const jsonl = readFileSync(resolve(process.cwd(), "eval/intents.jsonl"), "utf-8");
const records = parseEvalRecords(jsonl);

describe("compareIntent", () => {
  const base: QueryIntent = {
    quantity: "csdaRange",
    compareDim: "none",
    particles: [{ match: "protons" }],
    materials: [{ match: "water" }],
    energies: [{ value: 40, unit: "MeV" }],
    assumptions: [],
    confidence: 1,
  };

  it("treats phrasing-only differences as a match (entity identity)", () => {
    // "proton" vs "protons", "water" vs "liquid water" both resolve identically.
    const pred: QueryIntent = { ...base, particles: [{ match: "proton" }] };
    const v = compareIntent(pred, base);
    expect(v.particles).toBe(true);
    expect(v.materials).toBe(true);
  });

  it("flags a real entity difference", () => {
    const pred: QueryIntent = { ...base, particles: [{ match: "deuteron" }] };
    expect(compareIntent(pred, base).particles).toBe(false);
  });

  it("compares energies including the per-nucleon flag", () => {
    const pred: QueryIntent = {
      ...base,
      energies: [{ value: 40, unit: "MeV", perNucleonAssumed: true }],
    };
    expect(compareIntent(pred, base).energies).toBe(false);
  });
});

describe("evaluateExample", () => {
  it("scores a gold example it can reproduce as an exact match", () => {
    const example = records.find((r) => r.id === "sp-001");
    if (!example) throw new Error("fixture sp-001 missing from eval set");
    const result = evaluateExample(example);
    expect(result.exactMatch).toBe(true);
    expect(result.slotMatch).toBe(true);
  });
});

describe("runCoverage over the eval set", () => {
  const report = runCoverage(records);

  it("evaluates every record exactly once", () => {
    expect(report.results).toHaveLength(records.length);
    expect(report.total).toBe(records.length);
  });

  it("keeps the deterministic exact-intent coverage at a high baseline", () => {
    // The matcher is expected to hold ≥90% exact coverage of eval v0; a drop
    // below this is a regression. (It currently reaches 100%.)
    expect(report.exactMatches / report.total).toBeGreaterThanOrEqual(0.9);
  });

  it("lists exactly the non-exact examples as misses", () => {
    expect(report.misses).toHaveLength(report.total - report.exactMatches);
    expect(report.misses.every((m) => !m.exactMatch)).toBe(true);
  });

  it("partitions every example into a calibration band", () => {
    const counted = report.calibration.reduce((n, b) => n + b.total, 0);
    expect(counted).toBe(report.total);
  });

  it("renders a report mentioning coverage and misses", () => {
    const text = formatReport(report, { showMisses: true });
    expect(text).toContain("exact-intent");
    expect(text).toContain("Per-tag breakdown");
    expect(text).toContain("Confidence calibration");
    expect(text).toMatch(/LLM-fallback candidate/);
  });
});
