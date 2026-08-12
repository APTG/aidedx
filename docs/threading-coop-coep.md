# WASM threading (COOP/COEP) — how much it actually cuts the ~8 s prefill (issue #9)

> **Status update, 2026-08-12 (issue #163 §5.3):** steps 1-2 of the plan below are shipped —
> `coi-serviceworker.js` is registered in `src/app.html` and `transcribe.ts` sets
> `env.backends.onnx.wasm.numThreads` explicitly under `crossOriginIsolated`. This is now the
> permanent production threading path, not the experiment described below; `app.html`'s comment
> was updated to match. Step 3 (live GitHub Pages + real S3 mirror verification, including Cache
> Storage surviving a reload cycle) is still outstanding — see §5.4 of issue #163.

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
  a separate measurement — now answered below (issue #60).

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

## Addendum (2026-07-16, issue #60): the WebGPU tier, measured — verdict is "not worth it"

_Session report. Apple M1 (MacBookAir10,1), 8 cores (4P+4E), 16 GB RAM, Metal 4, macOS 26.3. Real
(non-headless) Google Chrome via `playwright.chromium.launch({ channel: "chrome", headless: false })`
— headless Chromium's WebGPU support is inconsistent, so this deliberately used a real windowed
browser to get a genuine GPU adapter. Same stack versions as the rest of this doc: transformers.js
4.2.0 / `onnxruntime-web` 1.27.0._

### TL;DR

- **WebGPU works.** `navigator.gpu.requestAdapter()` succeeds, `pipeline(..., { device: "webgpu" })`
  builds a real Whisper encoder+decoder session and runs real inference — no silent fallback to WASM,
  no thrown errors, for either whisper-tiny or whisper-large-v3-turbo.
- **WebGPU is consistently faster than WASM in-browser, but only by ~15–20%** — not the multiples a
  properly GPU-resident large model's matmuls should show. whisper-tiny: 1045 ms vs 1264 ms prefill.
  whisper-large-v3-turbo: ~51.6 s vs ~61.3 s prefill. The similar percentage gain at both model sizes
  (rather than a much bigger win for turbo) is itself evidence that a lot of turbo's WebGPU run is
  still falling back to CPU per-op, not genuinely GPU-resident end to end (see Caveats).
- **The number that actually matters: turbo's real in-browser prefill (either backend) is ~10× worse
  than the reference numbers this issue was chasing.** `docs/asr-model-comparison.md` measured
  turbo's Node (`onnxruntime-node`) prefill at **8.1 s**; the shipped WASM whisper-small tier above
  measures **~5 s** (threaded, cold). This session's real-browser turbo prefill is **~52 s
  (WebGPU) / ~61 s (WASM)** for the same ~5 s of audio — roughly 6–12× slower than either reference
  point, on both browser backends.
- **Verdict: do not ship turbo-on-WebGPU as an optional tier.** The premise that WebGPU would unlock
  turbo's already-measured accuracy advantage at competitive latency doesn't hold on this hardware
  with this stack — the bottleneck isn't which in-browser backend you pick, it's that the in-browser
  path (both of them) is far slower than the Node number this issue's comparisons were built on. The
  manifest/UX scoping (device detection, a second model download, tier-select UI) is moot until that
  gap is closed, so it's not attempted here.
- **Update, same session, real audio:** once real eval clips were available (see "real audio"
  results below), a second finding emerged that the synthetic-tone test was blind to — **decode
  flips the other way.** WebGPU wins prefill by ~10–15%, same direction as the tone test, but WASM
  decodes real multi-token output **2–3× faster** than WebGPU. Autoregressive decode is a sequential
  chain of single-token steps, and each step's GPU-dispatch round-trip appears to cost more than
  WASM's native call overhead — the opposite tradeoff from prefill's one big batched matmul, which is
  exactly where WebGPU helps. Net effect on total latency is a wash to a slight WASM win; it doesn't
  change the verdict above, since both are still far behind the Node CPU number.

### Method

No app code changes — a throwaway SvelteKit route (`src/routes/webgpu-probe/+page.svelte`, never
committed) called `pipeline("automatic-speech-recognition", modelId, { dtype: "q8", device })`
directly, bypassing `src/lib/asr/transcribe.ts` (which has no `device` option today). This was
necessary rather than optional: this machine's local `eval/audio/` is empty (per-machine, gitignored,
never synced — `eval/RECORDING.md`), so `scripts/asr-browser-benchmark.mjs`'s real-clip harness
couldn't run here. Audio was instead a 5 s synthetic 220 Hz tone at 16 kHz mono. This is a valid proxy
for **prefill** (the encoder's cost scales with audio duration/frame count, not content) but not for
**decode** or **accuracy** — the tone produces a near-empty transcript (1–2 tokens), so decode timing
below is not meaningful and no E2E/slot-token score exists from this session. Turbo's accuracy number
remains whatever `docs/voice-pipeline-feasibility.md` §2.4.1 already measured on CPU/Node (91% E2E
prompted) — this session only adds the missing browser-latency half of the picture.

Each `(model, device)` pair built the pipeline once, then ran inference 5× back-to-back in the same
session (matching this doc's "repeated same-session" methodology above) to get a steady-state mean
uncontaminated by one-time session-build cost. whisper-tiny (~40 MB) ran first as a harness sanity
check before spending bandwidth/time on turbo (~650 MB, q8).

One environment note: this session started on a **completely full disk** (0 bytes free, mid-way
through unrelated work) which broke `pnpm`/Vite entirely until the user freed space. Once free space
was healthy (15+ GB), Chrome's Cache Storage still threw `QuotaExceededError` / `UnknownError` while
caching turbo's weights on every run — likely a stale per-origin quota calculated while the disk was
still near-full. This made "session load" (pipeline build time, ~24–26 s, dominated by re-fetching
uncached weights over the network) unreliable and it's excluded from the headline numbers above;
`prefill`/`decode` are measured strictly inside the `asr()` call, after the session already exists in
memory, so they're unaffected by whether the weight bytes were cache-hit or network-fetched.

### Results (mean over 5 warm repeats, one loaded session per row)

| model                       | device | prefill     | decode\* |
| --------------------------- | ------ | ----------- | -------- |
| whisper-tiny (q8)           | webgpu | **1045 ms** | 36 ms    |
| whisper-tiny (q8)           | wasm   | 1264 ms     | 10 ms    |
| whisper-large-v3-turbo (q8) | webgpu | **51.6 s**  | 95 ms    |
| whisper-large-v3-turbo (q8) | wasm   | ~61.3 s¹    | 51 ms    |

\* Not a meaningful per-token decode cost — see Method (synthetic audio decodes to 1–2 tokens).

¹ Mean of 4/5 planned runs (60.1, 60.6, 61.1, 63.5 s) — the harness's own 10-minute timeout closed the
browser before run 5. The trend across those 4 was flat-to-slightly-rising, not falling, so a 5th run
would not change the conclusion.

### Update: real eval audio (same session, once available)

The disk-space blocker above was resolved mid-session and the user copied the real 89-clip eval set
(`eval/audio/{km,lg,mn}/`) onto this machine, so the synthetic-tone limitation could be lifted for
turbo specifically. Same throwaway route, extended to accept real WAV files (decoded via `ffmpeg` in
the Node-side Playwright driver, injected into the page as a plain array reconstructed into a
`Float32Array` — `window.__clips`, set via `page.addInitScript`). Three clips spanning all three
speakers (`km/sp-005`, `mn/pernuc-001`, `lg/stress-001`; 5.25–8.6 s each), one inference per clip per
backend, no domain-prompt biasing (this probe calls `pipeline()` directly, bypassing
`transcribe.ts`'s prompt logic — a deliberate scope cut, not an oversight):

| clip          | device | prefill | decode | tokens | transcript                                                      |
| ------------- | ------ | ------- | ------ | ------ | --------------------------------------------------------------- |
| km/sp-005     | webgpu | 19.5 s  | 1.38 s | 16     | "Stopping power for 80 MeV per nucleon carbon ions in water."   |
| km/sp-005     | wasm   | 21.7 s  | 0.53 s | 16     | (identical text)                                                |
| mn/pernuc-001 | webgpu | 20.5 s  | 1.21 s | 16     | "Range of carbon ions in water at 290 mEV per u."               |
| mn/pernuc-001 | wasm   | 23.9 s  | 0.51 s | 16     | (identical text)                                                |
| lg/stress-001 | webgpu | 22.3 s  | 1.32 s | 17     | "I am curious how far in water the 240k EV carbon ion will go." |
| lg/stress-001 | wasm   | 25.9 s  | 0.57 s | 17     | (identical text)                                                |

Three things this settles that the synthetic tone couldn't:

1. **Transcripts are correct and identical between backends.** `km/sp-005`'s transcript is an exact
   match to the gold sentence; the other two show the same acoustic confusions this domain's own
   corrector already targets (`"290 MeV/u"` → `"290 mEV per u"`, `"240 keV"` → `"240k EV"` — the
   well-documented number+unit garbling from `docs/voice-pipeline-feasibility.md`, not a WebGPU
   artifact). WebGPU and WASM produced byte-identical text on all three clips — no numeric-precision
   regression from running on GPU.
2. **Prefill confirms the tone test: WebGPU is consistently ~10–14% faster**, real speech included.
3. **Decode does not confirm the tone test — it couldn't, at 1–2 tokens.** With 16–17 real tokens,
   WASM decodes in ~0.5–0.6 s vs WebGPU's ~1.2–1.4 s, a consistent 2–3× WASM advantage across all
   three clips (see TL;DR above for why: per-step GPU dispatch overhead on a sequential, one-token-
   at-a-time loop).

Total (prefill + decode) is **~21–24 s (WebGPU) / ~22–26 s (WASM)** per clip — the two backends land
within a few percent of each other overall, decode's WASM win largely offsetting prefill's WebGPU
win. Both remain **~4–5× slower than this same M1's own Node/CPU number for turbo** (see
`docs/apple-silicon-benchmark.md`'s addendum: 5.5–5.7 s/clip) — reinforcing, not softening, the "not
worth it" verdict: this isn't a WebGPU-vs-WASM question, native CPU beats the entire in-browser path
either way.

### Caveats / what this does _not_ prove

- **One machine, still no full E2E/slot-token score.** The real-audio update above spot-checks three
  transcripts by eye against gold text (one exact match, two showing the domain's known, already-
  corrected acoustic confusions) — a good sanity check, but not the full 89-clip scored run
  `scripts/asr-browser-benchmark.mjs` would give. That script still can't drive this comparison
  directly (no `device` option in `transcribe.ts`), so a full scored browser run remains future work
  if the latency gap ever closes enough to justify it.
- **The ~15–20% WebGPU-over-WASM gap is suspiciously small for a 650 MB model's matmuls**, and worth
  a follow-up before fully writing WebGPU off: `dtype: "q8"` may not have good WebGPU kernel coverage
  in this `onnxruntime-web` version, forcing many ops back onto the CPU/WASM path even under
  `device: "webgpu"` (transformers.js has been reported to pair `device: "webgpu"` better with
  `dtype: "fp16"` or `"q4"` than `"q8"` for exactly this reason). This session did not test other
  dtypes — it used `q8` throughout to stay consistent with every other number in this doc and
  `docs/asr-model-comparison.md`. A `dtype: "fp16"` re-run is the natural next experiment if turbo's
  accuracy advantage is ever worth revisiting.
- **Doesn't retest whisper-small on WebGPU.** The shipped CPU/WASM model was left alone; only the
  turbo/WebGPU pairing this issue asked about was measured.
