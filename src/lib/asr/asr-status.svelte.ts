/**
 * Reactive state machine for the mic-to-text flow (issue #37): idle ->
 * recording -> transcribing -> done, with an error state reachable from
 * either recording (mic permission/hardware failure) or transcribing
 * (decode/inference failure). A single instance is used by whichever UI
 * component renders the mic button, mirroring `model-status.svelte.ts`'s
 * single-shared-store pattern.
 */
import { MicRecorder } from "./recorder.ts";
import { decodeToMono16k } from "./pcm.ts";
import { transcribe } from "./transcribe.ts";

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
  errorMessage: string | null = $state(null);
  recordingStartedAt: number | null = $state(null);
  transcribingStartedAt: number | null = $state(null);

  #recorder = new MicRecorder();

  get isBusy(): boolean {
    return this.phase === "recording" || this.phase === "transcribing";
  }

  async start(): Promise<void> {
    if (this.isBusy) return;
    this.errorMessage = null;
    this.transcript = "";
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
      this.transcript = await transcribe(pcm);
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
    this.errorMessage = null;
    this.recordingStartedAt = null;
    this.transcribingStartedAt = null;
  }
}

export const asrStatus = new AsrStore();
