# Whisper transcription progress feedback — feasibility research

_Session report, 2026-07-14. Answers a direct question: can the mic-to-text flow (issue #37,
just shipped) show something better than an indeterminate spinner while Whisper transcribes —
live word-by-word text, a "N seconds of the recording processed" readout, or both? Verified by
reading the actual pinned dependency source (`@huggingface/transformers@4.2.0`, installed fresh
into this checkout — see §7 for how). No Cyfronet S3 access was used or needed — see §0._

## TL;DR

- **Issue #37 shipped with the claim "transformers.js doesn't expose token-level progress for
  the encoder/decoder forward pass ... so this is an indeterminate/spinner treatment, not a
  percentage bar." That claim does not hold for the pinned version.** `@huggingface/
transformers@4.2.0` exports a public `WhisperTextStreamer` class
  (`src/generation/streamers.js`, re-exported from the package root and present in the built
  browser bundle) that fires **four** kinds of live callbacks during decoding: per-word text
  (`callback_function`), per-token (`token_callback_function`), per-audio-segment start/end in
  seconds (`on_chunk_start`/`on_chunk_end`), and stream-end (`on_finalize`). This is wired all
  the way through: the base `generate()` loop calls `streamer.put()` after **every** generated
  token (`modeling_utils.js`), and the ASR pipeline's `_call_whisper` forwards a `streamer`
  passed in the call options straight into `model.generate()` — no extra plumbing needed.
- **Word-level live streaming ("how many words already generated") works today, unmodified,
  with the app's existing domain-prompt-biased decoding setup** (`transcribe.ts`'s
  `buildDomainPromptOptions()`). It needs no accuracy re-validation because it doesn't touch
  decoding at all — it just listens to tokens as they're generated.
- **Seconds-of-audio-processed progress ("how many seconds of recording did it process") is
  also available**, via `on_chunk_start`/`on_chunk_end`, but **only when Whisper is generating
  timestamp tokens** (`return_timestamps: true`). The app's domain-prompt code currently forces
  the opposite (`<|notimestamps|>` baked into `decoder_input_ids`, deliberately, as part of the
  §2.4 domain-prompt fix in `docs/voice-pipeline-feasibility.md`). Turning timestamps on is a
  small, well-understood change (traced through `modeling_whisper.js`'s seek-loop implementation,
  §3.2) but it touches the exact mechanism `voice-pipeline-feasibility.md` §2.4 validated for
  accuracy — it should ship with a re-run of the slot-token eval, not on faith.
- **What's genuinely unverified in this session**: whether the callback firings translate into
  _visibly live_ UI updates in a real browser. An attempt to measure real wall-clock timing
  empirically (§2) was blocked by this sandbox's network policy before it could prove anything.
  ASR currently runs on the main thread (no Web Worker anywhere in `src/lib/asr/`), and — this
  matters independently of that failed attempt — Node uses a completely different ONNX execution
  provider (`onnxruntime-node`, native bindings) than the browser
  (`onnxruntime-web`, WASM/WebGPU), so even a successful Node timing run couldn't have settled
  "does WASM block the main thread between tokens." §4 explains why, and recommends the one
  change (a dedicated Worker) that makes the answer not matter.
- **Recommendation, in priority order**: (1) ship live word-by-word streaming text now — cheap,
  safe, directly answers half the ask; (2) add a real seconds-processed progress fraction behind
  `return_timestamps: true`, gated on re-running the eval harness; (3) move ASR inference into a
  Web Worker so live updates are guaranteed to render smoothly regardless of ONNX Runtime's
  internal threading behavior — the same architecture transformers.js's own official demo apps
  use.

## 0. Constraint: no Cyfronet S3 access

The production app points `env.remoteHost` at a Cyfronet-hosted mirror of model weights
(`src/lib/models/remote.ts`, `docs/model-hosting-cyfronet.md`) that this session has no
credentials for. Nothing in this report needed it: the source-reading in §1/§3 needed no model
weights at all (just `pnpm install`, which pulls the JS package itself from the public npm
registry). §2 describes a separate, unrelated attempt to fetch model weights from the _public_
`huggingface.co` hub (never Cyfronet) for an empirical timing run, and why that specific attempt
didn't complete — see there for detail; it isn't a Cyfronet-access problem.

## 1. What's actually in `@huggingface/transformers@4.2.0` (read from source, not docs/blog posts)

Installed fresh via `pnpm install` (this checkout had no `node_modules` yet — dependencies
weren't installed in this session's container). All citations below are file:line references
into `node_modules/@huggingface/transformers/src/...` as it exists at the version pinned in
`package.json` (`^4.2.0`, resolved to exactly `4.2.0` — the same version `transcribe.ts`'s module
comment already discusses in detail for an unrelated `onnxruntime-web` bug, and the same
`onnxruntime-web@1.27.0` override from `pnpm.overrides` applies). `node_modules` isn't committed,
but `pnpm install` reproduces the identical pinned version, so these paths are reproducible by
anyone who checks out this branch and runs it.

### 1.1 The streamer classes exist and are public API

`src/generation/streamers.js` defines three classes, all re-exported from the package root
(`src/transformers.js:45`: `export * from './generation/streamers.js';`; confirmed present in the
built browser bundle — `dist/transformers.web.js` and `dist/transformers.min.js` both contain
`WhisperTextStreamer` verbatim, so `import { WhisperTextStreamer } from '@huggingface/
transformers'` is a normal top-level import, not a deep/internal one):

```js
export class BaseStreamer {
  put(value) { throw Error('Not implemented'); }   // called by generate() per step
  end() { throw Error('Not implemented'); }         // called by generate() when done
}

export class TextStreamer extends BaseStreamer {
  constructor(tokenizer, {
    callback_function = null,        // (text: string) => void — fires per completed word(s)
    token_callback_function = null,  // (tokens: bigint[]) => void — fires per generated token
    skip_prompt = false,
    ...
  } = {}) { ... }
}

export class WhisperTextStreamer extends TextStreamer {
  constructor(tokenizer, {
    callback_function = null,        // inherited: per-word text
    token_callback_function = null,  // inherited: per-token
    on_chunk_start = null,           // (audioTimeSeconds: number) => void
    on_chunk_end = null,             // (audioTimeSeconds: number) => void
    on_finalize = null,              // () => void
    time_precision = 0.02,
    ...
  } = {}) { ... }
}
```

`WhisperTextStreamer.put()` (`streamers.js:227-252`) inspects each incoming token: if it's a
timestamp token (id ≥ `tokenizer.timestamp_begin`), it computes
`time = (token - timestamp_begin) * time_precision` and fires `on_chunk_start`/`on_chunk_end`
(toggling between the two on successive timestamp tokens); otherwise it falls through to
`TextStreamer.put()`, which accumulates tokens, decodes them, and fires `callback_function` as
soon as a whole word boundary is reached — it explicitly buffers partial words ("prints until the
last space char ... to avoid printing incomplete words, which may change with the subsequent
token", `streamers.js:129-132`).

### 1.2 It's wired all the way through `generate()`, not decorative

`src/models/modeling_utils.js` — the base `PreTrainedModel.generate()` every model, including
Whisper (for the common short-audio case, §3.2), ultimately runs:

```js
// line 944-946, before the decode loop starts:
if (streamer) {
  streamer.put(all_input_ids);
}

// line 1013-1015, inside the autoregressive loop, once per generated token:
if (streamer) {
  streamer.put(generated_input_ids);
}

// line 1030-1032, after the loop ends:
if (streamer) {
  streamer.end();
}
```

This is a real per-token hook, not a coarse end-of-batch callback — `streamer.put()` is a plain
synchronous function call made once per iteration of the same loop that runs one ONNX forward
pass per generated token.

### 1.3 The pipeline forwards a `streamer` option with zero extra plumbing

`src/pipelines/automatic-speech-recognition.js`'s `_call_whisper` — the code path this app
already goes through, since the loaded model's `config.model_type` is `whisper`:

```js
const generation_config = { ...kwargs };   // kwargs = whatever the caller passed as call options
...
const data = await this.model.generate({
  inputs: chunk.input_features,
  ...generation_config,                    // <- a `streamer` field here reaches generate() as-is
});
```

`transcribe.ts` already calls the high-level pipeline object exactly this way —
`await asr(pcm, genOpts)` — and `genOpts` is typed as a loosely-typed bag
(`AsrPipelineLike`'s call signature takes `options?: Record<string, unknown>`). Concretely:
`asr(pcm, { ...genOpts, streamer })` is a valid call today with **no interface change** to
`AsrPipelineLike` or the pipeline construction.

## 2. Attempted empirical confirmation — blocked by sandbox network policy, not by Cyfronet

To go beyond reading the source, I tried to actually run it: a throwaway Node script loading the
real production repo/dtype (`onnx-community/whisper-small`, q8 — exactly what
`src/lib/models/manifest.ts` names), pointed at the **public** `huggingface.co` host (`env.
remoteHost` deliberately left at its default, never set to the Cyfronet mirror), transcribing the
public JFK demo clip transformers.js's own pipeline docstring already references, with this app's
actual `buildDomainPromptOptions()` logic ported verbatim and a `WhisperTextStreamer` wired to
log wall-clock timestamps on every callback.

It got as far as downloading the model config/tokenizer, then failed fetching the ONNX decoder
weight file itself:

```
FAILED: Error: Forbidden access to file:
"https://huggingface.co/onnx-community/whisper-small/resolve/main/onnx/decoder_model_merged_quantized.onnx"
```

`resolve/main/*.onnx` files on `huggingface.co` are typically served from a separate LFS/CDN
origin; this session's environment routes all outbound HTTPS through a pre-configured agent proxy
(per the environment notes), and large binary fetches through it evidently don't all succeed the
same way small JSON/text fetches do — a plain `curl https://huggingface.co/` from this same
session returns `200` fine. I did not chase this further: diagnosing the proxy's own policy is
infrastructure reconnaissance outside this task's scope (and this session's permission model
correctly declined a proxy-status/config probe as unrelated to the research question asked). This
is **not** the Cyfronet restriction from §0 — it's a second, independent limitation of this
particular sandboxed session, unlikely to affect a normal dev machine or CI runner.

**Net effect: no wall-clock timing numbers in this report.** The mechanism itself is not in doubt
— §1's citations show `streamer.put()` called synchronously once per real ONNX decode step, which
by construction cannot batch into a single end-of-call flush — but the _cadence_ (how many words
land per second for a typical short physics-question utterance, how many timestamp chunks a
~5-15 word query actually produces) is quantitatively unverified here. §7 includes a ready-to-run
reproduction script for whoever picks this up on a machine with normal network access; it should
take under a minute to get real numbers matching this app's exact model/prompt/dtype.

## 3. Mapping the two mechanisms onto the two things you asked for

### 3.1 "How many words already generated" — works today, no decoding changes

`callback_function` and `token_callback_function` fire regardless of timestamp mode — they're on
`TextStreamer`, the base class, and `WhisperTextStreamer.put()` only special-cases _actual_
timestamp tokens before falling through to the inherited word-accumulation logic (§1.1). Since
the app's current domain-prompt setup never produces timestamp tokens (next section), every
generated token takes that fallthrough path. This is the cheap, no-risk win: wire a `streamer`
into the existing `asr(pcm, genOpts)` call, no change to `buildDomainPromptOptions()` at all.

### 3.2 "How many seconds of recording processed" — available, but currently switched off by the domain-prompt fix

This is the non-obvious finding. `transcribe.ts`'s `buildDomainPromptOptions()` builds a custom
`decoder_input_ids` ending in the resolved `<|notimestamps|>` token
(`transcribe.ts:98,108-114`) — deliberately: this is exactly the §2.4 domain-prompt-biasing
mechanism `voice-pipeline-feasibility.md` measured as worth +7.6pp slot-token accuracy. Tracing
what that token actually does, in `node_modules/@huggingface/transformers/src/models/whisper/
modeling_whisper.js`:

- `WhisperForConditionalGeneration.generate()` only attaches the logits processor that forces
  timestamp tokens (`WhisperTimeStampLogitsProcessor`) when `generation_config.return_timestamps`
  is truthy (`modeling_whisper.js:125-128`). `transcribe.ts` never sets `return_timestamps`
  today, so this processor is never attached, and the model just follows the soft
  training-time convention of the `<|notimestamps|>` context token — it essentially never
  emits a timestamp token. That's _why_ `on_chunk_start`/`on_chunk_end` would never fire under
  the app's current call: not because the streamer can't do it, but because the decoder is never
  asked to.
- There's a separate auto-cleanup path (`modeling_whisper.js:79-94`) that strips a conflicting
  `<|notimestamps|>` token from the prompt automatically when `return_timestamps: true` is
  requested — **but it only runs inside `_retrieve_init_tokens()`, the fallback path used only
  when the caller doesn't supply `decoder_input_ids`** (`modeling_whisper.js:120-123`:
  `kwargs.decoder_input_ids ?? this._retrieve_init_tokens(...)`). Since `transcribe.ts` always
  supplies its own `decoder_input_ids`, this auto-fix is bypassed. Simply adding
  `return_timestamps: true` to the call _without_ also editing `buildDomainPromptOptions()` would
  leave a redundant, self-contradicting token in the prompt ("don't timestamp" immediately
  followed by a processor that forces timestamps). It would probably still work —
  `WhisperTimeStampLogitsProcessor`'s constructor explicitly detects a trailing
  `no_timestamps_token_id` and adjusts its `begin_index` to compensate
  (`logits_process.js:286-288`) — but "probably still work" is exactly the kind of unverified
  claim this repo's own docs warn against (`voice-pipeline-feasibility.md` §3's whole point). The
  clean fix is a small, explicit one: give `buildDomainPromptOptions()` a
  `withTimestamps: boolean` parameter that omits the trailing `noTimestamps` token when true,
  rather than relying on the processor's defensive handling of a contradictory prompt.
- Enabling `return_timestamps: true` also switches `generate()` onto a different internal code
  path — `_generate_with_seek()` (`modeling_whisper.js:157-165` routes there whenever
  `return_timestamps && !max_new_tokens`), which is Whisper's standard long-form "seek" algorithm
  for audio potentially longer than 30s. I traced whether this path still honors a `streamer`:
  yes — `streamer` isn't in `_generate_with_seek`'s named parameters, so it rides along inside its
  `kwargs` and gets spread into the inner `super.generate({...kwargs})` call each time around the
  seek loop (`modeling_whisper.js:248-256`), which is the same base-class loop from §1.2 that
  calls `streamer.put()`/`.end()`. For this app's realistic recording lengths (a spoken physics
  question, well under Whisper's native 30s window — `num_segment_frames` works out to exactly
  30s of mel frames, `modeling_whisper.js:207-212`), the seek loop's `while (seek < total_frames)`
  will in the common case run exactly once (the loop advances `seek` by the full segment when the
  decoded sequence ends in a single trailing timestamp with no pair, i.e. normal end-of-speech —
  `modeling_whisper.js:310-329`), so switching to this path shouldn't practically change behavior
  for a single short utterance. It's a real possibility (not the norm) for the loop to run more
  than once even under 30s if decoding produces multiple complete timestamp pairs before running
  out of tokens — worth knowing about but not a blocker.
- **Granularity caveat**: Whisper emits timestamps roughly at phrase/segment boundaries, not one
  per word. For a 5-15 word physics question ("what is the range of 5 MeV protons in water"),
  expect on the order of **one to a handful** of `on_chunk_start`/`on_chunk_end` firings, not a
  smooth sweep — this is a coarser signal than word-level streaming for this app's actual query
  length, and would matter more if/when long-form recording is ever supported. §5 recommends
  treating it as a secondary, lower-priority addition for exactly this reason.

## 4. Can it actually be _live_ on screen? — the part this session couldn't verify

Two independent reasons this needs a real-browser check before shipping, neither resolved by
anything in this report:

1. **ASR runs on the main thread today.** `grep`-ing `src/` for `Worker`/`postMessage` turns up
   nothing under `src/lib/asr/` or `src/lib/models/` — `asr-status.svelte.ts` calls `transcribe()`
   directly from the UI's event handler. Whether per-token `streamer` callbacks produce visibly
   incremental DOM updates, versus the browser batching everything and painting once at the very
   end, depends on whether the ONNX Runtime Web WASM backend yields control back to the browser's
   event loop between decode steps — which in turn depends on settings this app doesn't currently
   configure (`ort.env.wasm.proxy`, `numThreads`, and whether the deployed page is cross-origin
   isolated at all — `docs/voice-pipeline-feasibility.md` §6.2 already flags COOP/COEP as an open
   question owned by issue #9). This is genuine browser/WASM-scheduling behavior, not something
   `@huggingface/transformers`'s own JS code controls.
2. **The existing "Transcribing…" spinner working today is not evidence either way.**
   `MicButton.svelte`'s spinner is a Tailwind `animate-spin` CSS transform animation
   (`MicButton.svelte:66-69`), and pure `transform`/`opacity` CSS animations are well known to run
   on the compositor thread — browsers keep them smooth even while the main JS thread is fully
   blocked. A live word-by-word transcript or a numeric progress readout is ordinary DOM text /
   Svelte reactive state, which **does** require the main thread to be free enough to run JS and
   re-render between updates. The spinner's smoothness proves nothing about whether text updates
   would be visible mid-decode.
3. (Related, not a blocker on its own) **Node and the browser use different ONNX Runtime
   backends entirely** — `package.json`'s `main` field for `@huggingface/transformers` resolves
   to `dist/transformers.node.cjs` under Node (backed by `onnxruntime-node`, native bindings, no
   WASM at all), while the package's browser export condition resolves to
   `dist/transformers.web.js` (backed by `onnxruntime-web`, WASM/WebGPU). This means even a
   successful Node-side timing run (§2's aborted attempt) would only have proven the _mechanism_
   fires progressively — genuinely useful — but could never have settled the main-thread-blocking
   question, because Node has no rendering/paint cycle and uses a different execution provider
   than what ships to users.

**The recommendation that sidesteps all three uncertainties at once**: run ASR inference inside a
dedicated Web Worker (`new Worker(new URL('./asr.worker.ts', import.meta.url), { type: 'module'
})`, transferring the PCM `Float32Array` in and receiving `{ type: 'partial', text }` / `{ type:
'progress', seconds }` / `{ type: 'done', text }` messages back via `postMessage`). This
guarantees the main thread is free for the Stop button, CSS, and Svelte reactivity regardless of
what ONNX Runtime does internally — worker→main `postMessage` is always a real task-queue hop, so
UI updates driven by it are never at the mercy of WASM's internal scheduling. This is also exactly
the architecture transformers.js's own official example apps (e.g. the whisper-web demo) use, for
the same reason. It's more upfront work (Vite/SvelteKit worker bundling, structured message
passing) than the progress bar itself, but it's the honest foundation — everything in §3 works
_mechanically_ without it, but "works mechanically" and "visibly live to the user" are different
claims, and only one of them is verified here.

## 5. Concrete recommendation (sketch only — not applied in this branch)

Phased, cheapest/lowest-risk first. None of this is implemented here; this is a proposal, matching
how this repo's other spike docs (`voice-pipeline-feasibility.md` §5, `apple-silicon-benchmark.md`)
hand off ranked ideas rather than shipping code from a research pass.

### Phase 1 — live word-by-word transcript (low risk, ship first)

- `transcribe()` (`transcribe.ts`) grows an optional `onPartial?: (textSoFar: string) => void`
  parameter, threading straight through to a `WhisperTextStreamer`'s `callback_function` (accumulate
  and pass the running text, not just the latest fragment — mirrors how `TextStreamer` itself
  accumulates before flushing).
- `AsrStore` (`asr-status.svelte.ts`) gains a `partialTranscript = $state("")` field, cleared in
  `start()`/`reset()`, updated via the new callback during `stop()`'s `transcribe()` call.
- `MicButton.svelte`'s "Transcribing…" branch renders `partialTranscript` (with a trailing
  cursor/ellipsis) instead of only the spinner, once it's non-empty — falls back to the spinner
  alone until the first word lands, so there's no empty/awkward transitional state.
- Testable exactly like the existing `asr-status.test.ts` pattern: the mocked `transcribe()` can
  synchronously invoke its `onPartial` callback before resolving, and assertions check
  `store.partialTranscript` mid-flight the same way the existing "passes through recording ->
  transcribing -> done" test already checks `store.phase` mid-flight
  (`asr-status.test.ts:81-111`).
- No change to `buildDomainPromptOptions()`, no accuracy re-validation needed.

### Phase 2 — real seconds-processed progress fraction (needs re-validation)

- `buildDomainPromptOptions()` takes a `withTimestamps` flag; when true, omits the trailing
  `noTimestamps` token (§3.2) and the caller adds `return_timestamps: true` to `genOpts`.
- Wire `on_chunk_start`/`on_chunk_end` to an `AsrStore` field like
  `processedSeconds = $state(0)`; the total is already known (recorded PCM length ÷
  `WHISPER_SAMPLE_RATE`, from `pcm.ts`), so `MicButton`/`+page.svelte` can render an actual
  `processedSeconds / totalSeconds` fraction — a real determinate bar, not a fake one.
- **Before shipping this phase**: re-run `scripts/asr-transcribe.mjs --prompt` /
  `scripts/asr-score-slots.mjs --ext` against `eval/audio/` with timestamps enabled, and confirm
  slot-token accuracy doesn't regress the §2.4 numbers (95.6% raw / 98.7% corrected). Given §3.2's
  granularity caveat, also confirm subjectively that a handful of chunk events over a 2-3 second
  transcription is worth the added surface, versus just leaning on Phase 1.

### Phase 3 — move ASR to a Web Worker (foundation, decoupled from the progress bar itself)

- Per §4: the one change that converts "callbacks fire" into "user visibly sees it happen,
  guaranteed." Also a prerequisite for a real Cancel button during transcription (today there
  isn't one — `MicButton` disables itself entirely while `isTranscribing`), since a worker can be
  `.terminate()`d while a main-thread synchronous WASM call cannot be interrupted.
- Independent of, and higher-leverage than, the progress bar specifically — worth scoping as its
  own follow-up rather than bundling into whichever of Phase 1/2 ships first.

## 6. Context: this is a converging pattern, not a transformers.js quirk

For completeness, since the question was "is there a way" in general, not "in transformers.js
specifically": whisper.cpp's C API has the same shape of hook —
`whisper_full_params.new_segment_callback` (fires per decoded segment) and `.progress_callback`
(coarse percent-complete) — and streaming-Whisper projects (e.g. `whisper_streaming`) are built
entirely around the same idea of incremental partial-hypothesis callbacks. This app is committed
to the transformers.js/ONNX in-browser architecture already (per `voice-pipeline-feasibility.md`'s
revised architecture, §4), so whisper.cpp itself isn't a relevant alternative runtime here — it's
mentioned only to note that "callback per generated segment/token" is the standard shape this
class of problem takes everywhere, so §1-§3's findings aren't a one-library peculiarity.

## 7. Risks and open questions

1. **No real timing numbers** (§2) — the single biggest gap in this report. Whoever picks this up
   should run the reproduction script below on a machine with normal (non-sandboxed) network
   access before committing to a specific UI treatment (e.g., whether Phase 1's word cadence is
   fast enough that a per-word update even reads as smooth rather than jumpy).
2. **Main-thread live-rendering is unverified** (§4) — needs an actual `pnpm dev` + real browser +
   real mic test, which this session cannot do (no model access, and even with it, this is a
   headless/sandboxed container).
3. **Phase 2's accuracy impact on the domain-prompt fix is unverified** — §3.2 traced the
   mechanism carefully but did not re-run the eval; do not ship it on the strength of the source
   reading alone, per this repo's own established practice of not trusting unverified claims
   (`voice-pipeline-feasibility.md` §3's whole audit section exists because of exactly this kind
   of mistake in earlier spikes).
4. **transformers.js version drift.** These findings are pinned to `4.2.0` exactly, the same
   version already load-bearing for the `onnxruntime-web` override in `transcribe.ts`'s module
   comment. If that pin moves, re-check `WhisperTextStreamer`'s shape — the GitHub issue found
   during general web research (huggingface/transformers.js#1198) suggests this exact API has
   churned across versions before (older `chunk_callback`/`callback_function`-on-the-pipeline
   patterns from transformers.js v2 don't exist in this v4 codebase; `WhisperTextStreamer` is the
   current shape).

## 8. Reproduction

### Source citations (§1, §3)

All paths relative to `node_modules/@huggingface/transformers/` at the pinned `4.2.0` (reproduce
via `pnpm install` on this branch):

| Claim                                                              | File : lines                                                         |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| Streamer classes + public re-export                                | `src/generation/streamers.js` (whole file); `src/transformers.js:45` |
| `generate()` calls `streamer.put()`/`.end()`                       | `src/models/modeling_utils.js:944-946,1013-1015,1030-1032`           |
| Pipeline forwards call kwargs (incl. `streamer`) into `generate()` | `src/pipelines/automatic-speech-recognition.js` (`_call_whisper`)    |
| `WhisperTimeStampLogitsProcessor` gated on `return_timestamps`     | `src/models/whisper/modeling_whisper.js:125-128`                     |
| `<                                                                 | notimestamps                                                         | >`auto-strip only runs when caller omits`decoder_input_ids` | `src/models/whisper/modeling_whisper.js:79-94,120-123` |
| `_generate_with_seek` still forwards `streamer` via `kwargs`       | `src/models/whisper/modeling_whisper.js:157-165,248-256`             |
| 30s native segment size                                            | `src/models/whisper/modeling_whisper.js:207-212`                     |
| Seek loop's single-pass behavior for short audio                   | `src/models/whisper/modeling_whisper.js:310-329`                     |
| Processor defensively handles a trailing `no_timestamps_token_id`  | `src/generation/logits_process.js:286-288`                           |

### Ready-to-run timing script (not yet executed successfully — §2)

Run from the repo root (needs `pnpm install` first) on a machine with normal network access:

```js
// save as e.g. scratch-streamer-timing.mjs, run: node scratch-streamer-timing.mjs
import { pipeline, env, WhisperTextStreamer } from "@huggingface/transformers";
// env.remoteHost left at its default (huggingface.co) -- do NOT point this at
// the Cyfronet mirror (src/lib/models/remote.ts) for an exploratory script.

const asr = await pipeline("automatic-speech-recognition", "onnx-community/whisper-small", {
  dtype: "q8",
});
const t0 = performance.now();
const streamer = new WhisperTextStreamer(asr.tokenizer, {
  callback_function: (text) => console.log(`+${(performance.now() - t0).toFixed(0)}ms  ${text}`),
  on_chunk_start: (s) =>
    console.log(`+${(performance.now() - t0).toFixed(0)}ms  chunk_start @ ${s}s`),
  on_chunk_end: (s) => console.log(`+${(performance.now() - t0).toFixed(0)}ms  chunk_end @ ${s}s`),
});
const result = await asr(
  "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav",
  { streamer, return_timestamps: true },
);
console.log(result.text);
```

Swap in this app's actual `buildDomainPromptOptions()` output for `decoder_input_ids` (with
`withTimestamps: true` per §5's Phase 2 sketch) and a locally recorded short physics-question clip
to get numbers directly representative of production use, rather than the generic JFK demo clip.

## Related

- `docs/voice-pipeline-feasibility.md` §2.4 — the domain-prompt-biasing fix whose
  `decoder_input_ids` construction §3.2 traces through.
- `docs/apple-silicon-benchmark.md` — CPU latency reference points (0.8-2.8s/clip) this doc's
  granularity discussion (§3.2) leans on.
- Issue #37 — shipped the current spinner-only "Transcribing…" state; the claim this report
  corrects.
- Issue #9 — runtime/hosting spike; owns the COOP/COEP question §4 flags as a prerequisite for
  reasoning precisely about WASM threading behavior.
