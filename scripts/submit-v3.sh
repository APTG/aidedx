#!/bin/bash
#SBATCH --job-name=aidedx-tts1000-v3
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
# Runs the v3 1000-sample TTS eval-audio pipeline (issue #92, following on from v2 in
# issue #83 / docs/tts-eval-1000-v2.md) as a batch job — same rationale as
# scripts/submit.sh/submit-v2.sh: an interactive background job doing this work died
# silently partway through once already when its session was torn down.
#
# v3 vs. v2 — the *sentences* are byte-identical (same generator, same fixed seed;
# scripts/generate-1000-sentences.mjs itself wasn't touched). Step 0 below still
# regenerates and validates them for reproducibility/resumability, not because the
# content differs. What actually changed, all in #93:
#  - scripts/tts-qwen-1000.py: the CustomVoice preset pool shrunk from 10 to 3 (the ones
#    that never showed up in a "worst 10 profiles" list across the v1/v2 reports); voice
#    assignment is now a stable hash of the sentence id instead of sequential-position
#    modulo (decorrelates voice from the fixed category order sentences are built in —
#    600 range, 250 inverse, 150 stp); each clip's synthesis is now individually seeded
#    for bit-reproducible audio. Net effect: same 1000 sentences, different (and fewer
#    CustomVoice) voices assigned, different actual audio.
#  - src/lib/asr/transcribe.ts's DOMAIN_PROMPT gained Kapton/Mylar/Teflon/Pyrex glass/
#    sodium iodide/cesium iodide (materials whisper-small fails on *every* occurrence,
#    per docs/tts-eval-1000.md §6.4 and docs/tts-eval-1000-v2.md §8) plus LET/linear
#    energy transfer/keV-um (taught to the matcher in #86, never biased toward before) —
#    mirrored by hand into scripts/asr-transcribe-manifest.mjs's own copy of
#    DOMAIN_PROMPT, which this job actually uses (see that script's header comment for
#    why it can't just import transcribe.ts).
#
# Distinct output paths throughout (the "-v3" / "tts-1000-v3-*" naming) so this run never
# collides with or overwrites the v1/v2 batches, which remain the historical record
# backing docs/tts-eval-1000.md and docs/tts-eval-1000-v2.md.
#
# Time limit bumped 4h -> 6h after a real run confirmed 4h is razor-thin even for a single
# clean pass: TTS generation alone took 11,823s (3.28h; see eval/audio/tts-qwen-1000-v3/
# manifest.json's summed gen_s), leaving well under an hour of margin for validation +
# transcription (~2,550s/42min for 1000 clips) + scoring before hitting a 4h ceiling. That
# run was in fact killed by SLURM's time limit — "CANCELLED ... DUE TO TIME LIMIT" — during
# transcription, at 975/1000 clips.
#
# Safe to resubmit as-is if it fails or times out partway through:
#  - TTS generation (scripts/tts-qwen-1000.py) skips any <id>.wav already on disk and
#    resumes from the manifest, so a resubmit only pays for the work not yet done.
#  - ASR transcription (scripts/asr-transcribe-manifest.mjs) is now resumable the same way
#    (issue #92, fixed after the run above lost all 975 completed transcriptions to the
#    time-limit kill — it used to write its output only once, after the full loop): it
#    checkpoints after every clip and skips any id already recorded in the existing
#    outFile, so a resubmit only re-transcribes what wasn't already saved.
#
# Usage (from the repo root, after pulling this branch/commit onto Athena):
#   sbatch scripts/submit-v3.sh

set -euo pipefail

# Defensive: `module` is normally inherited as an exported bash function from the
# submitting interactive shell, but don't rely on that surviving into a fresh batch
# environment — re-source Lmod's own init directly (idempotent if already initialized).
if ! type module &>/dev/null; then
  source /net/software/v1/software/Lmod/8.5.8/lmod/lmod/init/bash
fi

cd /net/tscratch/people/plgkongruencj/aidedx
source scripts/athena-env.sh

SENTENCES_FILE=scripts/tts-1000-sentences-v3.json
AUDIO_DIR=eval/audio/tts-qwen-1000-v3

echo "=== Step 0/3: regenerate + validate the 1000 sentences (unchanged from v2 — same seed, same output every run; every candidate is already checked against the real matcher + WASM as it's generated) ==="
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

RESULTS_DIR="eval/results/tts-1000-v3-$(date +%F)"
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
