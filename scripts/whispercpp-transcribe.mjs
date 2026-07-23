/**
 * whisper.cpp desktop CPU benchmark — issue #120 pre-Android sanity check.
 * Runs the locally-built `whisper-cli` binary over the eval clips and writes the same JSON
 * contract as scripts/asr-transcribe.mjs (docs/android-asr-runtime-bench.md §3), so results
 * score with the existing scripts/e2e-audio-intents.ts / scripts/asr-score-slots.mjs unmodified.
 *
 * Requires a locally-built whisper-cli (see docs/android-asr-runtime-bench.md "Desktop CPU
 * benchmark" section for the clone+cmake steps) and the ggml model files fetched via
 * scripts/android-asr-fetch-models.sh whispercpp — neither is bundled with this repo.
 *
 * Usage: node scripts/whispercpp-transcribe.mjs <ggmlModelPath> <outFile> [--no-prompt]
 */
import { spawn } from "child_process";
import { readdirSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(PROJECT_ROOT, ".android-asr-cache/src/whisper.cpp/build/bin/whisper-cli");

const modelPath = process.argv[2];
const outFile = process.argv[3];
const withPrompt = !process.argv.includes("--no-prompt");

if (!modelPath || !outFile) {
  console.error(
    "Usage: node scripts/whispercpp-transcribe.mjs <ggmlModelPath> <outFile> [--no-prompt]",
  );
  process.exit(1);
}
if (!existsSync(BIN)) {
  throw new Error(
    `whisper-cli not found at ${BIN} — build it first (see docs/android-asr-runtime-bench.md)`,
  );
}

// Kept in sync by hand with scripts/asr-transcribe.mjs's own copy (issue #25/#92) — same
// reason the two have always been separate literals (different runtimes, can't share a module).
const DOMAIN_PROMPT =
  "MeV, keV, GeV, MeV/u, MeV/nucl, dE/dx, CSDA, PMMA, ASTAR, PSTAR, " +
  "nucleon, proton, deuteron, carbon ion, neon ion, oxygen ion, " +
  "helium-3, carbon-13, stopping power, LET, linear energy transfer, keV/um, " +
  "Lucite, adipose tissue, Kapton, Mylar, Teflon, Pyrex glass, sodium iodide, cesium iodide";

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

const audioBase = path.join(PROJECT_ROOT, "eval", "audio");
const speakers = readdirSync(audioBase, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const clips = [];
for (const speaker of speakers) {
  for (const id of IDS) {
    const file = path.join(audioBase, speaker, `${id}.wav`);
    if (existsSync(file)) clips.push({ speaker, id, file });
  }
}

const args = ["-m", modelPath, "-l", "en", "-nt", "-np", "-oj"];
if (withPrompt) args.push("--prompt", DOMAIN_PROMPT);
args.push(...clips.map((c) => c.file));

console.log(
  `[whispercpp ${path.basename(modelPath)}${withPrompt ? " +prompt" : ""}] transcribing ${clips.length} clips (single process, one model load)...`,
);

// Model load happens once at process start, before the first "read_audio_data" line — timing
// the gaps between consecutive markers gives per-clip wall time without the reload-per-call
// distortion a separate whisper-cli invocation per clip would introduce (whisper-cli has no
// batch-mode JSON output with per-file timings, so this is the only way to get clean per-clip
// numbers from the CLI as shipped).
const markerRe = /read_audio_data: reading audio data from '(.+)' \.\.\./;
const marks = [];
let buf = "";
const t0 = Date.now();

function feed(chunk) {
  buf += chunk.toString("utf-8");
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    const m = markerRe.exec(line);
    if (m) marks.push({ file: m[1], t: Date.now() });
  }
}

const child = spawn(BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", feed);
child.stderr.on("data", feed);

const exitCode = await new Promise((resolve) => child.on("close", resolve));
const tEnd = Date.now();
if (exitCode !== 0) throw new Error(`whisper-cli exited with code ${exitCode}`);
if (marks.length !== clips.length) {
  throw new Error(
    `expected ${clips.length} start markers, got ${marks.length} — stdout parsing drifted`,
  );
}

const loadS = (marks[0].t - t0) / 1000;
const records = clips.map((c, i) => {
  const secs = ((i + 1 < marks.length ? marks[i + 1].t : tEnd) - marks[i].t) / 1000;
  const jsonPath = `${c.file}.json`;
  let raw = "";
  let error = null;
  try {
    const parsed = JSON.parse(readFileSync(jsonPath, "utf-8"));
    raw = parsed.transcription
      .map((seg) => seg.text)
      .join("")
      .trim();
  } catch (e) {
    error = String(e && e.message ? e.message : e);
  } finally {
    if (existsSync(jsonPath)) unlinkSync(jsonPath); // clean up sidecar files from eval/audio/
  }
  console.log(`  ${c.speaker}/${c.id}: (${secs.toFixed(1)}s) ${error ? "ERROR " + error : raw}`);
  return { speaker: c.speaker, id: c.id, raw, secs, error };
});

writeFileSync(
  outFile,
  JSON.stringify(
    {
      modelId: `whispercpp/${path.basename(modelPath, ".bin")}`,
      dtype: "ggml",
      withPrompt,
      loadS,
      records,
    },
    null,
    1,
  ),
);
console.log(`wrote ${outFile} (${records.length} records, loadS=${loadS.toFixed(1)}s)`);
