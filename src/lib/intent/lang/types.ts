/**
 * Shared shape every language pack (`./en.ts`, `./pl.ts`, …) implements.
 *
 * The matcher's core (`../matcher.ts`) is language-neutral control flow; every
 * regex/keyword table it needs comes from whichever pack `matchIntent()` is
 * called with. A pack is free to give language-specific *shape* to the
 * particle regexes (English's head-last "carbon ion" vs. Polish's head-first
 * "jon węgla") as long as it honors this contract.
 */
import type { Quantity } from "../query-intent.ts";

export type Lang = "en" | "pl";

export interface LangPack {
  /** Phrasings that imply a quantity without naming it directly. */
  INDIRECT_IDIOMS: ReadonlyArray<{ pattern: RegExp; quantity: Quantity }>;
  /** Direct keyword regex for stoppingPower, tested against lowercased text. */
  DIRECT_STOPPING: RegExp;
  /** Direct keyword regex for csdaRange, tested against lowercased text. */
  DIRECT_RANGE: RegExp;
  /** LET / linear-energy-transfer-style synonym for stopping power. */
  mentionsStoppingPowerSynonym(lower: string, text: string): boolean;
  /** Blanked out of the lowercased text before the inverse "asks for energy" test. */
  BLANK_BEFORE_INVERSE_RE: RegExp;
  /** True when the (de-synonymed) text asks for *energy* as the answer. */
  asksForEnergy(deSynonym: string): boolean;
  /** Word/phrase cues marking an inverse query as stopping-power- (vs. range-) flavored. */
  mentionsStoppingPowerKeyword(lower: string): boolean;
  /** Last-resort fallback verb that reads as range. */
  FALLBACK_STOP_RE: RegExp;

  /** Words that never start/own a material phrase on their own. */
  MATERIAL_STOPWORDS: ReadonlySet<string>;

  /** Connector regex source between list members ("X, Y, and Z" / "X, Y i Z"). */
  LIST_SEP_SRC: string;
  /** Optional per-nucleon suffix regex source, with its own capture group(s). */
  PER_NUCL_SUFFIX_SRC: string;
  /** Map a matched per-nucleon suffix word to its schema unit. */
  perNuclUnitFor(suffixWord: string): "MeV/u" | "MeV/nucl";

  /**
   * Coordinated particle list sharing one trailing/leading head (English:
   * "carbon and neon ions"). Capture group 1 must be the member-list text
   * (split by a `LIST_SEP_SRC`-built regex). Null when the language instead
   * expects each particle mention to stand alone (e.g. Polish's "jon węgla
   * czy jon neonu" — two independent `PARTICLE_HEAD_RE` matches).
   */
  PARTICLE_LIST_RE: RegExp | null;
  /** A single particle mention, e.g. "<element> ion(s)" or "jon <element>". */
  PARTICLE_HEAD_RE: RegExp;
  /** From a `PARTICLE_HEAD_RE` match, the substring to hand to `resolveParticle`. */
  particleHeadResolveText(m: RegExpExecArray): string;
  /** Standalone named particles whose isotope is fixed by the name. */
  NAMED_PARTICLE_RE: RegExp;
}
