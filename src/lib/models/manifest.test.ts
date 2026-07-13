import { describe, expect, it } from "vitest";
import { MODEL_MANIFEST, TOTAL_DOWNLOAD_SIZE_MB } from "./manifest.ts";

describe("MODEL_MANIFEST", () => {
  it("has a unique id per entry", () => {
    const ids = MODEL_MANIFEST.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sums entry sizes into TOTAL_DOWNLOAD_SIZE_MB", () => {
    const sum = MODEL_MANIFEST.reduce((total, entry) => total + entry.sizeMB, 0);
    expect(TOTAL_DOWNLOAD_SIZE_MB).toBe(sum);
  });

  it("totals close to the ~1.1 GB the issue's consent copy promises", () => {
    expect(TOTAL_DOWNLOAD_SIZE_MB).toBeGreaterThan(1000);
    expect(TOTAL_DOWNLOAD_SIZE_MB).toBeLessThan(1200);
  });
});
