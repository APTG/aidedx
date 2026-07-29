/**
 * Standalone validator for eval/datagen-sentences.json (issue #130, Part 1).
 *
 * Unlike scripts/generate-datagen-sentences.mjs's own inline gate (which only ever runs
 * against its own freshly-rendered output), this re-checks the *committed* file — so a
 * hand-edit to the JSON that isn't run back through the generator still gets caught in CI.
 * Checks, in order:
 *
 *  1. Schema — every record has the expected shape, ids are unique, `quantity` is one of
 *     the three supported values, `energyRendering` is "abbrev" or "expanded".
 *  2. Exactly 5 of the 50 records are "expanded" (the deliberate, documented split —
 *     eval/RECORDING.datagen.md "What this set can and cannot measure").
 *  3. `display` differs from `canonical` in *only* the unit/acronym renderings — reversing
 *     every known length/energy expansion and the EN "LET"→"el-ee-tee" / "CSDA"→
 *     "see-ess-dee-ay" spellings back to their abbreviation must reproduce `canonical`
 *     exactly. Catches a typo or accidental rewording introduced anywhere else in a
 *     hand-edited `display` string.
 *  4. Every `slotTruth` particle/material bare regex actually matches its own `canonical`
 *     text, and every energy/target value+unit appears in it — a regression guard against
 *     the sentence text and its own ground truth drifting apart.
 *  5. The EN and PL side of each record describe the same physics tuple (same energies/
 *     target values, same particle/material counts).
 *  6. Every canonical sentence (both languages) resolves through the real matcher
 *     (`matchIntent`) + vendored libdedx WASM (`computeIntent`) — no silent
 *     `quantitySource: "default"`, no schema error, a finite positive result.
 *
 *   node scripts/validate-datagen-sentences.ts
 *   pnpm validate:eval
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkCandidate, loadService } from "./tts-sentence-check.ts";

const QUANTITIES = new Set(["csdaRange", "energyFromRange", "stoppingPower"]);
const RENDERINGS = new Set(["abbrev", "expanded"]);
const EXPECTED_EXPANDED = 5;

interface SlotTruth {
  quantityKeyword: string;
  particles: string[];
  materials: string[];
  energies?: Array<{ value: number; unit: string; perNucleon?: boolean }>;
  target?: { value: number; unit: string };
  isInverse?: boolean;
}
interface LangSide {
  canonical: string;
  display: string;
  slotTruth: SlotTruth;
}
interface Record_ {
  id: string;
  quantity: string;
  energyRendering: string;
  en: LangSide;
  pl: LangSide;
}

const path = fileURLToPath(new URL("../eval/datagen-sentences.json", import.meta.url));
const records = JSON.parse(readFileSync(path, "utf-8")) as Record_[];

const errors: string[] = [];
const err = (msg: string) => errors.push(msg);

// --- 1. Schema + unique ids -------------------------------------------------
const seenIds = new Set<string>();
for (const r of records) {
  if (seenIds.has(r.id)) err(`${r.id}: duplicate id`);
  seenIds.add(r.id);
  if (!QUANTITIES.has(r.quantity)) err(`${r.id}: unknown quantity "${r.quantity}"`);
  if (!RENDERINGS.has(r.energyRendering))
    err(`${r.id}: unknown energyRendering "${r.energyRendering}"`);
  for (const lang of ["en", "pl"] as const) {
    const side = r[lang];
    if (!side?.canonical || !side?.display || !side?.slotTruth) {
      err(`${r.id} [${lang}]: missing canonical/display/slotTruth`);
    }
  }
}

// --- 2. Exactly 5 expanded ---------------------------------------------------
const expandedCount = records.filter((r) => r.energyRendering === "expanded").length;
if (expandedCount !== EXPECTED_EXPANDED) {
  err(
    `expected exactly ${EXPECTED_EXPANDED} energyRendering:"expanded" records, found ${expandedCount}`,
  );
}

// --- 3. display reverses cleanly to canonical (unit/acronym renderings only) ----------
// [pattern, replacement] pairs, applied to `display` to undo every known expansion. Order
// matters only within a language (longer/more-specific unit words don't collide here).
const UNDO_EN: Array<[RegExp, string]> = [
  [/\bel-ee-tee\b/gi, "LET"],
  [/\bsee-ess-dee-ay\b/gi, "CSDA"],
  [/\bkiloelectronvolts?\b/gi, "keV"],
  [/\bmegaelectronvolts?\b/gi, "MeV"],
  [/\bgigaelectronvolts?\b/gi, "GeV"],
  [/\bcentimeters?\b/gi, "cm"],
  [/\bmillimeters?\b/gi, "mm"],
  [/\bmicrometers?\b/gi, "um"],
];
const UNDO_PL: Array<[RegExp, string]> = [
  [/\bkiloelektronowolt(?:y|ów)?\b/giu, "keV"],
  [/\bmegaelektronowolt(?:y|ów)?\b/giu, "MeV"],
  [/\bgigaelektronowolt(?:y|ów)?\b/giu, "GeV"],
  [/\bcentymetr(?:y|ów)?\b/giu, "cm"],
  [/\bmilimetr(?:y|ów)?\b/giu, "mm"],
  [/\bmikrometr(?:y|ów)?\b/giu, "um"],
];
function undo(text: string, rules: Array<[RegExp, string]>): string {
  let out = text;
  for (const [re, repl] of rules) out = out.replace(re, repl);
  return out;
}
for (const r of records) {
  const enUndone = undo(r.en.display, UNDO_EN);
  if (enUndone !== r.en.canonical) {
    err(
      `${r.id} [en]: display differs from canonical in more than unit rendering\n    canonical: ${r.en.canonical}\n    display:   ${r.en.display}\n    undone:    ${enUndone}`,
    );
  }
  const plUndone = undo(r.pl.display, UNDO_PL);
  if (plUndone !== r.pl.canonical) {
    err(
      `${r.id} [pl]: display differs from canonical in more than unit rendering\n    canonical: ${r.pl.canonical}\n    display:   ${r.pl.display}\n    undone:    ${plUndone}`,
    );
  }
}

// --- 4. slotTruth actually matches its own canonical ------------------------
function unicodeWordBoundary(pattern: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\d])(?:${pattern})(?![\\p{L}\\d])`, "iu");
}
for (const r of records) {
  for (const lang of ["en", "pl"] as const) {
    const { canonical, slotTruth } = r[lang];
    for (const bare of slotTruth.particles) {
      if (!unicodeWordBoundary(bare).test(canonical)) {
        err(`${r.id} [${lang}]: particle regex /${bare}/ does not match canonical "${canonical}"`);
      }
    }
    for (const bare of slotTruth.materials) {
      if (!unicodeWordBoundary(bare).test(canonical)) {
        err(`${r.id} [${lang}]: material regex /${bare}/ does not match canonical "${canonical}"`);
      }
    }
    const numeric = [
      ...(slotTruth.energies ?? []),
      ...(slotTruth.target ? [slotTruth.target] : []),
    ];
    for (const { value, unit } of numeric) {
      if (!new RegExp(`(?<!\\d)${value}(?!\\d)`).test(canonical)) {
        err(`${r.id} [${lang}]: value ${value} not found in canonical "${canonical}"`);
      }
      if (!new RegExp(unit, "i").test(canonical)) {
        err(`${r.id} [${lang}]: unit "${unit}" not found in canonical "${canonical}"`);
      }
    }
  }
}

// --- 5. EN/PL describe the same tuple ---------------------------------------
function sameNumeric(
  a?: Array<{ value: number; unit: string }> | { value: number; unit: string },
  b?: Array<{ value: number; unit: string }> | { value: number; unit: string },
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
for (const r of records) {
  if (r.en.slotTruth.particles.length !== r.pl.slotTruth.particles.length) {
    err(
      `${r.id}: EN/PL particle count mismatch (${r.en.slotTruth.particles.length} vs ${r.pl.slotTruth.particles.length})`,
    );
  }
  if (r.en.slotTruth.materials.length !== r.pl.slotTruth.materials.length) {
    err(
      `${r.id}: EN/PL material count mismatch (${r.en.slotTruth.materials.length} vs ${r.pl.slotTruth.materials.length})`,
    );
  }
  if (!sameNumeric(r.en.slotTruth.energies, r.pl.slotTruth.energies)) {
    err(`${r.id}: EN/PL energies mismatch`);
  }
  if (!sameNumeric(r.en.slotTruth.target, r.pl.slotTruth.target)) {
    err(`${r.id}: EN/PL target mismatch`);
  }
}

// --- 6. Real matcher + real libdedx -----------------------------------------
const service = await loadService();
for (const r of records) {
  for (const lang of ["en", "pl"] as const) {
    const res = checkCandidate({ id: `${r.id}-${lang}`, text: r[lang].canonical }, service, lang);
    if (!res.ok) err(`${r.id} [${lang}]: ${res.reason}\n    text: ${r[lang].canonical}`);
  }
}

if (errors.length > 0) {
  console.error(`✗ ${errors.length} error(s) in eval/datagen-sentences.json:\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`✓ ${records.length} datagen sentences (× 2 languages) validated.`);
