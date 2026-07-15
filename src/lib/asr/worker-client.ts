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
  transcribe(pcm: Float32Array, onToken: (tokensSoFar: number) => void): Promise<string>;
  /** Fire-and-forget: asks the worker to start loading the pipeline now. Safe to call repeatedly — the worker's own loadPipeline() memoizes it. */
  warm(): void;
  terminate(): void;
}

class WorkerTranscribeClient implements TranscribeWorkerClient {
  #worker: Worker;
  #pending: { resolve: (text: string) => void; reject: (error: Error) => void } | null = null;
  #onToken: ((tokensSoFar: number) => void) | null = null;

  constructor() {
    this.#worker = new Worker(new URL("./asr.worker.ts", import.meta.url), { type: "module" });
    // DEBUG (#9 threading experiment, revertable): forward a thread-count
    // override chosen in ThreadDebugPanel.svelte to the worker before any
    // warm/transcribe, so the ORT session is built with it. Ordered before
    // warm()'s message, so it always wins.
    this.#sendDebugThreadConfig();
    this.#worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "token") {
        this.#onToken?.(message.count);
      } else if (message.type === "done") {
        this.#resolve(message.text);
      } else {
        this.#reject(new Error(message.message));
      }
    };
    this.#worker.onerror = (event: ErrorEvent) => {
      this.#reject(new Error(event.message || "ASR worker crashed"));
    };
  }

  /** Settles the in-flight promise and clears both it and `#onToken`, so a late/stray worker message after settling can't invoke a stale callback. */
  #resolve(text: string): void {
    this.#pending?.resolve(text);
    this.#pending = null;
    this.#onToken = null;
  }

  #reject(error: Error): void {
    this.#pending?.reject(error);
    this.#pending = null;
    this.#onToken = null;
  }

  transcribe(pcm: Float32Array, onToken: (tokensSoFar: number) => void): Promise<string> {
    if (this.#pending) {
      return Promise.reject(
        new Error(
          "TranscribeWorkerClient.transcribe() called while a previous call is still pending",
        ),
      );
    }
    this.#onToken = onToken;
    return new Promise((resolve, reject) => {
      this.#pending = { resolve, reject };
      const request: WorkerRequest = { type: "transcribe", pcm };
      this.#worker.postMessage(request, [pcm.buffer]);
    });
  }

  /**
   * DEBUG (#9): reads `aidedxDebugThreads` from localStorage and posts it as a
   * config message. Gated behind `?debug` so a stale selection can never affect
   * a normal visitor — without `?debug` the worker gets no override and the
   * shipped `threadCountForCores` policy applies.
   */
  #sendDebugThreadConfig(): void {
    try {
      const hasDebugFlag = new URLSearchParams(globalThis.location?.search ?? "").has("debug");
      if (!hasDebugFlag) return;
      const raw = globalThis.localStorage?.getItem("aidedxDebugThreads");
      if (raw == null || raw === "" || raw === "off") return;
      const numThreads = Number(raw);
      if (!Number.isFinite(numThreads) || numThreads <= 0) return;
      const request: WorkerRequest = { type: "config", numThreads };
      this.#worker.postMessage(request);
    } catch {
      /* localStorage/location may be unavailable (SSR/hardened browsers) — debug-only, ignore */
    }
  }

  warm(): void {
    const request: WorkerRequest = { type: "warm" };
    this.#worker.postMessage(request);
  }

  terminate(): void {
    this.#reject(new Error("ASR worker terminated"));
    this.#worker.terminate();
  }
}

export function createTranscribeWorkerClient(): TranscribeWorkerClient {
  return new WorkerTranscribeClient();
}
