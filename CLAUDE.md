# CLAUDE.md

Project context and conventions for Claude Code working in this repo.

## Stack at a glance

- **SvelteKit + Svelte 5** (runes only), **TypeScript strict**, **Tailwind CSS v4**
- **Vitest** for unit tests; **Node 24 LTS**; package manager **pnpm**
- Static site via `@sveltejs/adapter-static`, deployed to GitHub Pages
- Scripts run as plain TypeScript via Node's native type-stripping — no build step needed for `scripts/`

## CI gates (must all pass before merging)

```
pnpm run format:check   # Prettier
pnpm run lint           # ESLint
pnpm run check          # svelte-check + tsc
pnpm run validate:eval  # eval/intents.jsonl schema + tag validation
pnpm test               # Vitest
pnpm build              # SvelteKit static build
```

Run these locally before pushing. Never skip — CI runs exactly the same commands in this order (`static-analysis` job, then `build` job).

## Branches CI watches

Pattern: `main`, `claude/**`, `feature/**`, `feat/**`, `fix/**`. Work on spike branches uses `spike<N>-<slug>` but those still match because of manual dispatch + PRs targeting `main`.

## Commit / PR conventions

- Prefix the title with the scope, e.g. `[spike2-llm-nlu]`, `fix(lint):`, `feat(cache):`.
- One PR per spike/feature; keep formatting/lint fixes as separate commits on the same branch.
- PR description should include: what changed, measured results (for evals), lowered/adjusted goals if the original scope changed, and a test plan checklist.

## Eval set (`eval/intents.jsonl`)

- **Frozen regression suite** — every example must parse and validate; `pnpm validate:eval` enforces this.
- Every tag must be a member of `EVAL_TAGS` in `src/lib/intent/query-intent.ts`. Add new tags there first, then use them.
- `"stress-test"` is reserved for exactly the two §7 sentences checked by `query-intent.test.ts` (the "240 keV carbon ion" and "neon ions in water and air" examples). Use `"adversarial"` for LLM-fallback / hard examples added by spikes.
- When adding new examples, run `pnpm coverage:intents` to confirm they show up as misses or hits as intended.

## Benchmark / model eval scripts

- Load each model in a **separate child process** (`spawnSync`) to avoid OOM — never load all three ONNX models in the same Node heap.
- Create output directories **before** spawning children (`mkdirSync(dir, { recursive: true })`); child processes can't rely on the directory existing.
- Use `node:fs` synchronous imports (`readFileSync`, `writeFileSync`, `mkdirSync`) — async dynamic imports inside child output handlers cause race conditions.
- ONNX models are pre-cached in `.hf-cache/onnx-community/`; set `env.cacheDir` to that path and `env.allowLocalModels = false`.

## Common CI failure causes and fixes

| Failure                                             | Cause                                          | Fix                                                                             |
| --------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| Prettier CI fails despite running `--write` locally | Stale Prettier cache suppresses output         | Run `pnpm prettier --write <file>` (pnpm-invoked prettier bypasses cache)       |
| `no-empty` ESLint error                             | Empty `catch {}` block                         | Use `catch { /* reason */ }` (optional catch binding + non-empty block)         |
| `no-unused-vars` on `catch (_e)`                    | Named but unused error variable                | Use bare `catch { }` instead                                                    |
| Test `includes both §7 stress-test sentences` fails | New examples accidentally tagged `stress-test` | Use `adversarial` tag instead; `stress-test` is for exactly 2 specific examples |
| `ENOENT` writing result JSON in multi-model eval    | Output dir missing when child writes           | Call `mkdirSync(dir, { recursive: true })` in the orchestrator before spawning  |

## Issue & PR conventions

When writing GitHub issue comments or instructions for collaborators, use browser/UI-based steps — do **not** reference the `gh` CLI (collaborators may not have it installed).

## Key source files

| Path                             | Role                                                         |
| -------------------------------- | ------------------------------------------------------------ |
| `src/lib/intent/query-intent.ts` | `QueryIntent` schema, `EVAL_TAGS`, `validateQueryIntent()`   |
| `src/lib/intent/matcher.ts`      | Deterministic NLU matcher (`matchIntent`)                    |
| `src/lib/intent/coverage.ts`     | Coverage harness (`runCoverage`, `compareIntent`)            |
| `src/lib/aliases/`               | Material + particle alias tables for libdedx                 |
| `src/lib/wasm/`                  | libdedx WASM wrapper (`getService()`)                        |
| `src/lib/compute/`               | `computeIntent()` — resolves a `QueryIntent` to real numbers |
| `eval/intents.jsonl`             | Hand-labeled eval set (~120 examples)                        |
| `scripts/llm-nlu-eval.ts`        | LLM NLU spike eval harness (Spike 2 / issue #8)              |
