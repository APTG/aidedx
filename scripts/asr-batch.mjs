/**
 * Batch ASR benchmark against the 30-sentence eval set (issue #7).
 * Loads the model once and runs all audio files through it.
 *
 * Usage:
 *   node scripts/asr-batch.mjs                                              # whisper-small q8, all speakers
 *   node scripts/asr-batch.mjs onnx-community/whisper-large-v3-turbo q8
 *   node scripts/asr-batch.mjs onnx-community/moonshine-base-ONNX  q8
 *
 * Flags (combinable):
 *   --correct          show post-correction results alongside raw
 *   --prompt           inject domain vocabulary hint into Whisper decoder (prompt_ids)
 *   --speaker <tag>    run only this speaker subdirectory (default: all found)
 */
import { pipeline, env } from "@huggingface/transformers";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { readdirSync, existsSync } from "fs";
import path from "path";
import { correct } from "./asr-correct.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
env.cacheDir = path.join(PROJECT_ROOT, ".hf-cache");
env.allowLocalModels = false;

const modelId = process.argv[2] ?? "onnx-community/whisper-small";
const dtype = process.argv[3] ?? "q8";
const withCorrection = process.argv.includes("--correct");
const withPrompt = process.argv.includes("--prompt");
const speakerIdx = process.argv.indexOf("--speaker");
const speakerArg = speakerIdx !== -1 ? process.argv[speakerIdx + 1] : null;

// Domain vocabulary hint for Whisper's initial_prompt mechanism.
// Biases the decoder toward correct spellings of physics units/terms.
const DOMAIN_PROMPT =
  "MeV, keV, GeV, MeV/u, MeV/nucl, dE/dx, CSDA, PMMA, ASTAR, PSTAR, " +
  "nucleon, proton, deuteron, carbon ion, neon ion, oxygen ion, " +
  "helium-3, carbon-13, stopping power, Lucite, adipose tissue";

// Ground-truth sentences for the 30 recorded eval clips.
const FILES = [
  ["stress-001", "I am curious how far in water the 240 keV carbon ion will go"],
  ["stress-002", "compare stopping power of neon ions in water and air for 100 MeV/nucl"],
  ["sp-003", "What's the dE/dx of 250 MeV protons in PMMA?"],
  ["sp-005", "Stopping power for 80 MeV per nucleon carbon ions in water."],
  ["sp-007", "What is the mass stopping power of 200 MeV protons in cortical bone?"],
  ["sp-008", "dE/dx of 3 MeV deuterons in silicon."],
  ["rng-002", "What is the CSDA range of a 150 MeV proton in water?"],
  ["rng-005", "Range of 90 MeV per nucleon carbon ions in water."],
  ["rng-008", "How deep does a 100 MeV proton penetrate in water?"],
  ["ind-001", "How far will a 60 MeV proton travel in water?"],
  ["ind-003", "At what rate does a 30 MeV proton shed energy as it moves through aluminum?"],
  ["ind-008", "What penetration depth do 80 MeV per nucleon oxygen ions reach in water?"],
  ["conv-003", "Um, so like, how far does a 100 MeV proton go in water, roughly?"],
  ["conv-008", "Okay so I need the range of 230 MeV protons in water for a plan."],
  ["cmp-mat-001", "Compare the stopping power of 100 MeV protons in water and bone."],
  ["cmp-mat-004", "Range of 150 MeV protons in water, bone, and adipose tissue."],
  ["cmp-mat-007", "For 100 MeV per nucleon carbon ions, compare the range in water and PMMA."],
  ["cmp-par-003", "How do carbon and neon ions compare in range in water at 100 MeV per nucleon?"],
  ["cmp-par-005", "Which penetrates deeper in water at 60 MeV, a proton or a deuteron?"],
  ["cmp-en-001", "Compare the range of protons in water at 100 and 200 MeV."],
  ["cmp-prog-001", "Compare the range of 150 MeV protons in water using ASTAR and PSTAR."],
  ["unit-001", "Stopping power of 500 keV protons in water."],
  ["unit-003", "What is the stopping power of 1 GeV protons in water?"],
  ["unit-006", "What is the range of 900 keV deuterons in water?"],
  ["pernuc-001", "Range of carbon ions in water at 290 MeV/u."],
  ["pernuc-003", "What is the range of a carbon ion with 3.6 GeV total energy in water?"],
  ["iso-002", "Stopping power of carbon-13 ions in water at 100 MeV per nucleon."],
  ["iso-004", "Stopping power of a helium-3 ion in water at 40 MeV per nucleon."],
  ["inv-rng-001", "What energy gives a 10 cm range in water for protons?"],
  ["alias-001", "What is the range of 60 MeV protons in Lucite?"],
];

function loadAudio(file) {
  const buf = execSync(`ffmpeg -loglevel quiet -i "${file}" -ar 16000 -ac 1 -f f32le -`, {
    maxBuffer: 50 * 1024 * 1024,
  });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

console.log(`Model : ${modelId} [${dtype}]`);
console.log(`Clips : ${FILES.length}`);
if (withCorrection) console.log("Mode  : ASR + domain correction");
if (withPrompt) console.log("Prompt: domain vocabulary hint enabled");
console.log("Loading model...");
const t0 = Date.now();
const asr = await pipeline("automatic-speech-recognition", modelId, { dtype });

// Build decoder_input_ids replicating Whisper's prompt_ids mechanism (not in transformers.js v4).
// Correct structure: [<|startofprev|>, ...prompt_tokens, <|startoftranscript|>, <|en|>, <|transcribe|>, <|notimestamps|>]
// The <|startofprev|> token tells the decoder the prompt is prior context, not the transcript.
let promptDecoderIds;
let promptPrefix = "";
if (withPrompt) {
  const gc = asr.model.generation_config;
  const SOT_PREV = 50362; // <|startofprev|>
  const SOT = Number(gc.decoder_start_token_id); // <|startoftranscript|> = 50258
  const LANG_EN = Number(gc.lang_to_id["<|en|>"]); // 50259
  const TRANSCRIBE = Number(gc.task_to_id["transcribe"]); // 50360
  const NO_TS = Number(gc.no_timestamps_token_id); // 50364
  const encoded = await asr.tokenizer(DOMAIN_PROMPT, { add_special_tokens: false });
  const promptTokenIds = Array.from(encoded.input_ids.data).map(Number);
  promptDecoderIds = [SOT_PREV, ...promptTokenIds, SOT, LANG_EN, TRANSCRIBE, NO_TS];
  // The model echoes the prompt prefix verbatim before the actual transcript.
  // Decode just the prompt tokens to know exactly what to strip.
  const decoded = await asr.tokenizer.decode(promptTokenIds, { skip_special_tokens: true });
  promptPrefix = decoded.trim();
}

console.log(`Model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

// Determine which speakers to run
const audioBase = path.join(PROJECT_ROOT, "eval", "audio");
if (!existsSync(audioBase)) {
  console.error(`eval/audio/ not found. Run record-session.sh to create speaker recordings.`);
  process.exit(1);
}
const speakers = speakerArg
  ? [speakerArg]
  : readdirSync(audioBase, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

let totalRaw = 0,
  totalCorrected = 0,
  totalClips = 0;
const speakerSummary = [];

for (const speaker of speakers) {
  let exactRaw = 0,
    exactCorrected = 0,
    clips = 0;
  console.log(`\n--- Speaker: ${speaker} ---`);

  for (const [id, expected] of FILES) {
    const file = path.join(audioBase, speaker, `${id}.wav`);
    if (!existsSync(file)) {
      console.log(`  (skip) ${id} — file not found`);
      continue;
    }
    clips++;
    const audio = loadAudio(file);

    const t1 = Date.now();
    let result;
    try {
      result = await asr(
        audio,
        withPrompt ? { decoder_input_ids: promptDecoderIds, forced_decoder_ids: [] } : {},
      );
    } catch (err) {
      console.log(
        `  ! ${id.padEnd(14)} ERROR: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const elapsed = ((Date.now() - t1) / 1000).toFixed(1);

    let raw = result.text.trim();
    if (withPrompt && raw.startsWith(promptPrefix)) {
      raw = raw.slice(promptPrefix.length).trimStart();
    }
    const corrected = withCorrection ? correct(raw) : raw;

    const okRaw = raw.toLowerCase() === expected.toLowerCase();
    const okCorrected = corrected.toLowerCase() === expected.toLowerCase();
    if (okRaw) exactRaw++;
    if (withCorrection && okCorrected) exactCorrected++;

    const mark = okRaw ? "✓" : withCorrection && okCorrected ? "~" : "✗";
    console.log(`  ${mark} ${id.padEnd(14)} (${elapsed}s)`);
    if (!okRaw) {
      console.log(`    expected : ${expected}`);
      console.log(`    raw      : ${raw}`);
      if (withCorrection && corrected !== raw) {
        console.log(`    corrected: ${corrected}`);
      }
    }
  }

  console.log(
    `  => ${exactRaw}/${clips} exact match (raw)${withCorrection ? ` | ${exactCorrected}/${clips} after correction` : ""}`,
  );
  speakerSummary.push({ speaker, exactRaw, exactCorrected, clips });
  totalRaw += exactRaw;
  totalCorrected += exactCorrected;
  totalClips += clips;
}

console.log(`\n${"=".repeat(50)}`);
console.log("SUMMARY");
console.log(`${"=".repeat(50)}`);
for (const { speaker, exactRaw, exactCorrected, clips } of speakerSummary) {
  const pct = clips > 0 ? ((exactRaw / clips) * 100).toFixed(0) : "—";
  const line = `  ${speaker}  ${exactRaw}/${clips} (${pct}%)${withCorrection ? `  corrected: ${exactCorrected}/${clips}` : ""}`;
  console.log(line);
}
const allPct = totalClips > 0 ? ((totalRaw / totalClips) * 100).toFixed(0) : "—";
console.log(
  `  ALL  ${totalRaw}/${totalClips} (${allPct}%)${withCorrection ? `  corrected: ${totalCorrected}/${totalClips}` : ""}`,
);
console.log(`${"=".repeat(50)}`);
