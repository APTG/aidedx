# Local model weight cache

All inference in aidedx runs on-device. Model weights are large and must be
downloaded once on a fast connection; thereafter the app and the spike scripts
work fully offline.

## Directory layout

```
aidedx/
└── .hf-cache/               ← git-ignored, ~8 GB after a full prefetch
    └── onnx-community/
        ├── whisper-tiny/    # issue #7 — ASR spike
        ├── whisper-base/
        ├── whisper-small/
        ├── Qwen2.5-0.5B-Instruct/   # issue #8 — LLM NLU spike
        ├── Qwen2.5-1.5B-Instruct/
        └── Llama-3.2-1B-Instruct/
```

Each model directory contains JSON config files and an `onnx/` sub-directory
with the quantized weight files (`model_q4.onnx`, `model_quantized.onnx`, etc.).

## Why `.hf-cache/` inside the project

By default `@huggingface/transformers` caches weights inside `node_modules`,
which means a `pnpm install --force` or a clean `node_modules` wipe deletes
them. Pinning the cache to the project root keeps the 8 GB of weights safe
across dependency updates while still being co-located with the code that uses
them. The directory is listed in `.gitignore` so the weights are never
committed.

## Prefetch scripts

Run these **once on a fast connection** before switching to mobile / offline.

### Whisper models (issue #7 — ASR)

```sh
node scripts/prefetch-whisper-models.mjs
```

Downloads `whisper-tiny`, `whisper-base`, and `whisper-small` at both `q4` and
`q8` quantisation (~870 MB total).

### LLM NLU models (issue #8 — NLU fallback)

```sh
node scripts/prefetch-llm-models.mjs
```

Downloads `Qwen2.5-0.5B-Instruct`, `Qwen2.5-1.5B-Instruct`, and
`Llama-3.2-1B-Instruct` at both `q4` and `q8` (~7.3 GB total).

Both scripts are idempotent — already-cached files are not re-downloaded.

## Using the cache in application code

Set `env.cacheDir` before the first `from_pretrained` call:

```ts
import { env } from '@huggingface/transformers';
import { fileURLToPath } from 'url';
import path from 'path';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
env.cacheDir = path.join(PROJECT_ROOT, '.hf-cache');
```

For SvelteKit components the same applies in server hooks or a lazy-initialised
singleton — set `cacheDir` once before any model is loaded.

## Disk space

| Spike | Models | Approx size |
|---|---|---|
| #7 ASR | whisper-tiny + base + small, q4 + q8 | ~870 MB |
| #8 NLU | Qwen2.5-0.5B + 1.5B + Llama-3.2-1B, q4 + q8 | ~7.3 GB |
| **Total** | | **~8.2 GB** |

Make sure you have at least **10 GB free** before running both prefetch scripts.
