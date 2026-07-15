import { afterEach, describe, expect, it } from "vitest";
import { detectCpuThreads, threadCountForCores } from "./threading.ts";

describe("threadCountForCores", () => {
  it("uses half the logical cores, capped at 8", () => {
    expect(threadCountForCores(4)).toBe(2);
    expect(threadCountForCores(8)).toBe(4);
    expect(threadCountForCores(12)).toBe(6);
    expect(threadCountForCores(16)).toBe(8);
    expect(threadCountForCores(32)).toBe(8);
  });

  it("never goes below 1 thread", () => {
    expect(threadCountForCores(1)).toBe(1);
    expect(threadCountForCores(2)).toBe(1);
  });

  it("falls back to a modest 4-core assumption (→2) when cores is unknown", () => {
    expect(threadCountForCores(undefined)).toBe(2);
    expect(threadCountForCores(0)).toBe(2);
  });
});

describe("detectCpuThreads", () => {
  afterEach(() => {
    // @ts-expect-error -- cleaning up a test-only override
    delete navigator.hardwareConcurrency;
    // @ts-expect-error -- cleaning up a test-only override
    delete globalThis.crossOriginIsolated;
  });

  it("reports 1 thread used when the page is not cross-origin isolated, regardless of core count", () => {
    Object.defineProperty(navigator, "hardwareConcurrency", { configurable: true, value: 12 });
    Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: false });

    expect(detectCpuThreads()).toEqual({
      logicalCores: 12,
      threadsUsed: 1,
      crossOriginIsolated: false,
    });
  });

  it("reports the policy thread count when cross-origin isolated", () => {
    Object.defineProperty(navigator, "hardwareConcurrency", { configurable: true, value: 12 });
    Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });

    expect(detectCpuThreads()).toEqual({
      logicalCores: 12,
      threadsUsed: 6,
      crossOriginIsolated: true,
    });
  });

  it("reports null logical cores when hardwareConcurrency is unavailable", () => {
    Object.defineProperty(navigator, "hardwareConcurrency", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });

    expect(detectCpuThreads()).toEqual({
      logicalCores: null,
      threadsUsed: 2,
      crossOriginIsolated: true,
    });
  });

  it("normalizes hardwareConcurrency=0 to null instead of reporting '1 of 0' (review fix)", () => {
    // Some implementations report 0 to mean "unknown" rather than a real
    // core count — threadCountForCores() already treats non-positive values
    // as unknown, so logicalCores must match instead of leaking a bogus 0
    // through to the UI.
    Object.defineProperty(navigator, "hardwareConcurrency", { configurable: true, value: 0 });
    Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });

    expect(detectCpuThreads()).toEqual({
      logicalCores: null,
      threadsUsed: 2,
      crossOriginIsolated: true,
    });
  });
});
