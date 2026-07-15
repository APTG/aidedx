import { beforeEach, describe, expect, it } from "vitest";
import {
  estimateProgress,
  loadCalibration,
  recordCompletedTranscription,
  type ProgressCalibration,
} from "./transcribe-progress.ts";

const DEFAULTS: ProgressCalibration = {
  prefillMsEma: 7900,
  perTokenMsEma: 65,
  totalTokensEma: 15,
};

describe("transcribe-progress", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("loadCalibration", () => {
    it("returns the seeded defaults when nothing is persisted", () => {
      expect(loadCalibration()).toEqual(DEFAULTS);
    });

    it("returns the seeded defaults when localStorage holds corrupt JSON", () => {
      localStorage.setItem("aidedx:asr-progress-calibration-v1", "{not json");
      expect(loadCalibration()).toEqual(DEFAULTS);
    });

    it("returns the seeded defaults when the persisted shape is missing fields", () => {
      localStorage.setItem(
        "aidedx:asr-progress-calibration-v1",
        JSON.stringify({ prefillMsEma: 1000 }),
      );
      expect(loadCalibration()).toEqual(DEFAULTS);
    });

    it("returns the seeded defaults when a persisted value is zero or negative (Copilot review)", () => {
      // A 0 totalTokensEma in particular would otherwise let estimateProgress()
      // jump to ~99% on the very first token — validation must reject it, not
      // just check the shape.
      localStorage.setItem(
        "aidedx:asr-progress-calibration-v1",
        JSON.stringify({ prefillMsEma: 1000, perTokenMsEma: 50, totalTokensEma: 0 }),
      );
      expect(loadCalibration()).toEqual(DEFAULTS);

      localStorage.setItem(
        "aidedx:asr-progress-calibration-v1",
        JSON.stringify({ prefillMsEma: -1000, perTokenMsEma: 50, totalTokensEma: 10 }),
      );
      expect(loadCalibration()).toEqual(DEFAULTS);
    });

    it("returns the seeded defaults when totalTokensEma is below the minimum of 2 (Copilot review)", () => {
      localStorage.setItem(
        "aidedx:asr-progress-calibration-v1",
        JSON.stringify({ prefillMsEma: 1000, perTokenMsEma: 50, totalTokensEma: 1 }),
      );
      expect(loadCalibration()).toEqual(DEFAULTS);
    });
  });

  describe("recordCompletedTranscription", () => {
    it("folds a real sample into the EMA and persists it", () => {
      recordCompletedTranscription({
        transcribingStartedAt: 0,
        firstTokenAt: 2000,
        lastTokenAt: 2500,
        totalTokens: 11,
      });

      // prefillMs=2000, perTokenMs=500/10=50, totalTokens=11 — EMA (alpha=0.3) from the seeded defaults.
      const updated = loadCalibration();
      expect(updated.prefillMsEma).toBeCloseTo(7900 + 0.3 * (2000 - 7900), 5);
      expect(updated.perTokenMsEma).toBeCloseTo(65 + 0.3 * (50 - 65), 5);
      expect(updated.totalTokensEma).toBeCloseTo(15 + 0.3 * (11 - 15), 5);
    });

    it("converges toward repeated real samples over multiple calls", () => {
      // 40, not 20: needs enough iterations for (1-alpha)^n * (seed - sample)
      // to fall under the assertions' precision regardless of how far the
      // seeded default is from the sample value.
      for (let i = 0; i < 40; i++) {
        recordCompletedTranscription({
          transcribingStartedAt: 0,
          firstTokenAt: 1000,
          lastTokenAt: 1000 + 19 * 20,
          totalTokens: 20,
        });
      }
      const updated = loadCalibration();
      expect(updated.prefillMsEma).toBeCloseTo(1000, 0);
      expect(updated.perTokenMsEma).toBeCloseTo(20, 0);
      expect(updated.totalTokensEma).toBeCloseTo(20, 0);
    });

    it("is a no-op for fewer than 2 tokens (no derivable per-token interval)", () => {
      recordCompletedTranscription({
        transcribingStartedAt: 0,
        firstTokenAt: 2000,
        lastTokenAt: 2000,
        totalTokens: 1,
      });
      expect(loadCalibration()).toEqual(DEFAULTS);
    });

    it("is a no-op for zero tokens", () => {
      recordCompletedTranscription({
        transcribingStartedAt: 0,
        firstTokenAt: 0,
        lastTokenAt: 0,
        totalTokens: 0,
      });
      expect(loadCalibration()).toEqual(DEFAULTS);
    });

    it("ignores a sample with non-positive derived timings (defensive against clock skew)", () => {
      recordCompletedTranscription({
        transcribingStartedAt: 5000,
        firstTokenAt: 4000, // before transcribingStartedAt -> negative prefillMs
        lastTokenAt: 4500,
        totalTokens: 5,
      });
      expect(loadCalibration()).toEqual(DEFAULTS);
    });
  });

  describe("estimateProgress", () => {
    it("stays in the prefill stage with fraction 0 at the very start", () => {
      const estimate = estimateProgress({ tokensSoFar: 0, elapsedMs: 0 }, DEFAULTS);
      expect(estimate.stage).toBe("prefill");
      expect(estimate.fraction).toBe(0);
    });

    it("grows during prefill as elapsed time approaches the calibrated prefill duration", () => {
      const early = estimateProgress({ tokensSoFar: 0, elapsedMs: 200 }, DEFAULTS);
      const late = estimateProgress({ tokensSoFar: 0, elapsedMs: 1200 }, DEFAULTS);
      expect(late.fraction).toBeGreaterThan(early.fraction);
      expect(early.stage).toBe("prefill");
      expect(late.stage).toBe("prefill");
    });

    it("never lets prefill alone reach the prefill/decode handoff point", () => {
      // Even a huge elapsed time (well past the calibrated prefill duration)
      // must not let prefill's own fraction reach prefillBand — only real
      // tokens are allowed to cross into the decode share of the bar.
      const estimate = estimateProgress({ tokensSoFar: 0, elapsedMs: 1_000_000 }, DEFAULTS);
      expect(estimate.stage).toBe("prefill");
      expect(estimate.fraction).toBeLessThan(1);

      const decodeStart = estimateProgress({ tokensSoFar: 1, elapsedMs: 1_000_000 }, DEFAULTS);
      expect(estimate.fraction).toBeLessThan(decodeStart.fraction);
    });

    it("switches to the decode stage as soon as a single token has landed", () => {
      const estimate = estimateProgress({ tokensSoFar: 1, elapsedMs: 1500 }, DEFAULTS);
      expect(estimate.stage).toBe("decode");
    });

    it("advances monotonically forward across the prefill->decode handoff for realistic timings", () => {
      const lastPrefill = estimateProgress({ tokensSoFar: 0, elapsedMs: 1450 }, DEFAULTS);
      const firstDecode = estimateProgress({ tokensSoFar: 1, elapsedMs: 1460 }, DEFAULTS);
      expect(firstDecode.fraction).toBeGreaterThan(lastPrefill.fraction);
    });

    it("approaches but never reaches 1 as tokens approach the calibrated total", () => {
      const estimate = estimateProgress({ tokensSoFar: 16, elapsedMs: 3000 }, DEFAULTS);
      expect(estimate.stage).toBe("decode");
      expect(estimate.fraction).toBeLessThan(1);
      expect(estimate.fraction).toBeGreaterThan(0.9);
    });

    it("keeps growing (capped) if tokensSoFar exceeds the calibrated total (a longer-than-usual answer)", () => {
      const atTotal = estimateProgress({ tokensSoFar: 16, elapsedMs: 3000 }, DEFAULTS);
      const beyond = estimateProgress({ tokensSoFar: 30, elapsedMs: 3000 }, DEFAULTS);
      expect(beyond.fraction).toBeGreaterThanOrEqual(atTotal.fraction);
      expect(beyond.fraction).toBeLessThan(1);
    });

    it("defaults to loadCalibration() when no calibration argument is passed", () => {
      recordCompletedTranscription({
        transcribingStartedAt: 0,
        firstTokenAt: 500,
        lastTokenAt: 500,
        totalTokens: 2,
      });
      // Should not throw and should read whatever is currently persisted.
      expect(() => estimateProgress({ tokensSoFar: 0, elapsedMs: 100 })).not.toThrow();
    });

    it("clamps the prefill band even for degenerate calibration (near-zero decode cost)", () => {
      const degenerate: ProgressCalibration = {
        prefillMsEma: 1000,
        perTokenMsEma: 0,
        totalTokensEma: 0,
      };
      const prefill = estimateProgress({ tokensSoFar: 0, elapsedMs: 500 }, degenerate);
      const decodeStart = estimateProgress({ tokensSoFar: 1, elapsedMs: 500 }, degenerate);
      expect(prefill.fraction).toBeLessThan(decodeStart.fraction);
      expect(decodeStart.fraction).toBeLessThanOrEqual(1);
    });
  });
});
