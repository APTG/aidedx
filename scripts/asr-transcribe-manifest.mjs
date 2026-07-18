/**
 * ASR transcription runner for an arbitrary flat manifest + audio directory (as opposed to
 * scripts/asr-transcribe.mjs's hardcoded 30-ID x speaker-subdirectory layout, which doesn't
 * fit a large one-off batch where every clip has its own id and its own voice).
 *
 * Same model-loading and domain-prompt logic as scripts/asr-transcribe.mjs, verbatim — this
 * script only generalizes *which* files get fed to it.
 *
 * Usage: node scripts/asr-transcribe-manifest.mjs <audioDir> <manifest.json> <modelId> <dtype> <outFile> [--no-prompt]
 */
import { pipeline, env } from "@huggingface/transformers";
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import os from "os";
import path from "path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
env.cacheDir = path.join(PROJECT_ROOT, ".hf-cache");
env.allowLocalModels = false;

const audioDir = process.argv[2];
const manifestPath = process.argv[3];
const modelId = process.argv[4];
const dtype = process.argv[5];
const outFile = process.argv[6];
const withPrompt = !process.argv.includes("--no-prompt");

// Kept in sync by hand with src/lib/asr/transcribe.ts's own copy (issue #92) — this script
// can't import that module directly (Node/onnxruntime-node here vs. the browser
// transformers.js pipeline there), same reason the two have always been separate literals.
const DOMAIN_PROMPT =
  "MeV, keV, GeV, MeV/u, MeV/nucl, dE/dx, CSDA, PMMA, ASTAR, PSTAR, " +
  "nucleon, proton, deuteron, carbon ion, neon ion, oxygen ion, " +
  "helium-3, carbon-13, stopping power, LET, linear energy transfer, keV/um, " +
  "Lucite, adipose tissue, Kapton, Mylar, Teflon, Pyrex glass, sodium iodide, cesium iodide";

function loadAudio(file) {
  // execFileSync, not execSync — spawns ffmpeg directly with an argv array, no shell
  // involved to interpret `file`, so a manifest id/path containing quotes or shell
  // metacharacters can't be (mis)parsed as anything but a literal filename.
  const buf = execFileSync(
    "ffmpeg",
    ["-loglevel", "quiet", "-i", file, "-ar", "16000", "-ac", "1", "-f", "f32le", "-"],
    {
      maxBuffer: 50 * 1024 * 1024,
    },
  );
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
const clips = manifest.clips ?? manifest; // accept either {clips:[...]} or a bare array

// onnxruntime-node defaults its thread pool to the *physical* core count and pins thread i
// to CPU i; on a cgroup-limited Slurm/Athena allocation (nproc here != physical cores) most
// of those pins fail and it silently falls back to running well over 100 threads on the
// handful of cores actually granted — ~10x slower per clip, purely from scheduling overhead
// (docs/tts-eval-audio.md §4, confirmed there but not fixed at pilot scale; fixed here before
// a 1000-clip run would otherwise take hours longer than necessary for no benefit).
const nproc = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
console.log(`[${modelId} ${dtype}${withPrompt ? " +prompt" : ""}] loading... (nproc=${nproc})`);
const t0 = Date.now();
const asr = await pipeline("automatic-speech-recognition", modelId, {
  dtype,
  session_options: { interOpNumThreads: 1, intraOpNumThreads: nproc },
});
const loadS = (Date.now() - t0) / 1000;
console.log(`loaded in ${loadS.toFixed(1)}s`);

let promptEnabled = withPrompt;
let genOpts = {};
let promptPrefix = "";
if (promptEnabled) {
  const gc = asr.model.generation_config;
  if (!gc?.lang_to_id || !gc?.task_to_id || gc?.no_timestamps_token_id == null) {
    console.log(
      "prompt: unsupported by this model (no Whisper-style generation_config) — disabled",
    );
    promptEnabled = false;
  } else {
    const prevEnc = await asr.tokenizer("<|startofprev|>", { add_special_tokens: false });
    const prevIds = Array.from(prevEnc.input_ids.data).map(Number);
    if (prevIds.length !== 1) {
      throw new Error(
        `<|startofprev|> did not resolve to a single token (got ${JSON.stringify(prevIds)})`,
      );
    }
    const SOT_PREV = prevIds[0];
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
    promptPrefix = (
      await asr.tokenizer.decode(promptTokenIds, { skip_special_tokens: true })
    ).trim();
  }
}

const records = [];
for (let i = 0; i < clips.length; i++) {
  const { id } = clips[i];
  const file = path.join(audioDir, `${id}.wav`);
  const audio = loadAudio(file);
  const t1 = Date.now();
  let raw = "";
  let error = null;
  let usedPromptFallback = false;
  let result = null;
  try {
    result = await asr(audio, genOpts);
  } catch (e) {
    if (promptEnabled) {
      try {
        result = await asr(audio, {});
        usedPromptFallback = true;
      } catch (e2) {
        error = String(e2 && e2.message ? e2.message : e2);
      }
    } else {
      error = String(e && e.message ? e.message : e);
    }
  }
  if (result) {
    raw = result.text.trim();
    if (promptEnabled && !usedPromptFallback && raw.startsWith(promptPrefix)) {
      raw = raw.slice(promptPrefix.length).trimStart();
    }
  }
  const secs = (Date.now() - t1) / 1000;
  records.push({ id, raw, secs, error, usedPromptFallback });
  if ((i + 1) % 25 === 0 || i === clips.length - 1) {
    console.log(
      `  [${i + 1}/${clips.length}] ${id}: (${secs.toFixed(1)}s) ${error ? "ERROR " + error : raw}`,
    );
  }
}

writeFileSync(
  outFile,
  JSON.stringify({ modelId, dtype, withPrompt: promptEnabled, loadS, records }, null, 1),
);
console.log(`wrote ${outFile} (${records.length} records)`);
