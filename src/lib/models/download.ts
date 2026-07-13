/**
 * Framework-free model-weight downloader for the consent flow in issue #32.
 *
 * Deliberately has no SvelteKit dependency (same split as `src/lib/wasm/`)
 * and dynamic-imports `@huggingface/transformers` itself, so the ~1.1 GB
 * download path never enters the landing page's initial bundle.
 *
 * Progress comes from transformers.js's own `progress_callback` — see
 * `ProgressInfo` in `@huggingface/transformers/src/utils/core.js` — rather
 * than a hand-rolled `fetch` reader, since that's what's already loading
 * the files.
 *
 * Known limitation (issue #32 open question 2): transformers.js does not
 * expose a way to abort a load already in flight for a given file. Cancel
 * here stops emitting progress and lets the caller move on; any in-flight
 * fetch for the *current* file finishes in the background and lands in the
 * cache anyway (harmless — just an early write to the model cache).
 */
import { MODEL_MANIFEST, type ModelManifestEntry } from "./manifest.ts";

export interface FileProgress {
  loadedMB: number;
  totalMB: number;
  done: boolean;
}

export type DownloadProgressListener = (fileId: string, progress: FileProgress) => void;

export class DownloadCancelledError extends Error {
  constructor() {
    super("Model download was cancelled");
    this.name = "DownloadCancelledError";
  }
}

interface ProgressEventLike {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
}

function toFileProgress(event: ProgressEventLike, fallbackTotalMB: number): FileProgress {
  const totalBytes = event.total ?? fallbackTotalMB * 1024 * 1024;
  const loadedBytes = event.loaded ?? (event.status === "done" ? totalBytes : 0);
  return {
    loadedMB: loadedBytes / (1024 * 1024),
    totalMB: totalBytes / (1024 * 1024),
    done: event.status === "done",
  };
}

function makeProgressCallback(entry: ModelManifestEntry, onProgress: DownloadProgressListener) {
  return (event: ProgressEventLike): void => {
    if (event.status !== "progress" && event.status !== "done") return;
    onProgress(entry.id, toFileProgress(event, entry.sizeMB));
  };
}

async function downloadEntry(
  entry: ModelManifestEntry,
  onProgress: DownloadProgressListener,
): Promise<void> {
  const progress_callback = makeProgressCallback(entry, onProgress);

  if (entry.kind === "speech-to-text") {
    const { AutoProcessor, WhisperForConditionalGeneration } =
      await import("@huggingface/transformers");
    await AutoProcessor.from_pretrained(entry.repo, { progress_callback });
    await WhisperForConditionalGeneration.from_pretrained(entry.repo, {
      dtype: entry.dtype,
      progress_callback,
    });
  } else {
    const { AutoTokenizer, AutoModelForCausalLM } = await import("@huggingface/transformers");
    await AutoTokenizer.from_pretrained(entry.repo, { progress_callback });
    await AutoModelForCausalLM.from_pretrained(entry.repo, {
      dtype: entry.dtype,
      progress_callback,
    });
  }
}

/**
 * Downloads every model in `manifest` sequentially, reporting per-file
 * progress via `onProgress`. Checked-between-files cancellation only — see
 * the module-level known-limitation note.
 */
export async function downloadModelWeights(
  onProgress: DownloadProgressListener,
  signal?: AbortSignal,
  manifest: ModelManifestEntry[] = MODEL_MANIFEST,
): Promise<void> {
  for (const entry of manifest) {
    if (signal?.aborted) throw new DownloadCancelledError();
    await downloadEntry(entry, onProgress);
  }
  if (signal?.aborted) throw new DownloadCancelledError();
}
