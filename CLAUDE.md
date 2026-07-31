# CLAUDE.md

Project context and conventions for Claude Code working in this repo.

## Stack at a glance

- **SvelteKit + Svelte 5** (runes only), **TypeScript strict**, **Tailwind CSS v4**
- **Vitest** for unit tests; **Node 24 LTS**; package manager **pnpm**
- Static site via `@sveltejs/adapter-static`, deployed to GitHub Pages
- Scripts in `scripts/` run as plain TypeScript via Node's native type-stripping — no build step needed

## CI gates (must all pass before merging)

```
pnpm run format:check   # Prettier
pnpm run lint           # ESLint
pnpm run check          # svelte-check + tsc
pnpm run validate:eval  # eval/intents.jsonl schema + tag validation
pnpm test               # Vitest
pnpm build              # SvelteKit static build
```

Run these locally before pushing. CI runs the same gate commands in this order (`static-analysis` job,
then `build` job) and also runs `pnpm run coverage:intents` as a non-blocking metric.

## Branches CI watches

Pattern: `main`, `claude/**`, `feature/**`, `feat/**`, `fix/**`. Spike branches (`spike<N>-<slug>`) are
covered via manual dispatch and PRs targeting `main`.

## Commit / PR conventions

- Prefix the title with the scope: `[spike2-llm-nlu]`, `fix(lint):`, `feat(cache):`, etc.
- One PR per spike/feature; keep formatting/lint fixes as separate commits on the same branch.
- PR description must include: what changed, measured results (for evals), adjusted goals if scope
  changed, and a test-plan checklist.

## Eval set (`eval/intents.jsonl`)

- **Frozen regression suite** — every example must parse and validate; `pnpm validate:eval` enforces
  this in CI.
- Every tag must be a member of `EVAL_TAGS` in `src/lib/intent/query-intent.ts`. Add new tags there
  first, then use them in `.jsonl`.
- `"stress-test"` is reserved for the two §7 sentences checked by `query-intent.test.ts` (the
  "240 keV carbon ion" and "neon ions in water and air" examples). Use `"adversarial"` for
  LLM-fallback / hard examples added by spikes.
- After adding examples, run `pnpm coverage:intents` to confirm they appear as misses or hits.

## Benchmark / model eval scripts

- Load each model in a **separate child process** (`spawnSync`) — never load all ONNX models in one
  Node heap (OOM).
- Create output directories **before** spawning children: `mkdirSync(dir, { recursive: true })` in the
  orchestrator; child processes cannot rely on the directory existing.
- Use `node:fs` synchronous imports (`readFileSync`, `writeFileSync`, `mkdirSync`) — async dynamic
  imports inside child output handlers cause race conditions.
- ONNX models are pre-cached in `.hf-cache/onnx-community/`; set `env.cacheDir` to that path and
  `env.allowLocalModels = false`.

## Android bench apps (`bench/android/*`)

- Building locally (`./gradlew assembleDebug`) needs a full JDK (`javac`), not just a JRE. This
  machine has no system-wide JDK installed (`apt`'s `openjdk-17-jre`/`openjdk-21-jre` are JRE-only —
  `javac` is absent from both), and installing one needs interactive `sudo`. **Use Android Studio's
  bundled JBR instead** — it's already a full JDK, already on disk, and needs no install: it lives
  under wherever Android Studio is installed, typically `<android-studio-install-dir>/jbr` (e.g.
  `~/Applications/android-studio/jbr` on Linux, `.../Android Studio.app/Contents/jbr` on macOS):
  `JAVA_HOME=<path-to-android-studio>/jbr ./gradlew assembleDebug`.
- Test devices connect over wireless adb; if `adb devices` doesn't list one, reconnect with
  `adb connect <device-ip>:5555` (ask the user for the current IP — it's not fixed).

## Common CI failure causes and fixes

**Prettier CI fails despite running `--write` locally** — different Prettier version/plugins than CI
(global/IDE formatter vs repo-pinned). Run `pnpm run format` (uses the repo's Prettier + plugins), then
re-run `pnpm run format:check`.

**`no-empty` ESLint error** — empty `catch {}` block. Use `catch { /* reason */ }` (optional catch
binding with a non-empty comment).

**`@typescript-eslint/no-unused-vars` on `catch (_e)`** — named but unused error variable. Use
`catch { /* intentionally ignored */ }` (no binding + non-empty block).

**Test `includes both §7 stress-test sentences` fails** — new examples accidentally tagged
`"stress-test"`. Use `"adversarial"` instead; `"stress-test"` is reserved for exactly 2 examples.

**`ENOENT` writing result JSON in multi-model eval** — output dir missing when child process writes.
Call `mkdirSync(dir, { recursive: true })` in the orchestrator before spawning.

## Issue & PR conventions

When writing GitHub issue comments or instructions for collaborators, use browser/UI-based steps. Do
**not** reference the `gh` CLI — collaborators may not have it installed.

**Research/spike issues must land findings in a committed doc before closing.** If an issue's job is
to answer a question (a "Spike N", a benchmark run, an investigation) rather than ship a feature,
its conclusion must go into a new or updated `docs/*.md` file — not just a closing comment. A comment
thread is easy to miss, isn't linked from code, and isn't part of the durable project record the way
`docs/*.md` is. `docs/voice-pipeline-feasibility.md` and `docs/apple-silicon-benchmark.md` are the
model to follow: audit what prior comments found, correct anything that doesn't hold up, and leave a
self-contained report the next reader doesn't have to reconstruct from issue history.

**Every PR gets a Copilot review before merge.** After opening a PR, request a review from
`copilot-pull-request-reviewer[bot]` (`gh api repos/<owner>/<repo>/pulls/<n>/requested_reviewers -f
"reviewers[]=copilot-pull-request-reviewer[bot]"` — `gh pr edit --add-reviewer copilot` doesn't
resolve the login and fails). Wait for the review, address every comment (fix or explicitly justify
skipping), and make sure CI is green before merging.

## Key source files

- `src/lib/intent/query-intent.ts` — `QueryIntent` schema, `EVAL_TAGS`, `validateQueryIntent()`
- `src/lib/intent/matcher.ts` — deterministic NLU matcher (`matchIntent`)
- `src/lib/intent/coverage.ts` — coverage harness (`runCoverage`, `compareIntent`)
- `src/lib/aliases/` — material + particle alias tables for libdedx
- `src/lib/wasm/` — libdedx WASM wrapper (`getService()`)
- `src/lib/compute/` — `computeIntent()` — resolves a `QueryIntent` to real numbers
- `src/lib/nlg/render.ts` — `renderAnswer()` — templated `ComputeResult` → plain-text answer lines
- `src/lib/answer/answer-status.svelte.ts` — reactive store wiring query text → matcher → compute →
  NLG (`answerStatus.submit()`), shared by the typed query and the mic transcript (issue #39)
- `eval/intents.jsonl` — hand-labeled eval set (~120 examples)
- `scripts/validate-intents.ts` — `pnpm run validate:eval` entrypoint (schema + tag validation)
- `scripts/coverage-intents.ts` — `pnpm run coverage:intents` deterministic NLU coverage
- `scripts/generate-aliases.ts` — regenerates alias tables under `src/lib/aliases/`
- `scripts/llm-nlu-eval.ts` — LLM NLU spike eval harness (Spike 2 / issue #8)
- `scripts/asr-browser-benchmark.mjs` — Playwright real-browser ASR timing benchmark (needs a running
  `pnpm dev`/`pnpm preview`); see `docs/whisper-progress-feedback.md`'s "Real-browser verification"
