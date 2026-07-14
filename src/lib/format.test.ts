import { describe, expect, it } from "vitest";
import { formatElapsedSeconds, formatEta, formatMegabytes, formatSourceLabel } from "./format.ts";

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
