/**
 * Slot-token scorer for a large, manifest-driven ASR transcript batch (the 1000-sentence
 * scale-up). scripts/asr-score-slots.mjs derives its SLOTS from a hand-written table keyed
 * to 30 fixed sentence IDs — impractical to hand-author at 1000. This script derives the
 * same category of slots (number/unit/particle/material/quantity) programmatically from
 * each clip's `slotTruth`, which was recorded at *generation* time from the exact words/
 * values the sentence was built from (scripts/generate-1000-sentences.mjs) — not reverse-
 * engineered from the parsed intent.
 *
 * Reuses scripts/asr-correct.mjs / asr-correct-ext.mjs unmodified: this measures the
 * existing correction layer's real behavior, not a new one. --new instead scores
 * src/lib/asr/correct (issue #28's regex fast path + phonetic pass, now shipped).
 *
 * Usage:
 *   node scripts/asr-score-slots-generic.mjs <manifest.json> <results.json> [--ext|--new] [--json out.json]
 */
import { readFileSync, writeFileSync } from "fs";
import { correct as baseCorrect } from "./asr-correct.mjs";
import { correct as extCorrect } from "./asr-correct-ext.mjs";
import { correctTranscript as newCorrect } from "../src/lib/asr/correct/core.ts";

const useExt = process.argv.includes("--ext");
const useNew = process.argv.includes("--new");
const correct = useNew ? (text) => newCorrect(text).text : useExt ? extCorrect : baseCorrect;
const jsonOutIdx = process.argv.indexOf("--json");
const jsonOutPath = jsonOutIdx >= 0 ? process.argv[jsonOutIdx + 1] : undefined;

const [manifestPath, resultsPath] = process.argv
  .slice(2)
  .filter((a) => a !== "--ext" && a !== "--json" && a !== jsonOutPath);

// --- Same normalization as scripts/asr-score-slots.mjs ---
function norm(text) {
  let t = " " + text.toLowerCase() + " ";
  t = t.replace(/(\d)\.(\d)/g, "$1<D>$2");
  t = t.replace(/[.,?!;:]/g, " ");
  t = t.replace(/(\d)<D>(\d)/g, "$1.$2");
  t = t
    .replace(/\bone\b/g, "1")
    .replace(/\bten\b/g, "10")
    .replace(/\bthree\b/g, "3");
  t = t.replace(/\b(mev|kev|gev)\s*(?:\/|per)\s*(?:nucleon|nucl)\b/g, "$1 pn");
  t = t.replace(/\bmev\s*(?:\/|per)\s*(?:u|amu)\b/g, "mev mu");
  t = t.replace(/\bcentimeters?\b/g, "cm").replace(/\bmillimeters?\b/g, "mm");
  t = t.replace(/\s+/g, " ");
  return t;
}

const S = (cat, ...res) => ({ cat, res });
const num = (n) => S("number", new RegExp(`\\b${String(n).replace(".", "\\.")}\\b`));
const mev = () => S("unit", /\bmev\b/);
const kev = () => S("unit", /\bkev\b/);
const gev = () => S("unit", /\bgev\b/);
const mevPN = () => S("unit", /\bmev pn\b/);
const part = (w) => S("particle", new RegExp(`\\b(?:${w})\\b`));
const mat = (w) => S("material", new RegExp(`\\b(?:${w})\\b`));
const qty = (w) => S("quantity", new RegExp(`(?:${w})`));
const unitRe = (u) => {
  if (u === "cm") return S("unit", /\bcm\b/);
  if (u === "mm") return S("unit", /\bmm\b/);
  return S("unit", new RegExp(`\\b${u}\\b`));
};

function energySlots(e) {
  const out = [num(e.value)];
  if (e.unit === "MeV") out.push(e.perNucleon ? mevPN() : mev());
  else if (e.unit === "keV") out.push(kev());
  else if (e.unit === "GeV") out.push(gev());
  return out;
}

/** Build the expected SLOTS array for one clip from its recorded slotTruth. */
function slotsFor(slotTruth) {
  const slots = [];
  slots.push(qty(slotTruth.quantityKeyword));
  if (slotTruth.isInverse) slots.push(qty("range")); // every invrng sentence also says "range"
  for (const p of slotTruth.particles) slots.push(part(p));
  for (const m of slotTruth.materials) slots.push(mat(m));
  for (const e of slotTruth.energies ?? []) slots.push(...energySlots(e));
  if (slotTruth.target) {
    slots.push(num(slotTruth.target.value));
    slots.push(unitRe(slotTruth.target.unit));
  }
  return slots;
}

function scoreText(slots, text) {
  const t = norm(text);
  const missed = [];
  for (const s of slots) {
    const hit = s.res.some((re) => re.test(t));
    if (!hit) missed.push(s);
  }
  return { total: slots.length, missed };
}

const manifestRaw = JSON.parse(readFileSync(manifestPath, "utf-8"));
const clips = manifestRaw.clips ?? manifestRaw;
const byId = new Map(clips.map((c) => [c.id, c]));

const data = JSON.parse(readFileSync(resultsPath, "utf-8"));
const correctorLabel = useNew ? "new-corrector" : useExt ? "ext-corrector" : "base-corrector";
const label = `${data.modelId} [${data.dtype}]${data.withPrompt ? " +prompt" : ""} ${correctorLabel}`;

const catTotals = {};
const byQuantity = {}; // quantity -> {rawPass, corPass, n}
const byMulti = {}; // multi (null|energy|material|particle) -> {rawPass, corPass, n}
const byProfile = {}; // voice profile -> {rawPass, corPass, n}
let clipPassRaw = 0,
  clipPassCor = 0,
  clips_n = 0;
const failures = [];
const perClip = [];
const scoredSecs = [];

for (const r of data.records) {
  if (r.error) continue;
  const clip = byId.get(r.id);
  if (!clip || !clip.slotTruth) continue;
  clips_n++;
  scoredSecs.push(r.secs);
  const slots = slotsFor(clip.slotTruth);
  const sRaw = scoreText(slots, r.raw);
  const corrected = correct(r.raw);
  const sCor = scoreText(slots, corrected);

  const rawPass = sRaw.missed.length === 0;
  const corPass = sCor.missed.length === 0;
  if (rawPass) clipPassRaw++;
  if (corPass) clipPassCor++;
  else failures.push({ id: r.id, missed: sCor.missed.map((m) => m.cat), raw: r.raw, corrected });

  const q = clip.quantity ?? "unknown";
  byQuantity[q] ??= { rawPass: 0, corPass: 0, n: 0 };
  byQuantity[q].n++;
  if (rawPass) byQuantity[q].rawPass++;
  if (corPass) byQuantity[q].corPass++;

  const m = clip.multi ?? "single";
  byMulti[m] ??= { rawPass: 0, corPass: 0, n: 0 };
  byMulti[m].n++;
  if (rawPass) byMulti[m].rawPass++;
  if (corPass) byMulti[m].corPass++;

  const prof = clip.profile ?? "unknown";
  byProfile[prof] ??= { rawPass: 0, corPass: 0, n: 0 };
  byProfile[prof].n++;
  if (rawPass) byProfile[prof].rawPass++;
  if (corPass) byProfile[prof].corPass++;

  for (const s of slots) {
    catTotals[s.cat] ??= { rawMiss: 0, corMiss: 0, total: 0 };
    catTotals[s.cat].total++;
  }
  for (const m2 of sRaw.missed) catTotals[m2.cat].rawMiss++;
  for (const m2 of sCor.missed) catTotals[m2.cat].corMiss++;

  perClip.push({ id: r.id, quantity: q, multi: clip.multi, profile: prof, rawPass, corPass });
}

// Median over the records actually scored (excludes r.error/missing-slotTruth skips above) —
// a failed transcription's `secs` isn't representative of the scored population's latency.
const medianSecs = scoredSecs.sort((a, b) => a - b)[Math.floor(scoredSecs.length / 2)];
console.log(`\n=== ${label} ===`);
console.log(
  `clips: ${clips_n}   median inference: ${medianSecs.toFixed(1)}s   load: ${data.loadS.toFixed(1)}s`,
);
console.log(
  `clip-level all-slots-correct:  raw ${clipPassRaw}/${clips_n} (${((100 * clipPassRaw) / clips_n).toFixed(1)}%)   corrected ${clipPassCor}/${clips_n} (${((100 * clipPassCor) / clips_n).toFixed(1)}%)`,
);

console.log(`\nby quantity (corrected):`);
for (const [q, v] of Object.entries(byQuantity)) {
  console.log(`  ${q.padEnd(16)} ${v.corPass}/${v.n} (${((100 * v.corPass) / v.n).toFixed(1)}%)`);
}
console.log(`\nby scenario type (corrected):`);
for (const [m, v] of Object.entries(byMulti)) {
  console.log(`  ${m.padEnd(10)} ${v.corPass}/${v.n} (${((100 * v.corPass) / v.n).toFixed(1)}%)`);
}
console.log(`\nby voice profile (corrected), worst 10:`);
const profileRows = Object.entries(byProfile).map(([p, v]) => ({ p, rate: v.corPass / v.n, ...v }));
profileRows.sort((a, b) => a.rate - b.rate);
for (const row of profileRows.slice(0, 10)) {
  console.log(`  ${row.p.padEnd(32)} ${row.corPass}/${row.n} (${(100 * row.rate).toFixed(1)}%)`);
}

console.log(`\nslot-token accuracy by category (raw -> corrected):`);
let allTot = 0,
  allRawMiss = 0,
  allCorMiss = 0;
for (const [cat, v] of Object.entries(catTotals)) {
  allTot += v.total;
  allRawMiss += v.rawMiss;
  allCorMiss += v.corMiss;
  console.log(
    `  ${cat.padEnd(9)} ${(((v.total - v.rawMiss) / v.total) * 100).toFixed(1).padStart(5)}% -> ${(((v.total - v.corMiss) / v.total) * 100).toFixed(1).padStart(5)}%  (n=${v.total})`,
  );
}
console.log(
  `  ${"ALL".padEnd(9)} ${(((allTot - allRawMiss) / allTot) * 100).toFixed(1).padStart(5)}% -> ${(((allTot - allCorMiss) / allTot) * 100).toFixed(1).padStart(5)}%  (n=${allTot})`,
);

console.log(`\nfailing clips after correction (${failures.length} total, showing first 30):`);
for (const f of failures.slice(0, 30)) {
  console.log(`  ${f.id} missing[${f.missed.join(",")}]: ${f.raw}`);
}

if (jsonOutPath) {
  writeFileSync(
    jsonOutPath,
    JSON.stringify(
      {
        label,
        clips: clips_n,
        clipPassRaw,
        clipPassCor,
        byQuantity,
        byMulti,
        byProfile,
        catTotals,
        failures,
        perClip,
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${jsonOutPath}`);
}
