/**
 * Single source of truth for the English stopping-power/range keyword vocabulary
 * (issue #160 §9a). Before this module, the same physics-synonym list was independently
 * maintained in `src/lib/intent/lang/en.ts` (the matcher's `DIRECT_STOPPING`/`INDIRECT_IDIOMS`),
 * `scripts/nlu-quantity-prepass.ts` (a 9-rule synonym map, since retired), and
 * `bench/android/full-app/.../KotlinMatcher.kt` (`STOPPING_POWER_RE`/`INDIRECT_IDIOMS`) — adding
 * one synonym correctly meant editing all three in sync, with nothing to catch a missed one.
 *
 * `en.ts` rebuilds its regexes from these constants (see there for the exact reconstruction).
 * `scripts/generate-lexicon.ts` serializes them to `static/lexicon/quantity-en.json`, which the
 * Kotlin matcher loads as an Android asset — the same TS-source → JSON-artifact → Android-asset
 * pattern `src/lib/aliases/` already uses for materials/particles (see `scripts/generate-aliases.ts`
 * and `bench/android/full-app/.../Aliases.kt`).
 *
 * Patterns are stored as regex *source strings*, each already wrapped in its own `\b...\b`
 * anchors, so both `new RegExp()` (TS) and `Regex()` (Kotlin) can consume them identically and the
 * JSON round-trips losslessly.
 */
import type { Quantity } from "../query-intent.ts";

/**
 * Alternatives for the "asking about stopping power" direct keyword regex. Issue #26's physics
 * synonyms: specific ionisation (energy lost per ion pair, proportional to stopping power for a
 * given medium), Bethe-Bloch (the equation stopping power is computed from, used metonymically for
 * the quantity), retarding force (the force-dimensioned reading of dE/dx), energy deposition
 * (density) / dose per micrometer (the dosimetry-register phrasings of the same quantity).
 */
export const STOPPING_POWER_DIRECT_PATTERNS: readonly string[] = [
  "(?:mass\\s+|electronic\\s+)?stopping power",
  "de\\s*/\\s*dx",
  "energy loss",
  "specific ioni[sz]ation",
  "bethe[\\s-]bloch",
  "retarding force",
  "energy deposition(?:\\s+density)?",
  "dose per (?:micrometer|micrometre|micron|[uµ]m)",
];

/** Alternatives for the "asking about CSDA range" direct keyword regex. */
export const RANGE_DIRECT_PATTERNS: readonly string[] = ["csda", "range"];

/**
 * LET (linear energy transfer) is the radiobiology/particle-therapy synonym for (electronic)
 * stopping power. The acronym is matched case-sensitively against the *original* (non-lowercased)
 * text so the ordinary verb "let" ("let me know…") is never misread as the physics term; the
 * spelled-out phrase is unambiguous and matched case-insensitively.
 */
export const STOPPING_POWER_SYNONYM_ACRONYM = "LET";
export const STOPPING_POWER_SYNONYM_PHRASE = "linear energy transfer";

/**
 * Indirect-idiom table: phrasings that imply a quantity without naming it directly. `source` is a
 * full regex source string (its own `\b` anchors included, no flags — every consumer applies these
 * case-insensitively by testing against already-lowercased text).
 */
export const INDIRECT_IDIOM_PATTERNS: ReadonlyArray<{ source: string; quantity: Quantity }> = [
  // csdaRange — "how far / deep / thick … will go / travel / stop / come to rest".
  { source: "\\bhow far\\b", quantity: "csdaRange" },
  { source: "\\bhow deep\\b", quantity: "csdaRange" },
  { source: "\\bhow thick\\b", quantity: "csdaRange" },
  { source: "\\bpenetration depth\\b", quantity: "csdaRange" },
  { source: "\\bpenetrat(?:e|es|ing|ion)\\b", quantity: "csdaRange" },
  { source: "\\bcome to rest\\b", quantity: "csdaRange" },
  { source: "\\bcomes to rest\\b", quantity: "csdaRange" },
  { source: "\\bbefore stopping\\b", quantity: "csdaRange" },
  { source: "\\b(?:will|can|does|do)\\b[^.?!]*\\btravel\\b", quantity: "csdaRange" },
  { source: "\\bshorter distance\\b", quantity: "csdaRange" },
  { source: "\\bgo(?:es)? in\\b", quantity: "csdaRange" },
  { source: "\\bget into\\b", quantity: "csdaRange" },
  { source: "\\bmake it\\b", quantity: "csdaRange" },
  // stoppingPower — "how quickly / at what rate … loses / sheds / lost energy per length".
  { source: "\\b(?:lose[s]?|lost)\\s+energy\\b", quantity: "stoppingPower" },
  { source: "\\bshed[s]? energy\\b", quantity: "stoppingPower" },
  { source: "\\bslowed down\\b", quantity: "stoppingPower" },
  { source: "\\bat what rate\\b", quantity: "stoppingPower" },
  { source: "\\bhow quickly\\b", quantity: "stoppingPower" },
  {
    source:
      "\\b(?:lose[s]?|lost)\\b[^.?!]*\\bper\\s+(?:centimeter|millimeter|cm|mm|unit length)\\b",
    quantity: "stoppingPower",
  },
  {
    source: "\\b(?:per|after)\\s+(?:each\\s+)?(?:centimeter|millimeter|cm|mm|unit length)\\b",
    quantity: "stoppingPower",
  },
  // The verb form of the "energy deposition" synonym (issue #26, DIRECT_STOPPING's own noun form
  // doesn't match this) — "how much energy is deposited per micrometer".
  {
    source:
      "\\benergy\\b[^.?!]*\\bdeposited\\b[^.?!]*\\bper\\s+(?:micrometer|micrometre|micron|[uµ]m)\\b",
    quantity: "stoppingPower",
  },
];

/**
 * Canonical display terms for the quantity slot, shared by the ASR domain corrector's phonetic-
 * distance lexicon (`src/lib/asr/correct/en.ts`'s `LEXICON`). Deliberately coarser than the direct-
 * keyword/idiom vocabulary above — a closed set of *canonical spellings* for a nearest-neighbor
 * fallback, not an exhaustive synonym list.
 */
export const QUANTITY_CANONICAL_TERMS: readonly string[] = [
  "stopping power",
  "range",
  "dE/dx",
  "CSDA",
  "LET",
  "linear energy transfer",
];
