#!/usr/bin/env bash
# Athena/PLGrid environment setup for this project — see docs/athena-setup.md.
#
# Source this (do NOT execute it) before any Node/Python/GPU work on Athena:
#   source scripts/athena-env.sh
#
# Loads the modules this repo's tooling needs and redirects every cache that would
# otherwise write into $HOME (10 GB hard quota on PLGrid, easy to exceed with a couple of
# `pip install`s worth of torch wheels or one HF model download) onto scratch, inside this
# repo's own working directory. Idempotent — safe to source more than once per shell.

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "athena-env.sh must be sourced, not executed: 'source scripts/athena-env.sh'" >&2
  exit 1
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# GCCcore/14.3.0 is a hard prerequisite for FFmpeg/7.1.2 and nodejs/22.17.1 (Lmod hierarchical
# module tree — `module spider FFmpeg/7.1.2` shows it) and must be loaded first explicitly: it
# is NOT reliably pre-loaded by the login shell, and this whole script only works by accident
# in a session where something else happened to load it first.
module load GCCcore/14.3.0 FFmpeg/7.1.2 nodejs/22.17.1 Python/3.10.4

# Athena's module system unconditionally adds Python 3.13 system-package directories to
# PYTHONPATH regardless of which Python module is loaded, which shadows a venv's own packages
# with incompatible cp313 builds (docs/tts-eval-audio.md §2). Any venv in this repo is 3.10.
unset PYTHONPATH

# --- Cache redirects: everything below must live under $PROJECT_ROOT, never $HOME ---
export XDG_CACHE_HOME="$PROJECT_ROOT/.cache"
export PIP_CACHE_DIR="$PROJECT_ROOT/.cache/pip"
export npm_config_cache="$PROJECT_ROOT/.cache/npm"
export npm_config_prefix="$PROJECT_ROOT/.npm-global"
# Shared Python-side (huggingface_hub) cache — Kokoro (.venv-tts) and Qwen3-TTS (.venv-qwen)
# both use this; the Node-side @huggingface/transformers cache (.hf-cache/) is separate and
# already scratch-resident by construction (scripts/asr-transcribe.mjs sets env.cacheDir itself).
export HF_HOME="$PROJECT_ROOT/.hf-cache-py"

mkdir -p "$XDG_CACHE_HOME/pip" "$XDG_CACHE_HOME/npm" "$XDG_CACHE_HOME/torch" \
  "$npm_config_prefix" "$HF_HOME"

export PATH="$npm_config_prefix/bin:$PATH"

echo "athena-env: modules loaded, caches redirected to $PROJECT_ROOT (see docs/athena-setup.md)"
