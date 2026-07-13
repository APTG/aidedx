/**
 * Framework-free dark-mode helpers. Persists the user's choice in
 * `localStorage` and toggles the `.dark` class on `<html>`, matching the
 * `@custom-variant dark (&:is(.dark *))` selector defined in `src/app.css`.
 *
 * Kept free of Svelte/SvelteKit imports so it can be unit-tested without a
 * component harness; `DarkModeToggle.svelte` is the only caller.
 */

const STORAGE_KEY = "aidedx:dark-mode";

/** Returns the stored preference, or `null` if the user hasn't chosen yet. */
export function getStoredDarkModePreference(): boolean | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return null;
  return raw === "true";
}

export function storeDarkModePreference(enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, String(enabled));
}

/** Falls back to the OS-level color scheme when there's no stored preference. */
export function prefersDarkColorScheme(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyDarkMode(enabled: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", enabled);
}

/** Resolves the initial dark-mode state: stored preference, else OS preference. */
export function resolveInitialDarkMode(): boolean {
  return getStoredDarkModePreference() ?? prefersDarkColorScheme();
}
