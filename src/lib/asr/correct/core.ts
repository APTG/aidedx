/**
 * Domain vocabulary correction layer for ASR output (issue #87 Part B; supersedes
 * the eval-only `scripts/asr-correct.mjs` / `scripts/asr-correct-ext.mjs` for the
 * production transcript path — see `en.ts`'s header for the porting note).
 *
 * Two stages, in order (issue #28):
 *  1. The regex fast path (`applyRules` over `en.ts`'s `EN_RULES`) — cheap,
 *     exact, known mishearings.
 *  2. The phonetic-distance pass (`applyPhoneticPass`) — a closed-lexicon
 *     edit-distance lookup (units, quantity keywords, program names) for
 *     whatever the fixed rules above don't cover, so a new speaker or model's
 *     new mishearing doesn't need its own hand-written regex. Materials and
 *     particles already get this treatment inside the matcher itself
 *     (`resolveMaterial`/`resolveParticle`) — this pass only covers the
 *     domain keywords that had no fuzzy fallback at all before this.
 *
 * Both stages consume language-specific pack data (`./en.ts`); this module
 * only knows how to run them. A future `pl.ts` pack plugs into the same
 * `correctTranscript` without touching this file — today it hardwires the
 * `en` pack, mirroring how `../../intent/matcher.ts` hardwires `./lang/en.ts`
 * until a second language actually lands.
 */
import { EN_RULES, LEXICON, PHONETIC_STOPWORDS, type LexiconEntry } from "./en.ts";
import { boundedLevenshtein } from "../../aliases/normalize.ts";

export interface CorrectionRule {
  /** Short label for traceability. */
  label: string;
  pattern: RegExp;
  replacement: string;
}

/** Apply every rule in order, each seeing the previous rule's output. */
export function applyRules(text: string, rules: readonly CorrectionRule[]): string {
  return rules.reduce((acc, rule) => acc.replace(rule.pattern, rule.replacement), text);
}

/** One phonetic-pass correction, kept for the trust UX (issue #10) and the confidence gate. */
export interface PhoneticSubstitution {
  heard: string;
  readAs: string;
  slot: LexiconEntry["slot"];
}

interface Span {
  start: number;
  end: number;
}

interface Candidate extends PhoneticSubstitution {
  span: Span;
}

function overlaps(a: Span, spans: readonly Span[]): boolean {
  return spans.some((s) => a.start < s.end && s.start < a.end);
}

// A minimum key length per slot before attempting a fuzzy lookup at all — short
// tokens sit within edit distance of too many unrelated lexicon entries to be
// worth the risk. Every "program" canonical is >=4 chars, so a 3-char token
// being "close" to one is more likely coincidence than a real mishearing.
const MIN_KEY_LENGTH: Record<LexiconEntry["slot"], number> = { unit: 2, quantity: 3, program: 4 };

/** Length-scaled edit-distance cap, consistent with the existing alias fuzzy-match policy (`src/lib/aliases/lookup.ts`). */
function fuzzyMax(keyLength: number): number {
  return keyLength >= 7 ? 2 : 1;
}

/**
 * Nearest lexicon entry for the given slot within the length-scaled threshold,
 * or null if nothing is close enough (or `phrase` already IS a canonical
 * form — nothing to substitute). Ties keep the first (lowest-index) entry, so
 * `en.ts`'s `LEXICON` ordering doubles as the tie-break priority.
 */
function closestLexiconMatch(phrase: string, slot: LexiconEntry["slot"]): LexiconEntry | null {
  const key = phrase.toLowerCase();
  if (key.length < MIN_KEY_LENGTH[slot]) return null;
  const max = fuzzyMax(key.length);
  let best: LexiconEntry | null = null;
  let bestDist = Infinity;
  for (const entry of LEXICON) {
    if (entry.slot !== slot) continue;
    const candidate = entry.canonical.toLowerCase();
    if (candidate === key) return null;
    if (Math.abs(candidate.length - key.length) > max) continue;
    const dist = boundedLevenshtein(key, candidate, max);
    if (dist <= max && dist < bestDist) {
      bestDist = dist;
      best = entry;
    }
  }
  return best;
}

const TOKEN_RE = /[A-Za-z]+(?:[/-][A-Za-z]+)*/g;

function tokenize(text: string): Array<{ word: string; start: number; end: number }> {
  const tokens: Array<{ word: string; start: number; end: number }> = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    tokens.push({ word: m[0], start, end: start + m[0].length });
  }
  return tokens;
}

/** True when a number (with only whitespace between) sits directly before `tokenStart`. */
function precededByNumber(text: string, tokenStart: number): boolean {
  return /\d(?:\.\d+)?\s+$/.test(text.slice(0, tokenStart));
}

/**
 * Closed-lexicon phonetic-distance pass (issue #28): for units, quantity
 * keywords, and program names the regex fast path doesn't recognize, look up
 * the nearest lexicon entry by edit distance, weighted by slot context (a
 * token right after a number is a unit candidate; materials/particles are
 * deliberately excluded — see `en.ts`'s `LEXICON` doc comment). Every accepted
 * substitution is logged so the trust UX (issue #10) can eventually show
 * "heard X → read as Y".
 */
export function applyPhoneticPass(text: string): {
  text: string;
  substitutions: PhoneticSubstitution[];
} {
  const tokens = tokenize(text);
  const consumed: Span[] = [];
  const candidates: Candidate[] = [];

  // Unit slot: a token right after a number ("60 tamiya" -> "60 MeV").
  for (const t of tokens) {
    if (t.word.length > 6 || PHONETIC_STOPWORDS.has(t.word.toLowerCase())) continue;
    if (!precededByNumber(text, t.start)) continue;
    const span = { start: t.start, end: t.end };
    if (overlaps(span, consumed)) continue;
    const match = closestLexiconMatch(t.word, "unit");
    if (match) {
      candidates.push({ span, heard: t.word, readAs: match.canonical, slot: "unit" });
      consumed.push(span);
    }
  }

  // Program slot: standalone acronym-length tokens ("astor" -> "ASTAR").
  for (const t of tokens) {
    if (t.word.length < 4 || t.word.length > 8) continue;
    if (PHONETIC_STOPWORDS.has(t.word.toLowerCase())) continue;
    const span = { start: t.start, end: t.end };
    if (overlaps(span, consumed)) continue;
    const match = closestLexiconMatch(t.word, "program");
    if (match) {
      candidates.push({ span, heard: t.word, readAs: match.canonical, slot: "program" });
      consumed.push(span);
    }
  }

  // Quantity slot: 1-3 word windows, longest-first (mirrors the matcher's
  // material n-gram scan, src/lib/intent/matcher.ts's extractMaterials).
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const first = tokens[i];
      const last = tokens[i + n - 1];
      if (!first || !last) continue;
      if (/\d/.test(text.slice(first.end, last.start))) continue;
      if (n === 1 && PHONETIC_STOPWORDS.has(first.word.toLowerCase())) continue;
      const span = { start: first.start, end: last.end };
      if (overlaps(span, consumed)) continue;
      const phrase = text.slice(span.start, span.end);
      const match = closestLexiconMatch(phrase, "quantity");
      if (match) {
        candidates.push({ span, heard: phrase, readAs: match.canonical, slot: "quantity" });
        consumed.push(span);
      }
    }
  }

  candidates.sort((a, b) => a.span.start - b.span.start);

  let out = "";
  let cursor = 0;
  const substitutions: PhoneticSubstitution[] = [];
  for (const c of candidates) {
    out += text.slice(cursor, c.span.start) + c.readAs;
    cursor = c.span.end;
    substitutions.push({ heard: c.heard, readAs: c.readAs, slot: c.slot });
  }
  out += text.slice(cursor);

  return { text: out, substitutions };
}

/**
 * Correct known Whisper domain-vocabulary mishearings before the transcript
 * reaches the NLU matcher: the regex fast path first, then the phonetic pass
 * over whatever it left unrecognized.
 */
export function correctTranscript(text: string): {
  text: string;
  substitutions: PhoneticSubstitution[];
} {
  return applyPhoneticPass(applyRules(text, EN_RULES));
}
