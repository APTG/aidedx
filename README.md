# aidedx

AI-assisted, in-browser front-end for stopping-power (dE/dx) queries. Ask a
question in plain language and get an answer computed **entirely on your
machine** — nothing is sent to a server.

> **Status:** Phase 1 scaffold. This is the app skeleton + continuous GitHub
> Pages deploy only. **No ML yet** — the heavy in-browser model backends
> (transformers.js / WebLLM / wllama) are dynamic-imported in a later phase so
> the shell loads instantly and ships zero ML in the initial bundle.

## Stack

- **SvelteKit** + **Svelte 5** (runes only) + **TypeScript** (strict)
- **Tailwind CSS v4**
- **`@sveltejs/adapter-static`** — prerendered SPA, deployed to GitHub Pages
- **Vitest** for unit tests
- **Node 24 LTS**, package manager **pnpm**

## Develop

```sh
pnpm install
pnpm dev            # dev server
pnpm build          # static production build → build/
pnpm preview        # preview the production build
pnpm check          # svelte-check + tsc typecheck
pnpm lint           # ESLint
pnpm format         # Prettier (write)
pnpm test           # Vitest unit tests
```

## Deployment

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds the
static site (with `BASE_PATH=/aidedx`) and publishes it to GitHub Pages at
<https://aptg.github.io/aidedx/>. CI (`.github/workflows/ci.yml`) runs format,
lint, typecheck, unit tests, and a build on every push/PR.

## Cross-origin isolation (deferred)

In-browser ML backends need `SharedArrayBuffer`, which requires the page to be
[cross-origin isolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated)
(COOP/COEP headers). GitHub Pages cannot set those headers, so the planned
workaround is [`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker).
A documented, intentionally-inert hook is left in `src/app.html`; the actual
hosting/runtime decision is deferred to Spike 3.
