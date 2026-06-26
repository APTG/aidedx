/**
 * Pre-fetch LLM NLU models for issue #8 (Spike 2).
 * Downloads Qwen2.5-0.5B, Qwen2.5-1.5B, Llama-3.2-1B at q4 + q8
 * into the transformers.js cache so they're available offline.
 */
import { AutoTokenizer, AutoModelForCausalLM, env } from "@huggingface/transformers";
import { fileURLToPath } from "url";
import path from "path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
env.cacheDir = path.join(PROJECT_ROOT, ".hf-cache");
env.allowLocalModels = false;

const MODELS = [
  ["onnx-community/Qwen2.5-0.5B-Instruct", "q4"],
  ["onnx-community/Qwen2.5-0.5B-Instruct", "q8"],
  ["onnx-community/Qwen2.5-1.5B-Instruct", "q4"],
  ["onnx-community/Qwen2.5-1.5B-Instruct", "q8"],
  ["onnx-community/Llama-3.2-1B-Instruct", "q4"],
  ["onnx-community/Llama-3.2-1B-Instruct", "q8"],
];

let failed = false;
for (const [modelId, dtype] of MODELS) {
  console.log(`\n=== ${modelId} [${dtype}] ===`);
  try {
    console.log("  tokenizer...");
    await AutoTokenizer.from_pretrained(modelId);
    console.log("  model weights...");
    await AutoModelForCausalLM.from_pretrained(modelId, { dtype });
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
