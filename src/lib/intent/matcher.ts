/**
 * Deterministic NLU matcher for aidedx (issue #5, Spike 2 — deterministic half).
 *
 * Turns a natural-language query into a {@link QueryIntent} using only a
 * hand-written grammar plus the libdedx synonym/alias tables — no model. It is
 * the lower, certain half of the planned hybrid (deterministic ⊕ LLM) NLU: the
 * coverage harness (`coverage.ts`) measures exactly how far this gets over the
 * eval set, which is the empirical justification for how much LLM we still need.
 *
 * Pipeline (each stage is a small, independently testable function):
 *   1. quantity        — direct keywords, an indirect-idiom table, and the
 *                        inverse-query ("what energy gives …") detector.
 *   2. energies/target — number+unit grammar with per-nucleon-vs-total handling.
 *   3. particles       — named particles, a single "<element> ion(s)"-shaped
 *                        head, and (where the language uses it) a coordinated
 *                        list sharing one trailing head ("carbon and neon ions").
 *   4. materials       — n-gram scan resolved against the material alias table.
 *   5. compareDim      — entity multiplicity + program-name detection.
 *   6. resolver        — fuzzy-match slots to real libdedx entities, fill
 *                        `assumptions[]` (isotope defaults, total→per-nucleon)
 *                        and a calibrated `confidence`.
 *
 * Every keyword/idiom/regex table is supplied by a `LangPack` (`./lang/en.ts`,
 * `./lang/pl.ts`) selected by the `lang` parameter (issue #87 Part B) — this
 * file is the language-neutral control flow that consumes whichever pack is
 * selected; a pack's regexes may differ in *shape*, not just vocabulary (e.g.
 * Polish's head-first "jon węgla" vs. English's head-last "carbon ion").
 *
 * Both this matcher and the future LLM emit the *same* QueryIntent shape, so all
 * downstream code (resolver, compute, NLG) is producer-agnostic.
 */
import {
  boundedLevenshtein,
  resolveMaterial,
  resolveParticle,
  type MaterialMatch,
  type ParticleMatch,
} from "../aliases/index.ts";
import { formatSignificant } from "../format.ts";
import * as en from "./lang/en.ts";
import * as pl from "./lang/pl.ts";
import type { Lang, LangPack } from "./lang/types.ts";
import type {
  CompareDim,
  EnergySlot,
  EnergyUnit,
  MaterialSlot,
  ParticleSlot,
  Quantity,
  QueryIntent,
  RangeTargetUnit,
  StpTargetUnit,
  TargetSlot,
} from "./query-intent.ts";

/** Select the language pack for `lang` (default English, issue #87). */
function packFor(lang: Lang): LangPack {
  return lang === "pl" ? pl : en;
}

// ---------------------------------------------------------------------------
// Result type — the intent plus a little provenance the harness/tests can read.
// ---------------------------------------------------------------------------

/** How the quantity was decided, for confidence weighting and debugging. */
export type QuantitySource = "direct" | "indirect" | "inverse" | "default";

/**
 * issue #163 B3 — a particle/material *named* in the query text but not resolvable against the
 * alias tables (an entity libdedx has no data for — "stainless steel", "muons" — as opposed to a
 * slot that was never mentioned at all). Populated only when the corresponding slot in `intent`
 * came up empty; `fill-defaults.ts`'s `fillMissingSlots()` must not silently substitute a default
 * for a slot this lists, since doing so is what produced the false "material not specified"
 * banner the bug report measured.
 */
export interface UnresolvedEntity {
  kind: "particle" | "material";
  /** The phrase as it appeared in the query, not resolved against any alias table. */
  phrase: string;
}

export interface MatchResult {
  intent: QueryIntent;
  /** Which strategy fixed the quantity slot. */
  quantitySource: QuantitySource;
  /** The indirect-idiom phrase that fired, if any (for traceability). */
  idiom?: string;
  /** True when a required slot could not be filled (a likely LLM-fallback). */
  incomplete: boolean;
  /** Named-but-unresolved particle/material mentions — see `UnresolvedEntity`. Empty when every
   * empty slot was genuinely never mentioned (the common case). */
  unresolved: UnresolvedEntity[];
}

interface Span {
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// 1. Quantity — direct keywords, indirect idioms, inverse queries
//
// The keyword/idiom data is pack-supplied (`./lang/en.ts`, `./lang/pl.ts`);
// this section is the language-neutral control flow that consumes it.
// ---------------------------------------------------------------------------

/**
 * Compose spelled-out hundreds ("two hundred and fifty" -> "250", "one hundred" -> "100",
 * "one hundred fifty" -> "150") into digits, one length-preserving span at a time — a genuine
 * multi-word composition, unlike `spellOutNumbers()`'s one-token-at-a-time substitution, so it
 * must run first and replace the *whole* matched phrase, not word-by-word (issue #122: NeMo
 * Parakeet has no ASR inverse-text-normalization, so hundreds come out fully spelled, not just
 * the single digits issue #26 originally handled). The leading multiplier is restricted to
 * `NUMBER_WORDS`' 1-9 entries ("ten hundred" isn't a real number); the optional trailing
 * remainder is any `NUMBER_WORDS` entry (1-99) *or* an already-composed `\d+` run (issue #163 B4
 * — `composeTensOnes()` now runs first, see `spellOutNumbers()` below, so "thirty five" has
 * already become "35" by the time this pattern looks for a remainder), so "and"-joined, bare-word,
 * and tens+ones-compound remainders all resolve. "Thousand" and above is out of scope — not
 * attested in this project's eval set.
 */
function composeHundreds(text: string, pack: LangPack): string {
  if (!pack.HUNDRED_WORD) return text;
  const digitOf = new Map(pack.NUMBER_WORDS);
  const onesAlt = pack.NUMBER_WORDS.filter(([, d]) => Number(d) >= 1 && Number(d) <= 9)
    .map(([w]) => w)
    .join("|");
  const remainderAlt = pack.NUMBER_WORDS.map(([w]) => w).join("|");
  const re = new RegExp(
    `\\b(${onesAlt})\\s+${pack.HUNDRED_WORD}\\b(?:\\s+(?:and\\s+)?(\\d+|${remainderAlt})\\b)?`,
    "gi",
  );
  return text.replace(re, (m, onesWord: string, remainderWord?: string) => {
    const hundreds = Number(digitOf.get(onesWord.toLowerCase())) * 100;
    // No trailing remainder word ("just "one hundred") means the remainder is 0.
    let remainder = 0;
    if (remainderWord) {
      remainder = /^\d+$/.test(remainderWord)
        ? Number(remainderWord)
        : Number(digitOf.get(remainderWord.toLowerCase()));
    }
    return String(hundreds + remainder).padEnd(m.length);
  });
}

/**
 * Compose a bare spelled-out tens+ones compound ("fifty eight" -> "58") into digits, same
 * length-preserving whole-phrase substitution as `composeHundreds()` (issue #156 — a two-word
 * non-round value like "fifty eight MeV" or "fifty eight point four MeV" left the tens word
 * stranded: `NUMBER_WORDS` only has single-word entries, so nothing composed "fifty" and "eight"
 * into one number, and `extractEnergies()`'s single-`\d+` number grammar then picked up only
 * whichever word ended up adjacent to the unit). Must run before `composeDecimals()` so a
 * tens+ones compound in front of "point" is already a single digit run by the time that
 * function's whole-part alternative looks for one — and, since issue #163 B4, before
 * `composeHundreds()` too: reusing `spellOutNumbers()`'s original hundreds-then-tens-ones order,
 * "two hundred thirty five" had `composeHundreds()` consume "two hundred thirty" as hundreds=200 +
 * remainder="thirty" (30) first, leaving "five" orphaned with no adjacent tens word left to compose
 * with — so `extractEnergies()`'s number grammar picked up whichever bare digit ended up next to
 * the unit (5 MeV, not 235). Composing "thirty five" into "35" *before* `composeHundreds()` runs
 * means the hundreds pass instead sees an already-composed `\d+` remainder, which its own regex
 * was widened above to accept.
 */
function composeTensOnes(text: string, pack: LangPack): string {
  const digitOf = new Map(pack.NUMBER_WORDS);
  const tensAlt = pack.NUMBER_WORDS.filter(([, d]) => Number(d) >= 20 && Number(d) % 10 === 0)
    .map(([w]) => w)
    .join("|");
  const onesAlt = pack.NUMBER_WORDS.filter(([, d]) => Number(d) >= 1 && Number(d) <= 9)
    .map(([w]) => w)
    .join("|");
  if (!tensAlt || !onesAlt) return text;
  const re = new RegExp(`\\b(${tensAlt})\\s+(${onesAlt})\\b`, "gi");
  return text.replace(re, (m, tensWord: string, onesWord: string) => {
    const tens = Number(digitOf.get(tensWord.toLowerCase()));
    const ones = Number(digitOf.get(onesWord.toLowerCase()));
    return String(tens + ones).padEnd(m.length);
  });
}

/**
 * Compose a spelled-out decimal ("three point six" -> "3.6") into digits, same
 * length-preserving whole-phrase substitution as `composeHundreds()` (issue #122 — some clips
 * spell out "3.6 GeV" as "three point six GeV" instead of giving the digits directly; "dot"
 * added alongside "point" and a leading decimal with no whole part supported for #156 — "point
 * five MeV"/"dot five MeV" spoken for 0.5 MeV). The whole-number part is any `NUMBER_WORDS`
 * entry (1-99), or, once `composeTensOnes()` has already run, a composed tens+ones digit run
 * ("58" in "58 point four"), or omitted entirely ("point five" -> "0.5" — `extractEnergies()`'s
 * `\d+(?:\.\d+)?` grammar requires a leading digit, so a bare fraction needs an explicit "0").
 * Each digit after "point"/"dot" is restricted to the 0-9 entries or a bare digit character
 * ("point six"/"point 6", not "point sixty" — decimal digits are read one at a time, spelled or
 * not; a transcript can mix the two, e.g. ASR giving "point 5" with a literal digit).
 */
function composeDecimals(text: string, pack: LangPack): string {
  if (!pack.POINT_WORD) return text;
  const digitOf = new Map(pack.NUMBER_WORDS);
  const wholeAlt = pack.NUMBER_WORDS.map(([w]) => w).join("|");
  const digitAlt = pack.NUMBER_WORDS.filter(([, d]) => Number(d) <= 9)
    .map(([w]) => w)
    .join("|");
  const re = new RegExp(
    `\\b(?:(\\d+|${wholeAlt})\\s+)?(?:${pack.POINT_WORD})\\s+((?:(?:${digitAlt}|\\d)\\s*)+)`,
    "gi",
  );
  return text.replace(re, (m, wholeWord: string | undefined, digitsPart: string) => {
    const whole = wholeWord
      ? /^\d+$/.test(wholeWord)
        ? wholeWord
        : digitOf.get(wholeWord.toLowerCase())
      : "0";
    const digits = digitsPart
      .trim()
      .split(/\s+/)
      .map((w) => (/^\d$/.test(w) ? w : digitOf.get(w.toLowerCase())))
      .join("");
    return `${whole}.${digits}`.padEnd(m.length);
  });
}

/**
 * Replace a pack's spelled-out number words ("one", "three") with their digit form, padded
 * with trailing spaces so the string's length — and every character offset after it — is
 * unchanged (issue #26: "one GeV"/"three MeV" otherwise carry no energy slot at all, since
 * the number+unit grammar only ever looks for `\d+`). Padding instead of a plain replace
 * keeps every span computed downstream (particle/material/energy positions) valid in both
 * the substituted and original text, with no separate bookkeeping to reconcile them.
 */
function spellOutNumbers(text: string, pack: LangPack): string {
  // issue #163 B4 — tens+ones must compose *before* hundreds (see composeTensOnes()'s own doc
  // comment for why the opposite order silently drops a value like "thirty" out of "two hundred
  // thirty five").
  let out = composeDecimals(composeHundreds(composeTensOnes(text, pack), pack), pack);
  for (const [word, digit] of pack.NUMBER_WORDS) {
    out = out.replace(new RegExp(`\\b${word}\\b`, "gi"), (m) => digit.padEnd(m.length));
  }
  return out;
}

/** Unit-notation cue that an inverse query's target is stopping-power-flavored (vs. range-flavored); unit notation is language-neutral. */
const STP_UNIT_RE = /\bmev\s*cm2\s*\/\s*g\b|\bmev\s*\/\s*cm\b|\bkev\s*\/\s*[uµ]m\b/;

/**
 * Last-resort typo tolerance for a pack's canonical quantity phrases (issue #26, "Stoping
 * power"): scan every word-window the same length as each candidate phrase and accept a
 * near-miss within the alias table's own length-scaled edit-distance budget. Runs only after
 * every exact detector (direct keywords, indirect idioms) has already failed to match, so an
 * exact "stopping power" is never second-guessed by this path.
 */
function detectFuzzyQuantity(
  lower: string,
  pack: LangPack,
): { quantity: Quantity; idiom: string } | null {
  const words = lower.match(/[\p{L}]+/gu) ?? [];
  for (const { phrase, quantity } of pack.FUZZY_QUANTITY_PHRASES) {
    const phraseWords = phrase.split(/\s+/);
    const n = phraseWords.length;
    const target = phraseWords.join(" ");
    const max = target.length >= 7 ? 2 : 1;
    for (let i = 0; i + n <= words.length; i++) {
      const window = words.slice(i, i + n).join(" ");
      if (Math.abs(window.length - target.length) > max) continue;
      if (boundedLevenshtein(window, target, max) <= max) {
        return { quantity, idiom: window };
      }
    }
  }
  return null;
}

/** Detect an inverse ("solve for energy") query and which kind. */
function detectInverse(lower: string, text: string, pack: LangPack): Quantity | null {
  // A forward stopping-power synonym like "linear energy transfer" contains the
  // word "energy" but is NOT a request to solve for energy — blank it before the
  // asks-for-energy test so a forward LET query ("what is the linear energy
  // transfer of…") isn't misread as inverse.
  const deSynonym = lower.replace(pack.BLANK_BEFORE_INVERSE_RE, " ");
  if (!pack.asksForEnergy(deSynonym)) return null;
  const isStp =
    STP_UNIT_RE.test(lower) ||
    pack.mentionsStoppingPowerSynonym(lower, text) ||
    pack.mentionsStoppingPowerKeyword(lower);
  return isStp ? "energyFromStp" : "energyFromRange";
}

/** Decide the forward quantity (non-inverse) and how it was found. */
function detectForwardQuantity(
  lower: string,
  text: string,
  pack: LangPack,
): {
  quantity: Quantity;
  source: QuantitySource;
  idiom?: string;
} {
  // Strong direct keywords win first: "stopping power" / "dE/dx" / "LET" then "range".
  if (pack.DIRECT_STOPPING.test(lower) || pack.mentionsStoppingPowerSynonym(lower, text))
    return { quantity: "stoppingPower", source: "direct" };
  if (pack.DIRECT_RANGE.test(lower)) return { quantity: "csdaRange", source: "direct" };

  for (const { pattern, quantity } of pack.INDIRECT_IDIOMS) {
    const m = pattern.exec(lower);
    if (m) return { quantity, source: "indirect", idiom: m[0] };
  }

  // A typo'd direct keyword ("Stoping power") reads the same as the real one, one tier
  // below an exact match — tried after indirect idioms so a genuine phrasing is never
  // second-guessed by an edit-distance near-miss.
  const fuzzy = detectFuzzyQuantity(lower, pack);
  if (fuzzy) return { quantity: fuzzy.quantity, source: "indirect", idiom: fuzzy.idiom };

  // Last resort: a bare "stops/stopped … in <length>" reads as range.
  if (pack.FALLBACK_STOP_RE.test(lower))
    return { quantity: "csdaRange", source: "indirect", idiom: "stop" };

  // Unknown — default to range but flag low confidence via "default" source.
  return { quantity: "csdaRange", source: "default" };
}

// ---------------------------------------------------------------------------
// 2. Energies and inverse-query target
// ---------------------------------------------------------------------------

/** Map a base unit token + optional per-nucleon suffix to the schema enum. */
function toEnergyUnit(base: string, pack: LangPack, perNuclSuffix?: string): EnergyUnit {
  if (perNuclSuffix) return pack.perNuclUnitFor(perNuclSuffix);
  const b = base.toLowerCase();
  if (b === "kev") return "keV";
  if (b === "gev") return "GeV";
  if (b === "tev") return "TeV";
  return "MeV";
}

/**
 * Resolve a raw number + base unit + optional per-nucleon suffix to the schema's
 * `{ value, unit }`. The only per-nucleon units in the schema are MeV-based
 * (`MeV/nucl`, `MeV/u`), so a keV/GeV value that carries a per-nucleon suffix is
 * converted to MeV to preserve magnitude: "500 keV/u" → `{ 0.5, "MeV/u" }`,
 * "1.2 GeV/nucl" → `{ 1200, "MeV/nucl" }`. A forward (non-per-nucleon) value
 * keeps its stated unit untouched.
 */
function toEnergyValueUnit(
  rawValue: number,
  base: string,
  pack: LangPack,
  suffix?: string,
): { value: number; unit: EnergyUnit } {
  const unit = toEnergyUnit(base, pack, suffix);
  if (suffix === undefined) return { value: rawValue, unit };
  const b = base.toLowerCase();
  const value =
    b === "kev"
      ? rawValue / 1000
      : b === "gev"
        ? rawValue * 1000
        : b === "tev"
          ? rawValue * 1_000_000
          : rawValue;
  return { value: round(value), unit };
}

/** Build the list-member split regex from a pack's connector-word source. */
function buildListSplitRe(pack: LangPack): RegExp {
  return new RegExp(pack.LIST_SEP_SRC, "i");
}

/**
 * The number grammar always places group 1 = the number(s), group 2 = the
 * base unit, so a pack's `PER_NUCL_SUFFIX_SRC` capture group(s) — however
 * many it declares — start at index 3. Scanning for whichever one matched
 * (instead of a hardcoded `m[3] ?? m[4]`) lets English's two-shape suffix
 * (slash form / "per" form) and Polish's single-shape "na nukleon" share the
 * same extraction code.
 */
function perNuclSuffixFrom(m: RegExpExecArray): string | undefined {
  for (let i = 3; i < m.length; i++) {
    if (m[i] !== undefined) return m[i]?.toLowerCase();
  }
  return undefined;
}

interface RawEnergy {
  value: number;
  unit: EnergyUnit;
  perNucleon: boolean;
  span: Span;
  /**
   * True when a "-" sign sits directly before this match. The number grammar
   * (`\d+`) never captures a leading sign, so without this check "-100 MeV"
   * silently parses as "100 MeV" — the sign is simply dropped rather than
   * producing an error. Flagging it here lets the caller drop the value
   * instead of treating it as a normal positive energy.
   */
  negative: boolean;
}

/**
 * True when a "-" (a sign the number grammar can't capture) sits directly
 * before `matchStart`, ignoring intervening whitespace — "-100" and "- 100"
 * both count. Excludes a "-" that is itself preceded by a digit (skipping
 * whitespace), since that's a hyphenated range/compound like "100-200 MeV"
 * or "100 - 200 MeV" — the "-" separates two numbers rather than negating
 * one, so treating it as a sign would incorrectly drop "200 MeV" and mark
 * the query incomplete.
 */
function isNegativeAt(text: string, matchStart: number): boolean {
  let i = matchStart - 1;
  while (i >= 0 && /\s/.test(text[i] ?? "")) i--;
  if (i < 0 || text[i] !== "-") return false;
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j] ?? "")) j--;
  return !(j >= 0 && /\d/.test(text[j] ?? ""));
}

interface EnergyRegexes {
  energyRe: RegExp;
  energyListRe: RegExp;
}

/**
 * These patterns depend only on the selected `LangPack`, which is a stable
 * module-namespace reference (`packFor` always returns the same `en`/`pl`
 * object), so compiling them once per pack and caching avoids recompiling on
 * every `extractEnergies` call. `matchAll` clones the regex it's given, so a
 * shared cached instance is safe to reuse across calls.
 */
const energyRegexCache = new WeakMap<LangPack, EnergyRegexes>();

function energyRegexesFor(pack: LangPack): EnergyRegexes {
  const cached = energyRegexCache.get(pack);
  if (cached) return cached;

  // [\s-]* (not \s*) between the number and unit — issue #26: a written "10-MeV proton"
  // hyphenates the compound adjective, which \s* alone doesn't match.
  const energyRe = new RegExp(
    `(\\d+(?:\\.\\d+)?)[\\s-]*(tev|gev|mev|kev)\\b${pack.PER_NUCL_SUFFIX_SRC}`,
    "gi",
  );
  // A coordinated list of values sharing one trailing unit: "100 and 200 MeV",
  // "50, 100, and 150 MeV", "100 and 400 MeV per nucleon".
  const energyListRe = new RegExp(
    `((?:\\d+(?:\\.\\d+)?${pack.LIST_SEP_SRC})+\\d+(?:\\.\\d+)?)[\\s-]*(tev|gev|mev|kev)\\b${pack.PER_NUCL_SUFFIX_SRC}`,
    "gi",
  );

  const regexes: EnergyRegexes = { energyRe, energyListRe };
  energyRegexCache.set(pack, regexes);
  return regexes;
}

/** Extract every "<number> <unit>[/nucleon]" energy, in reading order.
 * Entries with `negative: true` are still returned (so their span can be
 * excluded from later material matching) but must not be used as a slot
 * value — see `isNegativeAt`. */
function extractEnergies(text: string, pack: LangPack): RawEnergy[] {
  const { energyRe, energyListRe } = energyRegexesFor(pack);

  const out: RawEnergy[] = [];
  const consumed: Span[] = [];

  // Shared-unit lists first, so the trailing "<num> <unit>" isn't also matched
  // as a lone energy below.
  for (const m of text.matchAll(energyListRe)) {
    const start = m.index ?? 0;
    const span = { start, end: start + m[0].length };
    const base = m[2] ?? "mev";
    const suffix = perNuclSuffixFrom(m);
    const listText = m[1] ?? "";
    // Each member's own position (not just the list's start) decides its sign — a leading
    // "-" on the first value must not be attributed to every later value in the list.
    const numberRe = /\d+(?:\.\d+)?/g;
    for (const nm of listText.matchAll(numberRe)) {
      const raw = Number(nm[0]);
      const negative = isNegativeAt(text, start + (nm.index ?? 0));
      const { value, unit } = toEnergyValueUnit(raw, base, pack, suffix);
      out.push({ value, unit, perNucleon: suffix !== undefined, span, negative });
    }
    consumed.push(span);
  }

  for (const m of text.matchAll(energyRe)) {
    const start = m.index ?? 0;
    const span = { start, end: start + m[0].length };
    if (consumed.some((s) => span.start < s.end && s.start < span.end)) continue;
    const base = m[2] ?? "mev";
    const suffix = perNuclSuffixFrom(m);
    const { value, unit } = toEnergyValueUnit(Number(m[1]), base, pack, suffix);
    out.push({
      value,
      unit,
      perNucleon: suffix !== undefined,
      span,
      negative: isNegativeAt(text, start),
    });
  }

  return out.sort((a, b) => a.span.start - b.span.start);
}

/** Convert an energy value to MeV (for the total→per-nucleon assumption note). */
function toMeV(value: number, unit: EnergyUnit): number {
  if (unit === "keV") return value / 1000;
  if (unit === "GeV") return value * 1000;
  if (unit === "TeV") return value * 1_000_000;
  return value; // MeV, MeV/nucl, MeV/u
}

// [\s-]* (not \s*) between the number and unit — issue #26: a written "10-cm range" hyphenates
// the compound adjective, which \s* alone doesn't match (a literal "-" isn't whitespace).
// Spelled-out forms ("centimeters", "millimeters", "micrometers") added for issue #122 — NeMo
// Parakeet, unlike Whisper, tends to spell length units out in full rather than abbreviate them
// (the issue's own maintainer quote: "length units (cm, mm), usually spelled out in full").
const LENGTH_TARGET_RE =
  /(\d+(?:\.\d+)?)[\s-]*(g\s*\/\s*cm\s*\^?\s*2|g\s*cm\s*\^?\s*-?\s*2|mm|millimeters?|cm|centimeters?|[uµ]m|micrometers?|micron[s]?)\b/i;

interface RawTarget {
  slot: TargetSlot;
  span: Span;
}

/**
 * Normalizes `LENGTH_TARGET_RE`'s captured unit group to the closed `RangeTargetUnit` set,
 * returning `null` for anything unrecognized. issue #163 B1 — the previous version (`let unit =
 * raw; if/else...`) had no real default: every branch that didn't match left `unit` as whatever
 * raw text the regex happened to capture, typed as plain `string`. That's what let a captured
 * "um"/"µm" silently reach `compute.ts`'s `rangeTargetToGcm2()`, which had no `"um"` branch either
 * and fell through to treating it as centimetres — a ~200× error with no error, warning, or
 * plausibility flag anywhere. Returning `null` here instead means an unrecognized unit drops the
 * target entirely (the query reads as incomplete) rather than ever guessing one.
 */
function normalizeRangeTargetUnit(raw: string): RangeTargetUnit | null {
  const compact = raw.toLowerCase().replace(/\s+/g, "");
  if (compact.startsWith("g/cm") || compact.startsWith("gcm")) return "g/cm2";
  if (
    compact === "micron" ||
    compact === "microns" ||
    compact === "um" ||
    compact === "µm" ||
    compact.startsWith("micrometer")
  ) {
    return "um";
  }
  if (compact === "cm" || compact.startsWith("centimeter")) return "cm";
  if (compact === "mm" || compact.startsWith("millimeter")) return "mm";
  return null;
}

/** Extract the given range for an `energyFromRange` query. */
function extractRangeTarget(text: string): RawTarget | null {
  const m = LENGTH_TARGET_RE.exec(text);
  if (!m) return null;
  const unit = normalizeRangeTargetUnit(m[2] ?? "");
  if (!unit) return null;
  const start = m.index ?? 0;
  return { slot: { value: Number(m[1]), unit }, span: { start, end: start + m[0].length } };
}

const STP_TARGET_RES: ReadonlyArray<{ re: RegExp; unit: StpTargetUnit }> = [
  { re: /(\d+(?:\.\d+)?)\s*mev\s*cm2\s*\/\s*g\b/i, unit: "MeV cm2/g" },
  { re: /(\d+(?:\.\d+)?)\s*mev\s*\/\s*cm\b/i, unit: "MeV/cm" },
  { re: /(\d+(?:\.\d+)?)\s*mev\s+per\s+cm\b/i, unit: "MeV/cm" },
  { re: /(\d+(?:\.\d+)?)\s*kev\s*\/\s*[uµ]m\b/i, unit: "keV/um" },
];

/** Extract the given stopping power for an `energyFromStp` query. */
function extractStpTarget(text: string): RawTarget | null {
  for (const { re, unit } of STP_TARGET_RES) {
    const m = re.exec(text);
    if (m) {
      const start = m.index ?? 0;
      return { slot: { value: Number(m[1]), unit }, span: { start, end: start + m[0].length } };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. Particles
// ---------------------------------------------------------------------------

interface RawParticle {
  match: string;
  resolved: ParticleMatch;
  span: Span;
}

function overlaps(a: Span, spans: Span[]): boolean {
  return spans.some((s) => a.start < s.end && s.start < a.end);
}

/**
 * Collapse repeated mentions of the same resolved entity to their first occurrence (issue
 * #26): an ASR echo repeating a word back ("...in Lucite? Lucite.") otherwise produces two
 * material slots and a spurious `compareDim: "material"`, even though there's only one
 * distinct entity in the query. Keyed by whatever `keyFn` returns, not raw match text, so two
 * different *phrasings* of the same entity also collapse (e.g. "Lucite" and its PMMA alias
 * would collapse too, if they ever both matched the same clip).
 */
function dedupeByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Resolve a phrase to a particle. `resolveText` is what's handed to
 * `resolveParticle`; `displayText` is what's stored as the slot's `match` and
 * defines the span — for English's head-last shape they're the same string
 * (the whole "carbon ion" match resolves fine via suffix-stripping), but
 * Polish's head-first "jon węgla" needs only "węgla" resolved while still
 * reporting the whole phrase as the match/span.
 */
function tryParticle(resolveText: string, displayText: string, start: number): RawParticle | null {
  const resolved = resolveParticle(resolveText);
  if (!resolved) return null;
  // Collapse whitespace runs for display only — spellOutNumbers() pads a spelled-out number
  // ("three" -> "3    ") to keep every span aligned with the original text, which would
  // otherwise leak visible multi-space gaps into the slot's displayed match text; `span`
  // still spans the untrimmed `displayText.length`, so position tracking is unaffected.
  const match = displayText.trim().replace(/\s+/g, " ");
  return { match, resolved, span: { start, end: start + displayText.length } };
}

function extractParticles(text: string, pack: LangPack): RawParticle[] {
  const found: RawParticle[] = [];
  const consumed: Span[] = [];

  // Coordinated lists first — they subsume any inner single/named matches.
  // Not every language uses this shape (Polish repeats "jon" per mention
  // instead), so it's skipped entirely when the pack has none.
  if (pack.PARTICLE_LIST_RE) {
    const listSplitRe = buildListSplitRe(pack);
    for (const m of text.matchAll(pack.PARTICLE_LIST_RE)) {
      const listStart = m.index ?? 0;
      const listText = m[1] ?? "";
      const members = listText.split(listSplitRe).filter(Boolean);
      // Resolve each member; a member like "alpha"/"protons" resolves on its own,
      // a bare element ("carbon") resolves to its ion via the alias table.
      const resolvedMembers: RawParticle[] = [];
      let cursor = listStart;
      let ok = true;
      for (const member of members) {
        const at = text.toLowerCase().indexOf(member.toLowerCase(), cursor);
        const rp = tryParticle(member, member, at >= 0 ? at : listStart);
        if (!rp) {
          ok = false;
          break;
        }
        if (at >= 0) cursor = at + member.length;
        resolvedMembers.push(rp);
      }
      if (ok && resolvedMembers.length >= 2) {
        found.push(...resolvedMembers);
        consumed.push({ start: listStart, end: listStart + m[0].length });
      }
    }
  }

  // Single "<element> ion(s)" (or a language's equivalent shape) heads not
  // already inside a list.
  for (const m of text.matchAll(pack.PARTICLE_HEAD_RE)) {
    const span = { start: m.index ?? 0, end: (m.index ?? 0) + m[0].length };
    if (overlaps(span, consumed)) continue;
    const rp = tryParticle(pack.particleHeadResolveText(m), m[0], span.start);
    if (rp) {
      found.push(rp);
      consumed.push(span);
    }
  }

  // Standalone named particles (proton, alpha, deuteron, …).
  for (const m of text.matchAll(pack.NAMED_PARTICLE_RE)) {
    const span = { start: m.index ?? 0, end: (m.index ?? 0) + m[0].length };
    if (overlaps(span, consumed)) continue;
    const rp = tryParticle(m[0], m[0], span.start);
    if (rp) {
      found.push(rp);
      consumed.push(span);
    }
  }

  return found.sort((a, b) => a.span.start - b.span.start);
}

// ---------------------------------------------------------------------------
// 4. Materials — n-gram scan resolved against the alias table
// ---------------------------------------------------------------------------

interface RawMaterial {
  match: string;
  resolved: MaterialMatch;
  span: Span;
}

const MAX_NGRAM = 3;

/** Scan unconsumed token windows (1..3 words) for known materials, longest-first. */
function extractMaterials(
  text: string,
  consumed: Span[],
  stopwords: ReadonlySet<string>,
): RawMaterial[] {
  const tokenRe = /[\p{L}][\p{L}\d-]*/gu;
  const tokens: { word: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(tokenRe)) {
    const start = m.index ?? 0;
    tokens.push({ word: m[0], start, end: start + m[0].length });
  }

  const out: RawMaterial[] = [];
  const used: Span[] = [...consumed];

  for (let n = MAX_NGRAM; n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const first = tokens[i];
      const last = tokens[i + n - 1];
      if (!first || !last) continue;
      const span = { start: first.start, end: last.end };
      if (overlaps(span, used)) continue;
      // No real material name starts or ends with a bare grammatical stopword
      // ("w wodzie", "wodzie i", "and water") — skipping these windows
      // outright (rather than just at n===1) matters for short single-token
      // materials in languages like Polish, where a 2-char preposition/
      // conjunction ("w "/" i") is short enough to fall inside the
      // fuzzy-match edit-distance budget and would otherwise resolve as a
      // needless *fuzzy* hit (discounting confidence) instead of the clean
      // exact match on the bare noun that a shifted window would find.
      if (stopwords.has(first.word.toLowerCase()) || stopwords.has(last.word.toLowerCase()))
        continue;
      // A 1- or 2-char token (a stray "s"/"I", or an element *symbol* like
      // "U") is never a material *name* in this domain — real names are ≥3
      // chars.
      if (n === 1 && first.word.length < 3) continue;
      const phrase = text.slice(span.start, span.end);
      const resolved = resolveMaterial(phrase);
      if (!resolved) continue;
      // Never accept a *fuzzy* single-word hit: any 4-letter English verb
      // ("puts", "need") sits within edit distance of some element name. Typo
      // tolerance is kept for multi-word phrases, where collisions are rare.
      if (n === 1 && resolved.matchKind === "fuzzy") continue;
      if (resolved.matchKind === "fuzzy" && phrase.replace(/\s/g, "").length < 4) continue;
      out.push({ match: phrase, resolved, span });
      used.push(span);
    }
  }

  return out.sort((a, b) => a.span.start - b.span.start);
}

/**
 * issue #163 B3 — `fillMissingSlots()` (fill-defaults.ts) treats "libdedx doesn't have this
 * material" and "no material was mentioned at all" identically, because the real scan above only
 * ever emits a slot for a phrase it can *resolve* — so both states are "materials.length === 0",
 * and the UI substituted water with a banner claiming the material was "not specified", which is
 * simply false for "protons in stainless steel". This is a second, narrowly-scoped pass, only
 * ever consulted when the real scan found nothing anywhere in the query (so it can never override
 * an already-successful match): the word(s) immediately after "in" — by far the dominant way a
 * target material is phrased in this domain — capped at two words and rejected if they're
 * function words, since "in general"/"in theory"/"in this case" are common filler this domain's
 * queries can also contain and are not material mentions. A phrase outside this "in ..." shape,
 * or that gets filtered out, still falls back to the old (also honest, just less specific) "not
 * specified" behavior — a safe degradation, never a regression: every query this *does* catch
 * already produced a silently wrong substitution before it existed.
 */
const NON_MATERIAL_IN_PHRASES = new Set([
  "general",
  "theory",
  "practice",
  "particular",
  "fact",
  "summary",
  "short",
  "addition",
  "conclusion",
  "reality",
  "detail",
  "total",
  "comparison",
  "this case",
  "that case",
  "other words",
]);

/** "a"/"an"/"the" lead a captured phrase far more often than they lead a genuine function-word
 * filler ("in general", "of the total"), so the leading-stopword reject below would otherwise
 * also reject the single most natural way to name an unknown particle/material ("a muon", "a
 * stainless steel") — silently falling back to the old defaults-substitution bug this pass exists
 * to catch. Strips at most one leading article, from both the words used for the stopword check
 * and the returned display phrase, so "a muon" resolves to the phrase "muon".
 */
const LEADING_ARTICLES = new Set(["a", "an", "the"]);

function stripLeadingArticle(rawWords: string[], lowerWords: string[]): [string[], string[]] {
  if (rawWords.length > 1 && LEADING_ARTICLES.has(lowerWords[0] ?? "")) {
    return [rawWords.slice(1), lowerWords.slice(1)];
  }
  return [rawWords, lowerWords];
}

function detectUnresolvedMaterialPhrase(
  text: string,
  stopwords: ReadonlySet<string>,
): string | null {
  const re = /\bin\s+([a-z][a-z-]*(?:\s+[a-z][a-z-]*)?)\b/gi;
  for (const m of text.matchAll(re)) {
    const phrase = (m[1] ?? "").trim();
    if (!phrase || phrase.length < 3) continue;
    const lower = phrase.toLowerCase();
    if (NON_MATERIAL_IN_PHRASES.has(lower)) continue;
    const [rawWords, words] = stripLeadingArticle(phrase.split(/\s+/), lower.split(/\s+/));
    if (stopwords.has(words[0] ?? "")) continue;
    if (words.every((w) => stopwords.has(w))) continue;
    return rawWords.join(" ");
  }
  return null;
}

/**
 * issue #163 B3, particle side — same reasoning as `detectUnresolvedMaterialPhrase()` above, for
 * "range of muons in water" / "stopping power of pions in water" shaped queries. `extractParticles`
 * only matches named particles (`NAMED_PARTICLE_RE`) or an "<element> ion(s)" head
 * (`PARTICLE_HEAD_RE`) — a bare unknown noun like "muons" (no "ion" suffix, not in the named list)
 * never gets attempted at all, so there's no failed-resolution span to report; this instead looks
 * for the word(s) between "of" and "in", the shape every one of this domain's direct-phrasing
 * queries already uses for the particle. Only consulted when the real scan found nothing.
 */
function detectUnresolvedParticlePhrase(
  text: string,
  stopwords: ReadonlySet<string>,
): string | null {
  const re = /\bof\s+([a-z][a-z-]*(?:\s+[a-z][a-z-]*)?)\s+in\b/gi;
  for (const m of text.matchAll(re)) {
    const phrase = (m[1] ?? "").trim();
    if (!phrase || phrase.length < 3) continue;
    const [rawWords, words] = stripLeadingArticle(
      phrase.split(/\s+/),
      phrase.toLowerCase().split(/\s+/),
    );
    if (stopwords.has(words[0] ?? "")) continue;
    if (words.every((w) => stopwords.has(w))) continue;
    return rawWords.join(" ");
  }
  return null;
}

// ---------------------------------------------------------------------------
// 5. compareDim — program names, then entity multiplicity
// ---------------------------------------------------------------------------

const PROGRAM_RE =
  /\b(astar|pstar|estar|mstar|srim|atima|libdedx|geant4?|fluka|bethe|icru|nist)\b/gi;

function detectPrograms(lower: string): Set<string> {
  const progs = new Set<string>();
  for (const m of lower.matchAll(PROGRAM_RE)) {
    const name = m[1];
    if (name) progs.add(name.toLowerCase());
  }
  return progs;
}

function decideCompareDim(
  programs: Set<string>,
  particles: number,
  materials: number,
  energies: number,
): CompareDim {
  if (programs.size >= 2) return "program";
  if (energies >= 2) return "energy";
  if (materials >= 2) return "material";
  if (particles >= 2) return "particle";
  return "none";
}

// ---------------------------------------------------------------------------
// 6. Resolver — assumptions and confidence
// ---------------------------------------------------------------------------

/** Lowercase element name from a resolved particle, e.g. "Carbon" → "carbon". */
function elementName(p: ParticleMatch): string {
  return p.name.toLowerCase();
}

/**
 * Per-nucleon value + unit for a total→per-nucleon assumption note, formatted for display.
 * issue #163 B7 — this used to return a raw `number` via `round()` (1e-6 precision, meant to trim
 * floating-point fuzz like `84/12 === 6.999999999999999`, not to round for *display*), which put
 * `round()`'s full precision straight into physicist-facing prose: "400 MeV taken as total →
 * 33.333333 MeV/nucl". `formatSignificant()` both trims that same fuzz and rounds to 4 significant
 * figures, the same convention every other physics value this app renders already uses
 * (`nlg/render.ts`'s own `formatNumber()`).
 */
function perNucleon(value: number, unit: EnergyUnit, a: number): { value: string; unit: string } {
  if (unit === "keV") return { value: formatSignificant(value / a), unit: "keV/nucl" };
  // MeV and GeV both express the per-nucleon figure in MeV/nucl.
  return { value: formatSignificant(toMeV(value, unit) / a), unit: "MeV/nucl" };
}

/** Trim floating-point fuzz so 84/12 prints as 7, not 6.999999999999999. */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Top-level matcher
// ---------------------------------------------------------------------------

/** Run the deterministic matcher over a query, returning intent + provenance. */
export function matchIntent(text: string, lang: Lang = "en"): MatchResult {
  const pack = packFor(lang);
  // Spelled-out numbers ("one GeV") normalized to digits before anything else runs (issue
  // #26) — length-preserving, so every span computed below stays valid in the original text.
  const query = spellOutNumbers(text, pack);
  const lower = query.toLowerCase();

  // 1. Quantity (inverse takes precedence — it changes how energies are read).
  const inverse = detectInverse(lower, query, pack);
  const fwd = inverse ? null : detectForwardQuantity(lower, query, pack);
  const quantity: Quantity = inverse ? inverse : fwd ? fwd.quantity : "csdaRange";
  const source: QuantitySource = inverse ? "inverse" : fwd ? fwd.source : "default";

  // 2. Particles and energies/target first, so their spans are not re-mined as
  //    materials (e.g. "carbon" in "carbon ions", "u" in "MeV/u", "cm" in a
  //    "10 cm" range target — all of which alias to element symbols).
  const rawParticlesAll = extractParticles(query, pack);
  // Repeated mentions of the same isotope collapse to one (issue #26) — keyed by
  // (id, massNumber), not id alone, so genuinely different isotopes of the same element
  // (a real multi-particle comparison, e.g. carbon-12 vs. carbon-13) are kept distinct.
  const rawParticles = dedupeByKey(
    rawParticlesAll,
    (p) => `${p.resolved.id}:${p.resolved.massNumber}`,
  );

  // Inverse queries carry no energy slot — only a target.
  let rawEnergiesAll: RawEnergy[] = [];
  let negativeEnergySpans: Span[] = [];
  let target: TargetSlot | undefined;
  let targetSpan: Span | undefined;
  if (quantity === "energyFromRange") {
    const t = extractRangeTarget(query);
    if (t) ({ slot: target, span: targetSpan } = t);
  } else if (quantity === "energyFromStp") {
    const t = extractStpTarget(query);
    if (t) ({ slot: target, span: targetSpan } = t);
  } else {
    // A non-positive energy (issue #42 §5) is dropped rather than filled in
    // as a slot — its span is still excluded from material matching below —
    // so the query reads as missing its energy and falls through the usual
    // `incomplete` / low-confidence path instead of silently going through
    // with the sign stripped off.
    const allEnergies = extractEnergies(query, pack);
    rawEnergiesAll = allEnergies.filter((e) => !e.negative);
    negativeEnergySpans = allEnergies.filter((e) => e.negative).map((e) => e.span);
  }
  // Repeated mentions of the same energy collapse to one (same "one entity, not one per
  // mention" rule issue #26 already applies to particles/materials below — this is that
  // same fix, extended to the one slot type it was missing from). Without this, a
  // comparison phrasing that states the shared energy once per particle clause ("a 200 MeV
  // carbon ion and a 200 MeV neon ion") produces two *duplicate* energy entries, which tips
  // `decideCompareDim` below to `"energy"` instead of `"particle"` — and `computeIntent`'s
  // `compareDim: "energy"` branch only ever resolves `particles[0]`, so the second particle
  // is silently never computed at all (issue #132). Keyed by (value, unit, perNucleon), not
  // raw match text, so two *distinct* energies (a genuine multi-energy comparison) are
  // correctly kept apart.
  const rawEnergies = dedupeByKey(rawEnergiesAll, (e) => `${e.value}:${e.unit}:${e.perNucleon}`);

  // 3. Materials — over the spans not already claimed by particles/energies.
  // Uses the *undeduplicated* particle/energy spans, so a repeated mention is still excluded
  // from the material scan even though only its first occurrence survives into the slot list.
  const consumedSpans: Span[] = [
    ...rawParticlesAll.map((p) => p.span),
    ...rawEnergiesAll.map((e) => e.span),
    ...negativeEnergySpans,
  ];
  if (targetSpan) consumedSpans.push(targetSpan);
  const rawMaterialsAll = extractMaterials(query, consumedSpans, pack.MATERIAL_STOPWORDS);
  // Same repeated-mention collapse as particles (issue #26) — an ASR echo repeating a
  // material name back ("...in Lucite? Lucite.") is one entity, not two.
  const rawMaterials = dedupeByKey(rawMaterialsAll, (m) => String(m.resolved.id));

  // 4. compareDim from program names + entity multiplicity.
  const programs = detectPrograms(lower);
  const compareDim = decideCompareDim(
    programs,
    rawParticles.length,
    rawMaterials.length,
    rawEnergies.length,
  );

  // 5. Assemble slots, assumptions, confidence.
  const assumptions: string[] = [];
  let fuzzy = 0;

  const particles: ParticleSlot[] = rawParticles.map((p) => {
    if (p.resolved.matchKind === "fuzzy") fuzzy++;
    const slot: ParticleSlot = { match: p.match };
    if (p.resolved.isotopeAssumed && p.resolved.isotope) {
      slot.isotopeAssumed = p.resolved.isotope;
      assumptions.push(`${elementName(p.resolved)} → ${p.resolved.isotope}`);
    }
    return slot;
  });

  const materials: MaterialSlot[] = rawMaterials.map((m) => {
    if (m.resolved.matchKind === "fuzzy") fuzzy++;
    return { match: m.match };
  });

  // issue #163 B3 — only ever consulted when the real scan above found nothing (see both
  // detectors' own doc comments for the false-"not specified"-banner bug this closes).
  const unresolved: UnresolvedEntity[] = [];
  if (materials.length === 0) {
    const phrase = detectUnresolvedMaterialPhrase(query, pack.MATERIAL_STOPWORDS);
    if (phrase) unresolved.push({ kind: "material", phrase });
  }
  if (particles.length === 0) {
    const phrase = detectUnresolvedParticlePhrase(query, pack.MATERIAL_STOPWORDS);
    if (phrase) unresolved.push({ kind: "particle", phrase });
  }

  // The first multi-nucleon particle governs total→per-nucleon reads. issue #163 B7 — was gated
  // on `isotopeAssumed`, which excludes every *named* multi-nucleon particle whose isotope is
  // inherent rather than assumed (deuteron A=2, triton A=3, alpha A=4): `compute.ts`'s
  // `energyToMeVPerNucl()` divides a bare energy by A for *any* massNumber > 1 regardless of how
  // that A was determined, so "20 MeV deuteron" was silently computed at 10 MeV/nucl with no
  // assumption note — the same silent total→per-nucleon division a bare "carbon" ion already
  // discloses, just not disclosed here. `massNumber > 1` alone covers both cases uniformly,
  // including an *explicit* isotope ("carbon-13") which is just as subject to the same division
  // and equally deserves the note despite not being an assumed default.
  const heavyIon = rawParticles.find((p) => p.resolved.massNumber > 1);

  const energies: EnergySlot[] = rawEnergies.map((e) => {
    const slot: EnergySlot = { value: e.value, unit: e.unit };
    if (e.perNucleon) {
      slot.perNucleonAssumed = true;
    } else if (heavyIon) {
      // A bare energy on a heavy ion is read as *total* and flagged.
      slot.perNucleonAssumed = false;
      const pn = perNucleon(e.value, e.unit, heavyIon.resolved.massNumber);
      assumptions.push(`${e.value} ${e.unit} taken as total → ${pn.value} ${pn.unit}`);
    }
    return slot;
  });

  // Required-slot completeness check (drives both `incomplete` and confidence).
  const needsEnergy = quantity !== "energyFromRange" && quantity !== "energyFromStp";
  const needsTarget = !needsEnergy;
  const incomplete =
    particles.length === 0 ||
    materials.length === 0 ||
    (needsEnergy && energies.length === 0) ||
    (needsTarget && target === undefined);

  const confidence = scoreConfidence(source, fuzzy, incomplete);

  const intent: QueryIntent = {
    quantity,
    compareDim,
    particles,
    materials,
    energies,
    assumptions,
    confidence,
  };
  if (target !== undefined) intent.target = target;

  const result: MatchResult = { intent, quantitySource: source, incomplete, unresolved };
  if (!inverse && fwd?.idiom) result.idiom = fwd.idiom;
  return result;
}

/** Convenience wrapper when only the intent is needed. */
export function matchQueryIntent(text: string, lang: Lang = "en"): QueryIntent {
  return matchIntent(text, lang).intent;
}

/**
 * Map provenance to a calibrated confidence in [0, 1]. The weights are
 * deliberately simple and monotone so the harness's calibration plot is
 * interpretable: direct > inverse > indirect, every fuzzy resolution discounts,
 * and a missing required slot caps confidence low.
 */
function scoreConfidence(source: QuantitySource, fuzzy: number, incomplete: boolean): number {
  const base =
    source === "direct" ? 0.97 : source === "inverse" ? 0.9 : source === "indirect" ? 0.82 : 0.5;
  let c = base * Math.pow(0.8, fuzzy);
  if (incomplete) c = Math.min(c, 0.4);
  return round(Math.max(0, Math.min(1, c)));
}
