/** Formats a megabyte value the way the status panel expects: "92 MB" / "1.13 GB". */
export function formatMegabytes(mb: number): string {
  if (mb <= 0) return "0 MB";
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${Math.round(mb)} MB`;
}

/** Formats a remaining-time estimate for the download progress modal. */
export function formatEta(loadedMB: number, totalMB: number, elapsedMs: number): string {
  if (loadedMB <= 0 || elapsedMs <= 0) return "estimating…";
  const remainingMB = Math.max(0, totalMB - loadedMB);
  const mbPerMs = loadedMB / elapsedMs;
  if (mbPerMs <= 0) return "estimating…";
  const remainingSec = Math.round(remainingMB / mbPerMs / 1000);
  if (remainingSec <= 0) return "almost done";
  if (remainingSec < 60) return `≈${remainingSec} sec remaining`;
  return `≈${Math.round(remainingSec / 60)} min remaining`;
}

/**
 * Formats the download source line ("huggingface.co/onnx-community") from
 * the manifest's repo ids, instead of hardcoding an org that could drift
 * from the actual manifest.
 */
export function formatSourceLabel(repos: string[]): string {
  const orgs = Array.from(new Set(repos.map((repo) => repo.split("/")[0]).filter(Boolean)));
  return orgs.length > 0 ? `huggingface.co/${orgs.join(", ")}` : "huggingface.co";
}
