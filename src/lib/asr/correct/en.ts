/**
 * English domain-correction rules for Whisper ASR output (issue #87 Part B).
 *
 * Ported verbatim from `scripts/asr-correct.mjs` (issue #7) and
 * `scripts/asr-correct-ext.mjs` (the extended/experimental rule set), which
 * measured whisper-small clip-pass improving 70% → 89% (94% with the domain
 * prompt) — see `docs/voice-pipeline-feasibility.md` §2.1-§2.3. Those two
 * `.mjs` files stay in place unmodified for the existing eval/benchmark
 * scripts (`asr-batch.mjs`, `asr-score-slots*.mjs`, `e2e-audio-intents.ts`),
 * which compare the base vs. extended rule sets against committed transcripts
 * as a research artifact; this module is the one typed, tested, shipped copy
 * wired into the actual browser transcript path (`asr-status.svelte.ts`).
 *
 * `asr-correct-ext.mjs`'s `correct()` runs its own ~25 rules and then calls
 * `asr-correct.mjs`'s `correct()` last — i.e. the effective, currently-best
 * pipeline is "ext rules, then base rules", exactly this file's order. The
 * two rule sets are kept as ONE ordered list rather than re-split by
 * language-neutral-vs-English, because many of these regexes were tuned
 * against each other's output on real recordings (docs §2.2) and reordering
 * them is not a "no risk" refactor the way it was for the matcher split; a
 * future `pl.ts` pack will reveal the true shared subset empirically instead
 * of by inspection.
 *
 * One deliberate deviation from "verbatim": the two glued-unit rules
 * ("glued-unit-before-particle", "mm-ml-before-particle") add a trailing `\b`
 * after the particle-word group that the original scripts lack. Without it,
 * the alternation can match a *prefix* of an unrelated longer word — "ion" at
 * the start of "ionization" — and silently rewrite "10mm ionization" to
 * "10 MeV ionization". That bug already existed in both `.mjs` scripts (this
 * is a faithful port, not a new one), but this module is the copy now live in
 * the shipped transcript path, so it's worth the one-token fix here rather
 * than reproducing it forward.
 */
import type { CorrectionRule } from "./core.ts";
import { NUMBER_WORDS } from "../../intent/lang/en.ts";
import { QUANTITY_CANONICAL_TERMS } from "../../intent/lexicon/quantity-en.ts";

// Particles that follow an energy value — used to detect MeV→mm/ml/etc. acoustic confusion.
const PARTICLE_WORDS =
  "proton|protons|deuteron|deuterons|alpha|alphas|carbon|neon|oxygen|helium|" +
  "lithium|nitrogen|argon|iron|ion|ions";

// A number written as digits ("20", "3.6") or spelled out as words ("twenty", "one hundred and
// eighty") — the mev/kev/gev-mishearing rules below all originally required a literal digit
// immediately before the unit, but `spellOutNumbers()` (matcher.ts) only runs *inside* the
// matcher, well after this correction layer sees the text. A model with no ASR inverse-text-
// normalization (e.g. the on-device Android matcher's sherpa-onnx/Parakeet-v3, issue #147:
// "twenty Me V" produced a silent "No match") speaks both the number *and* the unit as words,
// so the digit-only prefix let the number-word case slip through every rule below untouched.
// Widening the prefix to also accept a spelled-out run fixes it without needing to know the
// number's value here — `$1` just echoes whichever form was present, and the matcher's own
// `spellOutNumbers()` converts a surviving number word to digits later, same as it already does
// today for a clean "twenty MeV".
const NUMBER_WORD_ALT = NUMBER_WORDS.map(([word]) => word).join("|");
// issue #153 — the plain word-run above stops at "hundred" (not itself a NUMBER_WORDS entry), so
// a spelled-out hundred-compound like "five hundred kilo electronvolt" (a real Parakeet-v3
// transcript, docs/android-datagen-bench.md §4.7 — Parakeet has no ASR inverse-text-
// normalization, so it spells every number out, "hundred" included) never matched any rule
// below, unlike an equivalent Whisper transcript that already contained plain digits. Mirrors
// `composeHundreds()`'s own grammar in matcher.ts (`<1-9 word> hundred (and)? <optional 1-99
// remainder>`) rather than inventing a new one, so the value `matchIntent()` eventually derives
// stays consistent with what this prefix recognizes as a number.
const ONES_WORD_ALT = NUMBER_WORDS.filter(([, d]) => Number(d) >= 1 && Number(d) <= 9)
  .map(([word]) => word)
  .join("|");
const HUNDRED_RUN_SRC = `\\b(?:${ONES_WORD_ALT})\\s+hundred\\b(?:\\s+(?:and\\s+)?(?:${NUMBER_WORD_ALT})\\b)?`;
const NUMBER_PREFIX_SRC = `(?:\\d+(?:\\.\\d+)?|${HUNDRED_RUN_SRC}|(?:${NUMBER_WORD_ALT})(?:[\\s-]+(?:and\\s+)?(?:${NUMBER_WORD_ALT}))*)`;

export const EN_RULES: readonly CorrectionRule[] = [
  // --- from asr-correct-ext.mjs ---
  { label: "spelled-out-240", pattern: /\btwo hundred (and )?forty\b/gi, replacement: "240" },
  {
    label: "free-as-three",
    pattern: /\bfree (mev|kev|gev|MeV)\b/gi,
    replacement: "3 $1",
  },
  {
    label: "glued-unit-before-particle",
    pattern: new RegExp(
      `(${NUMBER_PREFIX_SRC})\\s*(?:mm|ml|mv|ma|mb|mhz|mev)\\s*[,.]?\\s+(?:a\\s+)?(${PARTICLE_WORDS})\\b`,
      "gi",
    ),
    replacement: "$1 MeV $2",
  },
  {
    label: "bare-mev-mishearing",
    pattern: new RegExp(`(${NUMBER_PREFIX_SRC})\\s*m[e]?v\\b`, "gi"),
    replacement: "$1 MeV",
  },
  {
    label: "kev-mishearing",
    pattern: new RegExp(`(${NUMBER_PREFIX_SRC})\\s*k\\s*[e]?v\\b`, "gi"),
    replacement: "$1 keV",
  },
  // Runs BEFORE the phonetic fuzzy pass ever sees "TeV" — without an explicit rule here,
  // `applyPhoneticPass`'s edit-distance lookup finds "TeV" is distance-1 from both "MeV" and
  // "keV" in LEXICON and silently rewrites it to one of them (issue #151: a real user saying "5
  // TeV proton" got a silent, confidently-wrong 5 MeV answer — a factor-of-10^6 error with no
  // error surfaced).
  {
    label: "tev-mishearing",
    pattern: new RegExp(`(${NUMBER_PREFIX_SRC})\\s*t\\s*[e]?v\\b`, "gi"),
    replacement: "$1 TeV",
  },
  // GeV was missing its own optional-`e` bare-unit rule the way keV/MeV already had one — found
  // alongside the TeV fix (issue #151), same class of gap.
  {
    label: "gev-mishearing",
    pattern: new RegExp(`(${NUMBER_PREFIX_SRC})\\s*g\\s*[e]?v\\b`, "gi"),
    replacement: "$1 GeV",
  },
  { label: "atmev", pattern: /\batmev\b/gi, replacement: "80 MeV" },
  // Letter-spelled energy units (issue #118 §1/§4: Whisper normalizes a *spoken-expanded*
  // "megaelectronvolt" back to "MeV" on its own, but a *letter-spelled* "em-ee-vee" sometimes
  // escapes as literal letters instead — confirmed in real transcripts as hyphenated "M-E-V"
  // (docs/unit-pronunciation-asr.md §1, `rng-0573`), which the fixed edit-distance cap in
  // applyPhoneticPass's LEXICON lookup can't reach (2 hyphen-insertions exceeds the length-5
  // token's max-1 threshold) — a regex rule here, not a LEXICON entry, is the fix. Also covers
  // the fully-named "kay e vee" style spelling the letter-probe generator
  // (scripts/generate-unit-probe.py) uses, in case a weaker model transcribes the letter NAMES
  // instead of the bare letters. `[\s.,-]*` between letters (not just `-`) matches spaces,
  // hyphens, and Whisper's occasional stray punctuation between spelled-out letters alike.
  {
    label: "mev-letter-spelled",
    pattern: new RegExp(
      `(${NUMBER_PREFIX_SRC})\\s*(?:em|m)[\\s.,-]*(?:ee|e)[\\s.,-]*(?:vee|v)\\b`,
      "gi",
    ),
    replacement: "$1 MeV",
  },
  {
    label: "kev-letter-spelled",
    pattern: new RegExp(
      `(${NUMBER_PREFIX_SRC})\\s*(?:kay|k)[\\s.,-]*(?:ee|e)[\\s.,-]*(?:vee|v)\\b`,
      "gi",
    ),
    replacement: "$1 keV",
  },
  {
    label: "gev-letter-spelled",
    pattern: new RegExp(
      `(${NUMBER_PREFIX_SRC})\\s*(?:gee|jee|g)[\\s.,-]*(?:ee|e)[\\s.,-]*(?:vee|v)\\b`,
      "gi",
    ),
    replacement: "$1 GeV",
  },
  {
    label: "tev-letter-spelled",
    pattern: new RegExp(
      `(${NUMBER_PREFIX_SRC})\\s*(?:tee|t)[\\s.,-]*(?:ee|e)[\\s.,-]*(?:vee|v)\\b`,
      "gi",
    ),
    replacement: "$1 TeV",
  },
  // Spoken-EXPANDED (not letter-spelled) energy-unit readings — "500 kiloelectronvolt", "1
  // gigaelectronvolt" — a real, confirmed-common rendering real speakers produce (issue #151,
  // docs/android-datagen-bench.md §4.2: 0/10 hit rate on this rendering in real audio). Verified
  // directly: even a *perfectly clean* transcription of this rendering fails to resolve an
  // energy slot today — this is a coverage gap independent of ASR accuracy, not a mishearing to
  // correct. Matches the "of"/"a" filler Whisper sometimes inserts ("giga electron of volt",
  // real transcript, dg-22) and both one-word-glued and three-word-spaced renderings.
  // `(?:electron|elektron)` (not a bare "electron" literal) — a real Parakeet-v3 EN transcript
  // (dg-44, docs/android-datagen-bench.md §4.7) came back "two hundred mega elektronovolt", the
  // `k` spelling bleeding in from Parakeet's multilingual model (that spelling is correct Polish
  // for "electron"), even though the utterance itself was English.
  {
    label: "kev-expanded",
    pattern: new RegExp(
      `(${NUMBER_PREFIX_SRC})\\s*kilo[\\s-]?(?:electron|elektron)[\\s-]?(?:a|of|o)?[\\s-]?volts?\\b`,
      "gi",
    ),
    replacement: "$1 keV",
  },
  {
    label: "mev-expanded",
    pattern: new RegExp(
      `(${NUMBER_PREFIX_SRC})\\s*mega[\\s-]?(?:electron|elektron)[\\s-]?(?:a|of|o)?[\\s-]?volts?\\b`,
      "gi",
    ),
    replacement: "$1 MeV",
  },
  {
    label: "gev-expanded",
    pattern: new RegExp(
      `(${NUMBER_PREFIX_SRC})\\s*giga[\\s-]?(?:electron|elektron)[\\s-]?(?:a|of|o)?[\\s-]?volts?\\b`,
      "gi",
    ),
    replacement: "$1 GeV",
  },
  {
    label: "tev-expanded",
    pattern: new RegExp(
      `(${NUMBER_PREFIX_SRC})\\s*tera[\\s-]?(?:electron|elektron)[\\s-]?(?:a|of|o)?[\\s-]?volts?\\b`,
      "gi",
    ),
    replacement: "$1 TeV",
  },
  {
    label: "per-nucleon-phonetic",
    pattern: /\bper\s+(?:napelion|nutlion|nuklion|nukleon|nuclei|nucleons?|nucle\w*|napoleon)\b/gi,
    replacement: "per nucleon",
  },
  { label: "pernucleon-glued", pattern: /\bpernucleon\b/gi, replacement: "per nucleon" },
  { label: "per-u", pattern: /\bper\s+u\b/gi, replacement: "/u" },
  {
    label: "deuteron-phonetic",
    pattern: /\b(?:dutrons?|deuterans?|deuterines?|diuterons?|dealt\s*t-?rons?|deutrons?)\b/gi,
    replacement: "deuterons",
  },
  { label: "aproton", pattern: /\baproton\b/gi, replacement: "a proton" },
  { label: "amoebiprotons", pattern: /\bamoebiprotons?\b/gi, replacement: "MeV protons" },
  { label: "amoebic-protons", pattern: /\bamoebic protons?\b/gi, replacement: "MeV protons" },
  {
    label: "products-as-protons",
    pattern:
      /\b(?:products|proteins)\b(?=[^.?!]*\b(?:in water|in pmma|in bone|range|stopping)\b)/gi,
    replacement: "protons",
  },
  {
    label: "carbon-ion-phonetic",
    pattern: /\bcarbon (?:isle|aisle|i\.?on)\b/gi,
    replacement: "carbon ion",
  },
  { label: "pmmea", pattern: /\bpmmea\b/gi, replacement: "PMMA" },
  { label: "silicone-as-silicon", pattern: /\bsilicone\b/gi, replacement: "silicon" },
  {
    label: "lucite-phonetic",
    pattern: /\b(?:loose site|lou site|luxite|lucid)\b/gi,
    replacement: "Lucite",
  },
  { label: "range-of-phonetic", pattern: /\brains of\b/gi, replacement: "range of" },
  // "Watt" is a real homophone of "What" at the start of an inverse-energy question ("Watt
  // energy gives a 10 cm range…" — issue #122, NeMo Parakeet). Scoped to "energy" specifically
  // (not a bare "watt" fix) so a genuine unit mention of watts, if this project ever adds one,
  // isn't silently rewritten.
  { label: "watt-energy-phonetic", pattern: /\bwatt\s+energy\b/gi, replacement: "what energy" },
  {
    label: "stopping-power-phonetic",
    pattern: /\bstop in power\b/gi,
    replacement: "stopping power",
  },
  { label: "compare-phonetic", pattern: /\bcomparis\b/gi, replacement: "compare" },
  {
    label: "compare-stopping-power-glued",
    pattern: /\bcompares topping power\b/gi,
    replacement: "compare stopping power",
  },
  {
    label: "dedx-spoken-letters",
    pattern: /\b(?:de|da|d)\s*(?:slash|over|-)\s*dx\b/gi,
    replacement: "dE/dx",
  },
  { label: "astar-phonetic", pattern: /\bastor\b/gi, replacement: "ASTAR" },
  { label: "pstar-phonetic", pattern: /\bpstor\b/gi, replacement: "PSTAR" },

  // --- from asr-correct.mjs (runs after the rules above) ---
  { label: "kev-case", pattern: /\bkev\b/gi, replacement: "keV" },
  { label: "mev-case", pattern: /\bmev\b/gi, replacement: "MeV" },
  { label: "gev-case", pattern: /\bgev\b/gi, replacement: "GeV" },
  { label: "the-edx", pattern: /\bthe\s+edx\b/gi, replacement: "dE/dx" },
  { label: "edx", pattern: /\bedx\b/gi, replacement: "dE/dx" },
  { label: "de-dx-punctuation", pattern: /\bde\s*[-/,]?\s*dx\b/gi, replacement: "dE/dx" },
  {
    label: "hyphenated-length-target",
    pattern: /\b(\d+(?:\.\d+)?)-cm\b/gi,
    replacement: "$1 cm",
  },
  {
    label: "mm-ml-before-particle",
    pattern: new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:mm|ml)\\s+(${PARTICLE_WORDS})\\b`, "gi"),
    replacement: "$1 MeV $2",
  },
  { label: "gev-word-split", pattern: /(\d)\s*g\s+ev\b/gi, replacement: "$1 GeV" },
  {
    label: "per-nucleon-base",
    pattern: /\bper\s+(?:nuclear\s+ion|knockdown|nuclear)\b/gi,
    replacement: "per nucleon",
  },
  {
    label: "megaelectron-per-nucleon",
    pattern: /\bmegaelectron\w*\s+per\s+nuclear?\b/gi,
    replacement: "MeV per nucleon",
  },
  {
    label: "mev-per-u-mishearing",
    pattern: /\bMeV\s+per\s+(?:year|you)\b/gi,
    replacement: "MeV/u",
  },
  {
    label: "tamiya-per-nucleon",
    pattern: new RegExp(`(${NUMBER_PREFIX_SRC})\\s+tamiya\\s+per\\s+nucleon`, "gi"),
    replacement: "$1 MeV per nucleon",
  },
  { label: "astar-spacing", pattern: /\ba\s*[-\s]?star\b/gi, replacement: "ASTAR" },
  { label: "pstar-spacing", pattern: /\bp\s*[-\s]?star\b/gi, replacement: "PSTAR" },
  { label: "centimeters-word", pattern: /\bcentimeters?\b/gi, replacement: "cm" },
  { label: "millimeters-word", pattern: /\bmillimeters?\b/gi, replacement: "mm" },
];

/**
 * Closed lexicon for the phonetic-distance pass (issue #28) — every domain
 * keyword that ISN'T already covered by a fuzzy alias lookup. Materials and
 * particles already get fuzzy resolution inside the matcher itself
 * (`resolveMaterial`/`resolveParticle`, `src/lib/aliases/lookup.ts`), so
 * duplicating them here would just stack a second, redundant fuzzy pass ahead
 * of an already-tuned one. Units, quantity keywords, and program names have no
 * such fallback today — a mishearing the fixed rules above don't cover (a new
 * ASR model, a new speaker) currently falls straight to the matcher's regex
 * keyword tables and misses entirely.
 *
 * Order matters for ties: `applyPhoneticPass` (`../correct/core.ts`) keeps the
 * first minimum-distance entry, so within a slot, put the most common domain
 * term first (e.g. MeV before keV/GeV — dominant in the eval set) to break a
 * tie sensibly rather than arbitrarily.
 */
export interface LexiconEntry {
  slot: "unit" | "quantity" | "program";
  canonical: string;
}

export const LEXICON: readonly LexiconEntry[] = [
  { slot: "unit", canonical: "MeV" },
  { slot: "unit", canonical: "keV" },
  { slot: "unit", canonical: "GeV" },
  { slot: "unit", canonical: "TeV" },
  // issue #160 §9a — sourced from the same canonical-terms list en.ts's DIRECT_STOPPING/
  // INDIRECT_IDIOMS are built from (../../intent/lexicon/quantity-en.ts), so a term added there
  // can't silently omit the phonetic-correction fallback. This list stays coarser than that
  // module's full synonym vocabulary by design (a closed set of canonical *spellings* for
  // nearest-neighbor correction, not an exhaustive match regex) — see that module's doc comment.
  ...QUANTITY_CANONICAL_TERMS.map((canonical) => ({ slot: "quantity" as const, canonical })),
  { slot: "program", canonical: "ASTAR" },
  { slot: "program", canonical: "PSTAR" },
  { slot: "program", canonical: "ESTAR" },
  { slot: "program", canonical: "MSTAR" },
  { slot: "program", canonical: "SRIM" },
  { slot: "program", canonical: "ATIMA" },
  { slot: "program", canonical: "libdedx" },
  { slot: "program", canonical: "Geant4" },
  { slot: "program", canonical: "FLUKA" },
  { slot: "program", canonical: "Bethe" },
  { slot: "program", canonical: "ICRU" },
  { slot: "program", canonical: "NIST" },
];

/**
 * Common English function/domain words the phonetic pass must never try to
 * "correct" against the lexicon — short, high-frequency words that would
 * otherwise sit within edit distance of some lexicon entry (e.g. "is" vs.
 * "u" isn't a risk, but "and"/"can" etc. are exactly the kind of short token
 * a length-scaled edit-distance check has to explicitly exclude).
 */
export const PHONETIC_STOPWORDS = new Set([
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
  "how",
  "does",
  "do",
  "much",
  "energy",
  "per",
  "compare",
  "with",
  "using",
  "both",
  "please",
  "me",
  "give",
  "it",
  "go",
  "goes",
  "will",
  "can",
  "you",
  "your",
  // issue #169 — "LET" (the quantity slot's shortest canonical, 3 letters) sits within edit
  // distance 1 of a whole cluster of ordinary short English words, none of which have any
  // legitimate reason to mean "LET" in this domain: "how far does a proton get through water?"
  // was silently corrected to "...LET through water?", flipping csdaRange to stoppingPower.
  // Confirmed via a systematic check against LEXICON with the same length/distance thresholds
  // closestLexiconMatch() itself uses (bench/scripts, not shipped) — every word below is a real
  // false-positive at distance ≤1, not a guess.
  "get",
  "lets",
  "set",
  "bet",
  "yet",
  "met",
  "net",
  "pet",
  "vet",
  "jet",
  "wet",
]);
