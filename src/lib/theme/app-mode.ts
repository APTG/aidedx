/**
 * Framework-free Basic/Advanced mode helpers (issue #17). Persists the
 * user's choice in `localStorage`, mirroring `dark-mode.ts`'s shape — the
 * same reasoning applies: aidedx is a fully static, client-only app with no
 * backend/session to remember a preference for, so `localStorage` is the
 * only place a cross-reload choice can live.
 *
 * Kept free of Svelte/SvelteKit imports so it can be unit-tested without a
 * component harness; `AppModeToggle.svelte` and `SystemStatusHeader.svelte`
 * are the only callers.
 */

export type AppMode = "basic" | "advanced";

const STORAGE_KEY = "aidedx:app-mode";

/** Returns the stored mode, or `null` if the user hasn't chosen yet. */
export function getStoredAppMode(): AppMode | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === "advanced" || raw === "basic" ? raw : null;
}

export function storeAppMode(mode: AppMode): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, mode);
}

/** Resolves the initial mode: stored preference, else Basic (the default — no OS-level signal to fall back to, unlike dark mode). */
export function resolveInitialAppMode(): AppMode {
  return getStoredAppMode() ?? "basic";
}
