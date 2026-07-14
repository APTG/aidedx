/**
 * Reactive state machine for the mic-to-text flow (issue #37): idle ->
 * recording -> transcribing -> done, with an error state reachable from
 * either recording (mic permission/hardware failure) or transcribing
 * (decode/inference failure). A single instance is used by whichever UI
 * component renders the mic button, mirroring `model-status.svelte.ts`'s
 * single-shared-store pattern.
 *
 * Inference runs in a Web Worker (issue #44 Phase B) via `worker-client.ts`,
 * not inline — `decodeToMono16k` still runs here since it needs
 * `AudioContext`, which only exists on the main thread. `tokensSoFar` mirrors
 * the worker's per-token callbacks (issue #46 — supersedes issue #44's
 * word-by-word `partialTranscript` preview) so the UI can show real
 * prefill/decode progress on a multi-second CPU transcription instead of a
 * bare spinner; see `transcribe-progress.ts` for how a token count becomes a
 * progress fraction. This store only tracks the raw signal (token count +
 * timestamps for calibration) — turning it into a displayable fraction needs
 * a live clock during prefill (no tokens yet), which `+page.svelte` already
 * owns for `elapsedLabel`, so that derivation stays there rather than
 * duplicating a ticking timer here.
 */
import { MicRecorder } from "./recorder.ts";
import { decodeToMono16k } from "./pcm.ts";
import { createTranscribeWorkerClient, type TranscribeWorkerClient } from "./worker-client.ts";
import { recordCompletedTranscription } from "./transcribe-progress.ts";

export type AsrPhase = "idle" | "recording" | "transcribing" | "done" | "error";

function describeError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "Microphone access was denied. Allow microphone access in your browser and try again.";
    }
    if (error.name === "NotFoundError") {
      return "No microphone was found on this device.";
    }
  }
  return error instanceof Error ? error.message : String(error);
}

class AsrStore {
  phase: AsrPhase = $state("idle");
  transcript = $state("");
  /** Decoder tokens generated so far while transcribing (issue #46); cleared on start()/reset(). */
  tokensSoFar = $state(0);
  errorMessage: string | null = $state(null);
  recordingStartedAt: number | null = $state(null);
  transcribingStartedAt: number | null = $state(null);

  #recorder = new MicRecorder();
  #workerClient: TranscribeWorkerClient | null = null;

  /**
   * Created lazily, not as a field initializer — `new Worker(...)` must
   * never run during SSR/prerendering, and this store is instantiated as a
   * module-level singleton that DOES get imported by prerendered pages.
   * Lazy creation here mirrors why `#recorder` (a plain class, side-effect
   * -free to construct) can safely be a field initializer while this can't.
   */
  #getWorkerClient(): TranscribeWorkerClient {
    this.#workerClient ??= createTranscribeWorkerClient();
    return this.#workerClient;
  }

  get isBusy(): boolean {
    return this.phase === "recording" || this.phase === "transcribing";
  }

  async start(): Promise<void> {
    if (this.isBusy) return;
    this.errorMessage = null;
    this.transcript = "";
    this.tokensSoFar = 0;
    // Kick off pipeline loading (Cache Storage read + ONNX Runtime Web
    // session creation) now, in parallel with the recording the user is
    // about to make, instead of waiting for stop() to request it. That cost
    // is the dominant, uncalibrated part of the first "Warming up…" state
    // (see transcribe-progress.ts's module comment); overlapping it with
    // mic recording time hides most or all of it instead of stacking it
    // after the user finishes speaking. Safe to call on every start() — the
    // worker's own loadPipeline() memoizes the load after the first time.
    this.#getWorkerClient().warm();
    try {
      await this.#recorder.start();
      this.phase = "recording";
      this.recordingStartedAt = Date.now();
    } catch (error) {
      this.errorMessage = describeError(error);
      this.phase = "error";
    }
  }

  async stop(): Promise<void> {
    if (this.phase !== "recording") return;
    this.recordingStartedAt = null;
    this.phase = "transcribing";
    const transcribingStartedAt = Date.now();
    this.transcribingStartedAt = transcribingStartedAt;
    this.tokensSoFar = 0;
    // Local (non-reactive) bookkeeping for calibration only — the UI reads
    // tokensSoFar + its own live clock, not these raw timestamps directly.
    let firstTokenAt: number | null = null;
    let lastTokenAt: number | null = null;
    try {
      const blob = await this.#recorder.stop();
      const pcm = await decodeToMono16k(await blob.arrayBuffer());
      this.transcript = await this.#getWorkerClient().transcribe(pcm, (tokensSoFar) => {
        const now = Date.now();
        firstTokenAt ??= now;
        lastTokenAt = now;
        this.tokensSoFar = tokensSoFar;
      });
      this.phase = "done";
      if (firstTokenAt !== null && lastTokenAt !== null) {
        recordCompletedTranscription({
          transcribingStartedAt,
          firstTokenAt,
          lastTokenAt,
          totalTokens: this.tokensSoFar,
        });
      }
    } catch (error) {
      this.errorMessage = describeError(error);
      this.phase = "error";
    } finally {
      this.transcribingStartedAt = null;
    }
  }

  /** Returns to idle — used after showing a "done" transcript or an error, so the mic button resets for another attempt. */
  reset(): void {
    this.phase = "idle";
    this.transcript = "";
    this.tokensSoFar = 0;
    this.errorMessage = null;
    this.recordingStartedAt = null;
    this.transcribingStartedAt = null;
  }
}

export const asrStatus = new AsrStore();
