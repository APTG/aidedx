import { beforeEach, describe, expect, it } from "vitest";
import { getStoredAppMode, resolveInitialAppMode, storeAppMode } from "./app-mode.ts";

describe("app-mode", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when no mode has been stored", () => {
    expect(getStoredAppMode()).toBeNull();
  });

  it("round-trips a stored mode", () => {
    storeAppMode("advanced");
    expect(getStoredAppMode()).toBe("advanced");

    storeAppMode("basic");
    expect(getStoredAppMode()).toBe("basic");
  });

  it("ignores a corrupt/unrecognized stored value", () => {
    localStorage.setItem("aidedx:app-mode", "not-a-real-mode");
    expect(getStoredAppMode()).toBeNull();
  });

  describe("resolveInitialAppMode", () => {
    it("defaults to basic when nothing is stored", () => {
      expect(resolveInitialAppMode()).toBe("basic");
    });

    it("returns the stored mode when present", () => {
      storeAppMode("advanced");
      expect(resolveInitialAppMode()).toBe("advanced");
    });
  });
});
