# Development & internals

Developer-facing reference for aidedx: the stack, the local workflow, deployment, and a tour of the
internal building blocks (eval set, alias tables, the libdedx WASM wrapper, and cross-origin
isolation). This is the material a contributor needs; the [README](../README.md) is the
short, narrative introduction for everyone else.

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

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds the static site (with
`BASE_PATH=/aidedx`) and publishes it to GitHub Pages at <https://aptg.github.io/aidedx/>. CI
(`.github/workflows/ci.yml`) runs format, lint, typecheck, unit tests, and a build on every
push/PR.

## Eval set

[`eval/intents.jsonl`](../eval/intents.jsonl) is a hand-labeled set of ~110 natural-language queries
mapped to the shared [`QueryIntent`](../src/lib/intent/query-intent.ts) schema. It is the project's
frozen regression suite — reused by the ASR/NLU spikes and the deterministic matcher — covering
direct/indirect/conversational phrasing, comparisons, unit variety, isotope and total-vs-per-nucleon
ambiguity, and inverse queries.

```sh
pnpm validate:eval   # validate the dataset + print tag coverage
```

See [`eval/README.md`](../eval/README.md) for the schema, labeling conventions, and tag taxonomy.
The validator also runs in CI and as a Vitest test.

## Alias tables

[`src/lib/aliases/`](../src/lib/aliases/) maps natural-language phrases ("PMMA", "carbon ions",
"lung tissue") to canonical **libdedx** materials and particles — the deterministic matcher's
accuracy backbone, also reusable by dedx_web's text search. `resolveMaterial()` /
`resolveParticle()` do exact → normalized → fuzzy matching and parse explicit isotopes
("carbon-13", "³He"). Tables are seeded from libdedx (via dedx_web) plus the periodic table and
shipped as both typed TS and JSON ([`static/aliases/`](../static/aliases/)).

```sh
pnpm generate:aliases   # regenerate the JSON artifacts from the TS tables
```

See [`docs/aliases.md`](./aliases.md) for provenance and how to regenerate when libdedx updates.

## libdedx compute

[`src/lib/wasm/`](../src/lib/wasm/) is a thin, dependency-free TypeScript wrapper over the vendored
**libdedx** WebAssembly module ([`static/wasm/`](../static/wasm/)) — forward stopping power / CSDA
range, inverse lookups, and entity lists. It is lazy-loaded (`getService()`) so the shell ships zero
WASM until a query needs a number, and is kept clean of any aidedx-specific concept so it can later
be extracted as `@aptg/libdedx-wasm` (issue #1 §17).

[`src/lib/compute/`](../src/lib/compute/) bridges the two worlds: `computeIntent(intent, service)`
resolves a [`QueryIntent`](../src/lib/intent/query-intent.ts)'s particle/material phrases via the
alias tables, converts energies to MeV/nucl (honoring the total-vs-per-nucleon assumption),
auto-selects a program, and fans out over the comparison dimension — returning **real libdedx
numbers, never the LLM**. The end-to-end smoke suite
([`compute.smoke.test.ts`](../src/lib/compute/compute.smoke.test.ts)) drives the actual WASM under
Node for the issue #1 §7 examples.

The binaries are prebuilt and checked in. See [`docs/wasm.md`](./wasm.md) for the wrapper boundary,
provenance, and how to regenerate them.

## Cross-origin isolation (deferred)

In-browser ML backends need `SharedArrayBuffer`, which requires the page to be
[cross-origin isolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated)
(COOP/COEP headers). GitHub Pages cannot set those headers, so the planned workaround is
[`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker). A documented,
intentionally-inert hook is left in `src/app.html`; the actual hosting/runtime decision is deferred
to Spike 3. See [`docs/threading-coop-coep.md`](./threading-coop-coep.md).

## Third-party licenses

aidedx is licensed **GPL-3.0-or-later** (see the [README](../README.md#license) for why). Everything
else it bundles or fetches at runtime is permissively licensed and compatible with GPL-3.0
(permissive code may be combined into a GPL-3.0 work; the reverse is not true):

| Component                                                                                       | License                                                                                                     | Notes                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Svelte, SvelteKit, Vite, TypeScript, Tailwind CSS, Vitest, ESLint, Prettier, Playwright         | MIT                                                                                                         | build/runtime tooling                                                                                                                                       |
| [`@huggingface/transformers`](https://github.com/huggingface/transformers.js) (transformers.js) | Apache-2.0                                                                                                  | in-browser ML runtime                                                                                                                                       |
| `onnxruntime-web`                                                                               | MIT                                                                                                         | ONNX inference backend                                                                                                                                      |
| [Whisper](https://github.com/openai/whisper) weights (`onnx-community/whisper-small`)           | MIT                                                                                                         | speech-to-text; mirrored to our Cyfronet S3 bucket, see [`docs/model-hosting-cyfronet.md`](./model-hosting-cyfronet.md)                                     |
| [Qwen2.5-0.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct) weights              | Apache-2.0                                                                                                  | listed in [`src/lib/models/manifest.ts`](../src/lib/models/manifest.ts), not yet mirrored/enabled                                                           |
| [Llama-3.2-1B-Instruct](https://huggingface.co/meta-llama/Llama-3.2-1B-Instruct) weights        | [Llama 3.2 Community License](https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/LICENSE) | custom, non-OSI license with an attribution ("Built with Llama") and acceptable-use-policy requirement; listed in the manifest but not yet mirrored/enabled |

`@img/sharp-libvips` (LGPL-3.0-or-later) is a transitive dependency of `sharp`, which is pulled in by
both `@huggingface/transformers` (a production dependency) and Playwright (dev/test tooling). It is
still never shipped to users, though: transformers.js's own browser build stubs `sharp` out entirely
as a Node-only module with no browser equivalent (verified in the built
`build/_app/immutable/workers/asr.worker-*.js` output — `// ignore-modules:sharp`), so it carries no
distribution obligation for aidedx itself.

## Deeper write-ups

- [`docs/design.md`](./design.md) — the original design & prototyping plan (issue #1): architecture,
  the `QueryIntent` schema, and phasing.
- [`docs/voice-pipeline-feasibility.md`](./voice-pipeline-feasibility.md) — audit of the ASR/NLU
  spikes' findings, with a revised architecture and measured numbers.
- [`docs/apple-silicon-benchmark.md`](./apple-silicon-benchmark.md) — the same benchmarks re-run on
  Apple Silicon (M5): ASR latency, LLM-NLU-fallback viability, KV-cache reuse.
- [`docs/asr-model-comparison.md`](./asr-model-comparison.md) — Whisper model-size comparison for the
  ASR stage.
- [`docs/nlu.md`](./nlu.md) — the deterministic NLU matcher.
- [`docs/aliases.md`](./aliases.md) — material/particle alias table provenance and regeneration.
- [`docs/wasm.md`](./wasm.md) — the libdedx WASM wrapper boundary and how to rebuild the binaries.
- [`docs/answer-pipeline.md`](./answer-pipeline.md) — matcher → compute → NLG → UI state, the layer
  after Whisper: unit conversion, error-message formatting, input validation.
- [`docs/local-model-cache.md`](./local-model-cache.md) — the Node-side `.hf-cache/` prefetch
  convention used by the benchmark scripts.
- [`docs/model-hosting-cyfronet.md`](./model-hosting-cyfronet.md) — mirroring model weights to
  Cyfronet S3 instead of Hugging Face's CDN.
- [`docs/status-panel-design.md`](./status-panel-design.md) — the model-status header,
  download-consent, and clear-cache UX.
- [`docs/threading-coop-coep.md`](./threading-coop-coep.md) — cross-origin isolation, `SharedArrayBuffer`,
  and the static-host threading constraint.
- [`docs/whisper-progress-feedback.md`](./whisper-progress-feedback.md) — download/inference progress
  UX for the Whisper stage.
  </content>
  </invoke>
