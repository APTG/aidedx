/**
 * End-to-end audio → intent accuracy for the benchmark-data-generator sentence set (issue
 * #130 Part 3). Same metric and corrector pipeline as scripts/e2e-audio-intents.ts — saved
 * ASR transcripts → correction layer → deterministic matcher → compareIntent — but two
 * differences from that script, both because eval/datagen-sentences.json isn't
 * eval/intents.jsonl:
 *
 *  - Ground truth isn't a hand-authored `expected` field (datagen-sentences.json has none —
 *    it carries `slotTruth` instead, for scripts/asr-score-slots-generic.mjs). It's derived by
 *    re-matching each record's own `canonical` text: scripts/validate-datagen-sentences.ts's
 *    `checkCandidate()` gate already proved every canonical sentence resolves to a complete,
 *    schema-valid, libdedx-computable intent, so `matchIntent(canonical, lang).intent` IS a
 *    trustworthy ground truth here — the same "ceiling" computation
 *    scripts/e2e-audio-intents.ts already does for its own eval set, just promoted from a
 *    reported ceiling to the actual comparison target.
 *  - `lang` is a required argument, threaded through `matchIntent(text, lang)` — the datagen
 *    set is bilingual and DataGenActivity's results files are already split by language
 *    (`results-<model>-<lang>.json`), so there's no ambiguity to default away the way
 *    e2e-audio-intents.ts defaults to "en" for its (today) English-only eval set.
 *
 * Also reports word error rate (WER) against `canonical` — transcript fidelity is only a
 * proxy for the E2E metric (per e2e-audio-intents.ts's own doc comment), but it's a useful
 * secondary read on raw ASR quality independent of whether the matcher recovers from it.
 *
 * Usage: node scripts/e2e-audio-intents-datagen.ts <en|pl> <asr-results.json> [more.json...] [--base|--ext]
 */
import { readFileSync } from "node:fs";
import { matchIntent } from "../src/lib/intent/matcher.ts";
import { compareIntent } from "../src/lib/intent/coverage.ts";
import type { Lang } from "../src/lib/intent/lang/types.ts";
// @ts-expect-error plain JS module
import { correct as baseCorrect } from "./asr-correct.mjs";
// @ts-expect-error plain JS module
import { correct as extCorrect } from "./asr-correct-ext.mjs";
import { correctTranscript as newCorrect } from "../src/lib/asr/correct/core.ts";

const useBase = process.argv.includes("--base");
const useExt = process.argv.includes("--ext");
const correct = useBase
  ? baseCorrect
  : useExt
    ? extCorrect
    : (text: string) => newCorrect(text).text;
const correctorLabel = useBase ? "legacy-base" : useExt ? "legacy-ext" : "shipped";

const [langArg, ...files] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (langArg !== "en" && langArg !== "pl") {
  console.error(
    "Usage: node scripts/e2e-audio-intents-datagen.ts <en|pl> <results.json> [...] [--base|--ext]",
  );
  process.exit(1);
}
const lang = langArg as Lang;

interface DatagenSide {
  canonical: string;
  display: string;
}
interface DatagenRecord {
  id: string;
  quantity: string;
  en: DatagenSide;
  pl: DatagenSide;
}

const sentencesPath = new URL("../eval/datagen-sentences.json", import.meta.url);
const byId = new Map(
  (JSON.parse(readFileSync(sentencesPath, "utf-8")) as DatagenRecord[]).map((r) => [r.id, r]),
);

/** Word-level Levenshtein edit distance / reference word count — standard WER. Case- and
 * punctuation-insensitive (a raw ASR transcript never carries the reference's punctuation, so
 * comparing it directly would just count every clip's own style as an error). */
function wer(hypothesis: string, reference: string): number {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[.,?!;:]/g, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  const ref = norm(reference);
  const hyp = norm(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  const dp: number[][] = Array.from({ length: ref.length + 1 }, () =>
    new Array(hyp.length + 1).fill(0),
  );
  for (let i = 0; i <= ref.length; i++) dp[i][0] = i;
  for (let j = 0; j <= hyp.length; j++) dp[0][j] = j;
  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= hyp.length; j++) {
      if (ref[i - 1] === hyp[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[ref.length][hyp.length] / ref.length;
}

for (const file of files) {
  const data = JSON.parse(readFileSync(file, "utf-8"));
  let slotOkRaw = 0,
    slotOkCor = 0,
    n = 0;
  let werSum = 0;
  const perSpeaker: Record<string, { cor: number; n: number }> = {};
  const failures: string[] = [];

  for (const r of data.records) {
    if (r.error) continue;
    const ex = byId.get(r.id);
    if (!ex) continue;
    const side = ex[lang];
    n++;

    const expected = matchIntent(side.canonical, lang).intent;
    const score = (text: string) => {
      const v = compareIntent(matchIntent(text, lang).intent, expected);
      return v.quantity && v.compareDim && v.particles && v.materials && v.energies && v.target;
    };
    const corrected = correct(r.raw);
    const okRaw = score(r.raw);
    const okCor = score(corrected);
    if (okRaw) slotOkRaw++;
    if (okCor) slotOkCor++;
    werSum += wer(r.raw, side.canonical);

    perSpeaker[r.speaker] ??= { cor: 0, n: 0 };
    perSpeaker[r.speaker].n++;
    if (okCor) perSpeaker[r.speaker].cor++;
    if (!okCor) {
      const v = compareIntent(matchIntent(corrected, lang).intent, expected);
      const bad = Object.entries(v)
        .filter(([k, ok]) => !ok && k !== "assumptions")
        .map(([k]) => k);
      failures.push(`  ${r.speaker}/${r.id} [${bad.join(",")}]: ${corrected}`);
    }
  }

  console.log(
    `\n=== E2E (datagen, ${lang}) ${data.modelId} [${data.dtype}] corrector=${correctorLabel} ===`,
  );
  console.log(
    `audio→intent slot-match: raw ${slotOkRaw}/${n} (${((100 * slotOkRaw) / n).toFixed(0)}%)  corrected ${slotOkCor}/${n} (${((100 * slotOkCor) / n).toFixed(0)}%)`,
  );
  console.log(`mean WER vs. canonical (raw transcript): ${((100 * werSum) / n).toFixed(1)}%`);
  console.log(
    `per speaker (corrected): ${Object.entries(perSpeaker)
      .map(([k, v]) => `${k} ${v.cor}/${v.n}`)
      .join("   ")}`,
  );
  console.log(`failures (${failures.length}):`);
  for (const f of failures.slice(0, 30)) console.log(f);
}
