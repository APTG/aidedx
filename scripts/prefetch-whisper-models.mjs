/**
 * Pre-fetch Whisper model weights for issue #7 (ASR spike).
 * Downloads tiny/base/small (already cached) plus large-v3-turbo and
 * distil-small.en into the HF hub cache. Run once on a fast connection.
 *
 * Usage:
 *   node scripts/prefetch-whisper-models.mjs          # all models
 *   node scripts/prefetch-whisper-models.mjs --new    # large-v3-turbo + distil-small.en only
 *   node scripts/prefetch-whisper-models.mjs --bench  # full whisper-model-bench matrix (issue #27
 *                                                      # follow-up: all 7 multilingual sizes x
 *                                                      # {q8, fp32}) — see scripts/submit-whisper-bench.sh
 */
import { AutoProcessor, WhisperForConditionalGeneration, env } from "@huggingface/transformers";
import { fileURLToPath } from "url";
import path from "path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
env.cacheDir = path.join(PROJECT_ROOT, ".hf-cache");
env.allowLocalModels = false;

const newOnly = process.argv.includes("--new");
const benchOnly = process.argv.includes("--bench");

const MODELS_EXISTING = [
  ["onnx-community/whisper-tiny", "q8"],
  ["onnx-community/whisper-tiny", "q4"],
  ["onnx-community/whisper-base", "q8"],
  ["onnx-community/whisper-base", "q4"],
  ["onnx-community/whisper-small", "q8"],
  ["onnx-community/whisper-small", "q4"],
];

// New models added after the 30-sentence benchmark (issue #7 comment, 2026-06-26).
// whisper-large-v3-turbo: distilled from large-v3, much better domain accuracy,
// designed for fast CPU inference. ~600 MB at q8.
// distil-small.en (issue #49): English-only distil-whisper, 2-layer decoder,
// full whisper-small encoder — ~190 MB at q8.
const MODELS_NEW = [
  ["onnx-community/whisper-large-v3-turbo", "q8"],
  ["onnx-community/distil-small.en", "q8"],
];

// Every officially-released Whisper size, at both q8 (this repo's usual browser-deployment
// quantization) and fp32 (unquantized — measures each size's real accuracy ceiling instead of
// the quantized approximation, since an Athena GPU-partition benchmark isn't budget-constrained
// the way a browser/WASM deployment is). Multilingual checkpoints only (no .en-suffixed
// variants) so the exact same 14 models run against both the English and Polish 1000-sentence
// batches — see scripts/submit-whisper-bench.sh. medium/large-v2/large-v3 are published under a
// "-ONNX"-suffixed repo name on onnx-community (confirmed via the HF API — the bare names 401,
// the "-ONNX" names don't); large-v3-turbo and the tiny/base/small tier keep their bare names.
const MODELS_BENCH = [
  ["onnx-community/whisper-tiny", "q8"],
  ["onnx-community/whisper-tiny", "fp32"],
  ["onnx-community/whisper-base", "q8"],
  ["onnx-community/whisper-base", "fp32"],
  ["onnx-community/whisper-small", "q8"],
  ["onnx-community/whisper-small", "fp32"],
  ["onnx-community/whisper-medium-ONNX", "q8"],
  ["onnx-community/whisper-medium-ONNX", "fp32"],
  ["onnx-community/whisper-large-v2-ONNX", "q8"],
  ["onnx-community/whisper-large-v2-ONNX", "fp32"],
  ["onnx-community/whisper-large-v3-ONNX", "q8"],
  ["onnx-community/whisper-large-v3-ONNX", "fp32"],
  ["onnx-community/whisper-large-v3-turbo", "q8"],
  ["onnx-community/whisper-large-v3-turbo", "fp32"],
];

const MODELS = benchOnly
  ? MODELS_BENCH
  : newOnly
    ? MODELS_NEW
    : [...MODELS_EXISTING, ...MODELS_NEW];

let failed = false;
for (const [modelId, dtype] of MODELS) {
  console.log(`\n=== ${modelId} [${dtype}] ===`);
  try {
    console.log("  processor...");
    await AutoProcessor.from_pretrained(modelId);
    console.log("  model weights...");
    await WhisperForConditionalGeneration.from_pretrained(modelId, { dtype });
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
