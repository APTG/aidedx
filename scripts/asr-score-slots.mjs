/**
 * Slot-token scorer for saved ASR transcripts (issue #7 pass criterion).
 * Scores each transcript on slot-bearing tokens (numbers, units, particles,
 * materials, quantity words, program names), raw and after the correction layer.
 *
 * Usage:
 *   node scripts/asr-score-slots.mjs <results.json> [more.json...]        # asr-correct.mjs
 *   node scripts/asr-score-slots.mjs --ext <results.json> [more.json...]  # asr-correct-ext.mjs
 *   node scripts/asr-score-slots.mjs --new <results.json> [more.json...]  # src/lib/asr/correct (issue #28)
 *
 * Input JSONs are produced by scripts/asr-transcribe.mjs; committed runs live
 * in eval/results/.
 */
import { readFileSync } from "fs";
import { correct as baseCorrect } from "./asr-correct.mjs";
import { correct as extCorrect } from "./asr-correct-ext.mjs";
import { correctTranscript as newCorrect } from "../src/lib/asr/correct/core.ts";

const correct = process.argv.includes("--new")
  ? (text) => newCorrect(text).text
  : process.argv.includes("--ext")
    ? extCorrect
    : baseCorrect;

// Canonicalisation applied before slot matching (case-insensitive containment).
// A number glued straight to its unit ("30mm", "100mev", no space) is a real, common
// Whisper/TTS rendering — the actual matcher (LENGTH_TARGET_RE/ENERGY_RE in
// src/lib/intent/matcher.ts) already tolerates zero whitespace between them. \b treats
// digits and letters as the same "word" character class, so \b(mev|kev|gev)\b silently
// fails to match the unit half of a glued token (issue #92: confirmed 34/66 mm-target
// clips in the v2 1000-sentence batch are glued this way, vs 1/184 for cm). Use a
// letter-boundary instead of \b wherever a preceding digit is possible.
function norm(text) {
  let t = " " + text.toLowerCase() + " ";
  t = t.replace(/(\d)\.(\d)/g, "$1<D>$2");
  t = t.replace(/[.,?!;:]/g, " ");
  t = t.replace(/(\d)<D>(\d)/g, "$1.$2");
  // number words
  t = t
    .replace(/\bone\b/g, "1")
    .replace(/\bten\b/g, "10")
    .replace(/\bthree\b/g, "3");
  // per-nucleon variants → PN ; MeV/u variants → MU
  t = t.replace(/(?<![a-z])(mev|kev|gev)\s*(?:\/|per)\s*(?:nucleon|nucl)\b/g, "$1 pn");
  t = t.replace(/(?<![a-z])mev\s*(?:\/|per)\s*(?:u|amu)\b/g, "mev mu");
  t = t.replace(/(?<![a-z])centimeters?\b/g, "cm").replace(/(?<![a-z])millimeters?\b/g, "mm");
  t = t.replace(/\s+/g, " ");
  return t;
}

// slot spec: [category, [acceptable regexes over normalised text]]
const S = (cat, ...res) => ({ cat, res });
// A number's boundary must still reject an adjacent DIGIT (so "30" doesn't match inside
// "130"), but may be adjacent to a letter — see the norm() comment above for why \b is
// wrong here when a number is glued straight to its unit.
const numBoundary = (n) => new RegExp(`(?<!\\d)${n.replace(".", "\\.")}(?!\\d)`);
// A unit's boundary is the mirror case: must reject an adjacent LETTER (so "mm" doesn't
// match inside "hmm"/"comment"), but may be adjacent to a digit.
const unitBoundary = (u) => new RegExp(`(?<![a-z])${u}(?![a-z])`);
const num = (n) => S("number", numBoundary(n));
const mev = () => S("unit", unitBoundary("mev"));
const kev = () => S("unit", unitBoundary("kev"));
const gev = () => S("unit", unitBoundary("gev"));
const mevPN = () => S("unit", unitBoundary("mev pn"));
const mevU = () => S("unit", unitBoundary("mev mu"));
const part = (...ws) => S("particle", new RegExp(`\\b(?:${ws.join("|")})\\b`));
const mat = (...ws) => S("material", new RegExp(`\\b(?:${ws.join("|")})\\b`));
const qty = (...ws) => S("quantity", new RegExp(`(?:${ws.join("|")})`));
const prog = (w) => S("program", new RegExp(`\\b${w}\\b`, "i"));

const SLOTS = {
  "stress-001": [num("240"), kev(), part("carbon"), mat("water"), qty("how far")],
  "stress-002": [
    qty("stopping power"),
    part("neon"),
    mat("water"),
    mat("air"),
    num("100"),
    mevPN(),
  ],
  "sp-003": [qty("de\\/dx|de dx|dedx"), num("250"), mev(), part("protons?"), mat("pmma")],
  "sp-005": [qty("stopping power"), num("80"), mevPN(), part("carbon"), mat("water")],
  "sp-007": [qty("stopping power"), num("200"), mev(), part("protons?"), mat("bone")],
  "sp-008": [qty("de\\/dx|de dx|dedx"), num("3"), mev(), part("deuterons?"), mat("silicon")],
  "rng-002": [qty("csda"), qty("range"), num("150"), mev(), part("protons?"), mat("water")],
  "rng-005": [qty("range"), num("90"), mevPN(), part("carbon"), mat("water")],
  "rng-008": [qty("deep|penetrat"), num("100"), mev(), part("protons?"), mat("water")],
  "ind-001": [qty("how far|travel"), num("60"), mev(), part("protons?"), mat("water")],
  "ind-003": [qty("rate|shed|lose"), num("30"), mev(), part("protons?"), mat("alumin[iu]?um")],
  "ind-008": [qty("penetration|depth"), num("80"), mevPN(), part("oxygen"), mat("water")],
  "conv-003": [qty("how far"), num("100"), mev(), part("protons?"), mat("water")],
  "conv-008": [qty("range"), num("230"), mev(), part("protons?"), mat("water")],
  "cmp-mat-001": [
    qty("stopping power"),
    num("100"),
    mev(),
    part("protons?"),
    mat("water"),
    mat("bone"),
  ],
  "cmp-mat-004": [
    qty("range"),
    num("150"),
    mev(),
    part("protons?"),
    mat("water"),
    mat("bone"),
    mat("adipose"),
  ],
  "cmp-mat-007": [num("100"), mevPN(), part("carbon"), qty("range"), mat("water"), mat("pmma")],
  "cmp-par-003": [part("carbon"), part("neon"), qty("range"), mat("water"), num("100"), mevPN()],
  "cmp-par-005": [
    qty("penetrat|deeper"),
    mat("water"),
    num("60"),
    mev(),
    part("protons?"),
    part("deuterons?"),
  ],
  "cmp-en-001": [qty("range"), part("protons?"), mat("water"), num("100"), num("200"), mev()],
  "cmp-prog-001": [
    qty("range"),
    num("150"),
    mev(),
    part("protons?"),
    mat("water"),
    prog("astar"),
    prog("pstar"),
  ],
  "unit-001": [qty("stopping power"), num("500"), kev(), part("protons?"), mat("water")],
  "unit-003": [qty("stopping power"), num("1"), gev(), part("protons?"), mat("water")],
  "unit-006": [qty("range"), num("900"), kev(), part("deuterons?"), mat("water")],
  "pernuc-001": [qty("range"), part("carbon"), mat("water"), num("290"), mevU()],
  "pernuc-003": [
    qty("range"),
    part("carbon"),
    num("3.6"),
    gev(),
    S("unit", /\btotal\b/),
    mat("water"),
  ],
  "iso-002": [
    qty("stopping power"),
    part("carbon-13|carbon 13"),
    mat("water"),
    num("100"),
    mevPN(),
  ],
  "iso-004": [qty("stopping power"), part("helium-3|helium 3"), mat("water"), num("40"), mevPN()],
  "inv-rng-001": [
    qty("what energy"),
    num("10"),
    S("unit", unitBoundary("cm")),
    qty("range"),
    mat("water"),
    part("protons?"),
  ],
  "alias-001": [qty("range"), num("60"), mev(), part("protons?"), mat("lucite")],
};

function scoreText(id, text) {
  const t = norm(text);
  const slots = SLOTS[id];
  const missed = [];
  for (const s of slots) {
    const hit = s.res.some((re) => re.test(t));
    if (!hit) missed.push(s);
  }
  return { total: slots.length, missed };
}

for (const file of process.argv.slice(2).filter((a) => !a.startsWith("--"))) {
  const data = JSON.parse(readFileSync(file, "utf-8"));
  const label = `${data.modelId} [${data.dtype}]${data.withPrompt ? " +prompt" : ""}`;
  const perSpeaker = {};
  const catTotals = {}; // cat -> {raw:[miss,total], cor:[miss,total]}
  let clipPassRaw = 0,
    clipPassCor = 0,
    clips = 0;
  const failures = [];

  for (const r of data.records) {
    if (r.error) continue;
    clips++;
    const sRaw = scoreText(r.id, r.raw);
    const sCor = scoreText(r.id, correct(r.raw));
    if (sRaw.missed.length === 0) clipPassRaw++;
    if (sCor.missed.length === 0) clipPassCor++;
    else
      failures.push({ sp: r.speaker, id: r.id, missed: sCor.missed.map((m) => m.cat), raw: r.raw });
    const key = r.speaker;
    perSpeaker[key] ??= { raw: 0, cor: 0, n: 0 };
    perSpeaker[key].n++;
    if (sRaw.missed.length === 0) perSpeaker[key].raw++;
    if (sCor.missed.length === 0) perSpeaker[key].cor++;
    for (const s of SLOTS[r.id]) {
      catTotals[s.cat] ??= { rawMiss: 0, corMiss: 0, total: 0 };
      catTotals[s.cat].total++;
    }
    for (const m of sRaw.missed) catTotals[m.cat].rawMiss++;
    for (const m of sCor.missed) catTotals[m.cat].corMiss++;
  }

  const medianSecs = data.records.map((r) => r.secs).sort((a, b) => a - b)[
    Math.floor(data.records.length / 2)
  ];
  console.log(`\n=== ${label} ===`);
  console.log(
    `clips: ${clips}   median inference: ${medianSecs.toFixed(1)}s   load: ${data.loadS.toFixed(1)}s`,
  );
  console.log(
    `clip-level all-slots-correct:  raw ${clipPassRaw}/${clips} (${((100 * clipPassRaw) / clips).toFixed(0)}%)   corrected ${clipPassCor}/${clips} (${((100 * clipPassCor) / clips).toFixed(0)}%)`,
  );
  console.log(
    `per speaker (corrected): ${Object.entries(perSpeaker)
      .map(([k, v]) => `${k} ${v.cor}/${v.n}`)
      .join("   ")}`,
  );
  console.log(`slot-token accuracy by category (raw → corrected):`);
  let allTot = 0,
    allRawMiss = 0,
    allCorMiss = 0;
  for (const [cat, v] of Object.entries(catTotals)) {
    allTot += v.total;
    allRawMiss += v.rawMiss;
    allCorMiss += v.corMiss;
    console.log(
      `  ${cat.padEnd(9)} ${(((v.total - v.rawMiss) / v.total) * 100).toFixed(1).padStart(5)}% → ${(((v.total - v.corMiss) / v.total) * 100).toFixed(1).padStart(5)}%  (n=${v.total})`,
    );
  }
  console.log(
    `  ${"ALL".padEnd(9)} ${(((allTot - allRawMiss) / allTot) * 100).toFixed(1).padStart(5)}% → ${(((allTot - allCorMiss) / allTot) * 100).toFixed(1).padStart(5)}%  (n=${allTot})`,
  );
  {
    console.log(`failing clips after correction (${failures.length}):`);
    for (const f of failures.slice(0, 40)) {
      console.log(`  ${f.sp}/${f.id} missing[${f.missed.join(",")}]: ${f.raw}`);
    }
    if (failures.length > 40) {
      console.log(`  ... and ${failures.length - 40} more (not printed)`);
    }
  }
}
