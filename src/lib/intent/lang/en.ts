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

/**
 * Indirect-idiom table: phrasings that imply a quantity without naming it.
 * These are the cases the issue flags as "the LLM's job"; the deterministic
 * matcher leans on this table to claw back the common, formulaic ones.
 */
export const INDIRECT_IDIOMS: ReadonlyArray<{ pattern: RegExp; quantity: Quantity }> = [
  // csdaRange — "how far / deep / thick … will go / travel / stop / come to rest".
  { pattern: /\bhow far\b/, quantity: "csdaRange" },
  { pattern: /\bhow deep\b/, quantity: "csdaRange" },
  { pattern: /\bhow thick\b/, quantity: "csdaRange" },
  { pattern: /\bpenetration depth\b/, quantity: "csdaRange" },
  { pattern: /\bpenetrat(?:e|es|ing|ion)\b/, quantity: "csdaRange" },
  { pattern: /\bcome to rest\b/, quantity: "csdaRange" },
  { pattern: /\bcomes to rest\b/, quantity: "csdaRange" },
  { pattern: /\bbefore stopping\b/, quantity: "csdaRange" },
  { pattern: /\b(?:will|can|does|do)\b[^.?!]*\btravel\b/, quantity: "csdaRange" },
  { pattern: /\bshorter distance\b/, quantity: "csdaRange" },
  { pattern: /\bgo(?:es)? in\b/, quantity: "csdaRange" },
  { pattern: /\bget into\b/, quantity: "csdaRange" },
  { pattern: /\bmake it\b/, quantity: "csdaRange" },
  // stoppingPower — "how quickly / at what rate … loses / sheds / lost energy per length".
  { pattern: /\b(?:lose[s]?|lost)\s+energy\b/, quantity: "stoppingPower" },
  { pattern: /\bshed[s]? energy\b/, quantity: "stoppingPower" },
  { pattern: /\bslowed down\b/, quantity: "stoppingPower" },
  { pattern: /\bat what rate\b/, quantity: "stoppingPower" },
  { pattern: /\bhow quickly\b/, quantity: "stoppingPower" },
  {
    pattern: /\b(?:lose[s]?|lost)\b[^.?!]*\bper\s+(?:centimeter|millimeter|cm|mm|unit length)\b/,
    quantity: "stoppingPower",
  },
  {
    pattern: /\b(?:per|after)\s+(?:each\s+)?(?:centimeter|millimeter|cm|mm|unit length)\b/,
    quantity: "stoppingPower",
  },
  // The verb form of the "energy deposition" synonym (issue #26, DIRECT_STOPPING's own noun
  // form doesn't match this) — "how much energy is deposited per micrometer".
  {
    pattern:
      /\benergy\b[^.?!]*\bdeposited\b[^.?!]*\bper\s+(?:micrometer|micrometre|micron|[uµ]m)\b/,
    quantity: "stoppingPower",
  },
];

/**
 * Direct keyword regex for the stoppingPower / csdaRange quantities (matched against
 * lowercased text). Issue #26 added the physics-synonym alternatives beyond the original
 * "stopping power"/"dE/dx"/"energy loss": specific ionisation (energy lost per ion pair,
 * proportional to stopping power for a given medium), Bethe-Bloch (the equation stopping
 * power is computed from — used metonymically for the quantity itself), retarding force
 * (the force-dimensioned reading of dE/dx), and energy deposition (density) / dose per
 * micrometer (the dosimetry-register phrasings of the same quantity).
 */
export const DIRECT_STOPPING =
  /\b(?:mass\s+|electronic\s+)?stopping power\b|\bde\s*\/\s*dx\b|\benergy loss\b|\bspecific ioni[sz]ation\b|\bbethe[\s-]bloch\b|\bretarding force\b|\benergy deposition(?:\s+density)?\b|\bdose per (?:micrometer|micrometre|micron|[uµ]m)\b/i;
export const DIRECT_RANGE = /\bcsda\b|\brange\b/i;

/**
 * LET (linear energy transfer) is the radiobiology / particle-therapy synonym for
 * (electronic) stopping power — unrestricted LET∞ is operationally equal to the
 * electronic mass stopping power libdedx returns, so it maps to `stoppingPower`.
 *
 * The acronym is matched CASE-SENSITIVELY against the *original* text (`/\bLET\b/`,
 * not the lowercased copy the other detectors use) so the ordinary verb "let"
 * ("let me know…", "Let's…") is never misread as the physics term. The spelled-out
 * form is unambiguous and matched case-insensitively. ASR transcripts that lowercase
 * the acronym are normalized upstream by the domain corrector (issue #28).
 */
export function mentionsStoppingPowerSynonym(lower: string, text: string): boolean {
  return /\bLET\b/.test(text) || /\blinear energy transfer\b/.test(lower);
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
 */
export const BLANK_BEFORE_INVERSE_RE =
  /\blinear energy transfer\b|\benergy deposition(?:\s+density)?\b|\benergy\b\s+(?:is\s+|was\s+)?(?:lost|lose[s]?|shed[s]?|loss)\s+per\s+(?:centimeter|millimeter|cm|mm|unit length)\b/g;

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

/** Spelled-out one through ten — the small, closed set actually plausible in an energy
 * phrase ("one GeV", "three MeV"); not a full number-word parser (issue #26). */
export const NUMBER_WORDS: ReadonlyArray<readonly [string, string]> = [
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
];

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
