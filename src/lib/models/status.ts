/**
 * Bridges the generic Cache Storage enumeration in `$lib/system/cache.ts`
 * with the specific model manifest, for the "is everything downloaded
 * already?" check and the clear-cache breakdown list.
 */
import { listCacheEntries, type CacheFileEntry } from "$lib/system/cache.ts";
import { MODEL_MANIFEST, type ModelManifestEntry } from "./manifest.ts";

/** True only if every manifest entry has at least one matching cached file. */
export async function areModelsCached(
  manifest: ModelManifestEntry[] = MODEL_MANIFEST,
): Promise<boolean> {
  const entries = await listCacheEntries();
  if (entries.length === 0) return false;
  return manifest.every((entry) => entries.some((cached) => cached.url.includes(entry.repo)));
}

export interface CacheBreakdownItem {
  label: string;
  sizeMB: number;
}

/** Groups real cached-file sizes by manifest entry, for the clear-cache dialog. */
export function groupCacheBreakdown(
  entries: CacheFileEntry[],
  manifest: ModelManifestEntry[] = MODEL_MANIFEST,
): CacheBreakdownItem[] {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    const match = manifest.find((model) => entry.url.includes(model.repo));
    const label = match?.label ?? "Other cached assets";
    totals.set(label, (totals.get(label) ?? 0) + entry.sizeMB);
  }
  return Array.from(totals.entries()).map(([label, sizeMB]) => ({ label, sizeMB }));
}
