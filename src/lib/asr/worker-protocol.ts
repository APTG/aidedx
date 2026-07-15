/** Message shapes shared by `asr.worker.ts` and `worker-client.ts` — kept in a separate module so neither side needs to import the other's implementation. */

export type WorkerRequest =
  | { type: "transcribe"; pcm: Float32Array }
  /** Fire-and-forget: triggers pipeline loading without transcribing anything. No response is sent. */
  | { type: "warm" }
  /** Like "warm", but replies with timing so callers can measure/display load time (debug use). */
  | { type: "warmMeasured" };

export type WorkerResponse =
  | { type: "token"; count: number }
  | { type: "done"; text: string }
  | { type: "error"; message: string }
  | { type: "warmed"; durationMs: number }
  | { type: "warmError"; message: string };
