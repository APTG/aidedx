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
 * Also reports two breakdowns issue #83/#92 asked for: per-unit accuracy (MeV/keV/GeV/
 * MeV-per-nucleon/cm/mm scored separately instead of one blended "unit" category), and a
 * clinical-core vs. long-tail-robustness stratum split (`stratumFor()`) so exotic entities
 * unlocked by #81's Bethe fallback don't masquerade as the real-world query distribution in
 * the headline number.
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
  .filter((a) => a !== "--ext" && a !== "--new" && a !== "--json" && a !== jsonOutPath);

// --- Same normalization as scripts/asr-score-slots.mjs ---
// A number glued straight to its unit ("30mm", "100mev", no space) is a real, common
// Whisper/TTS rendering — the actual matcher (LENGTH_TARGET_RE/ENERGY_RE in
// src/lib/intent/matcher.ts) already tolerates zero whitespace between them. \b treats
// digits and letters as the same "word" character class, so \b(mev|kev|gev)\b silently
// fails to match the unit half of a glued token (confirmed: 34/66 mm-target clips in the
// v2 1000-sentence batch are glued this way, vs 1/184 for cm — issue #92). Use a
// letter-boundary instead of \b wherever a preceding digit is possible.
function norm(text) {
  let t = " " + text.toLowerCase() + " ";
  t = t.replace(/(\d)\.(\d)/g, "$1<D>$2");
  t = t.replace(/[.,?!;:]/g, " ");
  t = t.replace(/(\d)<D>(\d)/g, "$1.$2");
  t = t
    .replace(/\bone\b/g, "1")
    .replace(/\bten\b/g, "10")
    .replace(/\bthree\b/g, "3");
  // Polish equivalents — precautionary, not yet observed failing in practice the way the
  // English mm/cm glued-unit bug (module doc comment above) was, but the same Whisper
  // behavior (writing a spoken number as a word instead of a digit) plausibly happens in any
  // language. "dziesięć" ends in a non-ASCII letter, so this needs the same Unicode-aware
  // boundary as wordBoundary() below, not plain \b (which would silently never match here).
  t = t
    .replace(/(?<![\p{L}\d])jeden(?![\p{L}\d])/gu, "1")
    .replace(/(?<![\p{L}\d])dziesięć(?![\p{L}\d])/gu, "10")
    .replace(/(?<![\p{L}\d])trzy(?![\p{L}\d])/gu, "3");
  t = t.replace(/(?<![a-z])(mev|kev|gev)\s*(?:\/|per)\s*(?:nucleon|nucl)\b/g, "$1 pn");
  // Polish "MeV na nukleon" (per-nucleon) — the only per-nucleon phrasing lang/pl.ts's matcher
  // supports (no Polish "per-u"/"per-amu" construction is vetted, so no Polish counterpart to
  // the "mev mu" normalization below). "nukleonu"/"nukleonie" tolerate a declined ASR
  // transcription of the word, not just the bare dictionary form actually spoken.
  t = t.replace(/(?<![a-z])(mev|kev|gev)\s+na\s+nukleon(?:u|ie|em)?\b/g, "$1 pn");
  t = t.replace(/(?<![a-z])mev\s*(?:\/|per)\s*(?:u|amu)\b/g, "mev mu");
  t = t.replace(/(?<![a-z])centimeters?\b/g, "cm").replace(/(?<![a-z])millimeters?\b/g, "mm");
  t = t.replace(/\s+/g, " ");
  return t;
}

const S = (cat, ...res) => ({ cat, res });
// `unitKind` tags a unit slot with its specific kind (MeV/keV/GeV/MeV-per-nucleon/cm/mm) so
// callers can report per-unit accuracy (issue #92) alongside the existing aggregate "unit"
// category — #83's own finding was that units are 65% of all failures, but that's one
// blended number across five different unit tokens with plausibly different accuracy.
const U = (unitKind, re) => ({ ...S("unit", re), unitKind });
// A number's boundary must still reject an adjacent DIGIT (so "30" doesn't match inside
// "130"), but may be adjacent to a letter — see the norm() comment above for why \b is
// wrong here when a number is glued straight to its unit.
const numBoundary = (n) => new RegExp(`(?<!\\d)${String(n).replace(".", "\\.")}(?!\\d)`);
// A unit's boundary is the mirror case: must reject an adjacent LETTER (so "mm" doesn't
// match inside "hmm"/"comment"), but may be adjacent to a digit.
const unitBoundary = (u) => new RegExp(`(?<![a-z])${u}(?![a-z])`);
const num = (n) => S("number", numBoundary(n));
const mev = () => U("MeV", unitBoundary("mev"));
const kev = () => U("keV", unitBoundary("kev"));
const gev = () => U("GeV", unitBoundary("gev"));
const mevPN = () => U("MeV/nucl", unitBoundary("mev pn"));
// Unicode-aware word boundary, not plain `\b` — `\b` is defined in terms of `\w`, which is
// ASCII-only, so `\bżelaza\b` (a real Polish material/particle word starting with a non-ASCII
// letter) silently fails to match at all: the position right before "ż" sees a non-word char
// on *both* sides (e.g. a space, then "ż" itself), so no boundary is detected there — confirmed
// empirically while wiring up Polish scoring (issue #79/#87), not a hypothetical. `(?<![\p{L}\d])`/
// `(?![\p{L}\d])` reject the same adjacent letter-or-digit classes `\b` does, just Unicode-aware.
const wordBoundary = (w) => new RegExp(`(?<![\\p{L}\\d])(?:${w})(?![\\p{L}\\d])`, "u");
const part = (w) => S("particle", wordBoundary(w));
const mat = (w) => S("material", wordBoundary(w));
const qty = (w) => S("quantity", new RegExp(`(?:${w})`, "u"));
const unitRe = (u) => {
  if (u === "cm") return U("cm", unitBoundary("cm"));
  if (u === "mm") return U("mm", unitBoundary("mm"));
  return U(u, unitBoundary(u));
};

function energySlots(e) {
  const out = [num(e.value)];
  if (e.unit === "MeV") out.push(e.perNucleon ? mevPN() : mev());
  else if (e.unit === "keV") out.push(kev());
  else if (e.unit === "GeV") out.push(gev());
  return out;
}

// Group A (issue #92, deferred from #83): "clinical core" vs. "long-tail robustness" split
// — #83 asked not to let exotic entities (unlocked by #81's Bethe fallback) masquerade as
// the real-world distribution in one blended headline number. Bare-string sets mirror
// scripts/generate-1000-sentences.mjs's PARTICLES/MATERIALS pools exactly: the particle set
// is the Z>18 long-tail addition (calcium..uranium) called out in that generator's own
// comments; the material set is every entry there that isn't water/air/PMMA/A-150/an ICRP
// tissue/bone — i.e. the detector/electronics-material and boron-family entries. A clip
// counts as long-tail if ANY of its particles or materials falls in these sets.
const LONGTAIL_PARTICLE_BARES = new Set([
  "calcium",
  "iron",
  "krypton",
  "xenon",
  "gold",
  "lead",
  "uranium",
  // Polish (scripts/generate-1000-sentences-pl.mjs) — same Z>18 boundary, its own bare
  // (genitive) forms rather than English's, since slotTruth.particles carries whichever
  // language the clip was generated in.
  "wapnia",
  "tytanu",
  "żelaza",
  "miedzi",
  "kryptonu",
  "ksenonu",
]);
const LONGTAIL_MATERIAL_BARES = new Set([
  "silicon",
  "aluminum|aluminium",
  "gold",
  "graphite",
  "polyethylene",
  "polystyrene",
  "kapton",
  "mylar",
  "lithium fluoride",
  "sodium iodide|nai",
  "cesium iodide|csi",
  "glass|pyrex",
  "teflon",
  "polycarbonate",
  "concrete",
  "boron",
  "boron carbide",
  "boron oxide",
  // Polish — same non-clinical (not water/air/PMMA/A-150/ICRP-tissue/bone) boundary.
  "kaptonie",
  "graficie",
  "poliwęglanie",
  "polietylenie",
  "dwutlenku krzemu",
  "aluminium",
  "złocie",
  "ołowiu",
]);
function stratumFor(slotTruth) {
  const longTail =
    slotTruth.particles.some((p) => LONGTAIL_PARTICLE_BARES.has(p)) ||
    slotTruth.materials.some((m) => LONGTAIL_MATERIAL_BARES.has(m));
  return longTail ? "long-tail" : "clinical-core";
}

/** Build the expected SLOTS array for one clip from its recorded slotTruth. */
function slotsFor(slotTruth) {
  const slots = [];
  slots.push(qty(slotTruth.quantityKeyword));
  // Every invrng sentence also says "range" (English) or "zasięg" (Polish) — checking for
  // either is safe in both directions, since a transcript in one language never contains the
  // other's word; simpler than threading a per-clip lang field through slotTruth just for this.
  if (slotTruth.isInverse) slots.push(qty("range|zasięg"));
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
const byUnit = {}; // unitKind (MeV/keV/GeV/MeV per nucl/cm/mm) -> {rawMiss, corMiss, total}
const byQuantity = {}; // quantity -> {rawPass, corPass, n}
const byMulti = {}; // multi (null|energy|material|particle) -> {rawPass, corPass, n}
const byProfile = {}; // voice profile -> {rawPass, corPass, n}
const byStratum = {}; // clinical-core|long-tail -> {rawPass, corPass, n}
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

  const stratum = stratumFor(clip.slotTruth);
  byStratum[stratum] ??= { rawPass: 0, corPass: 0, n: 0 };
  byStratum[stratum].n++;
  if (rawPass) byStratum[stratum].rawPass++;
  if (corPass) byStratum[stratum].corPass++;

  for (const s of slots) {
    catTotals[s.cat] ??= { rawMiss: 0, corMiss: 0, total: 0 };
    catTotals[s.cat].total++;
    if (s.unitKind) {
      byUnit[s.unitKind] ??= { rawMiss: 0, corMiss: 0, total: 0 };
      byUnit[s.unitKind].total++;
    }
  }
  for (const m2 of sRaw.missed) {
    catTotals[m2.cat].rawMiss++;
    if (m2.unitKind) byUnit[m2.unitKind].rawMiss++;
  }
  for (const m2 of sCor.missed) {
    catTotals[m2.cat].corMiss++;
    if (m2.unitKind) byUnit[m2.unitKind].corMiss++;
  }

  perClip.push({
    id: r.id,
    quantity: q,
    multi: clip.multi,
    profile: prof,
    stratum,
    rawPass,
    corPass,
  });
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
console.log(`\nby stratum (corrected) — issue #92, clinical-core vs. long-tail robustness:`);
for (const [s, v] of Object.entries(byStratum)) {
  console.log(`  ${s.padEnd(14)} ${v.corPass}/${v.n} (${((100 * v.corPass) / v.n).toFixed(1)}%)`);
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

console.log(`\nper-unit accuracy (raw -> corrected), issue #92:`);
for (const [kind, v] of Object.entries(byUnit)) {
  console.log(
    `  ${kind.padEnd(10)} ${(((v.total - v.rawMiss) / v.total) * 100).toFixed(1).padStart(5)}% -> ${(((v.total - v.corMiss) / v.total) * 100).toFixed(1).padStart(5)}%  (n=${v.total})`,
  );
}

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
        byStratum,
        catTotals,
        byUnit,
        failures,
        perClip,
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${jsonOutPath}`);
}
