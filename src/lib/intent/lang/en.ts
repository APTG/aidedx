/**
 * English-language pack for the deterministic matcher (issue #87 Part A).
 *
 * Holds every English-specific keyword/idiom/regex table the matcher's
 * language-neutral core (`../matcher.ts`) needs — idioms, direct keyword
 * regexes, inverse-query cues, stopping-power synonyms, coordinator words,
 * and the material-scan stopword set. A future `pl.ts` (or other language)
 * pack plugs into the same seam: the core stays untouched, only the pack
 * import in `matcher.ts` would need to become language-selected.
 *
 * This split is a no-behavior-change refactor — every table/regex here is
 * moved verbatim from `matcher.ts`, not rewritten.
 */
import type { Quantity } from "../query-intent.ts";
import {
  DIRECT_STOPPING_SOURCE,
  DIRECT_RANGE_SOURCE,
  STOPPING_POWER_ACRONYM_RE,
  STOPPING_POWER_SYNONYM_PHRASE_RE,
  buildIndirectIdioms,
} from "../lexicon/build.ts";

/**
 * Indirect-idiom table: phrasings that imply a quantity without naming it.
 * These are the cases the issue flags as "the LLM's job"; the deterministic
 * matcher leans on this table to claw back the common, formulaic ones.
 *
 * Built from the shared source of truth (`../lexicon/quantity-en.ts`, issue #160 §9a) — see that
 * module for the raw pattern list.
 */
export const INDIRECT_IDIOMS: ReadonlyArray<{ pattern: RegExp; quantity: Quantity }> =
  buildIndirectIdioms();

/**
 * Direct keyword regex for the stoppingPower / csdaRange quantities (matched against
 * lowercased text). Issue #26 added the physics-synonym alternatives beyond the original
 * "stopping power"/"dE/dx"/"energy loss": specific ionisation (energy lost per ion pair,
 * proportional to stopping power for a given medium), Bethe-Bloch (the equation stopping
 * power is computed from — used metonymically for the quantity itself), retarding force
 * (the force-dimensioned reading of dE/dx), and energy deposition (density) / dose per
 * micrometer (the dosimetry-register phrasings of the same quantity).
 *
 * Built from `../lexicon/quantity-en.ts`'s `STOPPING_POWER_DIRECT_PATTERNS` (issue #160 §9a).
 */
export const DIRECT_STOPPING = new RegExp(DIRECT_STOPPING_SOURCE, "i");
export const DIRECT_RANGE = new RegExp(DIRECT_RANGE_SOURCE, "i");

/**
 * LET (linear energy transfer) is the radiobiology / particle-therapy synonym for
 * (electronic) stopping power — unrestricted LET∞ is operationally equal to the
 * electronic mass stopping power libdedx returns, so it maps to `stoppingPower`.
 *
 * The acronym is matched CASE-SENSITIVELY against the *original* text (not the lowercased
 * copy the other detectors use) so the ordinary verb "let" ("let me know…", "Let's…") is
 * never misread as the physics term. The spelled-out form is unambiguous and matched
 * case-insensitively. ASR transcripts that lowercase the acronym are normalized upstream by
 * the domain corrector (issue #28).
 */
export function mentionsStoppingPowerSynonym(lower: string, text: string): boolean {
  return STOPPING_POWER_ACRONYM_RE.test(text) || STOPPING_POWER_SYNONYM_PHRASE_RE.test(lower);
}

/**
 * Spelled-out stopping-power synonyms containing the word "energy", blanked out of the
 * lowercased text before the inverse detector's asks-for-energy test — "linear energy
 * transfer" and "energy deposition (density)" both contain "energy" but neither is a request
 * to solve for energy. (Issue #26's other new synonyms — specific ionisation, Bethe-Bloch,
 * retarding force, dose per micrometer — don't contain "energy" and need no blanking.)
 *
 * The third alternative blanks a forward "energy (is/was) lost/lose[s]/shed[s]/loss per
 * <length>" idiom for the same reason — "what energy is lost per centimeter…" is asking for
 * the *rate*, not solving for an unknown energy, but naming "energy" right after a wh-word
 * would otherwise trip `asksForEnergy` before the forward idiom ever gets a chance to fire
 * (issue #103). The verb must sit *directly* against "energy" (only "is"/"was" allowed
 * between) so a genuine inverse query with a different grammatical subject between them —
 * "which energy makes a proton lose 2 MeV per cm" (eval `inv-stp-003`) — is left alone: there
 * "energy" is the cause being solved for, not the thing being lost.
 *
 * The fourth alternative, `energy loss` — `DIRECT_STOPPING`'s own synonym for the quantity —
 * needs the same treatment for the same reason (issue #169): "What is the energy loss of a 100
 * MeV proton in water?" has "is the" (2 words) between "what" and "energy", so `asksForEnergy`
 * fired before `detectForwardQuantity` (which recognizes "energy loss" correctly) ever got a
 * chance to — `detectInverse` runs first and short-circuits forward detection entirely (see
 * `matchIntent`'s "inverse takes precedence" comment). Unlike the "per <length>" idiom above,
 * no qualifying suffix is needed: "energy loss" alone is always the noun phrase, never a request
 * to solve for an unknown energy value.
 */
export const BLANK_BEFORE_INVERSE_RE =
  /\blinear energy transfer\b|\benergy deposition(?:\s+density)?\b|\benergy\b\s+(?:is\s+|was\s+)?(?:lost|lose[s]?|shed[s]?|loss)\s+per\s+(?:centimeter|millimeter|cm|mm|unit length)\b|\benergy loss\b/g;

/**
 * Inverse ("solve for energy") cue: the query must ask for *energy* as the
 * answer — "what energy", "which proton energy", "what carbon ion energy" —
 * i.e. ≤3 plain words between the wh-word and "energy". This rejects "at what
 * rate … shed energy" (a forward query).
 */
export function asksForEnergy(deSynonym: string): boolean {
  return (
    /\b(?:what|which)\s+(?:[a-z]+\s+){0,3}energy\b/.test(deSynonym) ||
    /\bhow energetic\b/.test(deSynonym)
  );
}

/** English keyword/phrase cues that mark an inverse query as stopping-power-flavored (vs. range-flavored). */
export function mentionsStoppingPowerKeyword(lower: string): boolean {
  return (
    /\bstopping power\b/.test(lower) ||
    /\b(?:lose[s]?|lost)\b[^.?!]*\bmev per cm\b/.test(lower) ||
    /\bmev per cm\b/.test(lower)
  );
}

/** Last-resort fallback: a bare "stops/stopped" verb reads as range. */
export const FALLBACK_STOP_RE = /\bstop(?:s|ped)?\b/;

/** Spelled-out one through ninety-nine (by tens, no hyphenated compounds like "twenty-five" —
 * not attested in this project's eval set). Started as just one-ten (issue #26, "one GeV",
 * "three MeV"); extended to teens/tens (issue #122) once NeMo Parakeet's lack of ASR inverse-
 * text-normalization showed "sixty MeV"/"ninety MeV" spelled out too, not just single digits.
 * Still not a full number-word parser — `HUNDRED_WORD` below composes these with "hundred" for
 * the multi-word case ("two hundred and fifty"), everything past that ("thousand") is out of
 * scope. */
export const NUMBER_WORDS: ReadonlyArray<readonly [string, string]> = [
  ["zero", "0"],
  ["one", "1"],
  ["two", "2"],
  ["three", "3"],
  ["four", "4"],
  ["five", "5"],
  ["six", "6"],
  ["seven", "7"],
  ["eight", "8"],
  ["nine", "9"],
  ["ten", "10"],
  ["eleven", "11"],
  ["twelve", "12"],
  ["thirteen", "13"],
  ["fourteen", "14"],
  ["fifteen", "15"],
  ["sixteen", "16"],
  ["seventeen", "17"],
  ["eighteen", "18"],
  ["nineteen", "19"],
  ["twenty", "20"],
  ["thirty", "30"],
  ["forty", "40"],
  ["fifty", "50"],
  ["sixty", "60"],
  ["seventy", "70"],
  ["eighty", "80"],
  ["ninety", "90"],
];

/** Multiplier word for spelled-out hundreds ("two hundred and fifty" -> 250), consumed by
 * `composeHundreds()` in matcher.ts. Null for a language with no `HUNDRED_WORD` support yet
 * (see pl.ts). */
export const HUNDRED_WORD: string | null = "hundred";

/** Regex-alternation source of connector words for spelled-out decimals ("three point six" ->
 * 3.6), consumed by `composeDecimals()` in matcher.ts (issue #122 — "3.6 GeV" comes out fully
 * spelled on some clips; "dot" added for #156 — some ASR/speakers read the decimal point as
 * "dot" rather than "point"). Null for a language with no `POINT_WORD` support yet (see pl.ts). */
export const POINT_WORD: string | null = "point|dot";

/** "Stopping power" is the only phrase judged safe for edit-distance typo tolerance (issue
 * #26, "Stoping power") — long and distinctive enough that a fuzzy match is unlikely to
 * collide with unrelated text, unlike a short/generic word such as "range". */
export const FUZZY_QUANTITY_PHRASES: ReadonlyArray<{ phrase: string; quantity: Quantity }> = [
  { phrase: "stopping power", quantity: "stoppingPower" },
];

// Words that never start/own a material phrase; kept short to avoid eating real
// multi-word names. Numbers are excluded by the \p{L} requirement in the core scan.
export const MATERIAL_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "into",
  "through",
  "for",
  "at",
  "and",
  "or",
  "to",
  "is",
  "what",
  "whats",
  "how",
  "does",
  "do",
  "much",
  "energy",
  "per",
  "compare",
  "versus",
  "vs",
  "range",
  "stopping",
  "power",
  "dedx",
  "loss",
  "lose",
  "loses",
  "deep",
  "far",
  "thick",
  "proton",
  "protons",
  "alpha",
  "alphas",
  "ion",
  "ions",
  "particle",
  "particles",
  "nucleon",
  "with",
  "using",
  "both",
  "model",
  "models",
  "please",
  "me",
  "give",
  "it",
  "go",
  "goes",
]);

/** Connector between list members, allowing a serial-comma "X, Y, and Z". */
export const LIST_SEP_SRC =
  "(?:\\s*,\\s*(?:and\\s+|or\\s+)?|\\s+and\\s+|\\s+or\\s+|\\s+versus\\s+|\\s+vs\\.?\\s+)";

/**
 * Optional per-nucleon suffix, e.g. "/nucleon", "/u", " per nucleon". Two
 * alternatives (slash form vs. "per" form) each with their own capture group,
 * since the core's `extractEnergies` doesn't assume a fixed group count — it
 * scans every group from index 3 onward for whichever one matched.
 */
export const PER_NUCL_SUFFIX_SRC =
  "(?:\\s*\\/\\s*(nucleon|nucl|amu|u)|\\s+per\\s+(nucleon|nucl|amu|u))?";

/** "u"/"amu" read as the per-*mass-unit* figure; anything else ("nucleon"/"nucl") as per-nucleon. */
export function perNuclUnitFor(suffixWord: string): "MeV/u" | "MeV/nucl" {
  return suffixWord === "u" || suffixWord === "amu" ? "MeV/u" : "MeV/nucl";
}

/** Trailing head word for a coordinated particle list or a single "<element> ion(s)" head. */
const PARTICLE_LIST_HEAD_SRC = "ions?|particles?|nuclei|nucleus";

/** Standalone named particles whose isotope is fixed by the name. */
const NAMED_PARTICLE_SRC =
  "protons?|deuterons?|tritons?|alpha particles?|alphas?|helions?|electrons?|positrons?|beta minus|betas?";

/** One list/head member: a bare element name, optionally with an isotope mass number
 * suffix ("carbon-13", "carbon 13", "helium, 3") — shared between the coordinated-list and
 * single-head regexes below so a list member can be an isotope, not just a bare element
 * (issue #103: "neon-20 and carbon-12 ions" previously fell through the list regex entirely,
 * since its member class excluded digits, silently dropping every member but the last). */
const PARTICLE_MEMBER_SRC = "[a-z][a-z]*(?:[-,\\s]+\\d{1,3})?";

// A coordinated list sharing a trailing head: "carbon and neon ions",
// "protons, helium, and carbon ions", "neon-20 and carbon-12 ions". Requires ≥1 connector so
// it only fires on genuine lists; single "<element> ion(s)" is handled separately below.
export const PARTICLE_LIST_RE = new RegExp(
  `((?:${PARTICLE_MEMBER_SRC}${LIST_SEP_SRC})+${PARTICLE_MEMBER_SRC})\\s+(${PARTICLE_LIST_HEAD_SRC})\\b`,
  "gi",
);
// A single "<element/isotope> ion(s)/particle(s)/nuclei" head. The isotope suffix accepts a
// hyphen ("carbon-13"), a space ("carbon 13", "helium 3 ion"), or a comma+space ("helium,
// three ions" — a real Whisper transcription of "helium-3 ions", confirmed against the
// committed eval/results/tts-1000-v3-2026-07-18 transcripts) — issue #26: a spoken/ASR
// isotope mention rarely carries the written hyphen, and lookup.ts's parseIsotope already
// tolerates the space form once this regex actually captures it as part of the same match
// (particleHeadResolveText below strips the comma itself before resolving).
export const PARTICLE_HEAD_RE = new RegExp(
  `\\b(${PARTICLE_MEMBER_SRC})\\s+(${PARTICLE_LIST_HEAD_SRC})\\b`,
  "gi",
);
/** English's head word trails the element, and the whole match ("carbon ion") already
 * resolves fine via `resolveParticle`'s suffix-stripping — except a comma-separated isotope
 * ("helium, 3 ions"), which needs the comma stripped first (parseIsotope expects only
 * letters/whitespace/digits). */
export function particleHeadResolveText(m: RegExpExecArray): string {
  return m[0].replace(/,/g, "");
}
// Standalone named particles whose isotope is fixed by the name.
export const NAMED_PARTICLE_RE = new RegExp(`\\b(${NAMED_PARTICLE_SRC})\\b`, "gi");
