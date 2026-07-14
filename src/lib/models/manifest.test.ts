import { describe, expect, it } from "vitest";
import { AVAILABLE_MODEL_MANIFEST, MODEL_MANIFEST, TOTAL_DOWNLOAD_SIZE_MB } from "./manifest.ts";

describe("MODEL_MANIFEST", () => {
  it("has a unique id per entry", () => {
    const ids = MODEL_MANIFEST.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("marks whisper as the only entry mirrored to S3 so far", () => {
    expect(AVAILABLE_MODEL_MANIFEST.map((entry) => entry.id)).toEqual(["whisper"]);
  });
});

describe("TOTAL_DOWNLOAD_SIZE_MB", () => {
  it("sums only the available entries' sizes", () => {
    const sum = AVAILABLE_MODEL_MANIFEST.reduce((total, entry) => total + entry.sizeMB, 0);
    expect(TOTAL_DOWNLOAD_SIZE_MB).toBe(sum);
  });

  it("excludes unavailable entries, so it's well under the full manifest's total", () => {
    const fullSum = MODEL_MANIFEST.reduce((total, entry) => total + entry.sizeMB, 0);
    expect(TOTAL_DOWNLOAD_SIZE_MB).toBeLessThan(fullSum);
  });

  it("reflects whisper-small's real size (~240 MB), not the old whisper-tiny placeholder", () => {
    expect(TOTAL_DOWNLOAD_SIZE_MB).toBeGreaterThan(200);
    expect(TOTAL_DOWNLOAD_SIZE_MB).toBeLessThan(300);
  });
});
