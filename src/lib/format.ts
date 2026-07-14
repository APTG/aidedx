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

/**
 * Rounds to `sigFigs` significant figures for display, e.g. 1.42899 ->
 * "1.429". Shared by the physics unit-scaling helpers below and by
 * `nlg/render.ts`'s `formatNumber` (kept as a separate export there since
 * it's the module's established public surface).
 */
export function formatSignificant(value: number, sigFigs = 4): string {
  if (!Number.isFinite(value)) return "n/a";
  if (value === 0) return "0";
  return Number(value.toPrecision(sigFigs)).toString();
}

interface ScaleTier {
  unit: string;
  /** Multiplier from the base unit to this tier's unit: display = base * factor. */
  factor: number;
}

/**
 * Picks the largest unit (scanned largest-to-smallest) whose magnitude is
 * still >= 1, falling back to the smallest tier when even that reads as a
 * sub-1 fraction (there's nothing smaller to switch to). `tiersLargestFirst`
 * must be ordered from the largest unit to the smallest.
 */
function autoScale(
  baseValue: number,
  tiersLargestFirst: readonly ScaleTier[],
): { value: number; unit: string } {
  for (const tier of tiersLargestFirst) {
    const display = baseValue * tier.factor;
    if (Math.abs(display) >= 1) return { value: display, unit: tier.unit };
  }
  const smallest = tiersLargestFirst[tiersLargestFirst.length - 1];
  if (!smallest) throw new Error("autoScale: tiersLargestFirst must be non-empty");
  return { value: baseValue * smallest.factor, unit: smallest.unit };
}

const LENGTH_TIERS_FROM_CM: readonly ScaleTier[] = [
  { unit: "km", factor: 1e-5 },
  { unit: "m", factor: 1e-2 },
  { unit: "cm", factor: 1 },
  { unit: "mm", factor: 10 },
  { unit: "µm", factor: 1e4 },
  { unit: "nm", factor: 1e7 },
];

/**
 * Auto-scales a length given in cm to whichever of nm/µm/mm/cm/m/km reads
 * best for its magnitude (dedx_web's range-display convention), e.g.
 * `formatLengthCm(1.285)` -> "1.285 cm", `formatLengthCm(0.0001)` -> "1 µm".
 */
export function formatLengthCm(cm: number): string {
  if (!Number.isFinite(cm)) return "n/a";
  if (cm === 0) return "0 cm";
  const { value, unit } = autoScale(cm, LENGTH_TIERS_FROM_CM);
  return `${formatSignificant(value)} ${unit}`;
}

const ENERGY_TIERS_FROM_MEV_PER_NUCL: readonly ScaleTier[] = [
  { unit: "GeV/nucl", factor: 1e-3 },
  { unit: "MeV/nucl", factor: 1 },
  { unit: "keV/nucl", factor: 1e3 },
];

/**
 * Auto-scales a per-nucleon energy given in MeV/nucl to whichever of
 * keV/MeV/GeV per nucleon reads best, e.g. `formatEnergyPerNucleon(0.00025)`
 * -> "0.25 keV/nucl". Used to render libdedx's [min, max] energy bounds as a
 * readable phrase instead of raw MeV/nucl floats.
 */
export function formatEnergyPerNucleon(mevPerNucl: number): string {
  if (!Number.isFinite(mevPerNucl)) return "n/a";
  if (mevPerNucl === 0) return "0 MeV/nucl";
  const { value, unit } = autoScale(mevPerNucl, ENERGY_TIERS_FROM_MEV_PER_NUCL);
  return `${formatSignificant(value)} ${unit}`;
}

/**
 * Converts mass stopping power (MeV·cm²/g) to linear stopping power in
 * keV/µm given the material density (g/cm³) — the dedx_web display
 * convention for stopping power. MeV·cm²/g × g/cm³ = MeV/cm; converting
 * MeV/cm to keV/µm (×1000 keV/MeV, ÷1e4 µm/cm) collapses to a flat ×0.1.
 */
export function stoppingPowerToKevPerUm(
  massStoppingPowerMevCm2PerG: number,
  densityGPerCm3: number,
): number {
  return massStoppingPowerMevCm2PerG * densityGPerCm3 * 0.1;
}

/**
 * Converts an areal CSDA range (g/cm²) to a physical length in cm given the
 * material density (g/cm³).
 */
export function csdaRangeToCm(csdaRangeGPerCm2: number, densityGPerCm3: number): number {
  return csdaRangeGPerCm2 / densityGPerCm3;
}
