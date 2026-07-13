import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyDarkMode,
  getStoredDarkModePreference,
  prefersDarkColorScheme,
  resolveInitialDarkMode,
  storeDarkModePreference,
} from "./dark-mode.ts";

describe("dark-mode", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  it("returns null when no preference has been stored", () => {
    expect(getStoredDarkModePreference()).toBeNull();
  });

  it("round-trips a stored preference", () => {
    storeDarkModePreference(true);
    expect(getStoredDarkModePreference()).toBe(true);

    storeDarkModePreference(false);
    expect(getStoredDarkModePreference()).toBe(false);
  });

  it("toggles the .dark class on <html>", () => {
    applyDarkMode(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    applyDarkMode(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  describe("prefersDarkColorScheme", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns false when matchMedia is unavailable", () => {
      const original = window.matchMedia;
      // @ts-expect-error -- simulating an environment without matchMedia
      delete window.matchMedia;
      expect(prefersDarkColorScheme()).toBe(false);
      window.matchMedia = original;
    });

    it("reflects the OS-level media query result", () => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia,
      );
      expect(prefersDarkColorScheme()).toBe(true);
    });
  });

  describe("resolveInitialDarkMode", () => {
    it("prefers the stored value over the OS preference", () => {
      storeDarkModePreference(false);
      vi.stubGlobal(
        "matchMedia",
        vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia,
      );
      expect(resolveInitialDarkMode()).toBe(false);
      vi.unstubAllGlobals();
    });

    it("falls back to the OS preference when nothing is stored", () => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia,
      );
      expect(resolveInitialDarkMode()).toBe(true);
      vi.unstubAllGlobals();
    });
  });
});
