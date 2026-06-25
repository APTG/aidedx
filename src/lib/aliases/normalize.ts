/**
 * Text normalization and small string-distance helpers shared by the material
 * and particle alias lookups. Dependency-free so the standalone JSON generator
 * (`scripts/generate-aliases.ts`) and Vitest both import it without a bundler.
 */

const SUPERSCRIPT_DIGITS: Record<string, string> = {
  "⁰": "0",
  "¹": "1",
  "²": "2",
  "³": "3",
  "⁴": "4",
  "⁵": "5",
  "⁶": "6",
  "⁷": "7",
  "⁸": "8",
  "⁹": "9",
};

const SUBSCRIPT_DIGITS: Record<string, string> = {
  "₀": "0",
  "₁": "1",
  "₂": "2",
  "₃": "3",
  "₄": "4",
  "₅": "5",
  "₆": "6",
  "₇": "7",
  "₈": "8",
  "₉": "9",
};

const ASCII_DIGITS = "0123456789";

/** Render a mass number as Unicode superscript digits, e.g. 12 → "¹²". */
export function toSuperscript(n: number): string {
  const supers = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"];
  return String(n)
    .split("")
    .map((d) => supers[ASCII_DIGITS.indexOf(d)] ?? d)
    .join("");
}

/** Format an isotope label, e.g. (12, "C") → "¹²C". */
export function formatIsotope(massNumber: number, symbol: string): string {
  return `${toSuperscript(massNumber)}${symbol}`;
}

/**
 * Canonical lookup key for an alias or query phrase:
 *  - lower-cased and stripped of combining diacritics (café → cafe),
 *  - super/subscript digits folded to ASCII (¹²C → "12c"),
 *  - every run of non-alphanumeric characters collapsed to a single space,
 *  - trimmed.
 *
 * Unicode letters are preserved (so "α" survives as a key) while punctuation,
 * hyphens, plus/minus signs, and underscores are flattened. This is the single
 * function every reader of the alias tables must share so a phrase and the
 * stored alias normalize identically.
 */
export function normalizeText(input: string): string {
  let s = input.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => SUPERSCRIPT_DIGITS[c] ?? c);
  s = s.replace(/[₀₁₂₃₄₅₆₇₈₉]/g, (c) => SUBSCRIPT_DIGITS[c] ?? c);
  s = s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return s;
}

/**
 * Levenshtein edit distance, capped at `max` for cheapness: returns `max + 1`
 * as soon as the best achievable distance provably exceeds the cap. Used for
 * the one-or-two-character fuzzy fallback (typos like "watr", "alumnium").
 */
export function boundedLevenshtein(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = new Array<number>(b.length + 1);
    curr[0] = i;
    let rowMin = i;
    const ai = a[i - 1];
    for (let j = 1; j <= b.length; j++) {
      const cost = ai === b[j - 1] ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      const v = Math.min(del, ins, sub);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length] ?? 0;
}
