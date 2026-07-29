/**
 * Flattens eval/datagen-sentences.json's per-tuple {id, en:{...}, pl:{...}} shape into the
 * flat per-clip {id, text, quantity, multi, slotTruth} shape scripts/asr-score-slots-
 * generic.mjs already expects — the same shape scripts/generate-1000-sentences.mjs's own
 * output uses. One manifest per language, since DataGenActivity's own
 * results-<model>-<lang>.json files are already split by language and use the bare id
 * ("dg-01", not "dg-01-en") — this is *not* the same shape eval/datagen-sentences.json itself
 * is committed in, and asr-score-slots-generic.mjs cannot read the nested en/pl shape
 * directly (confirmed while building issue #130 Part 3 — an earlier doc note claiming it
 * "needs no change" was about Polish-word regex support, not this JSON shape mismatch).
 *
 * `multi` is derived from slotTruth shape, not hand-authored: >1 energies -> "energy", >1
 * materials -> "material", >1 particles -> "particle", else null ("single" once
 * asr-score-slots-generic.mjs applies its own `?? "single"` fallback) — gives that script's
 * "by scenario type" breakdown real data instead of everything landing in one bucket.
 *
 * Output is NOT committed (gitignored, like scripts/tts-1000-sentences*.json) — regenerate
 * from the single source of truth, eval/datagen-sentences.json, whenever needed.
 *
 * Usage: node scripts/datagen-to-manifest.mjs <en|pl> [outFile]
 *   outFile defaults to eval/datagen-manifest-<lang>.json
 */
import { readFileSync, writeFileSync } from "node:fs";

const lang = process.argv[2];
if (lang !== "en" && lang !== "pl") {
  console.error("Usage: node scripts/datagen-to-manifest.mjs <en|pl> [outFile]");
  process.exit(1);
}
const outPath = process.argv[3] ?? `eval/datagen-manifest-${lang}.json`;

const records = JSON.parse(readFileSync("eval/datagen-sentences.json", "utf-8"));

function multiFor(slotTruth) {
  if ((slotTruth.energies?.length ?? 0) > 1) return "energy";
  if (slotTruth.materials.length > 1) return "material";
  if (slotTruth.particles.length > 1) return "particle";
  return null;
}

const clips = records.map((r) => {
  const side = r[lang];
  return {
    id: r.id,
    text: side.canonical,
    quantity: r.quantity,
    multi: multiFor(side.slotTruth),
    slotTruth: side.slotTruth,
  };
});

writeFileSync(outPath, JSON.stringify(clips, null, 2) + "\n");
console.log(`wrote ${outPath} (${clips.length} clips)`);
