/**
 * NeMo Parakeet-v3 (TDT) transcription runner via sherpa-onnx's native N-API binding
 * (issue #122). Writes the same modelId/dtype/loadS/records[] JSON contract
 * scripts/asr-transcribe.mjs uses, so scripts/e2e-audio-intents.ts and
 * scripts/asr-score-slots.mjs need no changes.
 *
 * Runs BOTH an unbiased pass and a hotwords-biased pass from a single loaded model
 * (one 640MB load, not two) — decodingMethod is modified_beam_search for both runs
 * (required for hotwords to take effect on the biased pass); the unbiased pass just
 * omits the hotwords string, per sherpa-onnx's own nodejs-addon-examples pattern
 * (test_asr_non_streaming_nemo_parakeet_tdt_v2_hotwords.js).
 *
 * The generic WebAssembly build (npm `sherpa-onnx`) was tried first and crashes
 * (`RuntimeError: unreachable`) loading this model's 652 MB encoder — its shared
 * WebAssembly.Memory is hardcoded to a 2 GiB maximum, too small for this model's
 * runtime footprint. `sherpa-onnx-node` (native N-API, same underlying C++ engine,
 * no WASM linear-memory ceiling) is used instead — see docs/nemo-parakeet-comparison.md.
 *
 * Usage: node scripts/sherpa-onnx-transcribe.mjs <outDir> [suffix] [--hotwords-only]
 *   suffix is appended to both output filenames (e.g. "v2" -> parakeet-v3-hotwords-v2.json).
 *   --hotwords-only skips the unbiased pass (for re-running just a reworded hotwords list).
 */
import sherpa_onnx from "sherpa-onnx-node";
import { execFileSync } from "child_process";
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_DIR = path.join(
  PROJECT_ROOT,
  ".hf-cache/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
);
const MODEL_ID = "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";

const outDir = process.argv[2];
if (!outDir) {
  console.error("Usage: node scripts/sherpa-onnx-transcribe.mjs <outDir>");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

// Same fixed 30-sentence set scripts/asr-transcribe.mjs uses (issue #120/§122 shared eval set).
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

// Hotwords: the project's own DOMAIN_PROMPT vocabulary (scripts/asr-transcribe.mjs, already
// validated as this project's curated domain-jargon list for Whisper prompt-biasing — reusing
// it here keeps the hotwords-vs-prompt comparison apples-to-apples), plus material/particle
// terms actually spoken in this eval set not already covered (from src/lib/aliases/ canonical
// forms, scoped to this eval set the same way #120 §2.6's Vosk grammar was, not the full
// 277-material/118-particle tables), plus explicit phonetic/spelled variants for the unit
// jargon specifically (issue #122 item 3 — "MeV" pronounced "em-ee-vee", "cm" spelled
// "centimeters"), which DOMAIN_PROMPT (plain running text) doesn't include.
const HOTWORDS = [
  // DOMAIN_PROMPT terms (scripts/asr-transcribe.mjs)
  "MeV",
  "keV",
  "GeV",
  "MeV per nucleon",
  "MeV per u",
  "dE dx",
  "CSDA",
  "PMMA",
  // ASTAR/PSTAR (program names) were tried and dropped — both v1 and v2 (docs/nemo-parakeet-
  // comparison.md) show them triggering runaway hallucinated repetition ("ASTAR ASTAR ASTAR
  // ASTAR...") on clips that never mention a program at all, corrupting otherwise-fine
  // transcripts. Program names are outside this spike's actual scope (issue #122 targets the
  // spoken-units problem specifically) and were already recognized fine unprompted
  // (cmp-prog-001 in the unbiased run) — not worth the collateral damage.
  "nucleon",
  "proton",
  "deuteron",
  "deuterons",
  "carbon ion",
  "carbon ions",
  "neon ion",
  "neon ions",
  "oxygen ion",
  "oxygen ions",
  "helium-3",
  "carbon-13",
  "stopping power",
  "LET",
  "linear energy transfer",
  "keV per um",
  "Lucite",
  "adipose tissue",
  "Kapton",
  "Mylar",
  "Teflon",
  "Pyrex glass",
  "sodium iodide",
  "cesium iodide",
  // materials/particles spoken in this eval set, not already above
  "air",
  "aluminum",
  "bone",
  "cortical bone",
  "silicon",
  "water",
  "protons",
  // phonetic/spelled variants for unit jargon (issue #122 item 3). Letter-name forms
  // ("M E V") were tried and dropped — v1 (docs/nemo-parakeet-comparison.md) found they bias
  // the decoder into splitting normally-pronounced "MeV" into individual letters on clips
  // where nothing was spelled out, 28/89 clips affected. Same "reword, don't abandon" lesson
  // as docs/android-asr-runtime-bench.md §5.7→§5.9's whisper.cpp prompt fix.
  "em ee vee",
  "kay ee vee",
  "gee ee vee",
  "centimeters",
  "centi meters",
  "millimeters",
  "milli meters",
  "micrometers",
  "micro meters",
  "microns",
]
  .map((w) => `${w} :2.0`)
  .join("/");

function ensureBpeVocab() {
  const bpeVocab = path.join(MODEL_DIR, "bpe.vocab");
  if (!existsSync(bpeVocab)) {
    // Same derivation as sherpa-onnx's own nodejs-addon-examples hotwords example: this
    // model's release ships tokens.txt but no separate bpe.vocab; equal (-1.0) scores make
    // the hotword-phrase encoder behave as longest-match against the token vocabulary.
    const tokens = readFileSync(path.join(MODEL_DIR, "tokens.txt"), "utf8");
    const vocab = tokens
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => `${line.split(" ")[0]}\t-1.0`)
      .join("\n");
    writeFileSync(bpeVocab, vocab + "\n");
  }
  return bpeVocab;
}

function loadAudio(file) {
  const buf = execFileSync(
    "ffmpeg",
    ["-loglevel", "quiet", "-i", file, "-ar", "16000", "-ac", "1", "-f", "f32le", "-"],
    { maxBuffer: 50 * 1024 * 1024 },
  );
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

const config = {
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: path.join(MODEL_DIR, "encoder.int8.onnx"),
      decoder: path.join(MODEL_DIR, "decoder.int8.onnx"),
      joiner: path.join(MODEL_DIR, "joiner.int8.onnx"),
    },
    tokens: path.join(MODEL_DIR, "tokens.txt"),
    numThreads: 2,
    provider: "cpu",
    debug: 0,
    modelType: "nemo_transducer",
    modelingUnit: "bpe",
    bpeVocab: ensureBpeVocab(),
  },
  decodingMethod: "modified_beam_search",
  hotwordsScore: 2.0,
};

console.log(`[${MODEL_ID}] loading...`);
const t0 = Date.now();
const recognizer = new sherpa_onnx.OfflineRecognizer(config);
const loadS = (Date.now() - t0) / 1000;
console.log(`loaded in ${loadS.toFixed(1)}s`);

const audioBase = path.join(PROJECT_ROOT, "eval", "audio");
const speakers = readdirSync(audioBase, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

function transcribe(hotwords) {
  const records = [];
  for (const speaker of speakers) {
    for (const id of IDS) {
      const file = path.join(audioBase, speaker, `${id}.wav`);
      if (!existsSync(file)) continue;
      const samples = loadAudio(file);
      const t1 = Date.now();
      let raw = "";
      let error = null;
      try {
        const stream = recognizer.createStream(hotwords);
        stream.acceptWaveform({ sampleRate: 16000, samples });
        recognizer.decode(stream);
        raw = recognizer.getResult(stream).text.trim();
      } catch (e) {
        // Prefer the Error's own message; fall back to stringifying whatever was thrown.
        if (e && e.message) {
          error = String(e.message);
        } else {
          error = String(e);
        }
      }
      const secs = (Date.now() - t1) / 1000;
      records.push({ speaker, id, raw, secs, error });
      let logLine = raw;
      if (error) {
        logLine = "ERROR " + error;
      }
      console.log(`  ${speaker}/${id}: (${secs.toFixed(1)}s) ${logLine}`);
    }
  }
  return records;
}

const hotwordsOnly = process.argv.includes("--hotwords-only");
// argv[3] is the optional suffix arg, unless it's actually a flag like --hotwords-only.
let suffix = "";
if (process.argv[3] && !process.argv[3].startsWith("--")) {
  suffix = `-${process.argv[3]}`;
}

if (!hotwordsOnly) {
  console.log("\n=== unbiased ===");
  const unbiasedRecords = transcribe(undefined);
  writeFileSync(
    path.join(outDir, `parakeet-v3-unbiased${suffix}.json`),
    JSON.stringify(
      { modelId: MODEL_ID, dtype: "int8", withPrompt: false, loadS, records: unbiasedRecords },
      null,
      1,
    ),
  );
}

console.log("\n=== hotwords-biased ===");
const hotwordsRecords = transcribe(HOTWORDS);
writeFileSync(
  path.join(outDir, `parakeet-v3-hotwords${suffix}.json`),
  JSON.stringify(
    { modelId: MODEL_ID, dtype: "int8", withPrompt: false, loadS, records: hotwordsRecords },
    null,
    1,
  ),
);

console.log(`\nwrote ${outDir}/parakeet-v3-{unbiased,hotwords}.json`);
