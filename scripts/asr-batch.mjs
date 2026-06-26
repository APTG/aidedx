/**
 * Batch ASR benchmark against the 30-sentence eval set (issue #7).
 * Loads the model once and runs all audio files through it.
 *
 * Usage:
 *   node scripts/asr-batch.mjs                                     # whisper-small q8
 *   node scripts/asr-batch.mjs onnx-community/whisper-large-v3-turbo q8
 *   node scripts/asr-batch.mjs onnx-community/moonshine-base-ONNX  q8
 *
 * Output: per-file pass/fail + summary counts.
 * Pipe through `--correct` to also show post-correction results:
 *   node scripts/asr-batch.mjs onnx-community/whisper-small q8 --correct
 */
import { pipeline, env } from "@huggingface/transformers";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import { correct } from "./asr-correct.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
env.cacheDir = path.join(PROJECT_ROOT, ".hf-cache");
env.allowLocalModels = false;

const modelId = process.argv[2] ?? "onnx-community/whisper-small";
const dtype   = process.argv[3] ?? "q8";
const withCorrection = process.argv.includes("--correct");

// Ground-truth sentences for the 30 recorded eval clips.
const FILES = [
  ["stress-001", "I am curious how far in water the 240 keV carbon ion will go"],
  ["stress-002", "compare stopping power of neon ions in water and air for 100 MeV/nucl"],
  ["sp-003",     "What's the dE/dx of 250 MeV protons in PMMA?"],
  ["sp-005",     "Stopping power for 80 MeV per nucleon carbon ions in water."],
  ["sp-007",     "What is the mass stopping power of 200 MeV protons in cortical bone?"],
  ["sp-008",     "dE/dx of 3 MeV deuterons in silicon."],
  ["rng-002",    "What is the CSDA range of a 150 MeV proton in water?"],
  ["rng-005",    "Range of 90 MeV per nucleon carbon ions in water."],
  ["rng-008",    "How deep does a 100 MeV proton penetrate in water?"],
  ["ind-001",    "How far will a 60 MeV proton travel in water?"],
  ["ind-003",    "At what rate does a 30 MeV proton shed energy as it moves through aluminum?"],
  ["ind-008",    "What penetration depth do 80 MeV per nucleon oxygen ions reach in water?"],
  ["conv-003",   "Um, so like, how far does a 100 MeV proton go in water, roughly?"],
  ["conv-008",   "Okay so I need the range of 230 MeV protons in water for a plan."],
  ["cmp-mat-001","Compare the stopping power of 100 MeV protons in water and bone."],
  ["cmp-mat-004","Range of 150 MeV protons in water, bone, and adipose tissue."],
  ["cmp-mat-007","For 100 MeV per nucleon carbon ions, compare the range in water and PMMA."],
  ["cmp-par-003","How do carbon and neon ions compare in range in water at 100 MeV per nucleon?"],
  ["cmp-par-005","Which penetrates deeper in water at 60 MeV, a proton or a deuteron?"],
  ["cmp-en-001", "Compare the range of protons in water at 100 and 200 MeV."],
  ["cmp-prog-001","Compare the range of 150 MeV protons in water using ASTAR and PSTAR."],
  ["unit-001",   "Stopping power of 500 keV protons in water."],
  ["unit-003",   "What is the stopping power of 1 GeV protons in water?"],
  ["unit-006",   "What is the range of 900 keV deuterons in water?"],
  ["pernuc-001", "Range of carbon ions in water at 290 MeV/u."],
  ["pernuc-003", "What is the range of a carbon ion with 3.6 GeV total energy in water?"],
  ["iso-002",    "Stopping power of carbon-13 ions in water at 100 MeV per nucleon."],
  ["iso-004",    "Stopping power of a helium-3 ion in water at 40 MeV per nucleon."],
  ["inv-rng-001","What energy gives a 10 cm range in water for protons?"],
  ["alias-001",  "What is the range of 60 MeV protons in Lucite?"],
];

function loadAudio(file) {
  const buf = execSync(
    `ffmpeg -loglevel quiet -i "${file}" -ar 16000 -ac 1 -f f32le -`,
    { maxBuffer: 50 * 1024 * 1024 }
  );
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

console.log(`Model : ${modelId} [${dtype}]`);
console.log(`Clips : ${FILES.length}`);
if (withCorrection) console.log("Mode  : ASR + domain correction");
console.log("Loading model...");
const t0 = Date.now();
const asr = await pipeline("automatic-speech-recognition", modelId, { dtype });
console.log(`Model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

let exactRaw = 0, exactCorrected = 0;

for (const [id, expected] of FILES) {
  const file = path.join(PROJECT_ROOT, "eval", "audio", `${id}.wav`);
  const audio = loadAudio(file);

  const t1 = Date.now();
  const result = await asr(audio);
  const elapsed = ((Date.now() - t1) / 1000).toFixed(1);

  const raw = result.text.trim();
  const corrected = withCorrection ? correct(raw) : raw;

  const okRaw = raw.toLowerCase() === expected.toLowerCase();
  const okCorrected = corrected.toLowerCase() === expected.toLowerCase();
  if (okRaw) exactRaw++;
  if (withCorrection && okCorrected) exactCorrected++;

  const mark = okRaw ? "✓" : (withCorrection && okCorrected ? "~" : "✗");
  console.log(`${mark} ${id.padEnd(14)} (${elapsed}s)`);
  if (!okRaw) {
    console.log(`  expected : ${expected}`);
    console.log(`  raw      : ${raw}`);
    if (withCorrection && corrected !== raw) {
      console.log(`  corrected: ${corrected}`);
    }
  }
}

console.log(`\n=== ${exactRaw}/${FILES.length} exact match (raw) ===`);
if (withCorrection) {
  console.log(`=== ${exactCorrected}/${FILES.length} exact match (after correction) ===`);
  console.log("  ~ = wrong raw but fixed by correction layer");
}
