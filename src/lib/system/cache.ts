/**
 * Browser disk-cache introspection for the status panel's "Disk cache" row
 * and the clear-cache flow.
 *
 * transformers.js caches model weights via the Cache Storage API in the
 * browser (`caches.open(env.cacheKey)`, default cache name
 * `"transformers-cache"` — confirmed by reading
 * `@huggingface/transformers/src/utils/cache.js`, resolving issue #32's
 * open question 1). It does not fall back to IndexedDB in the browser, so
 * only the Cache Storage API needs to be enumerated here.
 */

const KNOWN_CACHE_NAME_PATTERN = /transformers|onnx|whisper|qwen|llama/i;

/** Cache-usage warning threshold from issue #32's spec: 1.5 GB. */
export const CACHE_WARNING_THRESHOLD_MB = 1536;

export interface CacheFileEntry {
  url: string;
  sizeMB: number;
}

export interface DiskUsage {
  usedMB: number;
  quotaMB: number;
}

async function resolveModelCacheNames(): Promise<string[]> {
  if (typeof caches === "undefined") return [];
  const names = await caches.keys();
  return names.filter((name) => KNOWN_CACHE_NAME_PATTERN.test(name));
}

/** Lists every cached model file across all matching Cache Storage buckets. */
export async function listCacheEntries(): Promise<CacheFileEntry[]> {
  const names = await resolveModelCacheNames();
  const entries: CacheFileEntry[] = [];
  for (const name of names) {
    const cache = await caches.open(name);
    const requests = await cache.keys();
    for (const request of requests) {
      const response = await cache.match(request);
      const blob = await response?.blob();
      entries.push({ url: request.url, sizeMB: (blob?.size ?? 0) / (1024 * 1024) });
    }
  }
  return entries;
}

/** Total disk usage/quota via the Storage API — works regardless of cache backend. */
export async function getDiskUsage(): Promise<DiskUsage> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    return { usedMB: 0, quotaMB: 0 };
  }
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usedMB: usage / (1024 * 1024), quotaMB: quota / (1024 * 1024) };
}

/** Deletes every Cache Storage bucket that looks like a model-weight cache. */
export async function clearModelCache(): Promise<void> {
  const names = await resolveModelCacheNames();
  await Promise.all(names.map((name) => caches.delete(name)));
}
