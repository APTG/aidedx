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
  // Component tests mount Svelte components client-side under jsdom; without
  // this, Vite resolves svelte's server build and `mount()` throws
  // "not available on the server". See https://svelte.dev/docs/svelte/testing
  resolve: process.env.VITEST ? { conditions: ["browser"] } : undefined,
  build: {
    sourcemap: true,
  },
});
