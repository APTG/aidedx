/**
 * Turns the plain-data lexicon in `./quantity-en.ts` into the `RegExp` objects `lang/en.ts`
 * actually matches with. Kept separate from `quantity-en.ts` so that module stays
 * dependency-free plain data — exactly what `scripts/generate-lexicon.ts` needs to serialize to
 * JSON for the Kotlin port, with no `RegExp` objects in the way.
 */
import type { Quantity } from "../query-intent.ts";
import {
  STOPPING_POWER_DIRECT_PATTERNS,
  RANGE_DIRECT_PATTERNS,
  STOPPING_POWER_SYNONYM_ACRONYM,
  STOPPING_POWER_SYNONYM_PHRASE,
  INDIRECT_IDIOM_PATTERNS,
} from "./quantity-en.ts";

/** `patterns` are bare, unanchored fragments (see `quantity-en.ts`'s doc comment) — this is what
 * adds the shared `\b...\b` anchoring, once per alternative, when joining them into one regex. */
function alternation(patterns: readonly string[]): string {
  return patterns.map((p) => `\\b${p}\\b`).join("|");
}

export const DIRECT_STOPPING_SOURCE = alternation(STOPPING_POWER_DIRECT_PATTERNS);
export const DIRECT_RANGE_SOURCE = alternation(RANGE_DIRECT_PATTERNS);

export const STOPPING_POWER_ACRONYM_RE = new RegExp(`\\b${STOPPING_POWER_SYNONYM_ACRONYM}\\b`);
export const STOPPING_POWER_SYNONYM_PHRASE_RE = new RegExp(
  `\\b${STOPPING_POWER_SYNONYM_PHRASE}\\b`,
);

export function buildIndirectIdioms(): Array<{ pattern: RegExp; quantity: Quantity }> {
  return INDIRECT_IDIOM_PATTERNS.map(({ source, quantity }) => ({
    pattern: new RegExp(source),
    quantity,
  }));
}
