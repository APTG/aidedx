import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// GitHub Pages serves project sites under a sub-path (e.g. /aidedx). CI sets
// BASE_PATH=/aidedx for the deploy build; local dev leaves it empty so the app
// is served from the origin root.
const rawBasePath = process.env.BASE_PATH?.trim();
const basePath = rawBasePath && rawBasePath !== "/" ? rawBasePath.replace(/\/+$/, "") : "";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Static adapter → prerendered HTML + SPA fallback for GitHub Pages.
    adapter: adapter({
      fallback: "404.html",
    }),
    prerender: {
      handleHttpError: "warn",
    },
    paths: {
      base: basePath,
    },
    alias: {
      $lib: "./src/lib",
    },
  },
};

export default config;
