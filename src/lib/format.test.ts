import { describe, expect, it } from "vitest";
import {
  csdaRangeToCm,
  formatElapsedSeconds,
  formatEnergyPerNucleon,
  formatEta,
  formatLengthCm,
  formatMegabytes,
  formatSignificant,
  formatSourceLabel,
  stoppingPowerToKevPerUm,
} from "./format.ts";

describe("formatMegabytes", () => {
  it("renders zero and negative values as 0 MB", () => {
    expect(formatMegabytes(0)).toBe("0 MB");
    expect(formatMegabytes(-5)).toBe("0 MB");
  });

  it("renders sub-gigabyte sizes rounded to whole MB", () => {
    expect(formatMegabytes(92)).toBe("92 MB");
    expect(formatMegabytes(380.6)).toBe("381 MB");
  });

  it("renders sizes at or above 1024 MB in GB with two decimals", () => {
    expect(formatMegabytes(1132)).toBe("1.11 GB");
    expect(formatMegabytes(1024)).toBe("1.00 GB");
  });
});

describe("formatEta", () => {
  it("reports 'estimating…' before any bytes have loaded", () => {
    expect(formatEta(0, 100, 5000)).toBe("estimating…");
  });

  it("reports 'estimating…' when no time has elapsed yet", () => {
    expect(formatEta(10, 100, 0)).toBe("estimating…");
  });

  it("reports 'almost done' once the extrapolated remaining time rounds to zero", () => {
    expect(formatEta(100, 100, 5000)).toBe("almost done");
  });

  it("extrapolates remaining seconds from the observed rate", () => {
    // 50 MB loaded in 10s => 5 MB/s; 50 MB remaining => 10s remaining
    expect(formatEta(50, 100, 10_000)).toBe("≈10 sec remaining");
  });

  it("switches to minutes once remaining time is a minute or more", () => {
    // 10 MB loaded in 10s => 1 MB/s; 110 MB remaining => 110s => rounds to 2 min
    expect(formatEta(10, 120, 10_000)).toBe("≈2 min remaining");
  });
});

describe("formatElapsedSeconds", () => {
  it("floors to whole seconds", () => {
    expect(formatElapsedSeconds(2999)).toBe("2 s");
    expect(formatElapsedSeconds(3000)).toBe("3 s");
  });

  it("clamps negative durations to 0 s", () => {
    expect(formatElapsedSeconds(-500)).toBe("0 s");
  });
});

describe("formatSourceLabel", () => {
  it("extracts the hostname from a remote host URL", () => {
    expect(formatSourceLabel("https://aidedx-models.s3p.cloud.cyfronet.pl/")).toBe(
      "aidedx-models.s3p.cloud.cyfronet.pl",
    );
  });

  it("falls back to the raw string when it isn't a valid URL", () => {
    expect(formatSourceLabel("not-a-url")).toBe("not-a-url");
  });
});

describe("formatSignificant", () => {
  it("rounds to 4 significant figures by default", () => {
    expect(formatSignificant(1.42899)).toBe("1.429");
  });

  it("does not pad trailing zeros", () => {
    expect(formatSignificant(100)).toBe("100");
  });

  it("handles zero", () => {
    expect(formatSignificant(0)).toBe("0");
  });

  it("falls back to 'n/a' for non-finite values", () => {
    expect(formatSignificant(Number.NaN)).toBe("n/a");
    expect(formatSignificant(Number.POSITIVE_INFINITY)).toBe("n/a");
  });
});

describe("formatLengthCm", () => {
  it("keeps cm when the value already reads well in cm", () => {
    expect(formatLengthCm(1.2857142857)).toBe("1.286 cm");
  });

  it("scales down to µm for sub-mm lengths", () => {
    expect(formatLengthCm(0.0001)).toBe("1 µm");
  });

  it("scales up to m for multi-meter lengths", () => {
    expect(formatLengthCm(150)).toBe("1.5 m");
  });

  it("scales up to km for kilometer-scale lengths", () => {
    expect(formatLengthCm(250_000)).toBe("2.5 km");
  });

  it("falls back to nm — the smallest tier — for sub-nm-readable magnitudes", () => {
    expect(formatLengthCm(1e-7)).toBe("1 nm");
  });

  it("renders zero without scaling and non-finite values as 'n/a'", () => {
    expect(formatLengthCm(0)).toBe("0 cm");
    expect(formatLengthCm(Number.NaN)).toBe("n/a");
  });
});

describe("formatEnergyPerNucleon", () => {
  it("keeps MeV/nucl for ordinary magnitudes", () => {
    expect(formatEnergyPerNucleon(250)).toBe("250 MeV/nucl");
  });

  it("scales down to keV/nucl for sub-MeV bounds", () => {
    expect(formatEnergyPerNucleon(0.0002500000118743628)).toBe("0.25 keV/nucl");
  });

  it("scales up to GeV/nucl for multi-GeV bounds", () => {
    expect(formatEnergyPerNucleon(12_500)).toBe("12.5 GeV/nucl");
  });

  it("renders zero without scaling and non-finite values as 'n/a'", () => {
    expect(formatEnergyPerNucleon(0)).toBe("0 MeV/nucl");
    expect(formatEnergyPerNucleon(Number.NaN)).toBe("n/a");
  });
});

describe("stoppingPowerToKevPerUm", () => {
  it("converts mass stopping power to linear stopping power via density", () => {
    // 7.289 MeV·cm²/g x 1 g/cm³ (water) = 7.289 MeV/cm = 0.7289 keV/µm.
    expect(stoppingPowerToKevPerUm(7.289, 1)).toBeCloseTo(0.7289, 6);
  });
});

describe("csdaRangeToCm", () => {
  it("converts an areal range to a physical length via density", () => {
    // 1.529 g/cm² / 1.19 g/cm³ (PMMA) ≈ 1.2849 cm.
    expect(csdaRangeToCm(1.529, 1.19)).toBeCloseTo(1.284874, 5);
  });
});
