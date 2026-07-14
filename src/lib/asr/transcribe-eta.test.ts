import { beforeEach, describe, expect, it } from "vitest";
import {
  estimateTranscribeMs,
  getRealTimeFactor,
  recordRealTimeFactorSample,
} from "./transcribe-eta.ts";

describe("transcribe-eta", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to a real-time factor of 2 before any sample is recorded", () => {
    expect(getRealTimeFactor()).toBe(2);
    expect(estimateTranscribeMs(5)).toBe(10000);
  });

  it("recalibrates via a 50/50 moving average against an observed sample", () => {
    // 5s of audio took 5s to transcribe -> observed factor 1; averaged
    // against the default 2 -> 1.5.
    recordRealTimeFactorSample(5, 5);
    expect(getRealTimeFactor()).toBe(1.5);

    // A second identical sample pulls it further toward 1.
    recordRealTimeFactorSample(5, 5);
    expect(getRealTimeFactor()).toBeCloseTo(1.25, 5);
  });

  it("persists the calibrated factor across calls (localStorage-backed)", () => {
    recordRealTimeFactorSample(2, 4); // observed 0.5 -> avg with default 2 -> 1.25
    expect(getRealTimeFactor()).toBeCloseTo(1.25, 5);
    expect(estimateTranscribeMs(10)).toBeCloseTo(12500, 5);
  });

  it("clamps an extreme observed sample instead of letting it dominate the estimate", () => {
    // 0.001s to transcribe 10s of audio would imply a factor of ~0.0001;
    // clamped to the 0.1 floor before averaging with the default 2 -> 1.05.
    recordRealTimeFactorSample(0.001, 10);
    expect(getRealTimeFactor()).toBeCloseTo(1.05, 5);
  });

  it("ignores a non-positive or non-finite sample", () => {
    recordRealTimeFactorSample(5, 0);
    recordRealTimeFactorSample(NaN, 5);
    recordRealTimeFactorSample(-1, 5);
    expect(getRealTimeFactor()).toBe(2);
  });

  it("falls back to the default when localStorage holds a non-numeric value", () => {
    localStorage.setItem("aidedx:asr-real-time-factor", "not-a-number");
    expect(getRealTimeFactor()).toBe(2);
  });
});
