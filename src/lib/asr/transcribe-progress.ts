/**
 * Self-calibrating prefill/decode progress model for the transcribing phase
 * (issue #46, replacing the word-by-word preview issue #44 shipped —
 * `docs/whisper-progress-feedback.md`'s "Outcome (issue #46 implementation)"
 * section has the full rationale).
 *
 * Real per-query wall-clock time splits into two phases with very different
 * shapes:
 *   - **prefill**: a near-constant span from decode start to the first
 *     answer token (encoder pass over a fixed 30s-equivalent mel segment,
 *     plus the ~40-token domain prompt) — doesn't track audio length.
 *   - **decode**: token-proportional, stable ms/token across clips.
 * There is no token signal at all during prefill (`tokensSoFar` is
 * necessarily 0), so `estimateProgress()` blends two sub-models into one
 * monotonically-increasing 0..1 fraction: elapsed-time-vs-calibrated-prefill
 * while waiting for the first token, then tokens-vs-calibrated-total-tokens
 * once decoding starts. Both calibrations self-adjust via an EMA persisted
 * to `localStorage`, the same idea `format.ts`'s `formatEta` uses for
 * model-download ETAs — seeded from real measurements rather than starting
 * from zero, so the very first transcription already gets a reasonable
 * estimate.
 *
 * **The seed below is from a real-browser Playwright benchmark
 * (`scripts/asr-browser-benchmark.mjs`), not the Node numbers this module
 * originally shipped with.** `docs/whisper-progress-feedback.md`'s original
 * "Follow-up" section measured prefill at ~1.3-1.8s and decode at
 * ~38-47ms/token — but that was `scripts/asr-transcribe.mjs` running in
 * Node, backed by `onnxruntime-node` (native, multi-threaded). The browser
 * ships `onnxruntime-web` (WASM) and this app has no COOP/COEP headers (see
 * `app.html`), so there's no `SharedArrayBuffer` and WASM runs
 * single-threaded — a real-browser measurement (8 clips: 5 varied + 3
 * same-session repeats, `docs/whisper-progress-feedback.md`'s "Real-browser
 * verification" section has the full table) found prefill at a stable
 * ~7.6-8.5s (mean ~7.9s) and decode at ~62-68ms/token (mean ~65ms) — prefill
 * ~5x slower, decode ~1.5x slower, and neither improves across repeated
 * recordings in the same session (only the one-time pipeline load, kicked
 * off by `asr-status.svelte.ts`'s `start()`, is memoized; each utterance's
 * encoder pass is paid in full, every time). The EMA would have eventually
 * corrected a wrong seed on its own, but only after ~8-10 real
 * transcriptions (each sample moves the estimate 30% closer); reseeding here
 * means the progress bar is accurate from a user's very first recording
 * instead of visibly stuck near the top of an undersized prefill band for
 * several uses first.
 */

export type DecodeStage = "prefill" | "decode";

export interface ProgressEstimate {
  stage: DecodeStage;
  /** 0..1, monotonically non-decreasing within a single transcription — see estimateProgress()'s doc comment for why the prefill->decode handoff can't regress. */
  fraction: number;
}

export interface ProgressCalibration {
  prefillMsEma: number;
  perTokenMsEma: number;
  totalTokensEma: number;
}

const STORAGE_KEY = "aidedx:asr-progress-calibration-v1";

/** Seeded from a real-browser measurement (see module comment above), not zero and not the Node-side numbers this used to ship with. */
const DEFAULT_CALIBRATION: ProgressCalibration = {
  prefillMsEma: 7900,
  perTokenMsEma: 65,
  totalTokensEma: 15,
};

/** Weight given to each new real sample; same constant shape as a standard EMA, tuned to adapt within a handful of queries without being noisy on any single outlier. */
const EMA_ALPHA = 0.3;

function ema(previous: number, sample: number): number {
  return previous + EMA_ALPHA * (sample - previous);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Rejects not just malformed shapes but degenerate values a corrupted or
 * hand-edited localStorage entry could hold — e.g. `totalTokensEma: 0` would
 * otherwise survive validation and then make `estimateProgress()` jump to
 * ~99% on the very first token (Copilot review), defeating the clamping
 * `estimateProgress()` relies on to keep the bar honest. `totalTokensEma`
 * needs at least 2 for `recordCompletedTranscription()`'s own per-token-ms
 * math to be meaningful (it divides by `totalTokens - 1`), so anything below
 * that isn't a value this module would ever have written itself.
 */
function isValidCalibration(value: unknown): value is ProgressCalibration {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    isFiniteNumber(candidate.prefillMsEma) &&
    candidate.prefillMsEma > 0 &&
    isFiniteNumber(candidate.perTokenMsEma) &&
    candidate.perTokenMsEma > 0 &&
    isFiniteNumber(candidate.totalTokensEma) &&
    candidate.totalTokensEma >= 2
  );
}

/** Reads the persisted calibration, falling back to the seeded defaults if unset, corrupt, or localStorage is unavailable (SSR, private-mode quota, etc). */
export function loadCalibration(): ProgressCalibration {
  if (typeof localStorage === "undefined") return DEFAULT_CALIBRATION;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CALIBRATION;
    const parsed = JSON.parse(raw);
    return isValidCalibration(parsed) ? parsed : DEFAULT_CALIBRATION;
  } catch {
    return DEFAULT_CALIBRATION;
  }
}

function saveCalibration(calibration: ProgressCalibration): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(calibration));
  } catch {
    /* private-mode/quota localStorage failures just mean calibration doesn't persist this time */
  }
}

export interface TranscriptionTiming {
  /** Date.now() when the transcribing phase began (recording stopped). */
  transcribingStartedAt: number;
  /** Date.now() when the first decoder token arrived. */
  firstTokenAt: number;
  /** Date.now() when the last decoder token arrived (equal to firstTokenAt when totalTokens === 1). */
  lastTokenAt: number;
  totalTokens: number;
}

/**
 * Folds one completed transcription's real timings into the persisted EMA.
 * Call once, after a transcription finishes successfully. Requires at least
 * 2 tokens to derive a per-token interval — shorter answers are real but too
 * sparse a sample to safely calibrate from, so they're skipped rather than
 * risking a single outlier swinging the EMA.
 */
export function recordCompletedTranscription(timing: TranscriptionTiming): void {
  if (timing.totalTokens < 2) return;
  const prefillMs = timing.firstTokenAt - timing.transcribingStartedAt;
  const perTokenMs = (timing.lastTokenAt - timing.firstTokenAt) / (timing.totalTokens - 1);
  if (prefillMs <= 0 || perTokenMs <= 0) return;

  const previous = loadCalibration();
  saveCalibration({
    prefillMsEma: ema(previous.prefillMsEma, prefillMs),
    perTokenMsEma: ema(previous.perTokenMsEma, perTokenMs),
    totalTokensEma: ema(previous.totalTokensEma, timing.totalTokens),
  });
}

const MIN_PREFILL_BAND = 0.05;
const MAX_PREFILL_BAND = 0.9;

/**
 * Share of the bar's 0..1 travel budgeted to the prefill stage, proportional
 * to each stage's self-calibrated expected duration (not a fixed guess) —
 * so a device/session where decoding is unusually slow relative to prefill
 * (or vice versa) gets a split that reflects its own real timing, not a
 * one-size-fits-all constant. Clamped defensively in case calibration data
 * is ever degenerate (e.g. right after corrupted localStorage resets to
 * defaults mid-transcription).
 */
function prefillBandFor(calibration: ProgressCalibration): number {
  const expectedDecodeMs =
    Math.max(calibration.totalTokensEma, 1) * Math.max(calibration.perTokenMsEma, 1);
  const expectedTotalMs = Math.max(calibration.prefillMsEma, 1) + expectedDecodeMs;
  const band = calibration.prefillMsEma / expectedTotalMs;
  return Math.min(MAX_PREFILL_BAND, Math.max(MIN_PREFILL_BAND, band));
}

/**
 * Maps elapsed time + tokens-generated-so-far to a single 0..1 fraction.
 * Prefill fills `[0, prefillBand)` from elapsed-vs-calibrated-prefill-time
 * (there's no token signal yet, so time is the only proxy); decode fills
 * `[prefillBand, 1)` from tokensSoFar/calibrated-total-tokens. The handoff
 * always steps forward, never back: prefill is capped at 95% of its own
 * band (`0.95 * prefillBand`), strictly below `prefillBand` itself, while
 * decode's floor at tokensSoFar=1 is `prefillBand` plus a strictly positive
 * term — so the first real token always advances the bar past wherever
 * prefill left it, regardless of calibration values.
 */
export function estimateProgress(
  params: { tokensSoFar: number; elapsedMs: number },
  calibration: ProgressCalibration = loadCalibration(),
): ProgressEstimate {
  const prefillBand = prefillBandFor(calibration);

  if (params.tokensSoFar <= 0) {
    const prefillProgress = Math.min(
      0.95,
      Math.max(0, params.elapsedMs) / Math.max(calibration.prefillMsEma, 1),
    );
    return { stage: "prefill", fraction: prefillProgress * prefillBand };
  }

  const decodeProgress = Math.min(
    0.98,
    params.tokensSoFar / Math.max(calibration.totalTokensEma, 1),
  );
  return { stage: "decode", fraction: prefillBand + decodeProgress * (1 - prefillBand) };
}
