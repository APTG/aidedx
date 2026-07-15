/**
 * Real-browser ASR timing benchmark (issue #46 follow-up). Drives the actual
 * app in headless Chromium, feeding real eval audio through Chrome's
 * fake-mic-capture flags, to measure genuine prefill (first-token latency)
 * and per-token decode cost against onnxruntime-web/WASM — the backend that
 * ships to users — instead of relying on `docs/whisper-progress-feedback.md`'s
 * calibration table, which was measured with `scripts/asr-transcribe.mjs` in
 * Node (onnxruntime-node, a different, faster, natively-compiled backend;
 * see that doc's "Verification caveat" section). Findings are written up in
 * that doc's "Real-browser verification" section.
 *
 * Two measurement techniques, both needed:
 *   - DOM sampling of the progress bar's `aria-label` (`MicButton.svelte`)
 *     for the "Warming up…" -> "Processing…" -> gone transitions — coarse
 *     (~15ms polling) but needs no app instrumentation.
 *   - A `Worker` constructor monkey-patch (`addInitScript`, runs before any
 *     app code) that taps the worker's raw `{ type: "token", count }`
 *     messages for exact per-token timestamps — see `worker-protocol.ts`.
 *
 * No explicit "warm the pipeline first" step: `asr-status.svelte.ts`'s
 * start() already kicks off pipeline loading (Cache Storage read + ONNX
 * Runtime Web session creation, ~2.4-2.6s) the moment Start is clicked, in
 * parallel with recording — since every clip below runs longer than that,
 * it's already resolved by the time Stop is clicked, so the measured
 * "prefill" is genuinely just the per-utterance encoder pass, not
 * contaminated by leftover pipeline load. `runRepeated()`'s run 1 (no
 * warm-up at all) shows the same prefill as later runs, confirming this.
 *
 * Usage:
 *   pnpm run preview -- --port 4173 &        # or `pnpm dev`
 *   node scripts/asr-browser-benchmark.mjs [baseUrl] [--repeat=N]
 *
 * `--repeat=N` records the same clip N times in one page session (one Worker,
 * one loaded pipeline) instead of one pass over varied clips — the check for
 * whether prefill drops after the first transcription in a session (it
 * doesn't; see the doc's findings).
 *
 * Model weights (~245 MB) are downloaded into `.tmp-pw-profile/` (a
 * `launchPersistentContext` profile dir, gitignored) on first run and reused
 * — via the real download-consent UI, not a shortcut — on subsequent runs.
 *
 * Needs the `.wav` clips under `eval/audio/` (per `eval/RECORDING.md`), which
 * — like the model weights — is local-only and gitignored, not fetched by
 * `pnpm install`. Record it locally first, or point the `CLIPS` array below
 * at whatever `.wav` files you do have.
 */
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PROFILE_DIR = path.join(REPO_ROOT, ".tmp-pw-profile");

const args = process.argv.slice(2);
const BASE_URL = args.find((a) => !a.startsWith("--")) ?? "http://localhost:4173";
const repeatArg = args.find((a) => a.startsWith("--repeat="));
const REPEAT_COUNT = repeatArg ? Number(repeatArg.slice("--repeat=".length)) : 0;

const CLIPS = [
  { id: "km/sp-005", path: "eval/audio/km/sp-005.wav", audioSec: 5.375351 },
  { id: "km/rng-002", path: "eval/audio/km/rng-002.wav", audioSec: 5.375351 },
  { id: "km/cmp-mat-001", path: "eval/audio/km/cmp-mat-001.wav", audioSec: 5.375351 },
  { id: "mn/pernuc-001", path: "eval/audio/mn/pernuc-001.wav", audioSec: 5.25 },
  { id: "lg/stress-001", path: "eval/audio/lg/stress-001.wav", audioSec: 8.575351 },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs before any app script — must patch the global before `new Worker(...)` in worker-client.ts executes. */
const INIT_SCRIPT = `
  window.__samples = [];
  setInterval(() => {
    const pb = document.querySelector('[role="progressbar"]');
    window.__samples.push({ t: performance.now(), label: pb ? pb.getAttribute('aria-label') : null });
  }, 15);
  window.__tokenLog = [];
  const OrigWorker = window.Worker;
  window.Worker = class extends OrigWorker {
    constructor(...ctorArgs) {
      super(...ctorArgs);
      this.addEventListener("message", (e) => {
        if (e.data && e.data.type === "token") {
          window.__tokenLog.push({ t: performance.now(), count: e.data.count });
        }
      });
    }
  };
`;

async function isStartEnabled(page) {
  return page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /Start/.test(b.textContent ?? ""),
    );
    return Boolean(btn) && !btn.disabled;
  });
}

async function waitForStartEnabled(page, timeoutMs) {
  for (let waited = 0; waited < timeoutMs; waited += 200) {
    if (await isStartEnabled(page)) return true;
    await sleep(200);
  }
  return isStartEnabled(page);
}

async function ensureModelReady(page) {
  // modelStatus starts "checking" (async hardware detection + Cache Storage
  // probe) before settling into "fresh" (download banner) or "ready"
  // (already cached) — check for the banner too early and it's invisible in
  // both states, so poll briefly for either signal instead of a single read.
  const downloadBtn = page.getByRole("button", { name: "Download", exact: true });
  for (let waited = 0; waited < 15_000; waited += 200) {
    if ((await downloadBtn.isVisible().catch(() => false)) || (await isStartEnabled(page))) break;
    await sleep(200);
  }

  if (await downloadBtn.isVisible().catch(() => false)) {
    await downloadBtn.click();
    await page.getByRole("button", { name: "Download now" }).click();
  }
  const ready = await waitForStartEnabled(page, 180_000);
  if (!ready) throw new Error("model never became ready (download stalled or failed)");
}

async function recordOnce(page, audioSec) {
  await page.evaluate(() => {
    window.__samples = [];
    window.__tokenLog = [];
  });
  await page.getByRole("button", { name: /Start/ }).click();
  await sleep(Math.ceil(audioSec * 1000) + 400);
  await page.getByRole("button", { name: /Stop/ }).click();

  await page
    .waitForFunction(() => document.querySelector('[role="progressbar"]') === null, undefined, {
      timeout: 30_000,
    })
    .catch(() => {});
  await sleep(150);

  const samples = await page.evaluate(() => window.__samples);
  const tokenLog = await page.evaluate(() => window.__tokenLog);
  const transcript = await page
    .locator("input[name=query]")
    .inputValue()
    .catch(() => "");

  const warmingUpAt = samples.find((s) => s.label === "Warming up…")?.t ?? null;
  const processingAt = samples.find((s) => s.label === "Processing…")?.t ?? null;
  const lastSampleAt = samples.length > 0 ? samples[samples.length - 1].t : null;

  const totalTokens = tokenLog.length > 0 ? tokenLog[tokenLog.length - 1].count : null;
  const interTokenMs =
    tokenLog.length >= 2
      ? (tokenLog[tokenLog.length - 1].t - tokenLog[0].t) /
        (tokenLog[tokenLog.length - 1].count - 1)
      : null;

  return {
    prefillMs: warmingUpAt !== null && processingAt !== null ? processingAt - warmingUpAt : null,
    decodeMs: processingAt !== null && lastSampleAt !== null ? lastSampleAt - processingAt : null,
    totalTokens,
    interTokenMs,
    transcript,
  };
}

function fmt(n, digits = 0) {
  return n === null || n === undefined ? "—" : n.toFixed(digits);
}

async function runVariedClips() {
  const results = [];
  for (const clip of CLIPS) {
    console.error(`\n=== ${clip.id} (${clip.audioSec.toFixed(2)}s) ===`);
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      args: [
        "--no-sandbox",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-audio-capture=${path.join(REPO_ROOT, clip.path)}`,
      ],
    });
    try {
      const page = await context.newPage();
      await page.addInitScript(INIT_SCRIPT);
      await page.goto(BASE_URL, { waitUntil: "load" });
      await ensureModelReady(page);
      // No explicit pipeline warm-up step: recordOnce()'s Start click triggers
      // it naturally (asr-status.svelte.ts's start() calls the worker's
      // warm()), and every clip here runs longer than the ~2.4-2.6s pipeline
      // load takes, so it's already resolved by the time Stop is clicked —
      // confirmed by runRepeated() below showing no elevated prefill on run 1
      // even without any warm-up step at all.
      const r = await recordOnce(page, clip.audioSec);
      console.error(
        `prefill=${fmt(r.prefillMs)}ms decode=${fmt(r.decodeMs)}ms tokens=${r.totalTokens} interToken=${fmt(r.interTokenMs, 1)}ms "${r.transcript}"`,
      );
      results.push({ clip: clip.id, audioSec: clip.audioSec, ...r });
    } finally {
      await context.close();
    }
  }
  console.error("\n=== SUMMARY: one fresh page load per clip ===");
  console.table(results.map(({ transcript: _t, ...rest }) => rest));
}

async function runRepeated(count) {
  const clip = CLIPS[0];
  console.error(`\n=== repeating ${clip.id} x${count} in one page session ===`);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: [
      "--no-sandbox",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${path.join(REPO_ROOT, clip.path)}`,
    ],
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(INIT_SCRIPT);
    await page.goto(BASE_URL, { waitUntil: "load" });
    await ensureModelReady(page);

    const results = [];
    for (let i = 0; i < count; i++) {
      const r = await recordOnce(page, clip.audioSec);
      console.error(
        `run ${i + 1}: prefill=${fmt(r.prefillMs)}ms decode=${fmt(r.decodeMs)}ms tokens=${r.totalTokens}`,
      );
      results.push({ run: i + 1, ...r });
      await sleep(400);
    }
    console.error(
      "\n=== SUMMARY: same session, no relaunch (tests whether prefill drops after run 1) ===",
    );
    console.table(results.map(({ transcript: _t, ...rest }) => rest));
  } finally {
    await context.close();
  }
}

async function main() {
  if (REPEAT_COUNT > 0) {
    await runRepeated(REPEAT_COUNT);
  } else {
    await runVariedClips();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
