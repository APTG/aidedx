/**
 * The model set downloaded by the consent flow in issue #32: one ASR model
 * plus the two LLM-NLU-fallback models, single dtype each, matching the
 * repo IDs already validated by `scripts/prefetch-whisper-models.mjs` and
 * `scripts/prefetch-llm-models.mjs` (see `docs/local-model-cache.md`).
 *
 * This is a much smaller subset than those research prefetch scripts pull
 * (which grab every dtype/variant for benchmarking, ~9 GB) — this manifest
 * is the "just enough to answer a question" set the product flow needs.
 *
 * Only `whisper` is mirrored to the Cyfronet S3 bucket so far (issue #34,
 * see `docs/model-hosting-cyfronet.md`) — `qwen` and `llama` are listed for
 * the eventual full offline flow but marked `available: false` until they're
 * mirrored too. `AVAILABLE_MODEL_MANIFEST` / `TOTAL_DOWNLOAD_SIZE_MB` and the
 * download/status flows only ever act on `available` entries; unavailable
 * ones are inert (no fetch attempted, no progress bar shown).
 */

export type ModelKind = "speech-to-text" | "causal-lm";

export interface ModelManifestEntry {
  id: string;
  label: string;
  sizeMB: number;
  repo: string;
  dtype: "q4" | "q8";
  kind: ModelKind;
  /** Whether the weights are reachable yet (mirrored to the S3 bucket in `remote.ts`). */
  available: boolean;
}

export const MODEL_MANIFEST: ModelManifestEntry[] = [
  {
    id: "whisper",
    label: "Whisper · speech-to-text",
    sizeMB: 240,
    repo: "onnx-community/whisper-small",
    dtype: "q8",
    kind: "speech-to-text",
    available: true,
  },
  {
    id: "qwen",
    label: "Qwen2.5-0.5B · language understanding",
    sizeMB: 380,
    repo: "onnx-community/Qwen2.5-0.5B-Instruct",
    dtype: "q8",
    kind: "causal-lm",
    available: false,
  },
  {
    id: "llama",
    label: "Llama-3.2-1B · answer generation",
    sizeMB: 660,
    repo: "onnx-community/Llama-3.2-1B-Instruct",
    dtype: "q8",
    kind: "causal-lm",
    available: false,
  },
];

/** The subset of `MODEL_MANIFEST` actually fetched by the download flow right now. */
export const AVAILABLE_MODEL_MANIFEST = MODEL_MANIFEST.filter((entry) => entry.available);

export const TOTAL_DOWNLOAD_SIZE_MB = AVAILABLE_MODEL_MANIFEST.reduce(
  (sum, entry) => sum + entry.sizeMB,
  0,
);
