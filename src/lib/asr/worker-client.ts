/**
 * Main-thread handle to `asr.worker.ts` (issue #44 Phase B). Isolated into
 * its own module so `asr-status.svelte.ts` can depend on a small interface
 * instead of the raw `Worker` global — that's the seam `asr-status.test.ts`
 * mocks, the same way it previously mocked `transcribe.ts` directly before
 * inference moved into a worker.
 */
import type { WorkerRequest, WorkerResponse } from "./worker-protocol.ts";

export interface TranscribeWorkerClient {
  /** Transfers `pcm`'s buffer to the worker; `pcm` must not be used after calling this. */
  transcribe(pcm: Float32Array, onPartial: (textSoFar: string) => void): Promise<string>;
  terminate(): void;
}

class WorkerTranscribeClient implements TranscribeWorkerClient {
  #worker: Worker;
  #pending: { resolve: (text: string) => void; reject: (error: Error) => void } | null = null;
  #onPartial: ((textSoFar: string) => void) | null = null;

  constructor() {
    this.#worker = new Worker(new URL("./asr.worker.ts", import.meta.url), { type: "module" });
    this.#worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "partial") {
        this.#onPartial?.(message.text);
      } else if (message.type === "done") {
        this.#pending?.resolve(message.text);
        this.#pending = null;
      } else {
        this.#pending?.reject(new Error(message.message));
        this.#pending = null;
      }
    };
    this.#worker.onerror = (event: ErrorEvent) => {
      this.#pending?.reject(new Error(event.message || "ASR worker crashed"));
      this.#pending = null;
    };
  }

  transcribe(pcm: Float32Array, onPartial: (textSoFar: string) => void): Promise<string> {
    this.#onPartial = onPartial;
    return new Promise((resolve, reject) => {
      this.#pending = { resolve, reject };
      const request: WorkerRequest = { type: "transcribe", pcm };
      this.#worker.postMessage(request, [pcm.buffer]);
    });
  }

  terminate(): void {
    this.#worker.terminate();
  }
}

export function createTranscribeWorkerClient(): TranscribeWorkerClient {
  return new WorkerTranscribeClient();
}
