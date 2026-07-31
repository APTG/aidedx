/**
 * Regenerate the shipped JSON lexicon artifact from the typed TS tables (issue #160 §9a).
 *
 *   node scripts/generate-lexicon.ts        (Node 22.18+ / 24 — native TS)
 *   pnpm generate:lexicon
 *
 * Writes `static/lexicon/quantity-en.json`, the single source of truth for the English
 * stopping-power/range keyword vocabulary. The JSON is a derived artifact — edit the TS tables
 * in `src/lib/intent/lexicon/quantity-en.ts`, never the JSON. CI checks the committed JSON is up
 * to date (see `quantity-en.test.ts`). Mirrors `scripts/generate-aliases.ts`'s pattern exactly,
 * including how the Kotlin port consumes it: `bench/android/full-app/.../KotlinMatcher.kt` loads
 * a copy of this file from Android assets the same way `Aliases.kt` already does for
 * materials/particles.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  STOPPING_POWER_DIRECT_PATTERNS,
  RANGE_DIRECT_PATTERNS,
  STOPPING_POWER_SYNONYM_ACRONYM,
  STOPPING_POWER_SYNONYM_PHRASE,
  INDIRECT_IDIOM_PATTERNS,
  QUANTITY_CANONICAL_TERMS,
} from "../src/lib/intent/lexicon/quantity-en.ts";

export interface QuantityLexiconArtifact {
  stoppingPowerDirectPatterns: readonly string[];
  rangeDirectPatterns: readonly string[];
  stoppingPowerSynonymAcronym: string;
  stoppingPowerSynonymPhrase: string;
  indirectIdioms: ReadonlyArray<{ source: string; quantity: string }>;
  quantityCanonicalTerms: readonly string[];
}

export function buildQuantityLexiconArtifact(): QuantityLexiconArtifact {
  return {
    stoppingPowerDirectPatterns: STOPPING_POWER_DIRECT_PATTERNS,
    rangeDirectPatterns: RANGE_DIRECT_PATTERNS,
    stoppingPowerSynonymAcronym: STOPPING_POWER_SYNONYM_ACRONYM,
    stoppingPowerSynonymPhrase: STOPPING_POWER_SYNONYM_PHRASE,
    indirectIdioms: INDIRECT_IDIOM_PATTERNS,
    quantityCanonicalTerms: QUANTITY_CANONICAL_TERMS,
  };
}

export function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function main(): void {
  const outDir = fileURLToPath(new URL("../static/lexicon/", import.meta.url));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outDir + "quantity-en.json", serialize(buildQuantityLexiconArtifact()));
  console.log("✓ wrote static/lexicon/quantity-en.json");
}

// Only run when invoked directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
