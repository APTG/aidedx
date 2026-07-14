# Model status header, download-consent, and clear-cache UX

## Status: shipped

Implemented by [PR #33](https://github.com/APTG/aidedx/pull/33), following design option **1b**
from the mockup this doc is a companion to:
[`docs/status-panel-mockup/aidedx-status-explorations.dc.html`](./status-panel-mockup/aidedx-status-explorations.dc.html)
(vendored from an attachment on [issue #32](https://github.com/APTG/aidedx/issues/32) — see
"Design mockup" below). This page captures the spec and the _why_ behind it in prose, so a future
reader doesn't have to open a closed issue (or a non-trivial interactive HTML file) to find them.

**Relevance to issue #17** ("Basic/Advanced mode toggle + hardware status panel"): the status
pill/panel described here already ships everything #17's "hardware status panel" table asked
for (GPU, RAM, cache, and — beyond what #17 asked for — a model-download state too), and it's
**always visible** in the header, not gated behind any mode toggle. #17's only real remaining
scope is the Basic/Advanced toggle itself, if that's still wanted.

## What it looks like

- A compact **status pill** in the header — a colored dot + one-line summary (e.g.
  `Ready · 240 MB`, today's total for the one currently-mirrored model, whisper-small — it'll grow
  once qwen/llama are mirrored too, see `src/lib/models/manifest.ts`) — that expands into a panel on
  click/tap. Sits next to a dark-mode toggle that persists to `localStorage`.
- The panel has four rows: **Model** (Not downloaded / Downloading… NN% / Ready), **Disk cache**
  (size + an inline Clear action once non-zero), **Memory (RAM)**, **Hardware** (`GPU · WebGPU` or
  `CPU only`).
- A **blocking "Download model weights?" dialog** on first visit if nothing's cached yet — Not now
  (drops to a slim inline banner) / Download now (opens the progress dialog).
- A **download progress dialog** — real per-file + aggregate progress bars, ETA, source host,
  Cancel — bottom sheet on mobile, centered dialog (~440px) on desktop.
- A **clear-cache confirmation** dialog with a real breakdown of what will be deleted.

## Why option 1b

Three layouts were explored in the mockup (all sharing the same hero — title, input, disabled mic,
search — varying only where status lives and how the download decision is presented). 1b won
because it keeps the hero completely uncluttered (status lives in one small pill, expanding only on
demand), the blocking first-visit modal is the clearest way to get explicit consent before a large,
possibly-metered download (a hard product requirement), and the same pill/modal pair scales to
desktop unchanged (centered instead of bottom-sheeted).

## Technical notes (what shipped, and what was still open)

- **Hardware detection**: `navigator.gpu.requestAdapter()` first; on failure/absence, falls back
  to a WebGL `UNMASKED_RENDERER_WEBGL` string; otherwise `"CPU only"`. WebGPU is also the signal
  that decides which in-browser inference backend transformers.js picks, so this tile reuses the
  same detection the app needs anyway.
- **Memory (RAM)**: best-effort only — `performance.memory` (Chrome/Edge-only, reports JS heap
  size, not WASM linear-memory model weights) renders a number; everywhere else the tile shows `—`
  rather than fabricating one. **Still open** (flagged as a follow-up, not blocking): reading the
  ONNX runtime/wllama instance's WASM `memory.buffer.byteLength` would be more accurate, since most
  model-weight memory lives there, not on the JS heap.
- **Disk cache — issue #32's open question 1, now resolved**: confirmed by reading
  `@huggingface/transformers`'s source that it uses the **Cache Storage API**
  (`caches.open(env.cacheKey)`, default cache name `"transformers-cache"`) in-browser, not
  IndexedDB. The panel enumerates that cache for the size breakdown; total usage additionally comes
  from `navigator.storage.estimate()`. Cache-usage warning threshold: 1.5 GB (danger color + more
  prominent Clear above that).
- **Clear cache**: deletes the actual Cache Storage buckets matching the model caches (real
  deletion, not a mock).
- **Download progress**: wired to `@huggingface/transformers`'s own `progress_callback` (per-file
  `status`/`file`/`loaded`/`total`/`progress` events) rather than a hand-rolled
  `fetch`+`ReadableStream` reader, since that's what's already loading the files. One bug found via
  live testing against real huggingface.co traffic: **Cancel did nothing** until the in-flight file
  finished, because the abort signal was only checked _between_ files. Fixed by racing the in-flight
  download promise against the abort signal (`raceAbort` in `src/lib/models/download.ts`), so the UI
  reverts immediately — the underlying fetch itself still isn't truly interrupted (transformers.js
  exposes no abort hook, **issue #32's open question 2**) and finishes in the background, landing in
  the cache anyway; harmless, just not instant cancellation at the network level.
- The model set shipped in PR #33 was Whisper-tiny/Qwen2.5-0.5B/Llama-3.2-1B (~1.1 GB) as
  placeholders; the manifest (`src/lib/models/manifest.ts`) now ships **whisper-small** instead of
  whisper-tiny, to match the model actually mirrored to Cyfronet (see
  [`docs/model-hosting-cyfronet.md`](./model-hosting-cyfronet.md)) — `qwen`/`llama` stay listed but
  `available: false` until they get their own mirror.

## Known limitations (flagged in PR #33, not blocking)

- The first-visit download prompt's dismissal is in-memory only, not persisted to `localStorage` —
  a full page reload re-shows the consent gate if weights still aren't cached. This matches the
  design mock's own (non-persisted) state machine; flagged in case the original intent was for
  "Not now" to persist across reloads.
- No focus trap in the dialogs — Tab can still reach background elements behind an open blocking
  modal. All buttons are native `<button>` elements with visible `:focus-visible` rings and
  `aria-label`/`aria-modal`/`role="dialog"`, which satisfies keyboard-operability, but a true trap
  is a possible follow-up.
- A real, full ~1.1 GB download-to-`ready`-to-clear-cache cycle wasn't exercised end-to-end in CI
  (bandwidth/time cost); the individual pieces are each covered by unit tests plus a live partial-
  download check.

## Design mockup

[`docs/status-panel-mockup/`](./status-panel-mockup/) contains the original interactive HTML
exploration (`aidedx-status-explorations.dc.html` + its generated support runtime, `support.js`),
vendored from a comment attachment on issue #32 so the design source doesn't depend on GitHub's
attachment hosting. It shows all three layout options (1a/1b/1c) with mobile/desktop toggles and
clickable state transitions (Fresh → Downloading → Ready → Clear-cache); option 1b above is the one
that shipped. `support.js` is a generated third-party rendering runtime for that file's
`{{ }}`-templated format, not aidedx code — see the "do not edit" header in the file itself; both
are excluded from Prettier/ESLint (`.prettierignore`, `eslint.config.js`) as vendored, not
hand-maintained.

**Not fully offline.** "Vendored" here means the repo doesn't depend on GitHub's attachment hosting
for the file itself — it does **not** mean the mockup is self-contained. Opening the HTML fetches
and executes React, ReactDOM, and Babel Standalone from `unpkg.com` at runtime (specific versions
pinned via SRI hashes, but still a live third-party fetch). This is fine for a developer-only design
reference that's never loaded by an aidedx user, but worth knowing before opening the file on an
untrusted or offline network.

## Related

- Issue #32 — the original request, superseded by this doc.
- [PR #33](https://github.com/APTG/aidedx/pull/33) — the implementation.
- [`docs/local-model-cache.md`](./local-model-cache.md) — the Node-side cache convention (separate
  from the browser Cache Storage API this panel reads).
- [`docs/model-hosting-cyfronet.md`](./model-hosting-cyfronet.md) — why the manifest ships
  whisper-small.
- Issue #17 — the toggle-only scope this doc's "Relevance" note above narrows it to.
