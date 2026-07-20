#!/bin/bash
#SBATCH --job-name=aidedx-tts1000-chatterbox-pl
#SBATCH --partition=plgrid-gpu-a100
#SBATCH --account=plgccbmc15-gpu-a100
#SBATCH --qos=normal
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=16
#SBATCH --mem=64G
#SBATCH --gres=gpu:a100:1
#SBATCH --time=12:00:00
#SBATCH --output=%x-%j.out
#SBATCH --error=%x-%j.err
#
# Runs both Chatterbox Multilingual TTS Polish batches from issue #106, back to back:
#
#  - Option A, voice-cloned (scripts/tts-chatterbox-1000-pl.py --clone-refs): the speaker's own
#    voice (eval/audio/lg/'s 50 human-recorded Polish clips, explicitly authorized for cloning —
#    see the PR description), cloned into 10 reference voices via
#    scripts/prepare-voice-clone-refs.py (run locally, not here — this job expects
#    eval/audio/tts-clone-refs-pl/clone-01..10.wav to already exist, rsynced in ahead of time).
#    Each of the 1000 sentences goes to one of the 10 clones (~100 sentences/voice).
#  - Option B, native (scripts/tts-chatterbox-1000-pl.py, no --clone-refs): Chatterbox's own
#    default Polish voice, no cloning, no consent surface — a clean "how good is Chatterbox's
#    native Polish" data point independent of the cloning question.
#
# Same 1000 sentences as the existing Piper/Qwen3-TTS Polish batches (scripts/submit-pl.sh) —
# regenerated here from the same fixed-seed generator, not copied, so this job has no
# dependency on submit-pl.sh having run first.
#
# --- venv: .venv-chatterbox must already exist ---
# chatterbox-tts depends on torch (CUDA-specific wheel) the same way qwen-tts does — auto-
# provisioning that blind in a batch job risks silently pulling a CPU-only torch build from
# plain PyPI (docs/athena-setup.md's Qwen precedent: `pip install qwen-tts` alone pulled a
# mismatched torchaudio once already, docs/tts-eval-audio.md §6.2 point 1 — the same class of
# footgun is plausible here). One-time interactive setup, mirroring .venv-qwen's:
#   python3 -m venv .venv-chatterbox
#   source .venv-chatterbox/bin/activate
#   pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
#   pip install chatterbox-tts
# This script fails fast with a clear message if it's missing, same as submit-pl.sh does for
# .venv-qwen.
#
# --- Resumability ---
# Every step below is resumable exactly like submit-pl.sh: sentence generation is deterministic
# (safe to regenerate), TTS generation skips ids already in each batch's manifest.json, ASR
# transcription skips ids already in its outFile. Safe to resubmit as-is after any failure or
# timeout.
#
# Usage (from the repo root, after pulling this branch/commit onto Athena, and after rsyncing
# eval/audio/tts-clone-refs-pl/ from the machine that ran scripts/prepare-voice-clone-refs.py):
#   sbatch scripts/submit-chatterbox-pl.sh

set -euo pipefail

if ! type module &>/dev/null; then
  source /net/software/v1/software/Lmod/8.5.8/lmod/lmod/init/bash
fi

cd /net/tscratch/people/plgkongruencj/aidedx
source scripts/athena-env.sh

SENTENCES_FILE=scripts/tts-1000-sentences-pl.json
CLONE_REFS_DIR=eval/audio/tts-clone-refs-pl
CLONE_AUDIO_DIR=eval/audio/tts-chatterbox-clone-1000-pl
NATIVE_AUDIO_DIR=eval/audio/tts-chatterbox-native-1000-pl

echo "=== Step 0/4: generate + validate the 1000 Polish sentences (same fixed seed as submit-pl.sh) ==="
node --experimental-strip-types scripts/generate-1000-sentences-pl.mjs "$SENTENCES_FILE"
node --experimental-strip-types scripts/tts-sentence-check.ts "$SENTENCES_FILE" --lang pl

if [ ! -d .venv-chatterbox ]; then
  echo "ERROR: .venv-chatterbox not found. This is CUDA-specific (torch + chatterbox-tts) and" >&2
  echo "isn't auto-provisioned here — set it up once (see this file's header comment), then" >&2
  echo "resubmit." >&2
  exit 1
fi
if [ ! -d "$CLONE_REFS_DIR" ]; then
  echo "ERROR: $CLONE_REFS_DIR not found. Run scripts/prepare-voice-clone-refs.py locally and" >&2
  echo "rsync its output here first (see the PR description for the exact rsync command)." >&2
  exit 1
fi

source .venv-chatterbox/bin/activate

echo "=== Step 1/4: Chatterbox generation, cloned voices (resumes automatically from $CLONE_AUDIO_DIR) ==="
python scripts/tts-chatterbox-1000-pl.py "$SENTENCES_FILE" "$CLONE_AUDIO_DIR" --clone-refs "$CLONE_REFS_DIR"

echo "=== Step 2/4: Chatterbox generation, native voice, no cloning (resumes automatically from $NATIVE_AUDIO_DIR) ==="
python scripts/tts-chatterbox-1000-pl.py "$SENTENCES_FILE" "$NATIVE_AUDIO_DIR"

deactivate

for dir in "$CLONE_AUDIO_DIR" "$NATIVE_AUDIO_DIR"; do
  count=$(find "$dir" -maxdepth 1 -name '*.wav' | wc -l)
  echo "$dir: $count wav files"
done

RESULTS_DIR="eval/results/tts-1000-pl-chatterbox-$(date +%F)"
mkdir -p "$RESULTS_DIR"

echo "=== Step 3/4: ASR transcription, both batches (whisper-small q8, Polish token + Polish domain prompt) ==="
node scripts/asr-transcribe-manifest.mjs "$CLONE_AUDIO_DIR" "$CLONE_AUDIO_DIR/manifest.json" \
  onnx-community/whisper-small q8 "$RESULTS_DIR/clone-small-q8-prompt.json" --lang pl
node scripts/asr-transcribe-manifest.mjs "$NATIVE_AUDIO_DIR" "$NATIVE_AUDIO_DIR/manifest.json" \
  onnx-community/whisper-small q8 "$RESULTS_DIR/native-small-q8-prompt.json" --lang pl

echo "=== Step 4/4: score both batches against all three correction layers ==="
for engine in clone native; do
  audio_dir_var="${engine^^}_AUDIO_DIR"
  audio_dir="${!audio_dir_var}"
  node --experimental-strip-types scripts/asr-score-slots-generic.mjs "$audio_dir/manifest.json" \
    "$RESULTS_DIR/${engine}-small-q8-prompt.json" \
    --json "$RESULTS_DIR/${engine}-score-base.json" | tee "$RESULTS_DIR/${engine}-score-base.log"
  node --experimental-strip-types scripts/asr-score-slots-generic.mjs "$audio_dir/manifest.json" \
    "$RESULTS_DIR/${engine}-small-q8-prompt.json" --ext \
    --json "$RESULTS_DIR/${engine}-score-ext.json" | tee "$RESULTS_DIR/${engine}-score-ext.log"
  node --experimental-strip-types scripts/asr-score-slots-generic.mjs "$audio_dir/manifest.json" \
    "$RESULTS_DIR/${engine}-small-q8-prompt.json" --new \
    --json "$RESULTS_DIR/${engine}-score-new.json" | tee "$RESULTS_DIR/${engine}-score-new.log"
done

echo "=== Done — results in $RESULTS_DIR ==="
