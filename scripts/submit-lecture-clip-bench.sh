#!/bin/bash
#SBATCH --job-name=aidedx-lecture-clip-bench
#SBATCH --partition=plgrid-gpu-a100
#SBATCH --account=plgccbmc15-gpu-a100
#SBATCH --qos=normal
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=16
#SBATCH --mem=64G
#SBATCH --gres=gpu:a100:1
#SBATCH --time=02:00:00
#SBATCH --output=%x-%j.out
#SBATCH --error=%x-%j.err
#
# Benchmarks every officially-released Whisper size (tiny/base/small/medium-ONNX/large-v2-ONNX/
# large-v3-ONNX/large-v3-turbo), at both fp32 and q8 — 14 (model, dtype) pairs — against the 10
# real-lecture unit-pronunciation clips in eval/audio/lecture-clips-118/ (issue #118 §8: GeV from
# MIT8_701F20_00-07_Units, MeV from 09-02_binding, keV+MeV from 10-01_mechanism). Answers "which
# model actually gets the unit right on real speech" for those specific instances, complementing
# §8's tiny/fp32-only pre-filter with the full model matrix.
#
# --- Single job, not an array (unlike submit-whisper-bench.sh) ---
# That script splits 14 models x 5 1000-clip datasets across 5 SLURM array lanes because the total
# work (70,000 clip-transcriptions) needs the parallelism. Here it's 14 models x 10 clips = 140
# transcriptions total — small enough to just run every model sequentially in one job. No lane
# splitting, no `--array`, no concurrency cap needed.
#
# --- GPU note (same as submit-whisper-bench.sh, verified by reading the code, not assumed) ---
# scripts/asr-transcribe-manifest.mjs never sets a `device` option, so @huggingface/transformers
# runs Whisper inference on CPU (onnxruntime-node's default backend) regardless of the
# `--gres=gpu:a100:1` allocation below. The GPU partition is requested anyway only because it's
# the one partition/account known accessible under this grant (same as every other script here) —
# expect the GPU to sit idle throughout; this is a CPU job in practice, which is also why the time
# budget below is short (10 short clips, not 1000).
#
# --- No manual prerequisite ---
# Every (model, dtype) pair here was already fetched by prior submit-whisper-bench.sh runs
# (jobs 2804461/2805165/2807345), so `prefetch-whisper-models.mjs --pairs` below should be a fast
# cache-hit no-op for all 14 — kept anyway so this script has no undocumented prerequisite if run
# on a fresh checkout/cache.
#
# --- Output: one raw transcript JSON per (model, dtype) combo, no scoring here ---
# Deliberately does NOT run scripts/asr-score-slots-generic.mjs — that scorer needs full
# `slotTruth` (quantity+unit+material+particle) labels the lecture-clip manifest doesn't have
# (it only has a bare `expected_unit` per clip, and one clip expects two different units). Score
# with `scripts/lecture-clip-bench-analyze.mjs` LOCALLY after syncing results back (same
# split as `scripts/forced-align-analyze.py` / `scripts/unit-probe-analyze.py`) — it runs the
# transcripts through the actual shipped corrector (`src/lib/asr/correct/core.ts`), not just a
# raw string match, so the reported accuracy reflects what the app would really produce.
#
# --- Failure isolation ---
# Same discipline as submit-whisper-bench.sh: a failed prefetch or transcribe for one (model,
# dtype) pair is logged and skipped (`continue`), not fatal to the rest of the job.
#
# Usage (run ON Athena, after `git pull`):
#   sbatch scripts/submit-lecture-clip-bench.sh
# Resumable: asr-transcribe-manifest.mjs skips clip ids already in its outFile, so a resubmit
# (same RESULTS_DIR) only re-does whatever didn't finish.
#   RESULTS_DIR=eval/results/lecture-clip-bench-<jobid> sbatch scripts/submit-lecture-clip-bench.sh

set -euo pipefail

if ! type module &>/dev/null; then
  source /net/software/v1/software/Lmod/8.5.8/lmod/lmod/init/bash
fi

cd /net/tscratch/people/plgkongruencj/aidedx
source scripts/athena-env.sh

AUDIO_DIR="eval/audio/lecture-clips-118"
MANIFEST="$AUDIO_DIR/manifest.json"
if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: $MANIFEST not found — run the clip-extraction step from issue #118 §8 first" >&2
  exit 1
fi

RESULTS_DIR="${RESULTS_DIR:-eval/results/lecture-clip-bench-${SLURM_JOB_ID}}"
mkdir -p "$RESULTS_DIR"
# Copied alongside the transcripts (same convention as scripts/submit-unit-probe.sh's per-engine
# manifest copy) so scripts/lecture-clip-bench-analyze.mjs only needs RESULTS_DIR, no separate
# path to the audio manifest to keep track of after syncing back.
cp "$MANIFEST" "$RESULTS_DIR/manifest.json"

# --- All 14 (model, dtype) pairs, same set as submit-whisper-bench.sh's 5 lanes combined ---
MODELS=(
  "onnx-community/whisper-tiny:fp32"
  "onnx-community/whisper-tiny:q8"
  "onnx-community/whisper-base:fp32"
  "onnx-community/whisper-base:q8"
  "onnx-community/whisper-small:fp32"
  "onnx-community/whisper-small:q8"
  "onnx-community/whisper-medium-ONNX:fp32"
  "onnx-community/whisper-medium-ONNX:q8"
  "onnx-community/whisper-large-v2-ONNX:fp32"
  "onnx-community/whisper-large-v2-ONNX:q8"
  "onnx-community/whisper-large-v3-ONNX:fp32"
  "onnx-community/whisper-large-v3-ONNX:q8"
  "onnx-community/whisper-large-v3-turbo:fp32"
  "onnx-community/whisper-large-v3-turbo:q8"
)

echo "=== ${#MODELS[@]} model/dtype pairs over $AUDIO_DIR (10 clips) -> $RESULTS_DIR ==="

FAILED_STEPS=()

for model_entry in "${MODELS[@]}"; do
  IFS=':' read -r model_id dtype <<<"$model_entry"
  model_short="${model_id#onnx-community/}"
  combo_label="${model_short}__${dtype}"
  transcript_out="$RESULTS_DIR/${combo_label}.json"

  echo "--- $combo_label ---"
  echo "[prefetch] $model_id [$dtype]"
  if ! node scripts/prefetch-whisper-models.mjs --pairs "$model_entry"; then
    echo "SKIPPING $combo_label — prefetch failed, see output above" >&2
    FAILED_STEPS+=("prefetch:$combo_label")
    continue
  fi

  echo "[transcribe] $model_id [$dtype] lang=en over $AUDIO_DIR"
  if ! node scripts/asr-transcribe-manifest.mjs "$AUDIO_DIR" "$MANIFEST" "$model_id" "$dtype" \
    "$transcript_out" --lang en; then
    echo "SKIPPING $combo_label — transcription failed, see output above" >&2
    FAILED_STEPS+=("transcribe:$combo_label")
    continue
  fi
done

echo "=== done — raw transcripts in $RESULTS_DIR ==="
if [ "${#FAILED_STEPS[@]}" -gt 0 ]; then
  echo "=== ${#FAILED_STEPS[@]} step(s) failed and were skipped: ==="
  printf '  %s\n' "${FAILED_STEPS[@]}"
fi
echo
echo "Next (locally, after 'scripts/sync-athena-to-local.sh eval/results/lecture-clip-bench-${SLURM_JOB_ID}'):"
echo "  node --experimental-strip-types scripts/lecture-clip-bench-analyze.mjs $RESULTS_DIR"
