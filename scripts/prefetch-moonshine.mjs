/**
 * Pre-fetch non-Whisper ASR candidates (issue #7's Moonshine, issue #49's
 * variable-length/CTC "Lever 2" additions). All load via the generic
 * `pipeline("automatic-speech-recognition", ...)` API, unlike the Whisper
 * family in prefetch-whisper-models.mjs which needs the AutoProcessor +
 * WhisperForConditionalGeneration split.
 *
 * - moonshine-base-ONNX: edge-first English-only ASR, ~200 MB at q8.
 * - moonshine-tiny-ONNX (issue #49): smaller Moonshine, ~50 MB at q8.
 * - wav2vec2-base-960h (issue #49): Meta/Facebook CTC model, encoder-only,
 *   no autoregressive decode loop, ~91 MB at q8 (Xenova's "quantized" export).
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
  ["onnx-community/moonshine-tiny-ONNX", "q8"],
  ["Xenova/wav2vec2-base-960h", "q8"],
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
