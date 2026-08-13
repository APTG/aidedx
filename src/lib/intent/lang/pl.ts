/**
 * Polish-language pack for the deterministic matcher (issue #87/#63).
 *
 * Vocabulary and regex *shape* are both drawn strictly from the 50
 * physicist-reviewed sentences in `eval/RECORDING.pl.md` — every keyword,
 * idiom, and case form below traces back to a specific sentence there rather
 * than a guessed declension table. Where the corpus doesn't exercise a
 * quantity path (Polish has no `energyFromStp` example), the pack still
 * offers a reasonable minimal implementation rather than leaving it absent,
 * flagged in a comment.
 *
 * The one genuine *shape* divergence from `./en.ts`: Polish names an ion
 * head-first — "jon węgla" ("ion of-carbon", genitive) — rather than
 * English's head-last "carbon ion". `PARTICLE_HEAD_RE` reflects that directly
 * instead of reusing the core's English-shaped regex template.
 */
import type { Quantity } from "../query-intent.ts";

/**
 * Indirect-idiom table, mirroring `en.ts`'s `INDIRECT_IDIOMS`. 8 of the 30
 * range sentences and 1 of the 8 stopping-power sentences don't use the
 * direct "zasięg"/"zdolność hamowania" keywords at all, relying on these verbs
 * instead (`eval/RECORDING.pl.md` #3, #4, #8, #11, #14, #21, #22, #30, #45).
 */
export const INDIRECT_IDIOMS: ReadonlyArray<{ pattern: RegExp; quantity: Quantity }> = [
  // csdaRange — "jak głęboko/daleko wniknie/dotrze/doleci/zajdzie", "na jaką głębokość", "głębiej".
  { pattern: /\bjak\s+głęboko\b/iu, quantity: "csdaRange" },
  { pattern: /\bjak[aąie]?\s+głębokość\b/iu, quantity: "csdaRange" },
  { pattern: /\bjak\s+daleko\b/iu, quantity: "csdaRange" },
  { pattern: /\bgłębiej\b/iu, quantity: "csdaRange" },
  { pattern: /\bwniknie\b|\bwnika\b/iu, quantity: "csdaRange" },
  { pattern: /\bdotrze\b|\bdotrzeć\b/iu, quantity: "csdaRange" },
  { pattern: /\bdoleci\b/iu, quantity: "csdaRange" },
  { pattern: /\bzajdzie\b/iu, quantity: "csdaRange" },
  // stoppingPower — "ile energii traci ... na centymetr [drogi]" (#45).
  { pattern: /\btraci\b[^.?!]*\bcentymetr/iu, quantity: "stoppingPower" },
];

/** Direct keyword regex for stoppingPower, tested against lowercased text. */
export const DIRECT_STOPPING = /\b(?:masowa\s+)?zdolność hamowania\b|\bde\s*\/\s*dx\b/i;
/** Direct keyword regex for csdaRange, tested against lowercased text. */
export const DIRECT_RANGE = /\bzasięg\w*\b|\bcsda\b/i;

/**
 * "LET" is borrowed verbatim into Polish physics speech as the everyday
 * synonym for `zdolność hamowania` (#43, #47, #50) — matched case-sensitively
 * against the original text like `en.ts`'s, so a lowercase transcription
 * artifact never trips it. Polish has no spelled-out equivalent of English's
 * "linear energy transfer" in the eval set, so there is nothing else to check.
 */
export function mentionsStoppingPowerSynonym(_lower: string, text: string): boolean {
  return /\bLET\b/.test(text);
}

/**
 * "Ile energii traci … na centymetr" (#45/pl-sp-03, "how much energy does X
 * lose per centimeter") is the forward energy-loss idiom for stoppingPower,
 * but its "Ile energii" prefix is indistinguishable from the genuine inverse
 * cue "Ile energii potrzebuje …" (#34/#38, "how much energy does X need") —
 * both are "ile" immediately followed by an "energi-" stem. Blanking the
 * whole "ile energii traci … centymetr" span before the inverse test (mirrors
 * `en.ts`'s "linear energy transfer" blank) removes exactly the false-positive
 * case, since the genuine inverse phrasing never uses the verb "traci".
 */
export const BLANK_BEFORE_INVERSE_RE = /\bile\s+energi\p{L}*\s+traci\b[^.?!]*\bcentymetr\p{L}*/giu;

/**
 * Inverse ("solve for energy") cue: a wh-word immediately followed by an
 * "energi-" stem — "Jaką energię", "jakiej energii", "Jaka energia", "Ile
 * energii" — covers all 12 `pl-inv-*` sentences. `\p{L}` (not `\w`) is
 * required for the word-continuation classes here: "Jaką"/"energię" end in a
 * non-ASCII letter (ą/ę) that plain `\w` does not match, so a `\w*`-based
 * version silently fails on exactly the accusative forms the corpus uses.
 */
export function asksForEnergy(deSynonym: string): boolean {
  return /\bjak\p{L}*\s+energi\p{L}*/iu.test(deSynonym) || /\bile\s+energi\p{L}*/iu.test(deSynonym);
}

/**
 * Word-based cues that an inverse query is stopping-power- (vs. range-)
 * flavored. Unexercised by the eval set — all 12 `pl-inv-*` sentences are
 * energyFromRange — but kept analogous to `en.ts`'s for forward compatibility;
 * the language-neutral `STP_UNIT_RE` in the core catches unit-notation cases
 * ("5 MeV/cm") regardless.
 */
export function mentionsStoppingPowerKeyword(lower: string): boolean {
  return /\bzdolność hamowania\b/.test(lower) || /\bmev\s*(?:\/|na)\s*cm\b/.test(lower);
}

/** Last-resort fallback: a bare "zatrzyma-" stem reads as range. Unexercised by the eval set. */
export const FALLBACK_STOP_RE = /\bzatrzyma\w*\b/iu;

/**
 * Empty — no Polish spelled-out-number example exists in eval/RECORDING.pl.md to vet against
 * (issue #26's English fix, "one GeV"/"three MeV", has no confirmed Polish counterpart here).
 * Polish numerals also decline by the followed noun's case/gender in ways a flat word→digit
 * table can't safely capture without a physicist review, unlike English's invariant
 * "one".."ten" — left for a future pack update once real examples exist to build it from.
 */
export const NUMBER_WORDS: ReadonlyArray<readonly [string, string]> = [];

/** Null — no `HUNDRED_WORD` composition without `NUMBER_WORDS` to build it from (see above). */
export const HUNDRED_WORD: string | null = null;

/** Null — same reasoning as `HUNDRED_WORD` above. */
export const POINT_WORD: string | null = null;

/** Null — same reasoning as `HUNDRED_WORD` above. */
export const THOUSAND_WORD: string | null = null;

/** "Zdolność hamowania" is Polish's own long, distinctive direct keyword (mirrors en.ts's
 * "stopping power" entry) — safe to extend the same edit-distance typo tolerance to. */
export const FUZZY_QUANTITY_PHRASES: ReadonlyArray<{ phrase: string; quantity: Quantity }> = [
  { phrase: "zdolność hamowania", quantity: "stoppingPower" },
];

// Words that never start/own a material phrase on their own — the function
// words, quantities, and particle names actually used across the 50
// sentences. Numbers are excluded by the \p{L} requirement in the core scan.
export const MATERIAL_STOPWORDS = new Set([
  "jaki",
  "jaka",
  "jakie",
  "jaką",
  "jakiej",
  "jest",
  "ile",
  "ma",
  "co",
  "gdzie",
  "to",
  "a",
  "na",
  "w",
  "we",
  "i",
  "oraz",
  "czy",
  "lub",
  "o",
  "dla",
  "z",
  "za",
  "przy",
  "do",
  "od",
  "po",
  "przez",
  "energia",
  "energii",
  "energię",
  "energie",
  "zasięg",
  "zasięgu",
  "zasięgowi",
  "proton",
  "protonu",
  "protony",
  "protonów",
  "jon",
  "jonu",
  "cząstka",
  "cząstki",
  "cząstce",
  "alfa",
  "deuteron",
  "deuteronu",
  "tryton",
  "trytonu",
  "nukleon",
  "nukleonie",
  "głęboko",
  "głębokość",
  "głębiej",
  "daleko",
  "wniknie",
  "wnika",
  "dotrze",
  "dotrzeć",
  "doleci",
  "zajdzie",
  "zatrzyma",
  "podaj",
  "oblicz",
  "porównaj",
  "powiedz",
  "mi",
  "zmienia",
  "się",
  "musi",
  "mieć",
  "trzeba",
  "nadać",
  "aby",
  "żeby",
  "uzyska",
  "osiągnie",
  "potrzebuje",
  "odpowiada",
  "wynosi",
  "drogi",
  "centymetr",
  "centymetra",
]);

/**
 * issue #163 C8 — Polish counterpart of `en.ts`'s `UNRESOLVED_MATERIAL_RE`: the word(s)
 * immediately after "w"/"we" ("in"), the dominant way a target material is phrased directly in
 * Polish (locative case, e.g. "w wodzie"). Capture group 1 is the candidate phrase.
 *
 * Trailing boundary is a negative lookahead, not `\b`: JS's `\b` is defined over ASCII `\w`, so a
 * capture ending in a Polish diacritic (outside `[A-Za-z0-9_]`) sits between two "non-word"
 * characters from `\b`'s point of view and the boundary silently fails to match there, missing
 * the phrase entirely (Copilot review, PR #214). `(?![\p{L}])` stays Unicode-aware the same way
 * the capture group's own `\p{L}` character class already is.
 */
export const UNRESOLVED_MATERIAL_RE = /\bwe?\s+([\p{L}][\p{L}-]*(?:\s+[\p{L}-]+)?)(?![\p{L}])/giu;

/** Polish counterpart of `en.ts`'s `UNRESOLVED_MATERIAL_FILLERS` — "w ogóle"/"w teorii"/"w tym
 * przypadku" etc. are common filler, not material mentions. */
export const UNRESOLVED_MATERIAL_FILLERS = new Set([
  "ogóle",
  "teorii",
  "praktyce",
  "szczególności",
  "rzeczywistości",
  "skrócie",
  "sumie",
  "tym przypadku",
  "tamtym przypadku",
]);

/**
 * Null — Polish expresses "range of a muon" head-first via genitive case ("zasięg mionu"),
 * already covered by `PARTICLE_HEAD_RE`/`NAMED_PARTICLE_RE`, so there is no separate "of <X> in
 * <Y>" shape a fallback detector needs to catch (issue #163 C8).
 */
export const UNRESOLVED_PARTICLE_RE: RegExp | null = null;

/** Connector between list members — Polish uses "i" ("and"), serial-comma "X, Y i Z". */
export const LIST_SEP_SRC = "(?:\\s*,\\s*(?:i\\s+)?|\\s+i\\s+)";

/**
 * Optional per-nucleon suffix. The eval set only ever says "na nukleon" — no
 * contracted or per-mass-unit form — so a single capture group is enough (the
 * core's `extractEnergies` scans every trailing group, so this doesn't need
 * to match `en.ts`'s two-group shape).
 */
export const PER_NUCL_SUFFIX_SRC = "(?:\\s+na\\s+(nukleon))?";

/** Polish's "na nukleon" always reads as per-nucleon; there is no per-amu/"u" construction in the eval set. */
export function perNuclUnitFor(_suffixWord: string): "MeV/u" | "MeV/nucl" {
  return "MeV/nucl";
}

/**
 * Each ion mention is a self-contained "jon <element>" clause — even
 * multi-particle sentences (#30 "jon węgla czy jon neonu", #42 "...proton...?
 * A jon węgla?") repeat the head rather than sharing it the way English's
 * "carbon and neon ions" does. No coordinated-list shape is needed.
 */
export const PARTICLE_LIST_RE = null;

/**
 * Head-first "jon <element>[-<mass>]" — "jon węgla", "jonu żelaza", "jon
 * helu-3", "jonu węgla-12". Capture group 1 is the element (+ optional
 * isotope suffix) text handed to `resolveParticle`; "jon"/"jonu" (nominative
 * vs. genitive) is a fixed two-word closed set in the eval set, not a broader
 * head-word alternation like English's "ion(s)/particle(s)/nuclei".
 */
export const PARTICLE_HEAD_RE = /\bjonu?\s+([\p{L}]+(?:-\d{1,3})?)\b/giu;

/** Polish's head is a fixed prefix, not a decorative suffix — group 1 (the element text) is what resolves, not the whole "jon węgla" match. */
export function particleHeadResolveText(m: RegExpExecArray): string {
  return m[1] ?? m[0];
}

/**
 * Standalone named particles whose isotope is fixed by the name — proton,
 * deuteron, triton, and the multi-word "cząstka alfa" (alpha particle), in
 * every case form the eval set uses (nominative/genitive/dative).
 */
export const NAMED_PARTICLE_RE =
  /\b(proton(?:ów|y|u)?|deuteron(?:u)?|tryton(?:u)?|cząstk[ai] alfa|cząstce alfa)\b/giu;
