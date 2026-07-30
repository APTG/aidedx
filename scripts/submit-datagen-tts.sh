#!/bin/bash
#SBATCH --job-name=aidedx-datagen-tts
#SBATCH --partition=plgrid-gpu-a100
#SBATCH --account=plgccbmc15-gpu-a100
#SBATCH --qos=normal
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=16
#SBATCH --mem=64G
#SBATCH --gres=gpu:a100:1
#SBATCH --time=03:00:00
#SBATCH --output=%x-%j.out
#SBATCH --error=%x-%j.err
#
# Issue #155 (deferred Part 5 of #130) — synthesizes the same 50+50 eval/datagen-sentences.json
# set that #149 already recorded with a real human speaker (`lgpixel`, docs/android-datagen-
# bench.md), through three independent TTS engines, so a later session can pick whichever is
# useful for the human-vs-synthetic comparison instead of committing to one up front:
#
#  - Qwen3-TTS (English, VoiceDesign+CustomVoice pool) — the established EN engine across the
#    1000-sentence batches (docs/tts-eval-1000-v3.md, 84.0% clip-level).
#  - Piper (Polish, real pl_PL voices) — the only currently-viable PL engine
#    (docs/tts-eval-1000-pl.md: 20.8% vs. Qwen3-TTS-PL's ~0.9%, which isn't even a real language
#    match — see that doc's TL;DR).
#  - Chatterbox Multilingual TTS (Polish, native voice, no cloning) — issue #106's "how good is
#    Chatterbox's native Polish" data point, built to see whether it closes some of the
#    Piper/Qwen3-TTS Polish gap. Native only, deliberately: issue #155 explicitly excludes voice
#    cloning as a non-goal (cloning the `lgpixel` speaker's voice would need that speaker's own
#    explicit re-authorization for this specific use, per #106's consent precedent — not assumed
#    here just because it was granted for the unrelated 1000-sentence clone batch).
#
# Unlike the 1000-sentence batches, the sentence set here is NOT regenerated — it's the same
# already-committed, already-validated eval/datagen-sentences.json every other #130/#151/#153
# script reads, so there's no Step 0 sentence-generation/validation to run. What IS needed is
# flattening its {id, en:{...}, pl:{...}} shape into the {id, text, ...} shape every TTS
# generation script here expects — using the `display` field (not `canonical`), the one #130
# Part 1 deliberately designed to double as TTS input (spelled-out length units, the 5/50
# expanded-energy sentences, letter-spelled `LET`/`CSDA` in English — see
# eval/RECORDING.datagen.md's own rendering table). scripts/datagen-to-manifest.mjs's
# `--field display` mode (added for this issue) does exactly that; no new Python generation
# script was needed since tts-qwen-1000.py / tts-piper-1000.py / tts-chatterbox-1000-pl.py are
# already fully generic over the flat {id, text, ...} shape.
#
# --- venvs ---
# .venv-qwen and .venv-chatterbox must already exist (both CUDA-specific, one-time interactive
# setup — see docs/athena-setup.md for .venv-qwen, this repo's scripts/submit-chatterbox-pl.sh
# header comment for .venv-chatterbox's exact pip/torch-pin gotcha). This script fails fast with
# a clear message if either is missing, same convention as submit-pl.sh /
# submit-chatterbox-pl.sh. .venv-piper is auto-provisioned below if missing (piper-tts is a
# small, pure-CPU install — no CUDA wheel to get wrong).
#
# --- Resumability ---
# Every step is resumable exactly like submit-pl.sh / submit-chatterbox-pl.sh: TTS generation
# skips ids already in each batch's manifest.json, ASR transcription skips ids already in its
# outFile. Safe to resubmit as-is after any failure or timeout.
#
# --- Time budget ---
# 03:00:00 — generous, not measured (no prior run of this exact 50-clip-per-engine pipeline to
# size from). Scaled down from the 1000-clip batches' own generous 12h budgets by roughly the
# clip-count ratio (50 vs. 1000, ~20x fewer clips per engine) plus headroom for three separate
# model loads/downloads (Qwen3-TTS ~1.7B ×2 checkpoints, Piper's 5 pl_PL voices, Chatterbox's
# multilingual checkpoint) and three ASR transcription passes.
#
# Usage (from the repo root, after pulling this branch/commit onto Athena):
#   sbatch scripts/submit-datagen-tts.sh

set -euo pipefail

if ! type module &>/dev/null; then
  source /net/software/v1/software/Lmod/8.5.8/lmod/lmod/init/bash
fi

cd /net/tscratch/people/plgkongruencj/aidedx
source scripts/athena-env.sh

EN_SENTENCES=eval/datagen-manifest-tts-en.json
PL_SENTENCES=eval/datagen-manifest-tts-pl.json
QWEN_AUDIO_DIR=eval/audio/tts-qwen-datagen-en
PIPER_AUDIO_DIR=eval/audio/tts-piper-datagen-pl
CHATTERBOX_AUDIO_DIR=eval/audio/tts-chatterbox-datagen-pl

echo "=== Step 0/6: flatten eval/datagen-sentences.json's display field into TTS-ready manifests ==="
node scripts/datagen-to-manifest.mjs en "$EN_SENTENCES" --field display
node scripts/datagen-to-manifest.mjs pl "$PL_SENTENCES" --field display

if [ ! -d .venv-qwen ]; then
  echo "ERROR: .venv-qwen not found. CUDA-specific, one-time interactive setup — see" >&2
  echo "docs/athena-setup.md — then resubmit." >&2
  exit 1
fi
if [ ! -d .venv-chatterbox ]; then
  echo "ERROR: .venv-chatterbox not found. CUDA-specific, one-time interactive setup — see" >&2
  echo "scripts/submit-chatterbox-pl.sh's header comment for the exact torch-pin gotcha — then" >&2
  echo "resubmit." >&2
  exit 1
fi

echo "=== Step 1/6: Qwen3-TTS English generation (resumes automatically from $QWEN_AUDIO_DIR) ==="
source .venv-qwen/bin/activate
python scripts/tts-qwen-1000.py "$EN_SENTENCES" "$QWEN_AUDIO_DIR"
deactivate

echo "=== Step 2/6: Piper Polish generation (resumes automatically from $PIPER_AUDIO_DIR) ==="
if [ ! -d .venv-piper ]; then
  echo "  .venv-piper not found — creating it (one-time; piper-tts is a small, pure-CPU install)"
  python3 -m venv .venv-piper
  source .venv-piper/bin/activate
  pip install --upgrade pip
  pip install piper-tts
else
  source .venv-piper/bin/activate
fi
python scripts/tts-piper-1000.py "$PL_SENTENCES" "$PIPER_AUDIO_DIR"
deactivate

echo "=== Step 3/6: Chatterbox Polish generation, native voice, no cloning (resumes automatically from $CHATTERBOX_AUDIO_DIR) ==="
source .venv-chatterbox/bin/activate
python scripts/tts-chatterbox-1000-pl.py "$PL_SENTENCES" "$CHATTERBOX_AUDIO_DIR"
deactivate

for dir in "$QWEN_AUDIO_DIR" "$PIPER_AUDIO_DIR" "$CHATTERBOX_AUDIO_DIR"; do
  count=$(find "$dir" -maxdepth 1 -name '*.wav' | wc -l)
  echo "$dir: $count wav files"
done

RESULTS_DIR="eval/results/datagen-tts-$(date +%F)"
mkdir -p "$RESULTS_DIR"

echo "=== Step 4/6: ASR transcription, all three batches (whisper-small q8, language token + domain prompt) ==="
# Desktop whisper-small+prompt — the same leg docs/android-datagen-bench.md's own §4.1 table
# already reports for the real lgpixel session, so these numbers land directly in that table's
# EN/PL columns rather than needing a separate methodology to reconcile.
node scripts/asr-transcribe-manifest.mjs "$QWEN_AUDIO_DIR" "$QWEN_AUDIO_DIR/manifest.json" \
  onnx-community/whisper-small q8 "$RESULTS_DIR/qwen-en-small-q8-prompt.json" --lang en
node scripts/asr-transcribe-manifest.mjs "$PIPER_AUDIO_DIR" "$PIPER_AUDIO_DIR/manifest.json" \
  onnx-community/whisper-small q8 "$RESULTS_DIR/piper-pl-small-q8-prompt.json" --lang pl
node scripts/asr-transcribe-manifest.mjs "$CHATTERBOX_AUDIO_DIR" "$CHATTERBOX_AUDIO_DIR/manifest.json" \
  onnx-community/whisper-small q8 "$RESULTS_DIR/chatterbox-pl-small-q8-prompt.json" --lang pl

echo "=== Step 5/6: score all three batches (same E2E metric docs/android-datagen-bench.md §4.1 uses) ==="
# --experimental-strip-types: this script directly imports matcher.ts/coverage.ts/core.ts —
# same Athena-Node-22.17.1 gotcha scripts/submit-v4.sh's Step 3 already hit and fixed
# defensively for asr-score-slots-generic.mjs; applied here up front rather than waiting to
# rediscover it the same way.
node --experimental-strip-types scripts/e2e-audio-intents-datagen.ts en \
  "$RESULTS_DIR/qwen-en-small-q8-prompt.json" | tee "$RESULTS_DIR/qwen-en-score.log"
node --experimental-strip-types scripts/e2e-audio-intents-datagen.ts pl \
  "$RESULTS_DIR/piper-pl-small-q8-prompt.json" | tee "$RESULTS_DIR/piper-pl-score.log"
node --experimental-strip-types scripts/e2e-audio-intents-datagen.ts pl \
  "$RESULTS_DIR/chatterbox-pl-small-q8-prompt.json" | tee "$RESULTS_DIR/chatterbox-pl-score.log"

echo "=== Done — results in $RESULTS_DIR ==="
