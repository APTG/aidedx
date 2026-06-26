/**
 * Deterministic-matcher coverage report (issue #5).
 *
 * Runs the deterministic NLU matcher over `eval/intents.jsonl` and prints
 * coverage %, a per-tag breakdown, confidence calibration, and the explicit
 * list of misses (the LLM-fallback candidates).
 *
 *   node scripts/coverage-intents.ts            (Node 24, per package.json engines)
 *   pnpm coverage:intents
 *
 * This is a *reported, non-blocking* metric: it always exits 0 so it never gates
 * CI. Pass `--threshold <pct>` to make it fail below a slot-coverage floor
 * (used locally / once the deterministic half is expected to hold a baseline).
 *
 * Runs as plain TypeScript via Node's native type stripping — no build step.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEvalRecords } from "../src/lib/intent/query-intent.ts";
import { formatReport, runCoverage } from "../src/lib/intent/coverage.ts";

const datasetPath = fileURLToPath(new URL("../eval/intents.jsonl", import.meta.url));
const examples = parseEvalRecords(readFileSync(datasetPath, "utf-8"));

const report = runCoverage(examples);
console.log(formatReport(report, { showMisses: true }));

// Optional local gate: `--threshold 60` fails if slot coverage drops below 60%.
const thresholdArg = process.argv.indexOf("--threshold");
if (thresholdArg !== -1) {
  const floor = Number(process.argv[thresholdArg + 1]);
  const slotPct = (100 * report.slotMatches) / report.total;
  if (Number.isFinite(floor) && slotPct < floor) {
    console.error(`\n✗ slot coverage ${slotPct.toFixed(1)}% is below threshold ${floor}%.`);
    process.exit(1);
  }
}

// Reported metric: never gate CI by default.
process.exit(0);
