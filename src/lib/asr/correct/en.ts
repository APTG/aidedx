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

// Particles that follow an energy value — used to detect MeV→mm/ml/etc. acoustic confusion.
const PARTICLE_WORDS =
  "proton|protons|deuteron|deuterons|alpha|alphas|carbon|neon|oxygen|helium|" +
  "lithium|nitrogen|argon|iron|ion|ions";

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
      `(\\d+(?:\\.\\d+)?)\\s*(?:mm|ml|mv|ma|mb|mhz|mev)\\s*[,.]?\\s+(?:a\\s+)?(${PARTICLE_WORDS})\\b`,
      "gi",
    ),
    replacement: "$1 MeV $2",
  },
  { label: "bare-mev-mishearing", pattern: /(\d+(?:\.\d+)?)\s*m[e]?v\b/gi, replacement: "$1 MeV" },
  { label: "kev-mishearing", pattern: /(\d+(?:\.\d+)?)\s*k\s*[e]?v\b/gi, replacement: "$1 keV" },
  { label: "atmev", pattern: /\batmev\b/gi, replacement: "80 MeV" },
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
    pattern: /(\d+(?:\.\d+)?)\s+tamiya\s+per\s+nucleon/gi,
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
  { slot: "quantity", canonical: "stopping power" },
  { slot: "quantity", canonical: "range" },
  { slot: "quantity", canonical: "dE/dx" },
  { slot: "quantity", canonical: "CSDA" },
  { slot: "quantity", canonical: "LET" },
  { slot: "quantity", canonical: "linear energy transfer" },
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
]);
