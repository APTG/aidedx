#!/bin/bash
#SBATCH --job-name=aidedx-forced-align
#SBATCH --partition=plgrid-gpu-a100
#SBATCH --account=plgccbmc15-gpu-a100
#SBATCH --qos=normal
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G
#SBATCH --gres=gpu:a100:1
#SBATCH --time=06:00:00
#SBATCH --output=%x-%j.out
#SBATCH --error=%x-%j.err
#
# Forced alignment of the eval/lecture-corpus/ corpus (fetched by
# scripts/submit-fetch-lecture-corpus.sh) — the human-speech cross-check for the TTS unit-probe
# (scripts/submit-unit-probe.sh + scripts/unit-probe-analyze.py). Runs
# scripts/forced-align-corpus.py, which does the real work; see that script's docstring and
# docs/unit-pronunciation-asr.md §6 for the method. GPU is used for both stages: Whisper ASR
# (podcasts only — the MIT lectures already have a known transcript, no ASR needed) and the
# wav2vec2 CTC forward pass every segment needs for alignment.
#
# Prereq: .venv-align must already exist — see docs/forced-alignment-setup.md (one-time setup,
# not auto-provisioned here, same pattern as the other CUDA venvs in this repo).
#
# ~7-8 hours of podcast audio needs transcribing (the 21 MIT chapters don't — known-transcript
# alignment only) — --time=06:00:00 above is a starting budget, not a guarantee; if the job times
# out partway through a podcast file, that file's progress is lost (no intra-file resumability,
# see scripts/forced-align-corpus.py's docstring) but every FILE that finished keeps its
# eval/results/forced-align-<job>/.done/<name>.ok marker and is skipped on resubmit. Resubmitting
# after a timeout is the expected recovery path, not a bug to fix first.
#
# Submit:  sbatch scripts/submit-forced-align.sh
# Quick test first (a few files, ~minutes not hours) — see §2 below for how to run this
# interactively with --limit before committing a full GPU allocation to the real run.
set -uo pipefail

cd "${SLURM_SUBMIT_DIR:-$(pwd)}"
source scripts/athena-env.sh

if [ ! -d .venv-align ]; then
  echo "ERROR: .venv-align not found — one-time CUDA setup required first," >&2
  echo "       see docs/forced-alignment-setup.md" >&2
  exit 1
fi
source .venv-align/bin/activate

if [ ! -d eval/lecture-corpus ]; then
  echo "ERROR: eval/lecture-corpus not found — run scripts/submit-fetch-lecture-corpus.sh first" >&2
  exit 1
fi

JOB="${SLURM_JOB_ID:-manual}"
RESULTS_DIR="eval/results/forced-align-${JOB}"
mkdir -p "$RESULTS_DIR"

echo "=== forced alignment: results -> $RESULTS_DIR ==="
python3 scripts/forced-align-corpus.py "$RESULTS_DIR"
STATUS=$?

deactivate

echo "=== done (exit $STATUS): $RESULTS_DIR ==="
echo "Sync back with:  rsync -av <athena>:.../aidedx/$RESULTS_DIR/ $RESULTS_DIR/"
echo "Then analyze locally (no GPU needed):  python3 scripts/forced-align-analyze.py $RESULTS_DIR"
exit $STATUS
