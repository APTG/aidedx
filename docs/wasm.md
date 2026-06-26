# libdedx WASM wrapper

aidedx computes every stopping-power / range number with **libdedx**, compiled
to WebAssembly and run **entirely in the browser** — never the LLM (issue #1
§4). This document covers the vendored artifacts, the wrapper boundary, and how
to regenerate the binaries.

## Layers

```
QueryIntent ─▶ src/lib/compute/   ─▶ src/lib/wasm/   ─▶ libdedx.wasm
              (intent → numbers)     (typed wrapper)     (physics)
```

- **`src/lib/wasm/`** — a thin, dependency-free TypeScript wrapper over the
  Emscripten module: entity lists, forward stopping power / CSDA range (single
  and multi-program), inverse lookups, and the per-particle / per-material
  metadata needed for unit conversion. It knows nothing about `QueryIntent` or
  the alias tables, so it is the unit that issue #1 §17 plans to extract into a
  shared **`@aptg/libdedx-wasm`** package. Keep it that way: no imports from
  `src/lib/intent/`, `src/lib/aliases/`, or `src/lib/compute/`.
- **`src/lib/compute/`** — maps a resolved `QueryIntent` to libdedx calls:
  resolves particle/material phrases via the alias tables (issue #4), converts
  energies to MeV/nucl honoring the total-vs-per-nucleon assumption (issue #1
  §7), auto-selects a program, and fans out over the comparison dimension.

`computeIntent(intent, service)` is the entry point the resolver/NLG layers
call. The WASM is lazy-loaded so the app shell ships zero WASM until a query
needs a number. The loader is split to keep the core host-agnostic:
`loader.ts` (`createService` / `loadService(baseUrl)`) has no framework
dependency, and `sveltekit.ts` (`getService()`) is the only file that imports
`$app/paths` — app code imports it as `$lib/wasm/sveltekit`.

For efficiency the wrapper's `calculate()` accepts `{ computeCsda: false }`;
the compute layer passes it for `stoppingPower` queries so they never trigger
the CSDA integrator. It also validates energies against
`getMinEnergy`/`getMaxEnergy` before calling into WASM, returning a clear
per-series error for out-of-range input.

## Vendored artifacts

`static/wasm/libdedx.mjs` + `static/wasm/libdedx.wasm` are **prebuilt** and
checked in (the `.mjs`/`.wasm` are ~17 KB + ~468 KB, no `.data` sidecar). They
are generated artifacts — excluded from ESLint and Prettier — and serve as plain
static assets, copied into `build/wasm/` at build time.

Provenance:

- **libdedx** source: `APTG/libdedx`, the commit pinned by the `libdedx`
  submodule in `APTG/dedx_web` (currently `60d05f0`).
- **Build glue**: `wasm/dedx_extra.{c,h}` and the emcc flags from
  `APTG/dedx_web` `wasm/build.sh`. The thin C wrappers expose internal libdedx
  functions (nucleon number, atomic mass, density, gas flag, flat inverse
  lookups). See dedx_web `docs/06-wasm-api-contract.md` — the contract this
  wrapper implements.

We do **not** maintain a second Emscripten build pipeline; we vendor dedx_web's.

## Regenerating the binaries

The reproducible path is dedx_web's Docker build (`emscripten/emsdk:5.0.5`):

```sh
# in a dedx_web checkout with submodules initialized
./wasm/build.sh            # → static/wasm/libdedx.{mjs,wasm}
node wasm/verify.mjs       # contract checks (44/44 PASS)
```

then copy the two files into this repo's `static/wasm/`.

If Docker is unavailable, the same result comes from a native emsdk 5.0.5:

```sh
emcmake cmake libdedx -B build-wasm -DDEDX_BUILD_EXAMPLES=OFF \
  -DDEDX_BUILD_TESTS=OFF -DCMAKE_BUILD_TYPE=Release
emmake cmake --build build-wasm --parallel
emcc build-wasm/src/libdedx.a wasm/dedx_extra.c -o static/wasm/libdedx.mjs \
  -I wasm -I libdedx/include \
  -s EXPORT_ES6=1 -s MODULARIZE=1 -s WASM=1 -s ENVIRONMENT='web,node' \
  -s ALLOW_MEMORY_GROWTH=1 -O2 \
  -s 'EXPORTED_FUNCTIONS=[...]' -s 'EXPORTED_RUNTIME_METHODS=[...]'
```

The exact `EXPORTED_FUNCTIONS` / `EXPORTED_RUNTIME_METHODS` lists are in
dedx_web `wasm/build.sh`. `ENVIRONMENT='web,node'` is what lets the smoke tests
load the module under Node (`src/lib/compute/compute.smoke.test.ts`); the
browser path uses the same `.mjs`.

When the binaries are regenerated, keep the `EmscriptenModule` interface in
`src/lib/wasm/types.ts` in lock-step with the exported-functions list.

## Program auto-selection

When an intent carries no explicit `program`, the compute layer picks one per
particle: proton → **PSTAR**, alpha → **ASTAR**, heavier ions → **MSTAR**. The
general Bethe program (`DEFAULT`) is avoided as an auto pick because its adaptive
CSDA integrator can recurse unboundedly at very low energies. An explicit
`program` on the intent (e.g. "using PSTAR") overrides the heuristic.

## Out of scope for this phase

The full dedx_web contract also covers custom compounds, advanced options
(MSTAR mode, aggregate state, spline interpolation, density / I-value
overrides), and electron/ESTAR (not implemented in libdedx v1.4.0). These are
intentionally omitted here; the vendored binary still exports the custom-compound
entry points, so they can be added to the wrapper later without a rebuild.
