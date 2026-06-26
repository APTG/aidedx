/**
 * Quick ASR smoke-test for issue #7.
 * Usage: node scripts/test-asr.mjs <audio.wav> [model] [dtype]
 * Defaults: whisper-tiny, q8
 */
import { pipeline, env } from '@huggingface/transformers';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
env.cacheDir = path.join(PROJECT_ROOT, '.hf-cache');
env.allowLocalModels = false;

const audioFile = process.argv[2] ?? 'eval/audio/stress-001.wav';
const modelId   = `onnx-community/${process.argv[3] ?? 'whisper-tiny'}`;
const dtype     = process.argv[4] ?? 'q8';

if (!fs.existsSync(audioFile)) {
  console.error(`Audio file not found: ${audioFile}`); process.exit(1);
}

// Decode to 16 kHz mono float32 raw PCM via ffmpeg
const pcmBuf = execSync(
  `ffmpeg -loglevel quiet -i "${audioFile}" -ar 16000 -ac 1 -f f32le -`,
  { maxBuffer: 50 * 1024 * 1024 }
);
const audio = new Float32Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 4);

console.log(`Model : ${modelId} [${dtype}]`);
console.log(`Audio : ${audioFile} (${(audio.length / 16000).toFixed(2)}s @ 16 kHz mono)`);
console.log('Loading model...');
const t0 = Date.now();
const asr = await pipeline('automatic-speech-recognition', modelId, { dtype });
console.log(`Model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

console.log('Transcribing...');
const DOMAIN_PROMPT = 'Physics query about stopping power, CSDA range, dE/dx, keV, MeV, GeV, MeV/nucl, MeV/u, proton, alpha, deuteron, carbon ion, neon ion, PMMA, Lucite, Perspex, Plexiglas, Bragg peak, PSTAR, ASTAR.';

const t1 = Date.now();
const result = await asr(audio);
const elapsed = ((Date.now() - t1) / 1000).toFixed(2);
console.log(`\nNo prompt   (${elapsed}s): "${result.text.trim()}"`);

const t2 = Date.now();
const resultPrompted = await asr(audio, { generate_kwargs: { prompt_ids: await asr.tokenizer.encode(DOMAIN_PROMPT, { add_special_tokens: false }) } });
const elapsed2 = ((Date.now() - t2) / 1000).toFixed(2);
console.log(`With prompt (${elapsed2}s): "${resultPrompted.text.trim()}"`);
