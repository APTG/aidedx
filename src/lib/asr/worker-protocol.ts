/** Message shapes shared by `asr.worker.ts` and `worker-client.ts` — kept in a separate module so neither side needs to import the other's implementation. */

export type WorkerRequest =
  | { type: "transcribe"; pcm: Float32Array }
  /** Fire-and-forget: triggers pipeline loading without transcribing anything. No response is sent. */
  | { type: "warm" }
  /**
   * DEBUG (#9 threading experiment): sets the ORT WASM thread count applied
   * when the pipeline next loads. Must arrive before the first warm/transcribe
   * to take effect (the pipeline is memoized once created). No response.
   */
  | { type: "config"; numThreads: number | null };

export type WorkerResponse =
  | { type: "token"; count: number }
  | { type: "done"; text: string }
  | { type: "error"; message: string };
