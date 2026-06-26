/**
 * Pre-fetch Whisper model weights for issue #7 (ASR spike).
 * Downloads tiny/base/small at q8+q4 into the HF hub cache.
 * Run once on fast connection; transformers.js reuses the cache.
 */
import { AutoProcessor, WhisperForConditionalGeneration, env } from '@huggingface/transformers';
import { fileURLToPath } from 'url';
import path from 'path';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
env.cacheDir = path.join(PROJECT_ROOT, '.hf-cache');
env.allowLocalModels = false;

const MODELS = [
  ['onnx-community/whisper-tiny',  'q8'],
  ['onnx-community/whisper-tiny',  'q4'],
  ['onnx-community/whisper-base',  'q8'],
  ['onnx-community/whisper-base',  'q4'],
  ['onnx-community/whisper-small', 'q8'],
  ['onnx-community/whisper-small', 'q4'],
];

for (const [modelId, dtype] of MODELS) {
  console.log(`\n=== ${modelId} [${dtype}] ===`);
  try {
    console.log('  processor...');
    await AutoProcessor.from_pretrained(modelId);
    console.log('  model weights...');
    await WhisperForConditionalGeneration.from_pretrained(modelId, { dtype });
    console.log(`  done.`);
  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
  }
}

console.log('\nAll downloads complete.');
