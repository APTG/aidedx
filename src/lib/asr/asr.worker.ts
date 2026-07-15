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
 *      | { type: "warm" }
 *   out: { type: "token", count: number } (zero or more)
 *      | { type: "done", text: string }
 *      | { type: "error", message: string }
 *
 * `"warm"` loads the pipeline (Cache Storage read + ONNX Runtime Web session
 * creation) ahead of the first real `"transcribe"` request, so that cost
 * overlaps with the user recording instead of stacking onto the "Warming
 * up…" state after they stop — see `transcribe.ts`'s `warmup()`. It has no
 * response; a failed prewarm surfaces instead through the next real
 * `"transcribe"` request, which retries the load itself.
 */
import { transcribe, warmup } from "./transcribe.ts";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol.ts";

function post(message: WorkerResponse): void {
  self.postMessage(message);
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === "warm") {
    // Errors are swallowed here on purpose — loadPipeline() resets its
    // memoized promise on failure, so the next "transcribe" request just
    // retries and reports the error through its normal path.
    warmup().catch(() => undefined);
    return;
  }
  transcribe(message.pcm, { onToken: (count) => post({ type: "token", count }) })
    .then((text) => post({ type: "done", text }))
    .catch((error: unknown) => {
      post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    });
};
