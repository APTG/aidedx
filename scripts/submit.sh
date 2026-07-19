#!/bin/bash
#SBATCH --job-name=aidedx-tts1000
#SBATCH --partition=plgrid-gpu-a100
#SBATCH --account=plgccbmc15-gpu-a100
#SBATCH --qos=normal
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=16
#SBATCH --mem=64G
#SBATCH --gres=gpu:a100:1
#SBATCH --time=04:00:00
#SBATCH --output=%x-%j.out
#SBATCH --error=%x-%j.err
#
# Runs the full 1000-sample TTS eval-audio pipeline (issue #30) as a batch job instead of
# inside an interactive session — an interactive background job doing this same work died
# silently partway through when the session it was attached to was torn down (this project
# hit that once already; docs/athena-setup.md's "dropped connection" caveat applies to any
# long-running interactive command, not just the shell itself).
#
# Safe to resubmit as-is if it fails or times out partway through: TTS generation
# (scripts/tts-qwen-1000.py) skips any <id>.wav already on disk and resumes from the
# manifest, so a resubmit only pays for the work not yet done.
#
# Usage (from the repo root): sbatch scripts/submit.sh

set -euo pipefail

# Defensive: `module` is normally inherited as an exported bash function from the
# submitting interactive shell, but don't rely on that surviving into a fresh batch
# environment — re-source Lmod's own init directly (idempotent if already initialized).
if ! type module &>/dev/null; then
  source /net/software/v1/software/Lmod/8.5.8/lmod/lmod/init/bash
fi

cd /net/tscratch/people/plgkongruencj/aidedx
source scripts/athena-env.sh

echo "=== Step 0/4: regenerate + validate the 1000 sentences (deterministic — same seed, same output every run) ==="
# --experimental-strip-types: the generator now imports tts-sentence-check.ts directly
# (inline validation, issue #83) — required on Athena's older Node 22.17.1, which (unlike
# the CI runner's Node 24, or Node 22.18+) doesn't strip .ts imports unflagged.
node --experimental-strip-types scripts/generate-1000-sentences.mjs scripts/tts-1000-sentences.json
node --experimental-strip-types scripts/tts-sentence-check.ts scripts/tts-1000-sentences.json

echo "=== Step 1/4: TTS generation (resumes automatically from existing eval/audio/tts-qwen-1000/*.wav) ==="
source .venv-qwen/bin/activate
python scripts/tts-qwen-1000.py scripts/tts-1000-sentences.json eval/audio/tts-qwen-1000
deactivate

WAV_COUNT=$(find eval/audio/tts-qwen-1000 -maxdepth 1 -name '*.wav' | wc -l)
echo "generated audio count: $WAV_COUNT"
if [ "$WAV_COUNT" -ne 1000 ]; then
  echo "ERROR: expected 1000 wav files, found $WAV_COUNT — resubmit this job to resume" >&2
  exit 1
fi

echo "=== Step 2/4: patch slotTruth ground truth onto the manifest ==="
node scripts/patch-slot-truth.mjs

RESULTS_DIR=eval/results/tts-1000-2026-07-16
mkdir -p "$RESULTS_DIR"

echo "=== Step 3/4: ASR transcription (whisper-small q8 + domain prompt) ==="
node scripts/asr-transcribe-manifest.mjs eval/audio/tts-qwen-1000 eval/audio/tts-qwen-1000/manifest.json \
  onnx-community/whisper-small q8 "$RESULTS_DIR/small-q8-prompt.json"

echo "=== Step 4/4: score against both correction layers ==="
node scripts/asr-score-slots-generic.mjs eval/audio/tts-qwen-1000/manifest.json "$RESULTS_DIR/small-q8-prompt.json" \
  --json "$RESULTS_DIR/score-base.json" | tee "$RESULTS_DIR/score-base.log"
node scripts/asr-score-slots-generic.mjs eval/audio/tts-qwen-1000/manifest.json "$RESULTS_DIR/small-q8-prompt.json" --ext \
  --json "$RESULTS_DIR/score-ext.json" | tee "$RESULTS_DIR/score-ext.log"

echo "=== Done — results in $RESULTS_DIR ==="
