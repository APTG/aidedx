/**
 * End-to-end audio → intent accuracy.
 * Saved ASR transcripts → correction layer → deterministic matcher → compareIntent
 * against the eval set's expected QueryIntent. This is the metric that matters
 * for the voice pipeline (transcript fidelity is only a proxy).
 *
 * Usage: node scripts/e2e-audio-intents.ts <asr-results.json> [--base]
 *   --base  use the shipped asr-correct.mjs instead of the extended experiment layer
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { matchIntent } from "../src/lib/intent/matcher.ts";
import { compareIntent } from "../src/lib/intent/coverage.ts";
import { parseEvalRecords } from "../src/lib/intent/query-intent.ts";
// @ts-expect-error plain JS module
import { correct as baseCorrect } from "./asr-correct.mjs";
// @ts-expect-error plain JS module
import { correct as extCorrect } from "./asr-correct-ext.mjs";

const useBase = process.argv.includes("--base");
const correct = useBase ? baseCorrect : extCorrect;

const evalPath = fileURLToPath(new URL("../eval/intents.jsonl", import.meta.url));
const byId = new Map(parseEvalRecords(readFileSync(evalPath, "utf-8")).map((e) => [e.id, e]));

for (const file of process.argv.slice(2).filter((a) => !a.startsWith("--"))) {
  const data = JSON.parse(readFileSync(file, "utf-8"));
  let slotOkRaw = 0,
    slotOkCor = 0,
    n = 0;
  const perSpeaker: Record<string, { cor: number; n: number }> = {};
  const failures: string[] = [];

  // Also compute the text-only ceiling: matcher on the *ground-truth* sentence.
  let ceilingOk = 0;
  const ceilingIds = new Set<string>();

  for (const r of data.records) {
    if (r.error) continue;
    const ex = byId.get(r.id);
    if (!ex) continue;
    n++;
    if (!ceilingIds.has(r.id)) {
      ceilingIds.add(r.id);
      const v = compareIntent(matchIntent(ex.text).intent, ex.expected);
      if (v.quantity && v.compareDim && v.particles && v.materials && v.energies && v.target)
        ceilingOk++;
    }
    const score = (text: string) => {
      const v = compareIntent(matchIntent(text).intent, ex.expected);
      return v.quantity && v.compareDim && v.particles && v.materials && v.energies && v.target;
    };
    const okRaw = score(r.raw);
    const okCor = score(correct(r.raw));
    if (okRaw) slotOkRaw++;
    if (okCor) slotOkCor++;
    perSpeaker[r.speaker] ??= { cor: 0, n: 0 };
    perSpeaker[r.speaker].n++;
    if (okCor) perSpeaker[r.speaker].cor++;
    if (!okCor) {
      const v = compareIntent(matchIntent(correct(r.raw)).intent, ex.expected);
      const bad = Object.entries(v)
        .filter(([k, ok]) => !ok && k !== "assumptions")
        .map(([k]) => k);
      failures.push(`  ${r.speaker}/${r.id} [${bad.join(",")}]: ${correct(r.raw)}`);
    }
  }

  console.log(
    `\n=== E2E ${data.modelId} [${data.dtype}] corrector=${useBase ? "base" : "extended"} ===`,
  );
  console.log(
    `audio→intent slot-match: raw ${slotOkRaw}/${n} (${((100 * slotOkRaw) / n).toFixed(0)}%)  corrected ${slotOkCor}/${n} (${((100 * slotOkCor) / n).toFixed(0)}%)`,
  );
  console.log(
    `text-only matcher ceiling on these ${ceilingIds.size} sentences: ${ceilingOk}/${ceilingIds.size} (${((100 * ceilingOk) / ceilingIds.size).toFixed(0)}%)`,
  );
  console.log(
    `per speaker (corrected): ${Object.entries(perSpeaker)
      .map(([k, v]) => `${k} ${v.cor}/${v.n}`)
      .join("   ")}`,
  );
  console.log(`failures (${failures.length}):`);
  for (const f of failures.slice(0, 30)) console.log(f);
}
