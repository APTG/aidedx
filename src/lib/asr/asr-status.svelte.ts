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
 * `AudioContext`, which only exists on the main thread. `partialTranscript`
 * mirrors the worker's live word-by-word callbacks (issue #44 Phase A) so
 * the UI can show real progress on a multi-second CPU transcription instead
 * of a bare spinner. `estimatedTranscribeMs` (backed by `transcribe-eta.ts`)
 * turns that elapsed time into a 0-100% progress bar instead of a raw
 * seconds counter — see `transcribe-eta.ts`'s module comment for why this
 * estimates from recording length rather than a literal Whisper progress
 * signal.
 */
import { MicRecorder } from "./recorder.ts";
import { decodeToMono16k, WHISPER_SAMPLE_RATE } from "./pcm.ts";
import { createTranscribeWorkerClient, type TranscribeWorkerClient } from "./worker-client.ts";
import { estimateTranscribeMs, recordRealTimeFactorSample } from "./transcribe-eta.ts";

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
  /** Live running transcript as the worker decodes words (issue #44); cleared on start()/reset(). */
  partialTranscript = $state("");
  errorMessage: string | null = $state(null);
  recordingStartedAt: number | null = $state(null);
  transcribingStartedAt: number | null = $state(null);
  /** Length of the recorded audio, once decoded — the basis for `estimatedTranscribeMs`. */
  recordingDurationSeconds: number | null = $state(null);

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

  /** Estimated total transcription time in ms, or `null` until the recording's length is known (see `transcribe-eta.ts`). */
  get estimatedTranscribeMs(): number | null {
    return this.recordingDurationSeconds === null
      ? null
      : estimateTranscribeMs(this.recordingDurationSeconds);
  }

  async start(): Promise<void> {
    if (this.isBusy) return;
    this.errorMessage = null;
    this.transcript = "";
    this.partialTranscript = "";
    this.recordingDurationSeconds = null;
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
    this.transcribingStartedAt = Date.now();
    try {
      const blob = await this.#recorder.stop();
      const pcm = await decodeToMono16k(await blob.arrayBuffer());
      this.recordingDurationSeconds = pcm.length / WHISPER_SAMPLE_RATE;
      const inferenceStartedAt = Date.now();
      this.transcript = await this.#getWorkerClient().transcribe(pcm, (textSoFar) => {
        this.partialTranscript = textSoFar;
      });
      // Calibrate off inference time alone (excludes the decode step above),
      // so the real-time factor reflects Whisper's actual speed on this
      // device, not incidental Web Audio decoding overhead.
      recordRealTimeFactorSample(
        (Date.now() - inferenceStartedAt) / 1000,
        this.recordingDurationSeconds,
      );
      this.phase = "done";
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
    this.partialTranscript = "";
    this.errorMessage = null;
    this.recordingStartedAt = null;
    this.transcribingStartedAt = null;
    this.recordingDurationSeconds = null;
  }
}

export const asrStatus = new AsrStore();
