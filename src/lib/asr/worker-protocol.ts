/** Message shapes shared by `asr.worker.ts` and `worker-client.ts` — kept in a separate module so neither side needs to import the other's implementation. */

export interface WorkerRequest {
  type: "transcribe";
  pcm: Float32Array;
}

export type WorkerResponse =
  | { type: "partial"; text: string }
  | { type: "done"; text: string }
  | { type: "error"; message: string };
