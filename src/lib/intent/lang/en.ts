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
  // stoppingPower — "how quickly / at what rate … loses / sheds energy per length".
  { pattern: /\blose[s]? energy\b/, quantity: "stoppingPower" },
  { pattern: /\bshed[s]? energy\b/, quantity: "stoppingPower" },
  { pattern: /\bslowed down\b/, quantity: "stoppingPower" },
  { pattern: /\bat what rate\b/, quantity: "stoppingPower" },
  { pattern: /\bhow quickly\b/, quantity: "stoppingPower" },
  {
    pattern: /\blose[s]?\b[^.?!]*\bper\s+(?:centimeter|millimeter|cm|mm|unit length)\b/,
    quantity: "stoppingPower",
  },
  {
    pattern: /\b(?:per|after)\s+(?:each\s+)?(?:centimeter|millimeter|cm|mm|unit length)\b/,
    quantity: "stoppingPower",
  },
];

/** Direct keyword regex for the stoppingPower / csdaRange quantities (matched against lowercased text). */
export const DIRECT_STOPPING =
  /\b(?:mass\s+|electronic\s+)?stopping power\b|\bde\s*\/\s*dx\b|\benergy loss\b/i;
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
 * The spelled-out stopping-power synonym, blanked out of the lowercased text
 * before the inverse detector's asks-for-energy test — "linear energy transfer"
 * contains the word "energy" but is not a request to solve for energy.
 */
export const BLANK_BEFORE_INVERSE_RE = /\blinear energy transfer\b/g;

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
    /\blose[s]?\b[^.?!]*\bmev per cm\b/.test(lower) ||
    /\bmev per cm\b/.test(lower)
  );
}

/** Last-resort fallback: a bare "stops/stopped" verb reads as range. */
export const FALLBACK_STOP_RE = /\bstop(?:s|ped)?\b/;

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

/** Trailing head word for a coordinated particle list or a single "<element> ion(s)" head. */
export const PARTICLE_LIST_HEAD_SRC = "ions?|particles?|nuclei|nucleus";

/** Standalone named particles whose isotope is fixed by the name. */
export const NAMED_PARTICLE_SRC =
  "protons?|deuterons?|tritons?|alpha particles?|alphas?|helions?|electrons?|positrons?|beta minus|betas?";
