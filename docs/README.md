# docs/

Developer- and design-facing documentation for aidedx. If you're looking for what the app _does_,
start with the [root README](../README.md) — this folder is the deep-dive material it links out to.

## Start here

| Doc                                  | Covers                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------- |
| [`development.md`](./development.md) | Stack, local dev workflow, deployment, eval set, and third-party licenses. |
| [`user-guide.md`](./user-guide.md)   | End-user walkthrough (coming soon).                                        |

## Core reference

Docs that map 1:1 to shipped code — read these when working on the corresponding piece.

| Doc                                                        | Covers                                                                           |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [`nlu.md`](./nlu.md)                                       | Deterministic NLU matcher (`src/lib/intent/matcher.ts`) + coverage harness.      |
| [`aliases.md`](./aliases.md)                               | Material/particle alias tables (`src/lib/aliases/`) — provenance & regeneration. |
| [`wasm.md`](./wasm.md)                                     | libdedx WASM wrapper (`src/lib/wasm/`) — vendored binaries & rebuild steps.      |
| [`answer-pipeline.md`](./answer-pipeline.md)               | matcher → compute → NLG → UI state; unit conversion; error messages.             |
| [`status-panel-design.md`](./status-panel-design.md)       | Model-status header, download-consent, and clear-cache UX.                       |
| [`model-hosting-cyfronet.md`](./model-hosting-cyfronet.md) | Mirroring model weights to Cyfronet S3 instead of Hugging Face's CDN.            |
| [`local-model-cache.md`](./local-model-cache.md)           | The `.hf-cache/` Node-side prefetch convention used by benchmark scripts.        |

## Research & benchmark reports

Dated session reports from the ASR/NLU/TTS spikes: each states a question, measures it against real
code/models, and gives a verdict. Later reports build on — and sometimes correct — earlier ones, so
reading in order gives the current picture rather than a snapshot.

| Doc                                                                | Date                               | Question answered                                                                                                                                                         |
| ------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`design.md`](./design.md)                                         | 2026-06-25                         | The founding design & prototyping plan (issue #1). Historical — superseded by the architecture in `voice-pipeline-feasibility.md`.                                        |
| [`voice-pipeline-feasibility.md`](./voice-pipeline-feasibility.md) | 2026-07-05                         | Is the voice pipeline feasible CPU-only, with no LLM in the main path? Audits prior spike findings and revises the architecture.                                          |
| [`apple-silicon-benchmark.md`](./apple-silicon-benchmark.md)       | 2026-07-10 (+ 07-16 addendum)      | Do the CPU numbers hold up on real target hardware (M5, M1)?                                                                                                              |
| [`whisper-progress-feedback.md`](./whisper-progress-feedback.md)   | 2026-07-14 (updated through 07-16) | Can transcription show live progress instead of a spinner?                                                                                                                |
| [`asr-model-comparison.md`](./asr-model-comparison.md)             | 2026-07-15                         | Do faster-prefill ASR models beat whisper-small? (Verdict: no — threading does.)                                                                                          |
| [`threading-coop-coep.md`](./threading-coop-coep.md)               | 2026-07-15 (+ 07-16 addendum)      | Does COOP/COEP threading cut Whisper's prefill latency, and is WebGPU worth it?                                                                                           |
| [`tts-eval-audio.md`](./tts-eval-audio.md)                         | 2026-07-15/16                      | Pilot: can TTS-synthesized audio scale up the eval set instead of recording humans?                                                                                       |
| [`tts-eval-1000.md`](./tts-eval-1000.md)                           | 2026-07-16                         | 1000-sample TTS eval batch, weighted to a realistic query-intent distribution.                                                                                            |
| [`tts-eval-1000-v2.md`](./tts-eval-1000-v2.md)                     | 2026-07-17                         | v2 of the above: expanded particle/material pool + LET terminology (issue #83) — does it hold up, and how much does the new phonetic corrector (issue #28) help at scale? |
| [`phonetic-corrector.md`](./phonetic-corrector.md)                 | 2026-07-18                         | Does the phonetic-lexicon ASR corrector (issue #28) match or beat the tuned extended-rules experiment, without overfitting to the recordings that motivated it?           |
| [`tts-eval-1000-v3.md`](./tts-eval-1000-v3.md)                     | 2026-07-18                         | v3 of the above: `DOMAIN_PROMPT` expansion + voice-composition fixes (issue #92 Group B) — measured.                                                                      |

## Environment & tooling

| Doc                                    | Covers                                                               |
| -------------------------------------- | -------------------------------------------------------------------- |
| [`athena-setup.md`](./athena-setup.md) | Athena/PLGrid cluster setup — read before any GPU/Python work there. |

## Assets

[`assets/`](./assets/) — SVG diagrams embedded in the root README. See
[`assets/README.md`](./assets/README.md).
