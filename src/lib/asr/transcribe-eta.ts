/**
 * Self-calibrating estimate of how long transcription will take, so the UI
 * can show a real progress bar instead of a bare elapsed-seconds counter.
 *
 * Whisper doesn't expose a smooth "seconds of audio processed" signal for
 * this app's typical short queries — `docs/whisper-progress-feedback.md`'s
 * Outcome section measured `on_chunk_start`/`on_chunk_end` firing once at
 * the start and once right before the final word, not a sweep, which is why
 * issue #44 didn't wire timestamps into a progress fraction. Instead, this
 * estimates total transcription time as `recordingDurationSeconds *
 * realTimeFactor` and recalibrates `realTimeFactor` from what actually
 * happened on this device after every transcription — the same idea as
 * `format.ts`'s `formatEta` for model downloads, just seeded from a device
 * -speed ratio instead of a byte rate. Persisted in `localStorage` the same
 * way `dark-mode.ts` persists its preference, so the estimate starts out
 * already-calibrated on repeat visits instead of resetting every reload.
 */

const STORAGE_KEY = "aidedx:asr-real-time-factor";

/**
 * Conservative default: transcription may take up to ~2x the recording's
 * length before any real measurement exists, covering first-run WASM
 * compile overhead on a cold session. Recalibrates downward quickly (see
 * `recordRealTimeFactorSample`) once real data is available, typically
 * after the very first transcription.
 */
const DEFAULT_REAL_TIME_FACTOR = 2;

/** Clamp bounds for both the default and calibrated values, so one outlier sample (e.g. a backgrounded tab) can't send the estimate to somewhere useless. */
const MIN_REAL_TIME_FACTOR = 0.1;
const MAX_REAL_TIME_FACTOR = 8;

function clamp(value: number): number {
  return Math.min(MAX_REAL_TIME_FACTOR, Math.max(MIN_REAL_TIME_FACTOR, value));
}

/** Returns the current calibrated (or default) real-time factor: seconds of processing per second of audio. */
export function getRealTimeFactor(): number {
  if (typeof localStorage === "undefined") return DEFAULT_REAL_TIME_FACTOR;
  const raw = localStorage.getItem(STORAGE_KEY);
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) ? clamp(parsed) : DEFAULT_REAL_TIME_FACTOR;
}

/**
 * Updates the stored factor with a 50/50 exponential moving average against
 * the latest observation — a couple of transcriptions converge close to this
 * device's real speed without a single slow/fast outlier skewing it badly.
 */
export function recordRealTimeFactorSample(processingSeconds: number, audioSeconds: number): void {
  if (typeof localStorage === "undefined") return;
  if (
    audioSeconds <= 0 ||
    !Number.isFinite(processingSeconds) ||
    !Number.isFinite(audioSeconds) ||
    processingSeconds < 0
  ) {
    return;
  }
  const observed = clamp(processingSeconds / audioSeconds);
  const previous = getRealTimeFactor();
  localStorage.setItem(STORAGE_KEY, String(previous * 0.5 + observed * 0.5));
}

/** Estimated total transcription time in ms for a recording of the given length. */
export function estimateTranscribeMs(recordingDurationSeconds: number): number {
  return recordingDurationSeconds * 1000 * getRealTimeFactor();
}
