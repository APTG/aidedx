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

/** Formats elapsed recording/transcribing time for the mic status line, e.g. "3 s". */
export function formatElapsedSeconds(elapsedMs: number): string {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  return `${seconds} s`;
}

/**
 * Formats the download source line (e.g. "aidedx-models.s3p.cloud.cyfronet.pl")
 * from a remote host URL — just the hostname, since the progress dialog only
 * needs to say roughly where the bytes are coming from.
 */
export function formatSourceLabel(remoteHost: string): string {
  try {
    return new URL(remoteHost).host;
  } catch {
    return remoteHost;
  }
}
