/**
 * Standalone validator for the eval set (issue #3).
 *
 * Validates `eval/intents.jsonl` against the shared QueryIntent schema and
 * prints a short coverage summary. Exits non-zero on any violation so it can
 * gate CI.
 *
 *   node scripts/validate-intents.ts            (Node 22.18+ / 24 — default)
 *   pnpm validate:eval
 *
 * Runs as plain TypeScript via Node's native type stripping — no build step.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateEvalDataset } from "../src/lib/intent/query-intent.ts";

const datasetPath = fileURLToPath(new URL("../eval/intents.jsonl", import.meta.url));
const jsonl = readFileSync(datasetPath, "utf-8");
const report = validateEvalDataset(jsonl);

const MIN_EXAMPLES = 100;

if (!report.ok) {
  console.error(`✗ ${report.errors.length} validation error(s) in eval/intents.jsonl:\n`);
  for (const err of report.errors) console.error(`  - ${err}`);
  process.exit(1);
}

if (report.count < MIN_EXAMPLES) {
  console.error(`✗ only ${report.count} examples; need at least ${MIN_EXAMPLES}.`);
  process.exit(1);
}

// Coverage summary by tag — handy when extending the set.
const tagCounts = new Map<string, number>();
for (const raw of jsonl.split("\n")) {
  const line = raw.trim();
  if (line.length === 0) continue;
  const { tags } = JSON.parse(line) as { tags: string[] };
  for (const tag of tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
}

console.log(`✓ ${report.count} examples validated against the QueryIntent schema.\n`);
console.log("Tag coverage:");
for (const tag of [...tagCounts.keys()].sort()) {
  console.log(`  ${tag.padEnd(28)} ${tagCounts.get(tag)}`);
}
