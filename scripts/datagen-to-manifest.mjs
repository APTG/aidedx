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
 * `--field canonical|display` (default `canonical`) selects which text variant becomes `text`:
 *   - `canonical` (default, unchanged behavior) — the abbreviated reference form, for scoring
 *     against a real recorded/transcribed session (WER, matcher ground truth).
 *   - `display` (issue #155) — the human-pronunciation-informed rendering (spelled-out length
 *     units, the 5/50 expanded-energy sentences, letter-spelled `LET`/`CSDA` in English —
 *     eval/RECORDING.datagen.md's own rendering table) that #130 Part 1 designed specifically
 *     to double as TTS input. This is what scripts/tts-qwen-1000.py / tts-piper-1000.py /
 *     tts-chatterbox-1000-pl.py expect as their `<sentences.json>` argument — those scripts are
 *     otherwise fully generic over the {id, text, ...} shape, so no separate TTS-generation
 *     script was needed, just this flattening step pointed at `display` instead of `canonical`.
 *
 * `multi` is derived from slotTruth shape, not hand-authored: >1 energies -> "energy", >1
 * materials -> "material", >1 particles -> "particle", else null ("single" once
 * asr-score-slots-generic.mjs applies its own `?? "single"` fallback) — gives that script's
 * "by scenario type" breakdown real data instead of everything landing in one bucket.
 *
 * Output is NOT committed (gitignored, like scripts/tts-1000-sentences*.json) — regenerate
 * from the single source of truth, eval/datagen-sentences.json, whenever needed.
 *
 * Usage: node scripts/datagen-to-manifest.mjs <en|pl> [outFile] [--field canonical|display]
 *   outFile defaults to eval/datagen-manifest-<lang>.json (canonical) or
 *   eval/datagen-manifest-tts-<lang>.json (display)
 */
import { readFileSync, writeFileSync } from "node:fs";

const rawArgs = process.argv.slice(2);
const fieldFlagIdx = rawArgs.indexOf("--field");
const field = fieldFlagIdx >= 0 ? rawArgs[fieldFlagIdx + 1] : "canonical";
const positional =
  fieldFlagIdx >= 0
    ? rawArgs.filter((_, i) => i !== fieldFlagIdx && i !== fieldFlagIdx + 1)
    : rawArgs;
const [lang, explicitOutPath] = positional;

if (lang !== "en" && lang !== "pl") {
  console.error(
    "Usage: node scripts/datagen-to-manifest.mjs <en|pl> [outFile] [--field canonical|display]",
  );
  process.exit(1);
}
if (field !== "canonical" && field !== "display") {
  console.error(`--field must be "canonical" or "display", got "${field}"`);
  process.exit(1);
}
const outPath =
  explicitOutPath ??
  (field === "display"
    ? `eval/datagen-manifest-tts-${lang}.json`
    : `eval/datagen-manifest-${lang}.json`);

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
    text: side[field],
    quantity: r.quantity,
    multi: multiFor(side.slotTruth),
    slotTruth: side.slotTruth,
  };
});

writeFileSync(outPath, JSON.stringify(clips, null, 2) + "\n");
console.log(`wrote ${outPath} (${clips.length} clips, field=${field})`);
