#!/bin/bash
#SBATCH --job-name=aidedx-tts1000-v4
#SBATCH --partition=plgrid-gpu-a100
#SBATCH --account=plgccbmc15-gpu-a100
#SBATCH --qos=normal
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=16
#SBATCH --mem=64G
#SBATCH --gres=gpu:a100:1
#SBATCH --time=06:00:00
#SBATCH --output=%x-%j.out
#SBATCH --error=%x-%j.err
#
# Runs the v4 1000-sample TTS eval-audio pipeline (issue #118 TODO item 1,
# docs/unit-pronunciation-asr.md §7#1) as a batch job — same rationale as
# scripts/submit-v2.sh/submit-v3.sh: an interactive background job doing this work died
# silently partway through once already when its session was torn down.
#
# v4 vs. v3 — UNLIKE v3-vs-v2 (byte-identical sentences, only the TTS/prompt changed), the
# *sentences themselves* are now different: scripts/generate-1000-sentences.mjs was changed
# to render each keV/MeV/GeV/cm/mm mention as one of several spoken-out variants (abbrev /
# expanded / spaced-out for energy; abbrev / expanded for length) instead of always the bare
# abbreviation — so the corpus's own input TEXT spans more of the human pronunciation
# distribution (docs/unit-pronunciation-asr.md §3's finding: no single TTS engine's G2P does
# this on its own). slotTruth (the scoring ground truth) is unaffected — it's derived from
# the underlying value/unit, not reverse-parsed from the rendered text — but the actual
# words a listener would hear, and therefore what whisper-small has to recognize, are
# genuinely different from v1/v2/v3. That's the whole point of this run: compare this
# result against v3's (`eval/results/tts-1000-v3-*/score-*.json`) to see whether the varied
# renderings move the shipped model's accuracy.
#
# Distinct output paths throughout (the "-v4" / "tts-1000-v4-*" naming) so this run never
# collides with or overwrites the v1/v2/v3 batches, which remain the historical record
# backing docs/tts-eval-1000.md, docs/tts-eval-1000-v2.md, and issue #92/#93.
#
# Same workload size as v3 (1000 sentences, same TTS engine/voices, same transcription
# model) — no reason to expect materially different timing, so the same 6h budget applies:
# v3's real run took ~3.28h for TTS generation + ~42min for transcription.
#
# Safe to resubmit as-is if it fails or times out partway through:
#  - TTS generation (scripts/tts-qwen-1000.py) skips any <id>.wav already on disk and
#    resumes from the manifest, so a resubmit only pays for the work not yet done.
#  - ASR transcription (scripts/asr-transcribe-manifest.mjs) checkpoints after every clip
#    and skips any id already recorded in the existing outFile, so a resubmit only
#    re-transcribes what wasn't already saved.
#
# Usage (from the repo root, after pulling this branch/commit onto Athena):
#   sbatch scripts/submit-v4.sh

set -euo pipefail

# Defensive: `module` is normally inherited as an exported bash function from the
# submitting interactive shell, but don't rely on that surviving into a fresh batch
# environment — re-source Lmod's own init directly (idempotent if already initialized).
if ! type module &>/dev/null; then
  source /net/software/v1/software/Lmod/8.5.8/lmod/lmod/init/bash
fi

cd /net/tscratch/people/plgkongruencj/aidedx
source scripts/athena-env.sh

SENTENCES_FILE=scripts/tts-1000-sentences-v4.json
AUDIO_DIR=eval/audio/tts-qwen-1000-v4

echo "=== Step 0/3: generate + validate the 1000 sentences (unit-rendering variance, issue #118 item 1 — different from v2/v3's sentences) ==="
# --experimental-strip-types: the generator imports tts-sentence-check.ts directly for
# inline validation — required on Athena's older Node 22.17.1, which (unlike the CI
# runner's Node 24, or Node 22.18+) doesn't strip .ts imports unflagged.
node --experimental-strip-types scripts/generate-1000-sentences.mjs "$SENTENCES_FILE"
node --experimental-strip-types scripts/tts-sentence-check.ts "$SENTENCES_FILE"

echo "=== Step 1/3: TTS generation (resumes automatically from existing $AUDIO_DIR/*.wav) ==="
source .venv-qwen/bin/activate
python scripts/tts-qwen-1000.py "$SENTENCES_FILE" "$AUDIO_DIR"
deactivate

WAV_COUNT=$(find "$AUDIO_DIR" -maxdepth 1 -name '*.wav' | wc -l)
echo "generated audio count: $WAV_COUNT"
if [ "$WAV_COUNT" -ne 1000 ]; then
  echo "ERROR: expected 1000 wav files, found $WAV_COUNT — resubmit this job to resume" >&2
  exit 1
fi

RESULTS_DIR="eval/results/tts-1000-v4-$(date +%F)"
mkdir -p "$RESULTS_DIR"

echo "=== Step 2/3: ASR transcription (whisper-small q8 + expanded domain prompt) ==="
node scripts/asr-transcribe-manifest.mjs "$AUDIO_DIR" "$AUDIO_DIR/manifest.json" \
  onnx-community/whisper-small q8 "$RESULTS_DIR/small-q8-prompt.json"

echo "=== Step 3/3: score against all three correction layers ==="
node scripts/asr-score-slots-generic.mjs "$AUDIO_DIR/manifest.json" "$RESULTS_DIR/small-q8-prompt.json" \
  --json "$RESULTS_DIR/score-base.json" | tee "$RESULTS_DIR/score-base.log"
node scripts/asr-score-slots-generic.mjs "$AUDIO_DIR/manifest.json" "$RESULTS_DIR/small-q8-prompt.json" --ext \
  --json "$RESULTS_DIR/score-ext.json" | tee "$RESULTS_DIR/score-ext.log"
node scripts/asr-score-slots-generic.mjs "$AUDIO_DIR/manifest.json" "$RESULTS_DIR/small-q8-prompt.json" --new \
  --json "$RESULTS_DIR/score-new.json" | tee "$RESULTS_DIR/score-new.log"

echo "=== Done — results in $RESULTS_DIR ==="
echo "Compare against v3's baseline: eval/results/tts-1000-v3-*/score-new.json"
