/**
 * Domain vocabulary correction layer for ASR output (issue #87 Part B; supersedes
 * the eval-only `scripts/asr-correct.mjs` / `scripts/asr-correct-ext.mjs` for the
 * production transcript path — see `en.ts`'s header for the porting note).
 *
 * A rule is a regex + replacement, applied in order over the transcript before it
 * reaches the NLU matcher. This module only knows how to run an ordered rule list;
 * the rules themselves are language-specific pack data (`./en.ts`). A future
 * `pl.ts` pack plugs into the same `correctTranscript` without touching this file
 * — today it hardwires the `en` pack, mirroring how `../../intent/matcher.ts`
 * hardwires `./lang/en.ts` until a second language actually lands.
 *
 * This is the regex fast path named in issue #28 ("keep the regex layer as a fast
 * path; the phonetic pass replaces the unbounded tail of new one-off rules") — the
 * phonetic-lexicon matcher itself (Double Metaphone/edit-distance against the
 * alias tables, substitution logging into `assumptions[]`) is future work, not
 * built here.
 */
import { EN_RULES } from "./en.ts";

export interface CorrectionRule {
  /** Short label for traceability — surfaced once substitution logging (issue #28) lands. */
  label: string;
  pattern: RegExp;
  replacement: string;
}

/** Apply every rule in order, each seeing the previous rule's output. */
export function applyRules(text: string, rules: readonly CorrectionRule[]): string {
  return rules.reduce((acc, rule) => acc.replace(rule.pattern, rule.replacement), text);
}

/** Correct known Whisper domain-vocabulary mishearings before the transcript reaches the NLU matcher. */
export function correctTranscript(text: string): string {
  return applyRules(text, EN_RULES);
}
