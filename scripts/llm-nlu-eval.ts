/**
 * LLM NLU eval harness — Spike 2 (issue #8, lowered goal).
 *
 * Evaluates Qwen2.5-0.5B, Qwen2.5-1.5B, and Llama-3.2-1B (ONNX q4) on the
 * deterministic-matcher misses from eval/intents.jsonl. All models are already
 * cached in .hf-cache/onnx-community/.
 *
 * Measures per model:
 *   - JSON validity rate   (output parses + passes schema validation)
 *   - Slot accuracy        (quantity/compareDim/particles/materials/energies/target)
 *   - Exact-intent accuracy (slots + assumptions)
 *   - Median inference latency
 *
 * Lowered goal vs issue: prompt-level JSON enforcement instead of
 * grammar-constrained token-level decoding (not available in transformers.js).
 *
 * Usage:
 *   node scripts/llm-nlu-eval.ts                           # all 3 models, misses only
 *   node scripts/llm-nlu-eval.ts --all                     # full 120-example set
 *   node scripts/llm-nlu-eval.ts --model=Qwen2.5-0.5B-Instruct   # single model
 *   pnpm llm:nlu-eval
 *
 * Multi-model mode spawns one child process per model to avoid OOM from loading
 * all three models into the same Node.js heap.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pipeline, env } from "@huggingface/transformers";
import { parseEvalRecords, validateQueryIntent } from "../src/lib/intent/query-intent.ts";
import { compareIntent, runCoverage } from "../src/lib/intent/coverage.ts";
import type { EvalExample, QueryIntent } from "../src/lib/intent/query-intent.ts";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
env.cacheDir = path.join(PROJECT_ROOT, ".hf-cache");
env.allowLocalModels = false;

// ---------------------------------------------------------------------------
// Model list
// ---------------------------------------------------------------------------

const ALL_MODELS = [
  "onnx-community/Qwen2.5-0.5B-Instruct",
  "onnx-community/Qwen2.5-1.5B-Instruct",
  "onnx-community/Llama-3.2-1B-Instruct",
];

const DTYPE = "q4";

// ---------------------------------------------------------------------------
// Few-shot prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `\
You parse natural-language particle-physics queries into a JSON intent object.
Output ONLY valid JSON — no markdown, no explanation, nothing else.

Schema (all fields required unless marked optional):
{
  "quantity": "stoppingPower" | "csdaRange" | "energyFromRange" | "energyFromStp",
  "compareDim": "none" | "material" | "particle" | "energy" | "program",
  "particles": [{ "match": "<phrase>", "isotopeAssumed": "<isotope>" }],
  "materials":  [{ "match": "<phrase>" }],
  "energies":   [{ "value": <number>, "unit": "MeV"|"keV"|"GeV"|"MeV/nucl"|"MeV/u", "perNucleonAssumed": <bool> }],
  "target": { "value": <number>, "unit": "<string>" },
  "assumptions": ["<note>"],
  "confidence": 0.9
}

CRITICAL: quantity MUST be one of exactly these 4 strings:
  "stoppingPower"  — dE/dx, LET, linear energy transfer, stopping power, ionisation,
                     energy loss per length, energy deposition per length, Bethe-Bloch,
                     retarding force, dose per unit length
  "csdaRange"      — range, CSDA range, depth, penetration, "how far", "how deep"
  "energyFromRange" — ONLY when the query asks what energy achieves a GIVEN range
  "energyFromStp"  — ONLY when the query asks what energy achieves a GIVEN stopping power

compareDim: "material" if ≥2 materials; "particle" if ≥2 particles;
            "energy" if ≥2 energies; "program" if ≥2 programs; else "none"

Isotope defaults: carbon→¹²C  neon→²⁰Ne  oxygen→¹⁶O  helium→⁴He
  lithium→⁷Li  nitrogen→¹⁴N  argon→⁴⁰Ar  iron→⁵⁶Fe
When assumed, add "element → isotope" to assumptions and set isotopeAssumed on the particle.

For energyFromRange/energyFromStp: set energies=[] and target to the given value.
For all other quantities: target is omitted entirely.`;

// Few-shot pairs: [user query, assistant JSON]. NOT from the eval set.
const FEW_SHOT: [string, string][] = [
  [
    "Stopping power of 50 MeV protons in water.",
    '{"quantity":"stoppingPower","compareDim":"none","particles":[{"match":"protons"}],"materials":[{"match":"water"}],"energies":[{"value":50,"unit":"MeV"}],"assumptions":[],"confidence":0.97}',
  ],
  [
    "How far does a 200 MeV proton go in PMMA?",
    '{"quantity":"csdaRange","compareDim":"none","particles":[{"match":"proton"}],"materials":[{"match":"PMMA"}],"energies":[{"value":200,"unit":"MeV"}],"assumptions":[],"confidence":0.82}',
  ],
  [
    "Linear energy transfer of 80 MeV protons in silicon.",
    '{"quantity":"stoppingPower","compareDim":"none","particles":[{"match":"protons"}],"materials":[{"match":"silicon"}],"energies":[{"value":80,"unit":"MeV"}],"assumptions":[],"confidence":0.95}',
  ],
  [
    "Bethe-Bloch value for 120 MeV protons in aluminum.",
    '{"quantity":"stoppingPower","compareDim":"none","particles":[{"match":"protons"}],"materials":[{"match":"aluminum"}],"energies":[{"value":120,"unit":"MeV"}],"assumptions":[],"confidence":0.9}',
  ],
  [
    "Compare the range in water and bone for 150 MeV protons.",
    '{"quantity":"csdaRange","compareDim":"material","particles":[{"match":"protons"}],"materials":[{"match":"water"},{"match":"bone"}],"energies":[{"value":150,"unit":"MeV"}],"assumptions":[],"confidence":0.97}',
  ],
  [
    "What energy gives a 10 cm range for protons in water?",
    '{"quantity":"energyFromRange","compareDim":"none","particles":[{"match":"protons"}],"materials":[{"match":"water"}],"energies":[],"target":{"value":10,"unit":"cm"},"assumptions":[],"confidence":0.9}',
  ],
  [
    "Stopping power of carbon ions in water at 100 MeV/u.",
    '{"quantity":"stoppingPower","compareDim":"none","particles":[{"match":"carbon ions","isotopeAssumed":"¹²C"}],"materials":[{"match":"water"}],"energies":[{"value":100,"unit":"MeV/u","perNucleonAssumed":true}],"assumptions":["carbon → ¹²C"],"confidence":0.95}',
  ],
  [
    "Energy deposition density for 90 MeV protons in tissue.",
    '{"quantity":"stoppingPower","compareDim":"none","particles":[{"match":"protons"}],"materials":[{"match":"tissue"}],"energies":[{"value":90,"unit":"MeV"}],"assumptions":[],"confidence":0.9}',
  ],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Post-processing: map quantity values the model invents outside the enum
 * back to the nearest valid value. Improves schema-pass rate without grammar
 * constraints — catches the systematic "LET"/"betheBloch"/etc. pattern.
 */
const QUANTITY_NORMALISER: Array<[RegExp, string]> = [
  [/\blet\b|linear.?energy.?transfer/i, "stoppingPower"],
  [/bethe|bragg|retard|ionis|ioniz|dose.?per|dedx|stopping/i, "stoppingPower"],
  [/deposition|deposit/i, "stoppingPower"],
  [/energy.?from.?range|inv.*range/i, "energyFromRange"],
  [/energy.?from.?stp|inv.*stop/i, "energyFromStp"],
  [/range|penetrat|depth|csda/i, "csdaRange"],
];

const VALID_QUANTITIES = new Set([
  "stoppingPower",
  "csdaRange",
  "energyFromRange",
  "energyFromStp",
]);

function normaliseQuantity(raw: unknown): string | unknown {
  if (typeof raw !== "string") return raw;
  if (VALID_QUANTITIES.has(raw)) return raw;
  for (const [re, mapped] of QUANTITY_NORMALISER) {
    if (re.test(raw)) return mapped;
  }
  return raw;
}

function normalise(parsed: unknown): unknown {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return parsed;
  const obj = parsed as Record<string, unknown>;
  return { ...obj, quantity: normaliseQuantity(obj["quantity"]) };
}

function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to fence/brace extraction
  }
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(trimmed);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      // fall through to brace extraction
    }
  }
  const start = trimmed.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < trimmed.length; i++) {
    if (trimmed[i] === "{") depth++;
    else if (trimmed[i] === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          // fall through to return null
        }
        break;
      }
    }
  }
  return null;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

function pct(n: number, d: number): string {
  if (d === 0) return " n/a";
  return `${((100 * n) / d).toFixed(0).padStart(3)}%`;
}

// ---------------------------------------------------------------------------
// Per-model evaluation (runs in child process via --model=xxx)
// ---------------------------------------------------------------------------

interface ExampleResult {
  id: string;
  raw: string;
  jsonValid: boolean;
  slotMatch: boolean;
  exactMatch: boolean;
  latencyMs: number;
}

interface ModelReport {
  modelId: string;
  results: ExampleResult[];
}

async function evalModel(modelId: string, examples: EvalExample[]): Promise<ModelReport> {
  const shortName = modelId.split("/")[1] ?? modelId;
  console.log(`\n── ${shortName} ──────────────────────────────────`);
  console.log(`Loading model (dtype=${DTYPE})…`);
  const t0 = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const generator: any = await pipeline("text-generation", modelId, { dtype: DTYPE });
  console.log(`Loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const results: ExampleResult[] = [];

  for (const example of examples) {
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...FEW_SHOT.flatMap(([input, output]) => [
        { role: "user", content: input },
        { role: "assistant", content: output },
      ]),
      { role: "user", content: example.text },
    ];

    const t1 = Date.now();
    const out = await generator(messages, { max_new_tokens: 300, do_sample: false });
    const latencyMs = Date.now() - t1;

    const generated = out[0].generated_text;
    let raw: string;
    if (typeof generated === "string") {
      raw = generated.trim();
    } else {
      const last = Array.isArray(generated) ? generated.at(-1) : null;
      raw = (
        typeof last === "string" ? last : ((last as { content?: string })?.content ?? "")
      ).trim();
    }

    const parsed = normalise(extractJson(raw));
    const errors = parsed !== null ? validateQueryIntent(parsed) : ["no JSON found"];
    const jsonValid = errors.length === 0;

    let slotMatch = false;
    let exactMatch = false;
    if (jsonValid && parsed !== null) {
      const predicted = parsed as QueryIntent;
      const v = compareIntent(predicted, example.expected);
      slotMatch =
        v.quantity && v.compareDim && v.particles && v.materials && v.energies && v.target;
      exactMatch = slotMatch && v.assumptions;
    }

    const icon = exactMatch ? "✓" : slotMatch ? "~" : "✗";
    console.log(`  ${icon} ${example.id.padEnd(16)} ${latencyMs}ms`);
    if (!jsonValid) {
      const errMsg = errors[0] ?? "unknown error";
      // Show the field that's wrong and what the model actually output for it
      const quantityMatch = /"quantity"\s*:\s*"([^"]+)"/.exec(raw);
      const gotQuantity = quantityMatch?.[1] ?? "?";
      console.log(`    schema error: ${errMsg.replace("expected.", "")}`);
      console.log(`    got quantity: "${gotQuantity}"   raw[0..100]: ${raw.slice(0, 100)}`);
    } else if (!slotMatch) {
      const predicted = parsed as QueryIntent;
      if (predicted.quantity !== example.expected.quantity) {
        console.log(`    quantity: got=${predicted.quantity} want=${example.expected.quantity}`);
      }
    }

    results.push({ id: example.id, raw, jsonValid, slotMatch, exactMatch, latencyMs });
  }

  return { modelId, results };
}

// ---------------------------------------------------------------------------
// Summary table
// ---------------------------------------------------------------------------

function printSummary(reports: ModelReport[], n: number): void {
  console.log("\n" + "=".repeat(72));
  console.log("LLM NLU Spike 2 — results summary");
  console.log("=".repeat(72));
  console.log(
    `${"Model".padEnd(30)} ${"JSON%".padStart(5)}  ${"Slot%".padStart(5)}  ${"Exact%".padStart(6)}  ${"Med ms".padStart(7)}`,
  );
  console.log("-".repeat(72));
  for (const r of reports) {
    const name = (r.modelId.split("/")[1] ?? r.modelId).padEnd(30);
    const jsonN = r.results.filter((x) => x.jsonValid).length;
    const slotN = r.results.filter((x) => x.slotMatch).length;
    const exactN = r.results.filter((x) => x.exactMatch).length;
    const med = median(r.results.map((x) => x.latencyMs));
    console.log(
      `${name} ${pct(jsonN, n).padStart(5)}  ${pct(slotN, n).padStart(5)}  ${pct(exactN, n).padStart(6)}  ${String(Math.round(med)).padStart(7)}`,
    );
  }
  console.log("=".repeat(72));
  console.log(`n=${n} examples  |  ✓ exact  ~ slot-only  ✗ miss/invalid-schema`);
  console.log("Prompt-level JSON enforcement only (no grammar-constrained decoding).");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const runAll = args.includes("--all");
const modelArg = args.find((a) => a.startsWith("--model="))?.slice("--model=".length);
// Internal flag used when this process is the child for a single model.
const isSingleModelChild = modelArg !== undefined;
// Path to write JSON results when running as a child process.
const outFile = args.find((a) => a.startsWith("--out="))?.slice("--out=".length);

const datasetPath = fileURLToPath(new URL("../eval/intents.jsonl", import.meta.url));
const allExamples = parseEvalRecords(readFileSync(datasetPath, "utf-8"));

let evalExamples: EvalExample[];
if (runAll) {
  evalExamples = allExamples;
  if (!outFile) console.log(`Evaluating all ${evalExamples.length} examples.`);
} else {
  const coverage = runCoverage(allExamples);
  evalExamples = coverage.misses.map((r) => ({
    id: r.id,
    text: r.text,
    expected: r.expected,
    tags: r.tags,
  }));
  if (evalExamples.length === 0) {
    console.log("No deterministic misses — use --all to run on the full set.");
    process.exit(0);
  }
  if (!outFile) {
    console.log(
      `Deterministic matcher: ${coverage.exactMatches}/${coverage.total} exact-intent. ` +
        `Evaluating ${evalExamples.length} miss(es) as LLM targets.`,
    );
  }
}

if (isSingleModelChild) {
  // ── Child process: evaluate one model and write JSON results ──────────────
  const fullModelId = `onnx-community/${modelArg}`;
  const report = await evalModel(fullModelId, evalExamples);
  if (outFile) {
    writeFileSync(outFile, JSON.stringify(report));
  }
} else {
  // ── Orchestrator: spawn one child process per model ───────────────────────
  const modelsToRun = ALL_MODELS;
  const reports: ModelReport[] = [];
  const tmpDir = path.join(PROJECT_ROOT, "node_modules", ".cache");
  mkdirSync(tmpDir, { recursive: true });

  const allArg = runAll ? ["--all"] : [];

  for (const modelId of modelsToRun) {
    const shortName = modelId.split("/")[1] ?? modelId;
    const tmpOut = path.join(
      PROJECT_ROOT,
      "node_modules",
      ".cache",
      `llm-nlu-eval-${shortName}.json`,
    );

    console.log(`\nSpawning child for ${shortName}…`);
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), `--model=${shortName}`, `--out=${tmpOut}`, ...allArg],
      {
        stdio: "inherit",
        encoding: "utf-8",
        timeout: 600_000, // 10 min per model
      },
    );

    if (result.status !== 0) {
      console.error(
        `\n✗ ${shortName} exited with code ${result.status ?? "signal:" + result.signal}`,
      );
      continue;
    }

    try {
      const saved = JSON.parse(readFileSync(tmpOut, "utf-8")) as ModelReport;
      reports.push(saved);
    } catch (e) {
      console.error(`✗ Could not read results for ${shortName}: ${e}`);
    }
  }

  if (reports.length > 0) {
    printSummary(reports, evalExamples.length);
  }
}
