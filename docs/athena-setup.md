# Athena/PLGrid environment setup — read this before any GPU/Python work on this repo

_Written 2026-07-16, after `$HOME`'s disk quota was hit for real mid-session (see §2). Canonical
reference for working on this repo on Athena — `docs/tts-eval-audio.md` §2/§6.4 point here instead
of repeating setup instructions._

## TL;DR

```sh
cd aidedx
source scripts/athena-env.sh
```

That one line loads every module this repo's tooling needs and redirects every cache this session
touched away from `$HOME` and onto scratch, inside the repo itself. Re-source it in any new shell
before running Node, Python, or anything GPU-related here. It's idempotent.

## 1. Why this exists

Athena compute nodes give each user account a **10 GB hard quota on `$HOME`** (`quota -s` —
`172.23.31.103:/net/people`, `10240M` limit). That's tiny next to what ML tooling downloads by
default: PyTorch wheels alone are 800 MB–2 GB each, a single TTS model's weights can be 4–5 GB, and
every one of `pip`, `npm`, and `huggingface_hub` defaults to caching inside `$HOME` unless told
otherwise. None of that is specific to this repo — it's how these tools always behave — but it
collides hard with PLGrid's quota the moment you do anything nontrivial.

**This is not hypothetical.** Downloading `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` for
`docs/tts-eval-audio.md` §6 hit `OSError: [Errno 122] Disk quota exceeded` partway through, because
two `pip install torch` runs (one per venv) had already put 2.4 GB of wheel cache in
`~/.cache/pip`, on top of an `~/.npm` and a `~/.local`-installed `pnpm`. The account was already at
its 10 GB limit before the model download even started. Scratch (`/net/tscratch/...`), by contrast,
had **126 TB free** at the time. The fix isn't "clean up occasionally" — it's "never write these
caches into `$HOME` in the first place."

## 2. What `scripts/athena-env.sh` does

```sh
module load GCCcore/14.3.0 FFmpeg/7.1.2 nodejs/22.17.1 Python/3.10.4
unset PYTHONPATH
export XDG_CACHE_HOME="$PROJECT_ROOT/.cache"
export PIP_CACHE_DIR="$PROJECT_ROOT/.cache/pip"
export npm_config_cache="$PROJECT_ROOT/.cache/npm"
export npm_config_prefix="$PROJECT_ROOT/.npm-global"
export HF_HOME="$PROJECT_ROOT/.hf-cache-py"
export PATH="$npm_config_prefix/bin:$PATH"
```

| Concern                                         | Setting             | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node, ffmpeg, Python aren't on the default PATH | `module load ...`   | None of these are preinstalled outside the module system on Athena. `Python/3.10.4` specifically (not the default `3.13.5`) — see §3. `GCCcore/14.3.0` is listed first because it's a hard Lmod prerequisite for `FFmpeg/7.1.2` and `nodejs/22.17.1` (`module spider FFmpeg/7.1.2` shows it) — omitting it works only by accident, if something else in the shell happened to load a compatible toolchain first; a genuinely fresh login shell fails with `"cannot be loaded as requested"` without it. (Caught by re-testing this script from a genuinely fresh shell after a dropped connection.) |
| Module system leaks incompatible packages       | `unset PYTHONPATH`  | Athena's module system unconditionally adds Python **3.13** system-package directories to `PYTHONPATH` regardless of which Python module you load. This shadows a 3.10 venv's own packages with incompatible cp313 builds and breaks imports (hit this with `regex` under Kokoro — `docs/tts-eval-audio.md` §2).                                                                                                                                                                                                                                                                                    |
| `pip`'s wheel/http cache                        | `PIP_CACHE_DIR`     | Defaults to `~/.cache/pip`. Two venvs' worth of `torch` downloads alone were 2.4 GB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `npm`'s package cache                           | `npm_config_cache`  | Defaults to `~/.npm`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `npm install -g`'s install location             | `npm_config_prefix` | Defaults to `~/.local`. This is where `pnpm` (this repo's package manager, not on Athena's module system) gets installed via `npm install -g pnpm --prefix=...`.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Python-side Hugging Face downloads              | `HF_HOME`           | Defaults to `~/.cache/huggingface`. **This is the one that actually broke** — see §1. Shared between Kokoro (`.venv-tts/`) and Qwen3-TTS (`.venv-qwen/`); a HF cache is safely shared across unrelated repo IDs, no need to split it per model.                                                                                                                                                                                                                                                                                                                                                     |
| Anything else respecting the XDG spec           | `XDG_CACHE_HOME`    | Umbrella redirect — catches things like PyTorch's own CUDA-kernel cache (`~/.cache/torch`, small but was there) without needing a tool-specific env var for each one. Tools that ignore XDG (`npm`, `huggingface_hub`) get their own explicit var above regardless.                                                                                                                                                                                                                                                                                                                                 |

Node's own package manager, **`pnpm`, already defaults its content-addressable store to scratch**
on this cluster (`pnpm store path` → `/net/tscratch/.../.pnpm-store`, one level up from any one
repo, shared across projects) — that's a PLGrid/pnpm default already doing the right thing, not
something this script needed to fix.

## 3. Directory layout this creates (all inside the repo, all gitignored)

```
aidedx/
├── .cache/
│   ├── pip/         # pip wheel + HTTP cache
│   ├── npm/         # npm package cache
│   └── torch/       # PyTorch's CUDA kernel cache (small)
├── .npm-global/      # npm global install prefix — currently just pnpm's own CLI
├── .hf-cache-py/      # huggingface_hub cache — Python side (Kokoro + Qwen3-TTS venvs)
├── .hf-cache/         # @huggingface/transformers cache — Node/ASR side (pre-existing,
│                      #   scripts/asr-transcribe.mjs sets this itself, unrelated to this script)
├── .venv-tts/         # Kokoro-82M venv (docs/tts-eval-audio.md §2)
└── .venv-qwen/        # Qwen3-TTS venv (docs/tts-eval-audio.md §6.4)
```

Nothing here is committed — all gitignored. If you `du -sh` the repo directory after a full setup,
expect several GB; that's expected and is the entire point (scratch has room, `$HOME` doesn't).

## 4. What this script deliberately does NOT touch

- **`~/.local/share/claude/`** and similar — Claude Code's own (or any other dev tool's) persistent
  application data, unrelated to this repo. Don't redirect or clean this from a project script.
- **Pre-existing large `$HOME` directories from other tools** (`.ollama`, `.vscode-server-insiders`,
  `.opencode`, …, multiple GB combined on this account) — not created by this repo's work, out of
  scope for this script to manage.
- **`~/.gitconfig` / `~/.config/gh`** — your actual identity and GitHub auth; these are tiny pointer
  files, not caches, and there's no reason to move them.

If `$HOME` is still tight after sourcing this script and working normally, the remaining usage is
almost certainly one of the above, not this repo.

## 5. First-time setup on a new account/session

```sh
cd aidedx
source scripts/athena-env.sh          # modules + cache redirects, every session

python3 -m venv .venv-tts              # or .venv-qwen — see docs/tts-eval-audio.md for package lists
source .venv-tts/bin/activate
pip install --upgrade pip
pip install torch --index-url https://download.pytorch.org/whl/cu128
# ... model-specific packages, per docs/tts-eval-audio.md §2 / §6.4

pnpm install                           # Node deps; pnpm itself comes from athena-env.sh's PATH addition
```

`pnpm` isn't installed the first time `athena-env.sh` runs — that script only puts
`$PROJECT_ROOT/.npm-global/bin` on `PATH`, it doesn't install anything into it. Bootstrap it once
per account with:

```sh
npm install -g pnpm@10.33.0 --prefix="$PROJECT_ROOT/.npm-global"   # reads package.json's pinned version
```

after which it's picked up by `athena-env.sh`'s `PATH` export in every future session.

## 6. Verifying it worked

```sh
source scripts/athena-env.sh
which node python3 ffmpeg pnpm    # all resolve, none under $HOME
echo "$PIP_CACHE_DIR $npm_config_cache $HF_HOME"   # all under the repo, on scratch
quota -s                          # space usage well under the 10240M limit
```

## 7. Heavy work goes through `sbatch`, never run directly in an interactive/login shell

Two real failure modes this project has already hit, both from running GPU/long-CPU work directly
in an interactive session instead of as a batch job:

- **An interactive background TTS-generation job died silently** when the session it was attached
  to was torn down (§1's "dropped connection" scenario isn't limited to the shell itself — any
  long-running child process attached to that session goes with it). It happened to be resumable
  (`scripts/tts-qwen-1000.py` skips existing output files), so the lost work was bounded, but that's
  luck, not a plan.
- **Running Node/Python compute-heavy commands from a login/access node** rather than a job
  allocation is the same class of mistake, just caught before it caused damage rather than after —
  login nodes are shared, thin, and not meant for it, and it's easy to end up on one without
  noticing (`hostname` / `echo $SLURM_JOB_PARTITION` tells you which kind of node a given shell is
  actually on).

The fix used for the 1000-sample TTS batch (`docs/tts-eval-1000.md`): a committed
`scripts/submit.sh` (`sbatch scripts/submit.sh`) that runs the whole pipeline — regenerate +
validate sentences, synthesize
audio, transcribe, score — as one job, independent of whatever interactive session submitted it.
Resumable by construction, so a resubmit after a failure only pays for the work not yet done.

**Rule of thumb going forward**: anything involving the GPU, a model's `.generate()`/inference
call, or more than a few seconds of CPU work belongs in an `sbatch` script, not typed directly into
an interactive shell — even one that already has a GPU allocation (the allocation dying isn't the
only risk; being on the wrong kind of node in the first place is another). Quick read-only checks
(`grep`, `jq`/`python3 -c` over an already-written JSON file, `git`, `gh`) are fine anywhere.
