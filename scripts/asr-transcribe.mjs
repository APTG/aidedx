/**
 * ASR transcription runner — saves raw transcripts to JSON for offline scoring.
 * Usage: node scripts/asr-transcribe.mjs <modelId> <dtype> <outFile> [--prompt]
 */
import { pipeline, env } from "@huggingface/transformers";
import { execSync } from "child_process";
import { readdirSync, existsSync, writeFileSync } from "fs";
import path from "path";

const PROJECT_ROOT = "/home/grzanka/workspace/aidedx";
env.cacheDir = path.join(PROJECT_ROOT, ".hf-cache");
env.allowLocalModels = false;

const modelId = process.argv[2];
const dtype = process.argv[3];
const outFile = process.argv[4];
const withPrompt = process.argv.includes("--prompt");

const IDS = [
  "stress-001",
  "stress-002",
  "sp-003",
  "sp-005",
  "sp-007",
  "sp-008",
  "rng-002",
  "rng-005",
  "rng-008",
  "ind-001",
  "ind-003",
  "ind-008",
  "conv-003",
  "conv-008",
  "cmp-mat-001",
  "cmp-mat-004",
  "cmp-mat-007",
  "cmp-par-003",
  "cmp-par-005",
  "cmp-en-001",
  "cmp-prog-001",
  "unit-001",
  "unit-003",
  "unit-006",
  "pernuc-001",
  "pernuc-003",
  "iso-002",
  "iso-004",
  "inv-rng-001",
  "alias-001",
];

const DOMAIN_PROMPT =
  "MeV, keV, GeV, MeV/u, MeV/nucl, dE/dx, CSDA, PMMA, ASTAR, PSTAR, " +
  "nucleon, proton, deuteron, carbon ion, neon ion, oxygen ion, " +
  "helium-3, carbon-13, stopping power, Lucite, adipose tissue";

function loadAudio(file) {
  const buf = execSync(`ffmpeg -loglevel quiet -i "${file}" -ar 16000 -ac 1 -f f32le -`, {
    maxBuffer: 50 * 1024 * 1024,
  });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

console.log(`[${modelId} ${dtype}${withPrompt ? " +prompt" : ""}] loading...`);
const t0 = Date.now();
const asr = await pipeline("automatic-speech-recognition", modelId, { dtype });
const loadS = (Date.now() - t0) / 1000;
console.log(`loaded in ${loadS.toFixed(1)}s`);

let genOpts = {};
let promptPrefix = "";
if (withPrompt) {
  const gc = asr.model.generation_config;
  // <|startofprev|> resolved from the tokenizer, NOT hardcoded — asr-batch.mjs uses
  // 50362, which is wrong for the multilingual vocab (50361) and derails decoding.
  const prevEnc = await asr.tokenizer("<|startofprev|>", { add_special_tokens: false });
  const prevIds = Array.from(prevEnc.input_ids.data).map(Number);
  const SOT_PREV = prevIds.length === 1 ? prevIds[0] : 50361;
  console.log(`<|startofprev|> = ${SOT_PREV}`);
  const SOT = Number(gc.decoder_start_token_id);
  const LANG_EN = Number(gc.lang_to_id["<|en|>"]);
  const TRANSCRIBE = Number(gc.task_to_id["transcribe"]);
  const NO_TS = Number(gc.no_timestamps_token_id);
  const encoded = await asr.tokenizer(DOMAIN_PROMPT, { add_special_tokens: false });
  const promptTokenIds = Array.from(encoded.input_ids.data).map(Number);
  genOpts = {
    decoder_input_ids: [SOT_PREV, ...promptTokenIds, SOT, LANG_EN, TRANSCRIBE, NO_TS],
    forced_decoder_ids: [],
  };
  promptPrefix = (await asr.tokenizer.decode(promptTokenIds, { skip_special_tokens: true })).trim();
}

const audioBase = path.join(PROJECT_ROOT, "eval", "audio");
const speakers = readdirSync(audioBase, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const records = [];
for (const speaker of speakers) {
  for (const id of IDS) {
    const file = path.join(audioBase, speaker, `${id}.wav`);
    if (!existsSync(file)) continue;
    const audio = loadAudio(file);
    const t1 = Date.now();
    let raw = "";
    let error = null;
    try {
      const result = await asr(audio, genOpts);
      raw = result.text.trim();
      if (withPrompt && raw.startsWith(promptPrefix)) {
        raw = raw.slice(promptPrefix.length).trimStart();
      }
    } catch (e) {
      error = String(e && e.message ? e.message : e);
    }
    const secs = (Date.now() - t1) / 1000;
    records.push({ speaker, id, raw, secs, error });
    console.log(`  ${speaker}/${id}: (${secs.toFixed(1)}s) ${error ? "ERROR " + error : raw}`);
  }
}

writeFileSync(outFile, JSON.stringify({ modelId, dtype, withPrompt, loadS, records }, null, 1));
console.log(`wrote ${outFile} (${records.length} records)`);
