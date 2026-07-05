/**
 * Quantity-synonym pre-pass before the deterministic matcher
 * (docs/voice-pipeline-feasibility.md §2.6).
 * Maps domain synonyms of "stopping power" (LET, ionisation, Bethe-Bloch, …)
 * onto the canonical keyword, then runs the full 120-example coverage.
 * If this reaches 120/120, no LLM is needed for the current eval set at all.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { matchIntent } from "../src/lib/intent/matcher.ts";
import { compareIntent } from "../src/lib/intent/coverage.ts";
import { parseEvalRecords } from "../src/lib/intent/query-intent.ts";

const QUANTITY_SYNONYMS: Array<[RegExp, string]> = [
  [/\blinear energy transfer\b/gi, "stopping power"],
  [/\bLET\b/g, "stopping power"],
  [/\bspecific ionisation\b|\bspecific ionization\b/gi, "stopping power"],
  [/\bbethe-?bloch(?:\s+value)?\b/gi, "stopping power"],
  [/\bretarding force\b/gi, "stopping power"],
  [/\benergy deposition(?:\s+density)?\b/gi, "stopping power"],
  [/\bvolumetric stopping power\b/gi, "stopping power"],
  [/\b(?:radiation\s+)?dose per micromet(?:er|re)\b/gi, "stopping power"],
  [/\benergy (?:is )?deposited per micromet(?:er|re)\b/gi, "stopping power lost"],
];

function prepass(text: string): string {
  let t = text;
  for (const [re, sub] of QUANTITY_SYNONYMS) t = t.replace(re, sub);
  return t;
}

const evalPath = fileURLToPath(new URL("../eval/intents.jsonl", import.meta.url));
const examples = parseEvalRecords(readFileSync(evalPath, "utf-8"));

let okPlain = 0,
  okPre = 0;
const stillFailing: string[] = [];
for (const ex of examples) {
  const score = (text: string) => {
    const v = compareIntent(matchIntent(text).intent, ex.expected);
    return v.quantity && v.compareDim && v.particles && v.materials && v.energies && v.target;
  };
  if (score(ex.text)) okPlain++;
  if (score(prepass(ex.text))) okPre++;
  else stillFailing.push(`  ${ex.id}: ${prepass(ex.text)}`);
}
console.log(`plain matcher   : ${okPlain}/${examples.length}`);
console.log(`with pre-pass   : ${okPre}/${examples.length}`);
console.log(`still failing (${stillFailing.length}):`);
for (const f of stillFailing) console.log(f);
