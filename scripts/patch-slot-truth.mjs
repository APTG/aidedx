// Overlays ground-truth slotTruth from scripts/tts-1000-sentences.json onto
// eval/audio/tts-qwen-1000/manifest.json, by id. Needed because the generator's first
// version recorded a fixed "range"/"stopping power" keyword per quantity regardless of
// which phrasing template actually fired — wrong for indirect phrasings ("how far will X
// travel" never says "range"). Touches only `slotTruth` on each entry — text/audio/timing/
// voice fields are left exactly as recorded during synthesis. Idempotent; part of
// submit.sh's pipeline, run once generation is complete.
import { readFileSync, writeFileSync } from "fs";

const candidates = JSON.parse(readFileSync("scripts/tts-1000-sentences.json", "utf-8"));
const truthById = new Map(candidates.map((c) => [c.id, c.slotTruth]));

const manifestPath = "eval/audio/tts-qwen-1000/manifest.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
let patched = 0;
for (const clip of manifest.clips) {
  const truth = truthById.get(clip.id);
  if (truth) {
    clip.slotTruth = truth;
    patched++;
  }
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`patched slotTruth on ${patched}/${manifest.clips.length} clips`);
