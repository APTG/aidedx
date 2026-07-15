# WASM threading (COOP/COEP) — how much it actually cuts the ~8 s prefill (issue #9)

_Session report, 2026-07-15. Local measurements on Linux, 12 logical cores, headless Chromium
(Playwright), the real shipped stack: SvelteKit static build + transformers.js 4.2.0 +
`onnxruntime-web` 1.27.0 (WASM), whisper-small q8 with domain-prompt biasing. This answers the two
open `coi-serviceworker` / threading checkboxes in issue #9, and extends the ~7.9 s single-thread
prefill baseline from `docs/whisper-progress-feedback.md` ("Real-browser verification") and the ASR
model comparison (`docs/asr-model-comparison.md`), which concluded threading — not a smaller model —
is the real lever on prefill._

## TL;DR

- **The bottleneck is real and threading does help — but only if you set the thread count yourself.**
  Just turning on COOP/COEP and changing nothing else drops prefill from **~8 s to only ~6.8 s
  (~16%)**, because transformers.js never sets `numThreads` and `onnxruntime-web`'s browser default
  is conservative. Explicitly setting `env.backends.onnx.wasm.numThreads` unlocks the real win.
- **With an explicit `numThreads = 8`, prefill drops to ~2.5 s (best-case cold) / ~4.7 s
  (sustained back-to-back) — a 2–3× improvement.** That takes the "Warming up…" phase a user waits
  through from ~8–10 s down to roughly 3–5 s.
- **8 threads is the sweet spot on a 12-core machine; 12 oversubscribes and regresses** on both
  prefill and decode (the thread pool then contends with the main thread and the browser itself).
- **Threading slightly _hurts_ decode** (~1.2 s → ~1.7 s at 8 threads): the autoregressive
  single-token loop is latency-bound and pays thread-sync overhead. Net is still a large win because
  prefill dominates the wall clock.
- **`coi-serviceworker` works.** On a header-less static host (GitHub Pages simulation) it flips
  `crossOriginIsolated` → `true` and enables `SharedArrayBuffer`, after a one-time auto-reload on the
  first visit. Using **COEP `credentialless`** lets the cross-origin ORT wasm (jsdelivr) and the
  Cyfronet S3 weight mirror load without needing their own CORP headers.
- **Verdict: the COOP/COEP + explicit-numThreads path is worth implementing** — it roughly halves
  the wait with no accuracy cost and no model change. Concrete plan at the bottom.

## Method

Two local static servers served the same `build/` output, differing only in response headers:

- **`COI=none`** — no cross-origin headers (simulates GitHub Pages). `crossOriginIsolated` is
  `false`, `onnxruntime-web` is forced single-threaded.
- **`COI=headers`** — `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
credentialless`. `crossOriginIsolated` is `true`, `SharedArrayBuffer` available.

Timings came from an augmented copy of `scripts/asr-browser-benchmark.mjs` (same DOM-progressbar
sampling for the "Warming up…"→"Processing…" prefill window, same `Worker`-message tap for
per-token decode timing). To vary the thread count, `env.backends.onnx.wasm.numThreads` was set in
`transcribe.ts` before pipeline load and the app rebuilt per value. All threaded runs confirmed
`crossOriginIsolated=true` + `SharedArrayBuffer=true` from inside the page, and the worker logged the
forced `numThreads`. **These edits were experiment-only and are not committed** — this doc is the
durable artifact.

Two measurement modes, both reported because they bracket real usage:

- **Fresh page load, one transcription per clip** — closest to a real user's single-shot cold run.
- **Repeated same-session (8× back-to-back, one page load)** — low variance, but sustained load on a
  shared box induces some throttling/contention a single-shot user won't hit, so it reads a bit
  higher than a true cold run.

## Results — thread-count sweep (whisper-small q8, 12-core Linux)

Steady-state (repeated same-session, 8 runs of `km/sp-005`, mean):

| config                                             | `crossOriginIsolated` | prefill    | decode (total) | vs 1-thread |
| -------------------------------------------------- | --------------------- | ---------- | -------------- | ----------- |
| **1 thread** (COOP/COEP off — ships today)         | false                 | **~9.8 s** | ~1.2 s         | —           |
| COOP/COEP on, `numThreads` **unset** (ORT default) | true                  | ~6.8 s¹    | ~1.3 s         | ~1.2×       |
| explicit `numThreads = 4`                          | true                  | ~5.7 s     | ~1.4 s         | ~1.7×       |
| **explicit `numThreads = 8` (sweet spot)**         | true                  | **~4.7 s** | ~1.7 s         | **~2.1×**   |
| explicit `numThreads = 12` (oversubscribed)        | true                  | ~5.6 s     | ~2.2 s         | ~1.8×       |

Cold single-shot (fresh page load) is faster than the sustained numbers above — the first isolated,
`numThreads = 8` transcription of a 5.4 s clip measured **~2.5 s prefill** (vs ~8 s single-thread on
the same fresh-load basis), i.e. closer to **3×**. Real users do one transcription per visit, so the
cold number is the more representative UX figure; the ~4.7 s steady-state is a conservative floor.

¹ The "unset" row is the important trap: this is what you get from _only_ adding COOP/COEP headers
and touching no code. transformers.js does not set `ort.env.wasm.numThreads` (the worker logged
`default numThreads = undefined`), so `onnxruntime-web` uses its own conservative browser default —
worth only ~16%. The 4/8/12 rows all required an explicit assignment.

Why decode gets _worse_ with more threads: decode is an autoregressive single-token loop, bound by
the sequential dependency chain, not by matmul width — so it barely parallelizes, and the WASM
thread pool's per-op synchronization is pure overhead there. Prefill (the encoder's one big batched
matmul over the fixed 30 s mel window) is exactly the opposite — it's what threads help. Since
prefill is ~85% of the wall clock, the net is a clear win despite the decode regression.

## Results — `coi-serviceworker` on a header-less host (the GitHub Pages question)

Served the build with **no** cross-origin headers and registered a vendored `coi-serviceworker.js`
(the gzuidhof service worker, COEP-credentialless variant). A Playwright probe:

```
[initial load]                 crossOriginIsolated=false  SharedArrayBuffer=false  sw.controller=false
  page> COOP/COEP Service Worker registered http://localhost:.../
  page> Reloading page to make use of updated COOP/COEP Service Worker.
[after SW install (auto-reload)] crossOriginIsolated=true  SharedArrayBuffer=true   sw.controller=true
[after manual reload]            crossOriginIsolated=true  SharedArrayBuffer=true   sw.controller=true

VERDICT: coi-serviceworker DID achieve cross-origin isolation on a header-less static host.
```

So the GitHub Pages path is viable: the SW injects COOP/COEP on every response client-side, and
after a **one-time auto-reload on the first visit** the page is cross-origin isolated for that visit
and all cached subsequent ones. `credentialless` (rather than `require-corp`) is what lets the
cross-origin ORT wasm from jsdelivr and the Cyfronet S3 weight mirror keep loading — confirmed in the
threaded runs above, which fetched both under `credentialless` with no CORP headers on those hosts.
The Cyfronet bucket's existing CORS policy (`scripts/cyfronet-cors-policy.xml`, `ACAO: *`) is
sufficient; no CORP header needs to be added there.

## Caveats / what this does _not_ prove

- **Hardware-dependent.** These are 12-core numbers. A typical 4–8 core laptop has less headroom —
  expect the sweet spot nearer `numThreads = 4` and a smaller absolute floor. The _relative_ 2–3×
  and the "set it explicitly, don't oversubscribe" conclusions should hold; the absolute prefill
  floor will vary. `Math.min(8, navigator.hardwareConcurrency)` (or `… / 2` to leave the main thread
  headroom) is the portable shape, to be tuned on real user hardware.
- **Not yet run live on GitHub Pages with the real S3 mirror end-to-end.** Cross-origin isolation
  and credentialless subresource loading were each validated locally, but issue #9's checkbox asks
  for a live GitHub Pages verification — still outstanding, and the one thing a local static server
  can't fully stand in for (SW scope, cache durability across real reload cycles).
- **First-visit reload.** `coi-serviceworker` reloads once on the first uncontrolled visit. It's a
  brief flash before any model download starts, but it is a real UX artifact to account for.
- **Measured on the non-Safari asyncify threaded ORT build.** Safari takes a different
  `onnxruntime-web` build; not measured here.
- **WebGPU tier untouched.** This is purely the WASM-threading lever. `whisper-large-v3-turbo` on
  WebGPU (the other #9 lever, and the highest-accuracy option per `docs/asr-model-comparison.md`) is
  a separate measurement.

## Recommendation / implementation plan

Implement the CPU-tier threading path — it roughly halves the user-visible warmup with zero accuracy
cost and no model swap. As a follow-up PR (needs the issue #9 hosting decision recorded alongside):

1. **Ship `coi-serviceworker.js`** in `static/` and register it in `app.html` — the inert hook is
   already there waiting (`src/app.html`'s cross-origin-isolation comment). Use the
   COEP-`credentialless` variant so the S3/jsdelivr fetches keep working.
2. **Set `env.backends.onnx.wasm.numThreads` explicitly** in `src/lib/asr/transcribe.ts` (and
   consider `download.ts`) when `crossOriginIsolated`, e.g. `Math.min(8, navigator.hardwareConcurrency)`
   — **do not** rely on the ORT default (the ~16% trap above). This one line is what converts
   COOP/COEP from a marginal win into a 2–3× one.
3. **Verify live on GitHub Pages** with the real Cyfronet S3 mirror, and confirm Cache Storage
   survives a reload cycle (issue #9's remaining checkboxes).
4. Optionally guard against oversubscription on high-core machines and re-tune `numThreads` against
   real user-hardware telemetry.

Expected outcome: the "Warming up…" wait drops from ~8–10 s to ~3–5 s for the same model and same
accuracy — the single biggest voice-latency improvement available without changing the model or the
runtime tier.
