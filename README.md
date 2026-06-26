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

## Eval set

[`eval/intents.jsonl`](eval/intents.jsonl) is a hand-labeled set of ~110
natural-language queries mapped to the shared
[`QueryIntent`](src/lib/intent/query-intent.ts) schema. It is the project's
frozen regression suite — reused by the ASR/NLU spikes and the deterministic
matcher — covering direct/indirect/conversational phrasing, comparisons, unit
variety, isotope and total-vs-per-nucleon ambiguity, and inverse queries.

```sh
pnpm validate:eval   # validate the dataset + print tag coverage
```

See [`eval/README.md`](eval/README.md) for the schema, labeling conventions,
and tag taxonomy. The validator also runs in CI and as a Vitest test.

## Alias tables

[`src/lib/aliases/`](src/lib/aliases/) maps natural-language phrases ("PMMA",
"carbon ions", "lung tissue") to canonical **libdedx** materials and particles —
the deterministic matcher's accuracy backbone, also reusable by dedx_web's text
search. `resolveMaterial()` / `resolveParticle()` do exact → normalized → fuzzy
matching and parse explicit isotopes ("carbon-13", "³He"). Tables are seeded
from libdedx (via dedx_web) plus the periodic table and shipped as both typed TS
and JSON ([`static/aliases/`](static/aliases/)).

```sh
pnpm generate:aliases   # regenerate the JSON artifacts from the TS tables
```

See [`docs/aliases.md`](docs/aliases.md) for provenance and how to regenerate
when libdedx updates.

## libdedx compute

[`src/lib/wasm/`](src/lib/wasm/) is a thin, dependency-free TypeScript wrapper
over the vendored **libdedx** WebAssembly module
([`static/wasm/`](static/wasm/)) — forward stopping power / CSDA range, inverse
lookups, and entity lists. It is lazy-loaded (`getService()`) so the shell ships
zero WASM until a query needs a number, and is kept clean of any
aidedx-specific concept so it can later be extracted as `@aptg/libdedx-wasm`
(issue #1 §17).

[`src/lib/compute/`](src/lib/compute/) bridges the two worlds:
`computeIntent(intent, service)` resolves a [`QueryIntent`](src/lib/intent/query-intent.ts)'s
particle/material phrases via the alias tables, converts energies to MeV/nucl
(honoring the total-vs-per-nucleon assumption), auto-selects a program, and
fans out over the comparison dimension — returning **real libdedx numbers,
never the LLM**. The end-to-end smoke suite
([`compute.smoke.test.ts`](src/lib/compute/compute.smoke.test.ts)) drives the
actual WASM under Node for the issue #1 §7 examples.

The binaries are prebuilt and checked in. See [`docs/wasm.md`](docs/wasm.md) for
the wrapper boundary, provenance, and how to regenerate them.

## Cross-origin isolation (deferred)

In-browser ML backends need `SharedArrayBuffer`, which requires the page to be
[cross-origin isolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated)
(COOP/COEP headers). GitHub Pages cannot set those headers, so the planned
workaround is [`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker).
A documented, intentionally-inert hook is left in `src/app.html`; the actual
hosting/runtime decision is deferred to Spike 3.
