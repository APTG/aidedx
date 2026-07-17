/**
 * Text-mode intent + compute validator for candidate TTS eval sentences (issue #30).
 *
 * For each candidate sentence, runs the *real* aidedx pipeline exactly as the text-query
 * UI would: the deterministic matcher (`matchIntent`) then `computeIntent` against the
 * actual vendored libdedx WASM (never a guess/LLM). A sentence only counts as usable when
 * it produces a complete intent AND a finite, error-free, physically-positive numeric
 * result — matching this project's "numbers only ever from libdedx" rule.
 *
 * Usage:
 *   node --experimental-strip-types scripts/tts-sentence-check.ts <sentences.json> [--json out.json]
 *
 * <sentences.json>: [{ "id": "...", "text": "..." }, ...]
 * Exit code 0 iff every candidate passes; otherwise prints each failure's reason so
 * wording can be fixed and the script re-run.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

import { LibdedxServiceImpl } from "../src/lib/wasm/libdedx.ts";
import type { LibdedxModuleFactory, LibdedxService } from "../src/lib/wasm/types.ts";
import { matchIntent } from "../src/lib/intent/matcher.ts";
import { computeIntent, ComputeError } from "../src/lib/compute/compute.ts";
import { validateQueryIntent, type QueryIntent } from "../src/lib/intent/query-intent.ts";

interface Candidate {
  id: string;
  text: string;
}

export interface CheckResult {
  id: string;
  text: string;
  ok: boolean;
  reason?: string;
  intent?: QueryIntent;
  quantitySource?: string;
  confidence?: number;
  /** Human-readable summary of the first numeric result, for eyeballing plausibility. */
  numericSummary?: string;
}

/** Loads the vendored libdedx WASM service. Exported for reuse by the generator
 * (scripts/generate-1000-sentences.mjs), which validates candidates inline as it builds
 * them rather than as a separate pass. */
export async function loadService(): Promise<LibdedxService> {
  const here = dirname(fileURLToPath(import.meta.url));
  const wasmDir = resolve(here, "..", "static", "wasm");
  const mjsUrl = pathToFileURL(join(wasmDir, "libdedx.mjs")).href;
  const factory = (await import(/* @vite-ignore */ mjsUrl)).default as LibdedxModuleFactory;
  const module = await factory({
    locateFile: (f: string) => join(wasmDir, f),
    print: () => {},
    printErr: () => {},
  });
  const service = new LibdedxServiceImpl(module);
  await service.init();
  return service;
}

function summarizePoint(intent: QueryIntent, point: Record<string, unknown>): string {
  const isInverse = intent.quantity === "energyFromRange" || intent.quantity === "energyFromStp";
  if (isInverse) return `energy ≈ ${Number(point.energy).toPrecision(4)} MeV/nucl`;
  if (intent.quantity === "stoppingPower")
    return `stoppingPower ≈ ${Number(point.stoppingPower).toPrecision(4)} MeV·cm²/g`;
  return `csdaRange ≈ ${Number(point.csdaRange).toPrecision(4)} g/cm²`;
}

/** Check one candidate. Never throws — failures are reported, not raised. */
export function checkCandidate(candidate: Candidate, service: LibdedxService): CheckResult {
  const { id, text } = candidate;
  const { intent, quantitySource, incomplete } = matchIntent(text);

  // "default" means the matcher never recognized *any* quantity keyword/idiom and
  // silently fell back to csdaRange — a wrong guess that can still compute a number.
  // Only count a sentence as understood when a real strategy (direct/indirect/inverse)
  // actually fired.
  if (quantitySource === "default") {
    return {
      id,
      text,
      ok: false,
      reason: "quantity not recognized — matcher silently defaulted to csdaRange",
      intent,
      quantitySource,
    };
  }
  // Checked before schema validation, not after: an inverse intent missing its target
  // fails validateQueryIntent() too (`target: required for quantity "..."`), which would
  // otherwise short-circuit here with that one generic message instead of this branch's
  // fuller "missing: particle, material, target" picture — strictly more useful for fixing
  // sentence wording, and the schema error in that case is just a symptom of the same
  // incompleteness, not a separate problem.
  if (incomplete) {
    const missing: string[] = [];
    if (intent.particles.length === 0) missing.push("particle");
    if (intent.materials.length === 0) missing.push("material");
    const needsEnergy =
      intent.quantity !== "energyFromRange" && intent.quantity !== "energyFromStp";
    if (needsEnergy && intent.energies.length === 0) missing.push("energy");
    if (!needsEnergy && intent.target === undefined) missing.push("target");
    return {
      id,
      text,
      ok: false,
      reason: `incomplete intent — missing: ${missing.join(", ") || "unknown slot"}`,
      intent,
      quantitySource,
    };
  }

  const schemaErrors = validateQueryIntent(intent);
  if (schemaErrors.length > 0) {
    return { id, text, ok: false, reason: `schema: ${schemaErrors.join("; ")}`, intent };
  }

  let result;
  try {
    result = computeIntent(intent, service);
  } catch (e) {
    const msg = e instanceof ComputeError ? e.message : String(e);
    return { id, text, ok: false, reason: `ComputeError: ${msg}`, intent, quantitySource };
  }

  const failedSeries = result.series.filter((s) => s.error || s.points.length === 0);
  if (failedSeries.length > 0) {
    const reasons = failedSeries.map((s) => s.error ?? `${s.label}: no points returned`);
    return {
      id,
      text,
      ok: false,
      reason: `series error(s): ${reasons.join(" | ")}`,
      intent,
      quantitySource,
    };
  }

  // Every series must carry a finite, positive number in the field the quantity actually
  // uses — "no exception raised" is not "meaningful output" (an energyFromStp target fed
  // a unit the converter silently mis-scales would still produce *a* finite number).
  const isInverse = intent.quantity === "energyFromRange" || intent.quantity === "energyFromStp";
  for (const s of result.series) {
    const p = s.points[0];
    if (!p)
      return { id, text, ok: false, reason: `${s.label}: empty points`, intent, quantitySource };
    const value = isInverse
      ? p.energy
      : intent.quantity === "stoppingPower"
        ? p.stoppingPower
        : p.csdaRange;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return {
        id,
        text,
        ok: false,
        reason: `${s.label}: non-finite/non-positive result (${String(value)})`,
        intent,
        quantitySource,
      };
    }
  }

  const firstPoint = result.series[0]?.points[0] as Record<string, unknown> | undefined;
  return {
    id,
    text,
    ok: true,
    intent,
    quantitySource,
    confidence: intent.confidence,
    numericSummary: firstPoint ? summarizePoint(intent, firstPoint) : undefined,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOutIdx = args.indexOf("--json");
  const jsonOutPath = jsonOutIdx >= 0 ? args[jsonOutIdx + 1] : undefined;
  const inputPath = args.filter((a) => a !== "--json" && a !== jsonOutPath)[0];
  if (!inputPath) {
    console.error(
      "Usage: node --experimental-strip-types scripts/tts-sentence-check.ts <sentences.json> [--json out.json]",
    );
    process.exit(1);
  }

  const candidates: Candidate[] = JSON.parse(readFileSync(inputPath, "utf-8"));
  const service = await loadService();

  const results = candidates.map((c) => checkCandidate(c, service));
  const passed = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  for (const r of results) {
    if (r.ok) {
      console.log(
        `  PASS ${r.id}  [${r.quantitySource}, conf=${r.confidence}]  ${r.numericSummary}`,
      );
    } else {
      console.log(`  FAIL ${r.id}  ${r.reason}`);
      console.log(`       "${r.text}"`);
    }
  }
  console.log(`\n${passed.length}/${results.length} passed`);

  if (jsonOutPath) {
    writeFileSync(jsonOutPath, JSON.stringify(results, null, 2));
    console.log(`wrote ${jsonOutPath}`);
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith("tts-sentence-check.ts")) {
  main();
}
