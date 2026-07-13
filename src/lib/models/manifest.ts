/**
 * The model set downloaded by the consent flow in issue #32: one ASR model
 * plus the two LLM-NLU-fallback models, single dtype each, matching the
 * repo IDs already validated by `scripts/prefetch-whisper-models.mjs` and
 * `scripts/prefetch-llm-models.mjs` (see `docs/local-model-cache.md`).
 *
 * This is a much smaller subset than those research prefetch scripts pull
 * (which grab every dtype/variant for benchmarking, ~9 GB) — this manifest
 * is the "just enough to answer a question" set the product flow needs,
 * ~1.1 GB total.
 */

export type ModelKind = "speech-to-text" | "causal-lm";

export interface ModelManifestEntry {
  id: string;
  label: string;
  sizeMB: number;
  repo: string;
  dtype: "q4" | "q8";
  kind: ModelKind;
}

export const MODEL_MANIFEST: ModelManifestEntry[] = [
  {
    id: "whisper",
    label: "Whisper · speech-to-text",
    sizeMB: 92,
    repo: "onnx-community/whisper-tiny",
    dtype: "q8",
    kind: "speech-to-text",
  },
  {
    id: "qwen",
    label: "Qwen2.5-0.5B · language understanding",
    sizeMB: 380,
    repo: "onnx-community/Qwen2.5-0.5B-Instruct",
    dtype: "q8",
    kind: "causal-lm",
  },
  {
    id: "llama",
    label: "Llama-3.2-1B · answer generation",
    sizeMB: 660,
    repo: "onnx-community/Llama-3.2-1B-Instruct",
    dtype: "q8",
    kind: "causal-lm",
  },
];

export const TOTAL_DOWNLOAD_SIZE_MB = MODEL_MANIFEST.reduce((sum, entry) => sum + entry.sizeMB, 0);
