import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/tests/setup.ts"],
    include: ["src/**/*.{test,spec}.{js,ts}"],
    exclude: ["**/node_modules/**", "**/build/**"],
  },
  build: {
    sourcemap: true,
  },
  // Component tests mount Svelte components client-side under jsdom; without
  // this, Vite resolves svelte's server build and `mount()` throws
  // "not available on the server". See https://svelte.dev/docs/svelte/testing
  // Only spread `resolve` in under Vitest — an explicit `resolve: undefined`
  // key can still affect Vite's config-merging outside that context.
  ...(process.env.VITEST ? { resolve: { conditions: ["browser"] } } : {}),
});
