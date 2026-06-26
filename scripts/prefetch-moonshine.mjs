/**
 * Pre-fetch MoonShine ASR model for issue #7 (ASR spike — alternative to Whisper).
 * MoonShine is an edge-first English-only ASR model; ~200 MB at q8,
 * often more accurate than whisper-small on English out-of-vocabulary terms.
 *
 * Usage: node scripts/prefetch-moonshine.mjs
 */
import { pipeline, env } from "@huggingface/transformers";
import { fileURLToPath } from "url";
import path from "path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
env.cacheDir = path.join(PROJECT_ROOT, ".hf-cache");
env.allowLocalModels = false;

const MODELS = [
  ["onnx-community/moonshine-base-ONNX", "q8"],
];

let failed = false;
for (const [modelId, dtype] of MODELS) {
  console.log(`\n=== ${modelId} [${dtype}] ===`);
  try {
    console.log("  downloading via pipeline (automatic-speech-recognition)...");
    await pipeline("automatic-speech-recognition", modelId, { dtype });
    console.log("  done.");
  } catch (err) {
    console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
    failed = true;
  }
}

if (failed) {
  console.error("\nSome downloads failed — check errors above.");
  process.exit(1);
}
console.log("\nAll downloads complete.");
