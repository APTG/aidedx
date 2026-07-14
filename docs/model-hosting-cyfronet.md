# Mirroring model weights to Cyfronet S3

Companion to issue #9 (runtime/hosting spike) and issue #34 (this mirror). `@huggingface/transformers`
fetches model weights from `https://huggingface.co/` by default; this doc covers mirroring them to an
S3-compatible bucket at Cyfronet instead, as a candidate self-hosting solution.

## Status: live

`onnx-community/whisper-small` (dtype `q8`, the 7 files / ~241 MB described below) is uploaded and
verified publicly reachable at:

```
https://aidedx-models.s3p.cloud.cyfronet.pl/onnx-community/whisper-small/resolve/main/
```

Bucket: `aidedx-models`, DC-Podole (`s3p.cloud.cyfronet.pl`), CORS applied via
`scripts/cyfronet-cors-policy.xml`. Uploaded 2026-07-14; local-vs-remote object count verified by
`scripts/mirror-upload-s3.sh` (7/7) and spot-checked with `curl -I` (200, `content-length: 2227` on
`config.json`). To point the app at this mirror, set `env.remoteHost =
"https://aidedx-models.s3p.cloud.cyfronet.pl/"` — no other code changes needed (see "How the mirror
works" below). Wiring that switch into the app itself is still a follow-up (not done here).

## Why

Issue #9's hosting decision is **GitHub Pages (+ `coi-serviceworker`)** vs **Cyfronet (native
COOP/COEP)**. Self-hosting the model weights themselves — regardless of which option wins for the app
shell — is worth doing independently, because:

- **We control the response headers.** huggingface.co's CDN doesn't let us set custom CORS/CORP
  headers; a bucket we own does. This matters once the app is COEP-isolated (issue #9), since
  cross-origin subresources need a valid CORS response (or `Cross-Origin-Resource-Policy:
cross-origin`) or the browser silently fails the request.
- **We don't depend on Hugging Face's availability/rate limits** for a production critical path.
- **Latency**: Cyfronet is a Polish/EU host; likely lower latency than HF's CDN for the project's
  actual user base.

This does **not** require deciding the app-shell hosting question first — the model mirror is useful
either way, and `env.remoteHost` (see below) makes switching a one-line change.

## What to copy, and why exactly this

Per `docs/voice-pipeline-feasibility.md` (2026-07-05 session), the LLM NLU fallback was **rescoped out
of the critical path** (§2.5, §2.6 — a synonym pre-pass gets the deterministic matcher to 120/120), so
issue #9's hosting matrix reduces to **Whisper only**. The confirmed CPU/WASM-tier pick is:

> **`onnx-community/whisper-small` at dtype `q8`, with domain-prompt biasing** — 95.6% raw slot-token
> accuracy, 2.8 s/clip on Linux CPU (§2.4). whisper-tiny/base and Moonshine are ruled out (too
> inaccurate on this domain's vocabulary); large-v3-turbo is a WebGPU-tier candidate but not yet
> confirmed with prompt biasing (issue #9 comment) — start with `small` only.

### How many files, and where from

`@huggingface/transformers` only fetches the files a given `dtype` actually needs, not every dtype
variant in the repo (the full `onnx-community/whisper-small` repo is ~6 GB across 41 files — every
fp32/fp16/int8/uint8/q4/bnb4/q8 variant of the encoder and three decoder graphs). Loading
`WhisperForConditionalGeneration.from_pretrained("onnx-community/whisper-small", { dtype: "q8" })`
was run once against a clean cache to get the ground truth (not a guess):

| File                                       |      Size |
| ------------------------------------------ | --------: |
| `config.json`                              |    2.2 KB |
| `generation_config.json`                   |    4.2 KB |
| `preprocessor_config.json`                 |    0.3 KB |
| `tokenizer_config.json`                    |  280.4 KB |
| `tokenizer.json`                           |   2.37 MB |
| `onnx/encoder_model_quantized.onnx`        |  88.05 MB |
| `onnx/decoder_model_merged_quantized.onnx` | 149.49 MB |

**7 files, ~240 MB total.** Source: Hugging Face Hub, repo `onnx-community/whisper-small`, revision
`main`. (Note: this is real ONNX weight data, ~2.6× the design mock's placeholder "92 MB" number in
`src/lib/models/manifest.ts` from issue #32, which currently ships `whisper-tiny` as a UI placeholder —
that manifest needs updating to `whisper-small` separately once ASR is actually wired into the app;
out of scope here.)

## How the mirror works

`env.remoteHost` (default `https://huggingface.co/`) and `env.remotePathTemplate` (default
`{model}/resolve/{revision}/`) together determine every URL transformers.js fetches:

```
<remoteHost><model>/resolve/<revision>/<filename>
```

So a mirror is a drop-in replacement **only if the bucket's object keys exactly match that path**,
relative to the bucket's public base URL — e.g. for whisper-small:

```
<bucket-base-url>/onnx-community/whisper-small/resolve/main/config.json
<bucket-base-url>/onnx-community/whisper-small/resolve/main/onnx/encoder_model_quantized.onnx
...
```

Switching the app to the mirror is then a single line (`env.remoteHost = "<bucket-base-url>/"`) — no
other code changes. **Wiring that switch into the app itself (e.g. a build-time config flag) is a
follow-up, not covered by this doc** — this is just about getting the files mirrored and verified
reachable first.

Node's on-disk `.hf-cache/` layout (see `docs/local-model-cache.md`) is flat (`<org>/<repo>/<file>`,
no `resolve/<revision>`) — that's a _local disk cache_ convention, different from the remote URL
layout above. `scripts/mirror-fetch-model.ts` (below) re-inserts the `resolve/<revision>/` segment
when staging, so don't try to upload `.hf-cache/` directly.

Tooling: **s3cmd**, per Cyfronet's own documented CLI
([guide.s3p.cloud.cyfronet.pl/narzedzia_cli.html](https://guide.s3p.cloud.cyfronet.pl/narzedzia_cli.html)).

## Step by step

### 1. Fetch from Hugging Face, then restage for upload

```sh
node scripts/mirror-fetch-model.ts onnx-community/whisper-small q8
```

This is two phases, and it prints both so you can see exactly where files land locally at each step:

1. **Fetch** — downloads (or reuses, if already present) into `.hf-cache/` at the project root, same
   cache `scripts/prefetch-whisper-models.mjs` uses. For this repo the 7 files end up flat at:

   ```
   .hf-cache/onnx-community/whisper-small/config.json
   .hf-cache/onnx-community/whisper-small/generation_config.json
   .hf-cache/onnx-community/whisper-small/preprocessor_config.json
   .hf-cache/onnx-community/whisper-small/tokenizer_config.json
   .hf-cache/onnx-community/whisper-small/tokenizer.json
   .hf-cache/onnx-community/whisper-small/onnx/encoder_model_quantized.onnx
   .hf-cache/onnx-community/whisper-small/onnx/decoder_model_merged_quantized.onnx
   ```

   (`.hf-cache/` is git-ignored and won't exist until you run this — see `docs/local-model-cache.md`.)

2. **Restage** — copies those same 7 files into `mirror-staging/onnx-community/whisper-small/resolve/main/...`
   (the `resolve/main/` segment `.hf-cache/`'s flat layout omits — see "How the mirror works" above).
   This is the directory that actually gets uploaded.

Re-running is safe/cheap: phase 1 skips already-cached files, phase 2 just re-copies from local disk.

### 2. Provision a bucket at Cyfronet

1. **Get credentials**: sign in at <https://storage-panel.cloud.cyfronet.pl>, go to the Credentials
   page, pick your PLGrid group and storage region, press "Generate credential". You'll get an
   `access_key`, `secret_key`, and the region's endpoint:
   - DC-Nawojki → `s3.cloud.cyfronet.pl`
   - DC-Podole → `s3p.cloud.cyfronet.pl`

2. **Install and configure s3cmd**: copy `scripts/.s3cfg.cyfronet.example` to `~/.s3cfg` and fill in
   `access_key`/`secret_key` (and `host_base`/`host_bucket` if you're on DC-Podole instead of the
   default DC-Nawojki in the template).

3. **Create the bucket**:

   ```sh
   s3cmd mb s3://<your-bucket>
   ```

   (Bucket names: lowercase letters, digits, `-` only, globally unique.)

4. **Enable CORS** — see `scripts/cyfronet-cors-policy.xml` (allows `GET`/`HEAD` from any origin; the
   files are public weights, not sensitive, so a wildcard origin is the pragmatic default — tighten to
   specific origins later if desired; scoped to GET/HEAD only, unlike Cyfronet's generic
   GET/POST/PUT/DELETE example, since this bucket only needs to be publicly _readable_):

   ```sh
   s3cmd setcors scripts/cyfronet-cors-policy.xml s3://<your-bucket>
   ```

   `Content-Length` is on the CORS-safelisted response header list by default (readable cross-origin
   without `Access-Control-Expose-Headers`), which is what our own download-progress UI (issue #32)
   and the status panel's disk-cache introspection rely on — but the policy above exposes it (plus
   `Content-Range`/`ETag`) explicitly anyway, since safelisting isn't obvious and costs nothing to
   spell out.

5. **Public read access** — Cyfronet's docs don't cover a specific bucket-policy mechanism for this, so
   the upload step below passes s3cmd's `--acl-public` flag per-object at sync time instead of doing it
   as separate one-time bucket setup.

### 3. Upload

```sh
CYFRONET_S3_BUCKET=<your-bucket> scripts/mirror-upload-s3.sh mirror-staging
```

Runs `s3cmd sync --acl-public`, then prints a per-model local-vs-remote file count check.

### 4. Verify it's actually a working mirror

Don't just check the files landed — confirm transformers.js can load the model **from the mirror
alone**, with nothing falling back to huggingface.co:

```sh
node --input-type=module -e '
  import("@huggingface/transformers").then(async ({ AutoProcessor, WhisperForConditionalGeneration, env }) => {
    env.remoteHost = "https://<your-bucket>.<host_base>/"; // e.g. https://aidedx-models.s3.cloud.cyfronet.pl/
    env.cacheDir = "/tmp/mirror-verify-cache"; // fresh dir — force a real fetch, not the local cache
    env.allowLocalModels = false;
    await AutoProcessor.from_pretrained("onnx-community/whisper-small");
    await WhisperForConditionalGeneration.from_pretrained("onnx-community/whisper-small", { dtype: "q8" });
    console.log("OK: loaded entirely from the mirror.");
  });
'
```

(This exact check — model load succeeding against a local static file server standing in for the
bucket — was used to validate the staging layout before writing this doc.)

## Cost / growth note

~240 MB today (whisper-small q8 only). If large-v3-turbo is confirmed for the WebGPU tier (issue #9)
or an LLM fallback ships later (Qwen2.5-1.5B q4, ~1 GB — see the feasibility report §5.6, currently
scoped as "maybe never"), each addition is another `mirror-fetch-model.ts` + `mirror-upload-s3.sh` run;
nothing about the bucket layout needs to change.

## Related

- `docs/local-model-cache.md` — the Node-side `.hf-cache/` prefetch convention this reuses.
- `docs/voice-pipeline-feasibility.md` — why whisper-small q8 is the model being mirrored.
- Issue #9 — the app-shell hosting decision (GH Pages vs Cyfronet) this mirror feeds into.
- Issue #34 — tracks this mirroring work specifically.
