#!/bin/bash
#SBATCH --job-name=aidedx-tts1000-v2
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
# Runs the v2 1000-sample TTS eval-audio pipeline (issue #83, following on from the
# original run in issue #30 / docs/tts-eval-1000.md) as a batch job — same rationale as
# scripts/submit.sh: an interactive background job doing this work died silently
# partway through once already when its session was torn down.
#
# v2 vs. the original run:
#  - the sentence pool now includes Z>18 heavy ions (calcium..uranium) and the
#    previously-broken materials (soft tissue, skin, lung, brain, blood, concrete, boron
#    family) — all unlocked by #81's libdedx update + Bethe fallback;
#  - ~50% of the stoppingPower category is phrased with LET terminology instead of
#    "stopping power" (matcher support: #86);
#  - scripts/generate-1000-sentences.mjs now validates every candidate against the real
#    matcher + WASM inline as it generates (closing the generate→validate loop), so the
#    separate tts-sentence-check.ts pass below is a confirmation, not a discovery step —
#    it should always report 1000/1000 on the first try.
#
# Distinct output paths throughout (the "-v2" / "tts-1000-v2-*" naming) so this run never
# collides with or overwrites the original batch's outputs, which remain the historical
# record backing docs/tts-eval-1000.md.
#
# Safe to resubmit as-is if it fails or times out partway through: TTS generation
# (scripts/tts-qwen-1000.py) skips any <id>.wav already on disk and resumes from the
# manifest, so a resubmit only pays for the work not yet done.
#
# Usage (from the repo root): sbatch scripts/submit-v2.sh

set -euo pipefail

# Defensive: `module` is normally inherited as an exported bash function from the
# submitting interactive shell, but don't rely on that surviving into a fresh batch
# environment — re-source Lmod's own init directly (idempotent if already initialized).
if ! type module &>/dev/null; then
  source /net/software/v1/software/Lmod/8.5.8/lmod/lmod/init/bash
fi

cd /net/tscratch/people/plgkongruencj/aidedx
source scripts/athena-env.sh

SENTENCES_FILE=scripts/tts-1000-sentences-v2.json
AUDIO_DIR=eval/audio/tts-qwen-1000-v2

echo "=== Step 0/3: regenerate + validate the 1000 sentences (deterministic — same seed, same output every run; every candidate is already checked against the real matcher + WASM as it's generated) ==="
node scripts/generate-1000-sentences.mjs "$SENTENCES_FILE"
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

# No patch-slot-truth step here (unlike scripts/submit.sh): that script existed to fix a
# generator bug from the *original* run (every csdaRange clip recorded a blanket "range"
# keyword regardless of which template phrasing actually fired). The current generator
# already records the correct per-template keyword at generation time — see
# scripts/generate-1000-sentences.mjs's per-template `kw` field — so
# eval/audio/tts-qwen-1000-v2/manifest.json's slotTruth is correct from the moment
# tts-qwen-1000.py writes it; patching it again here would be a no-op.

RESULTS_DIR="eval/results/tts-1000-v2-$(date +%F)"
mkdir -p "$RESULTS_DIR"

echo "=== Step 2/3: ASR transcription (whisper-small q8 + domain prompt) ==="
node scripts/asr-transcribe-manifest.mjs "$AUDIO_DIR" "$AUDIO_DIR/manifest.json" \
  onnx-community/whisper-small q8 "$RESULTS_DIR/small-q8-prompt.json"

echo "=== Step 3/3: score against both correction layers ==="
node scripts/asr-score-slots-generic.mjs "$AUDIO_DIR/manifest.json" "$RESULTS_DIR/small-q8-prompt.json" \
  --json "$RESULTS_DIR/score-base.json" | tee "$RESULTS_DIR/score-base.log"
node scripts/asr-score-slots-generic.mjs "$AUDIO_DIR/manifest.json" "$RESULTS_DIR/small-q8-prompt.json" --ext \
  --json "$RESULTS_DIR/score-ext.json" | tee "$RESULTS_DIR/score-ext.log"

echo "=== Done — results in $RESULTS_DIR ==="
