import { describe, expect, it } from "vitest";
import { formatEta, formatMegabytes, formatSourceLabel } from "./format.ts";

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

describe("formatSourceLabel", () => {
  it("derives the org from a single repo", () => {
    expect(formatSourceLabel(["onnx-community/whisper-tiny"])).toBe(
      "huggingface.co/onnx-community",
    );
  });

  it("dedupes orgs shared across multiple repos", () => {
    expect(
      formatSourceLabel([
        "onnx-community/whisper-tiny",
        "onnx-community/Qwen2.5-0.5B-Instruct",
        "onnx-community/Llama-3.2-1B-Instruct",
      ]),
    ).toBe("huggingface.co/onnx-community");
  });

  it("lists every distinct org when the manifest spans more than one", () => {
    expect(formatSourceLabel(["onnx-community/whisper-tiny", "some-other-org/model-x"])).toBe(
      "huggingface.co/onnx-community, some-other-org",
    );
  });

  it("falls back to the bare host when given no repos", () => {
    expect(formatSourceLabel([])).toBe("huggingface.co");
  });
});
