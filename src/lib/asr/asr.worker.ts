/**
 * Runs Whisper inference off the main thread (issue #44 Phase B). A dedicated
 * Worker guarantees `postMessage`-driven UI updates are a real task-queue
 * hop, so partial-transcript rendering can't be at the mercy of ONNX Runtime
 * Web's internal WASM scheduling — see `docs/whisper-progress-feedback.md`
 * §4. It also keeps the main thread free for the Stop button and Svelte
 * reactivity during the multi-second CPU decode this app's slow-hardware
 * tier expects.
 *
 * Message contract (see `worker-client.ts`, the only other file that should
 * import this contract):
 *   in:  { type: "transcribe", pcm: Float32Array }
 *   out: { type: "partial", text: string } (zero or more)
 *      | { type: "done", text: string }
 *      | { type: "error", message: string }
 */
import { transcribe } from "./transcribe.ts";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol.ts";

function post(message: WorkerResponse): void {
  self.postMessage(message);
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { pcm } = event.data;
  transcribe(pcm, { onPartial: (text) => post({ type: "partial", text }) })
    .then((text) => post({ type: "done", text }))
    .catch((error: unknown) => {
      post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    });
};
