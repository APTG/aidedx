/**
 * Framework-free model-weight downloader for the consent flow in issue #32.
 *
 * Deliberately has no SvelteKit dependency (same split as `src/lib/wasm/`)
 * and dynamic-imports `@huggingface/transformers` itself, so the download
 * path never enters the landing page's initial bundle.
 *
 * Progress comes from transformers.js's own `progress_callback` — see
 * `ProgressInfo` in `@huggingface/transformers/src/utils/core.js` — rather
 * than a hand-rolled `fetch` reader, since that's what's already loading
 * the files.
 *
 * Known limitation (issue #32 open question 2): transformers.js does not
 * expose a way to abort a load already in flight for a given file. Cancel
 * therefore races the in-flight `downloadEntry()` promise against the abort
 * signal (see `raceAbort`) so the *caller* moves on immediately instead of
 * waiting for the current file to finish — but the underlying fetch for
 * that file isn't actually interrupted; it keeps running in the background
 * and lands in the cache anyway (harmless — just an early write).
 *
 * Every entry is fetched from the Cyfronet S3 mirror (`MODEL_MIRROR_HOST`,
 * see `docs/model-hosting-cyfronet.md`) rather than huggingface.co — set via
 * `env.remoteHost` before the first `from_pretrained` call. Browser
 * transformers.js caches responses in Cache Storage keyed by the request URL
 * (see `$lib/system/cache.ts`), so any later load of the same repo (e.g. a
 * future ASR inference module) must set the same `env.remoteHost` to hit
 * that cache instead of re-fetching.
 */
import { AVAILABLE_MODEL_MANIFEST, type ModelManifestEntry } from "./manifest.ts";
import { MODEL_MIRROR_HOST } from "./remote.ts";

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
    const { AutoProcessor, WhisperForConditionalGeneration, env } =
      await import("@huggingface/transformers");
    env.remoteHost = MODEL_MIRROR_HOST;
    await AutoProcessor.from_pretrained(entry.repo, { progress_callback });
    await WhisperForConditionalGeneration.from_pretrained(entry.repo, {
      dtype: entry.dtype,
      progress_callback,
    });
  } else {
    const { AutoTokenizer, AutoModelForCausalLM, env } = await import("@huggingface/transformers");
    env.remoteHost = MODEL_MIRROR_HOST;
    await AutoTokenizer.from_pretrained(entry.repo, { progress_callback });
    await AutoModelForCausalLM.from_pretrained(entry.repo, {
      dtype: entry.dtype,
      progress_callback,
    });
  }
}

/** Rejects with `DownloadCancelledError` as soon as `signal` aborts, whichever comes first. */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DownloadCancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DownloadCancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error as Error);
      },
    );
  });
}

/**
 * Downloads every model in `manifest` sequentially, reporting per-file
 * progress via `onProgress`. Cancellation via `signal` takes effect
 * immediately from the caller's perspective, even mid-file — see the
 * module-level known-limitation note.
 *
 * Defaults to `AVAILABLE_MODEL_MANIFEST`, i.e. only entries actually mirrored
 * to S3 — entries not yet mirrored (`available: false`) are never fetched.
 */
export async function downloadModelWeights(
  onProgress: DownloadProgressListener,
  signal?: AbortSignal,
  manifest: ModelManifestEntry[] = AVAILABLE_MODEL_MANIFEST,
): Promise<void> {
  for (const entry of manifest) {
    if (signal?.aborted) throw new DownloadCancelledError();
    await raceAbort(downloadEntry(entry, onProgress), signal);
  }
  if (signal?.aborted) throw new DownloadCancelledError();
}
