import { afterEach, describe, expect, it } from "vitest";
import { getMemoryEstimate } from "./memory.ts";

describe("getMemoryEstimate", () => {
  afterEach(() => {
    delete (performance as Performance & { memory?: unknown }).memory;
    delete (navigator as Navigator & { deviceMemory?: unknown }).deviceMemory;
  });

  it("reports unsupported when neither performance.memory nor navigator.deviceMemory is available", () => {
    expect(getMemoryEstimate()).toEqual({ source: "unsupported" });
  });

  it("converts usedJSHeapSize bytes to megabytes when performance.memory is available (Chrome/Edge)", () => {
    Object.defineProperty(performance, "memory", {
      configurable: true,
      value: { usedJSHeapSize: 50 * 1024 * 1024 },
    });

    expect(getMemoryEstimate()).toEqual({ source: "heap", mb: 50 });
  });

  it("falls back to navigator.deviceMemory when performance.memory is unavailable", () => {
    Object.defineProperty(navigator, "deviceMemory", {
      configurable: true,
      value: 8,
    });

    expect(getMemoryEstimate()).toEqual({ source: "device", gb: 8 });
  });

  it("prefers performance.memory over navigator.deviceMemory when both are available", () => {
    Object.defineProperty(performance, "memory", {
      configurable: true,
      value: { usedJSHeapSize: 50 * 1024 * 1024 },
    });
    Object.defineProperty(navigator, "deviceMemory", {
      configurable: true,
      value: 8,
    });

    expect(getMemoryEstimate()).toEqual({ source: "heap", mb: 50 });
  });
});
