import { afterEach, describe, expect, it } from "vitest";
import { getMemoryEstimateMB } from "./memory.ts";

describe("getMemoryEstimateMB", () => {
  afterEach(() => {
    delete (performance as Performance & { memory?: unknown }).memory;
  });

  it("returns null when performance.memory is unavailable (Firefox/Safari)", () => {
    expect(getMemoryEstimateMB()).toBeNull();
  });

  it("converts usedJSHeapSize bytes to megabytes when available (Chrome/Edge)", () => {
    Object.defineProperty(performance, "memory", {
      configurable: true,
      value: { usedJSHeapSize: 50 * 1024 * 1024 },
    });

    expect(getMemoryEstimateMB()).toBe(50);
  });
});
