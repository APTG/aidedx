# Local model weight cache

All inference in aidedx runs on-device. Model weights are large and must be
downloaded once on a fast connection; thereafter the app and the spike scripts
work fully offline.

## Directory layout

The Hugging Face Hub cache uses a content-addressed layout. After a full
prefetch, `.hf-cache/` looks like this:

```
aidedx/
└── .hf-cache/               ← git-ignored, ~8 GB after a full prefetch
    ├── models--onnx-community--whisper-tiny/
    │   ├── blobs/
    │   ├── refs/
    │   └── snapshots/<rev>/   # JSON configs + onnx/ weight files
    ├── models--onnx-community--whisper-base/
    ├── models--onnx-community--whisper-small/
    ├── models--onnx-community--Qwen2.5-0.5B-Instruct/
    ├── models--onnx-community--Qwen2.5-1.5B-Instruct/
    └── models--onnx-community--Llama-3.2-1B-Instruct/
```

Each `snapshots/<rev>/` directory contains JSON config files and an `onnx/`
sub-directory with the quantized weight files (`model_q4.onnx`,
`model_quantized.onnx`, etc.).

## Why `.hf-cache/` inside the project

By default `@huggingface/transformers` caches weights in a user-global
directory (`~/.cache/huggingface/hub` on Linux/macOS). That location is
shared across all projects but is invisible in the project tree and harder
to manage per-project. Pinning the cache to `.hf-cache/` at the project
root keeps the 8 GB of weights clearly associated with this project and
ensures they survive `pnpm install` reinstalls. The directory is listed in
`.gitignore` so the weights are never committed.

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
import { env } from "@huggingface/transformers";
import { fileURLToPath } from "url";
import path from "path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
env.cacheDir = path.join(PROJECT_ROOT, ".hf-cache");
```

For SvelteKit components the same applies in server hooks or a lazy-initialised
singleton — set `cacheDir` once before any model is loaded.

## Disk space

| Spike     | Models                                      | Approx size |
| --------- | ------------------------------------------- | ----------- |
| #7 ASR    | whisper-tiny + base + small, q4 + q8        | ~870 MB     |
| #8 NLU    | Qwen2.5-0.5B + 1.5B + Llama-3.2-1B, q4 + q8 | ~7.3 GB     |
| **Total** |                                             | **~8.2 GB** |

Make sure you have at least **10 GB free** before running both prefetch scripts.
