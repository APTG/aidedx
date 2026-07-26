/**
 * Score scripts/submit-lecture-clip-bench.sh's output (issue #118 §8 follow-up): for each
 * (model, dtype) combo, how often does the transcript actually contain the unit that's really in
 * the audio (per manifest.json's `expected_unit`, backed by the MIT lectures' own `.srt` ground
 * truth, not ASR guesswork — see docs/unit-pronunciation-asr.md §8)?
 *
 * Runs LOCALLY after `scripts/sync-athena-to-local.sh eval/results/lecture-clip-bench-<jobid>` —
 * no GPU, no model loading. Scores two ways per clip/unit:
 *   - raw:       does the untouched Whisper transcript contain the unit (case-insensitive)?
 *   - corrected: does it contain the unit AFTER running through the actual shipped corrector
 *                (`src/lib/asr/correct/core.ts`'s `correctTranscript`), the same pass the real
 *                app applies before the NLU matcher ever sees the text? This is the number that
 *                matters for "would the app get this right", not the raw ASR string.
 * One clip (`10-01-mechanism__kev-mev__1`) expects two units (`keV+MeV`) and counts as two scoring
 * opportunities, not one.
 *
 * Usage:
 *   node --experimental-strip-types scripts/lecture-clip-bench-analyze.mjs <results_dir> [--json out.json]
 */
import { readFileSync, readdirSync, writeFileSync } from "fs";
import path from "path";
import { correctTranscript } from "../src/lib/asr/correct/core.ts";

const resultsDir = process.argv[2];
const jsonFlagIdx = process.argv.indexOf("--json");
const jsonOut = jsonFlagIdx >= 0 ? process.argv[jsonFlagIdx + 1] : null;

if (!resultsDir) {
  console.error(
    "Usage: node --experimental-strip-types scripts/lecture-clip-bench-analyze.mjs <results_dir> [--json out.json]",
  );
  process.exit(1);
}

const manifestPath = path.join(resultsDir, "manifest.json");
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
} catch (e) {
  console.error(
    `could not read ${manifestPath} (${e.message}) — was it copied by the submit script?`,
  );
  process.exit(1);
}
const clips = manifest.clips ?? manifest;

// One (clip id, unit) row per expected unit — the dual-unit clip contributes two rows.
const opportunities = [];
for (const clip of clips) {
  const units = String(clip.expected_unit).split("+");
  for (const unit of units) opportunities.push({ id: clip.id, unit });
}

function hasUnit(text, unit) {
  const re = new RegExp(`\\b${unit}\\b`, "i");
  return re.test(text);
}

const comboFiles = readdirSync(resultsDir).filter(
  (f) => f.endsWith(".json") && f !== "manifest.json",
);
if (comboFiles.length === 0) {
  console.error(`no <model>__<dtype>.json transcript files found in ${resultsDir}`);
  process.exit(1);
}

const report = [];
for (const file of comboFiles.sort()) {
  const combo = file.slice(0, -".json".length);
  const data = JSON.parse(readFileSync(path.join(resultsDir, file), "utf-8"));
  const records = data.records ?? data;
  const byId = new Map(records.map((r) => [r.id, r]));

  const missed = [];
  let rawHits = 0;
  let correctedHits = 0;
  let totalSecs = 0;
  let nSecs = 0;
  for (const { id, unit } of opportunities) {
    const rec = byId.get(id);
    const raw = rec?.raw ?? "";
    if (rec && typeof rec.secs === "number") {
      totalSecs += rec.secs;
      nSecs += 1;
    }
    const rawHit = hasUnit(raw, unit);
    const corrected = correctTranscript(raw).text;
    const correctedHit = hasUnit(corrected, unit);
    if (rawHit) rawHits += 1;
    if (correctedHit) correctedHits += 1;
    if (!correctedHit) missed.push({ id, unit, raw });
  }

  report.push({
    combo,
    total: opportunities.length,
    rawHits,
    correctedHits,
    avgSecsPerClip: nSecs ? totalSecs / nSecs : null,
    missed,
  });
}

report.sort((a, b) => b.correctedHits - a.correctedHits || b.rawHits - a.rawHits);

console.log(
  `${opportunities.length} unit-recognition opportunities across ${clips.length} clips\n`,
);
console.log(
  `${"model/dtype".padEnd(28)} ${"raw".padStart(8)} ${"corrected".padStart(10)} ${"avg s/clip".padStart(11)}  missed (after correction)`,
);
for (const r of report) {
  const rawStr = `${r.rawHits}/${r.total}`;
  const corrStr = `${r.correctedHits}/${r.total}`;
  const secsStr = r.avgSecsPerClip !== null ? r.avgSecsPerClip.toFixed(2) : "  -  ";
  const missedStr = r.missed.length
    ? r.missed
        .map((m) => `${m.id}(${m.unit}, heard ${JSON.stringify(m.raw.slice(0, 60))})`)
        .join("; ")
    : "(none)";
  console.log(
    `${r.combo.padEnd(28)} ${rawStr.padStart(8)} ${corrStr.padStart(10)} ${secsStr.padStart(11)}  ${missedStr}`,
  );
}

console.log(
  "\nInterpretation: 'raw' = untouched Whisper transcript contains the unit; 'corrected' = after " +
    "\nsrc/lib/asr/correct/core.ts's correctTranscript() — the same pass the shipped app runs " +
    "\nbefore the NLU matcher. corrected > raw means the corrector recovered a mishearing the " +
    "\nraw model missed; corrected < total means even the shipped corrector doesn't save it.",
);

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(report, null, 1));
  console.error(`\nwrote ${jsonOut}`);
}
