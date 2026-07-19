#!/bin/bash
#SBATCH --job-name=aidedx-whisper-bench
#SBATCH --partition=plgrid-gpu-a100
#SBATCH --account=plgccbmc15-gpu-a100
#SBATCH --qos=normal
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=16
#SBATCH --mem=64G
#SBATCH --gres=gpu:a100:1
#SBATCH --time=24:00:00
#SBATCH --array=0-4
#SBATCH --output=%x-%A_%a.out
#SBATCH --error=%x-%A_%a.err
#
# Benchmarks every officially-released Whisper size (tiny/base/small/medium/large-v2/large-v3/
# large-v3-turbo), at both q8 and fp32, against the three existing 1000-sentence TTS batches
# (English tts-qwen-1000-v3, Polish tts-piper-1000-pl, Polish tts-qwen-1000-pl) — 14 models x 3
# datasets = 42 transcription runs, each scored 3 ways (raw/base/ext/new correctors), reusing
# scripts/asr-score-slots-generic.mjs exactly as docs/tts-eval-1000-v3.md and
# docs/tts-eval-1000-pl.md already do. This deliberately does NOT use scripts/e2e-audio-intents.ts
# ("the standard voice-path metric", issue #27) — that scorer is hardcoded to the small
# hand-labeled eval/intents.jsonl set (see eval/README.md's "Two measurement tracks" section) and
# doesn't apply to the slot-truth-labeled 1000-sentence batches this benchmark uses.
#
# --- Why an array job, and how the 5 lanes are split ---
# 14 (model, dtype) pairs, capped at 5 concurrent SLURM jobs (`--array=0-4`, one lane per task —
# 5 array elements IS the concurrency cap, no `%N` throttle needed). Lanes are grouped by rough
# compute cost, not evenly by count, since tiny/base/small are each individually cheap (whisper-
# small q8 already measured at ~3s/clip median, docs/tts-eval-1000-pl.md §2) while
# medium/large-v2/large-v3 are unmeasured here and could be far slower — bundling the three cheap
# tiers into one lane keeps that lane fast regardless, while each heavy tier gets its own
# dedicated lane so a slow model can't stall the cheap ones behind it in the same job:
#   lane 0: whisper-large-v3-ONNX      (fp32, q8)               — 2 combos, heaviest single tier
#   lane 1: whisper-large-v2-ONNX      (fp32, q8)               — 2 combos
#   lane 2: whisper-large-v3-turbo     (fp32, q8)                — 2 combos
#   lane 3: whisper-medium-ONNX        (fp32, q8)                — 2 combos
#   lane 4: whisper-small/base/tiny    (fp32, q8 each)           — 6 combos, all cheap
#
# --- GPU note ---
# scripts/asr-transcribe-manifest.mjs never sets a `device` option, so @huggingface/transformers
# runs Whisper inference on CPU (onnxruntime-node's default backend) regardless of the
# `--gres=gpu:a100:1` allocation below — confirmed by reading the script, not assumed. The GPU
# request is kept only because every existing script in this repo uses the
# plgrid-gpu-a100/plgccbmc15-gpu-a100 partition/account and this is the only one known to be
# accessible under this grant; if a CPU-only partition exists on your allocation, prefer that
# for this job instead, since the GPU sits idle throughout.
#
# --- No manual prerequisite ---
# Each lane prefetches its own (model, dtype) pairs itself, as Step 0 below, via
# `prefetch-whisper-models.mjs --pairs` — no separate `node` invocation needed before
# submitting, unlike docs/local-model-cache.md's usual "run on a fast connection first"
# convention for the shipped app's models. Every model's already cached read is a fast no-op
# on resubmit, same as everything else in this script.
#
# --- Time budget ---
# 24h per lane, generous rather than measured (issue #27 follow-up: no prior run of
# medium/large-v2/large-v3 on this CPU config to size against). Every step below is resumable
# (asr-transcribe-manifest.mjs skips ids already in its outFile) — if a lane times out partway
# through, resubmit just that array index (`sbatch --array=<n> scripts/submit-whisper-bench.sh`)
# and it continues from wherever it stopped, same discipline as submit-v3.sh/submit-pl.sh.
#
# Usage:
#   sbatch scripts/submit-whisper-bench.sh              # all 5 lanes
#   sbatch --array=3 scripts/submit-whisper-bench.sh    # resubmit just lane 3 (e.g. after a timeout)

set -euo pipefail

if ! type module &>/dev/null; then
  source /net/software/v1/software/Lmod/8.5.8/lmod/lmod/init/bash
fi

cd /net/tscratch/people/plgkongruencj/aidedx
source scripts/athena-env.sh

# Shared across every array task (unlike `date +%F`, which could differ between tasks if the
# array spans midnight) so all 5 lanes write into the same results directory.
RESULTS_DIR="eval/results/whisper-bench-${SLURM_ARRAY_JOB_ID}"
mkdir -p "$RESULTS_DIR"

# --- Datasets: audio dir : manifest : lang : short label ---
DATASETS=(
  "eval/audio/tts-qwen-1000-v3:eval/audio/tts-qwen-1000-v3/manifest.json:en:en-v3"
  "eval/audio/tts-piper-1000-pl:eval/audio/tts-piper-1000-pl/manifest.json:pl:pl-piper"
  "eval/audio/tts-qwen-1000-pl:eval/audio/tts-qwen-1000-pl/manifest.json:pl:pl-qwen"
)

# --- Lanes: one per SLURM_ARRAY_TASK_ID, each a list of "modelId:dtype" pairs ---
case "$SLURM_ARRAY_TASK_ID" in
  0)
    LANE_NAME="large-v3"
    MODELS=(
      "onnx-community/whisper-large-v3-ONNX:fp32"
      "onnx-community/whisper-large-v3-ONNX:q8"
    )
    ;;
  1)
    LANE_NAME="large-v2"
    MODELS=(
      "onnx-community/whisper-large-v2-ONNX:fp32"
      "onnx-community/whisper-large-v2-ONNX:q8"
    )
    ;;
  2)
    LANE_NAME="large-v3-turbo"
    MODELS=(
      "onnx-community/whisper-large-v3-turbo:fp32"
      "onnx-community/whisper-large-v3-turbo:q8"
    )
    ;;
  3)
    LANE_NAME="medium"
    MODELS=(
      "onnx-community/whisper-medium-ONNX:fp32"
      "onnx-community/whisper-medium-ONNX:q8"
    )
    ;;
  4)
    LANE_NAME="small-base-tiny"
    MODELS=(
      "onnx-community/whisper-small:fp32"
      "onnx-community/whisper-small:q8"
      "onnx-community/whisper-base:fp32"
      "onnx-community/whisper-base:q8"
      "onnx-community/whisper-tiny:fp32"
      "onnx-community/whisper-tiny:q8"
    )
    ;;
  *)
    echo "ERROR: unexpected SLURM_ARRAY_TASK_ID=$SLURM_ARRAY_TASK_ID (expected 0-4)" >&2
    exit 1
    ;;
esac

echo "=== Lane $SLURM_ARRAY_TASK_ID ($LANE_NAME): ${#MODELS[@]} model/dtype pairs x ${#DATASETS[@]} datasets ==="

echo "=== Step 0: prefetch this lane's ${#MODELS[@]} model/dtype pairs ==="
node scripts/prefetch-whisper-models.mjs --pairs "${MODELS[@]}"

for model_entry in "${MODELS[@]}"; do
  IFS=':' read -r model_id dtype <<<"$model_entry"
  # Filesystem-safe short name for output filenames: strip the "onnx-community/" prefix only
  # (every model id here is already slash-free after that, no further sanitizing needed).
  model_short="${model_id#onnx-community/}"

  for dataset_entry in "${DATASETS[@]}"; do
    IFS=':' read -r audio_dir manifest lang dataset_label <<<"$dataset_entry"
    combo_label="${dataset_label}__${model_short}__${dtype}"
    transcript_out="$RESULTS_DIR/${combo_label}.json"

    echo "--- $combo_label ---"
    echo "[transcribe] $model_id [$dtype] lang=$lang over $audio_dir"
    node scripts/asr-transcribe-manifest.mjs "$audio_dir" "$manifest" "$model_id" "$dtype" \
      "$transcript_out" --lang "$lang"

    echo "[score] $combo_label"
    for mode in base ext new; do
      flag=""
      [ "$mode" = "ext" ] && flag="--ext"
      [ "$mode" = "new" ] && flag="--new"
      node scripts/asr-score-slots-generic.mjs "$manifest" "$transcript_out" $flag \
        --json "$RESULTS_DIR/${combo_label}__score-${mode}.json" \
        | tee "$RESULTS_DIR/${combo_label}__score-${mode}.log"
    done
  done
done

echo "=== Lane $SLURM_ARRAY_TASK_ID ($LANE_NAME) done — results in $RESULTS_DIR ==="
