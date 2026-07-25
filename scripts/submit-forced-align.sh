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
# .venv-align is created HERE, on first run, inside this job — unlike .venv-qwen/.venv-chatterbox
# (docs/tts-eval-audio.md §6.4, setup-venv-chatterbox.md), which are deliberately manual because
# they need an interactive shell to verify torch.cuda.is_available() before trusting a big batch.
# That reasoning doesn't apply here: this job already carries its own #SBATCH --gres=gpu:a100:1,
# so the GPU-availability check below runs for real, inside the job that will actually use it, no
# separate interactive step needed. Idempotent — a second run reuses the existing venv untouched.
# Full setup rationale/troubleshooting: docs/forced-alignment-setup.md (now background reading,
# not a required step).
#
# ~7-8 hours of podcast audio needs transcribing (the 21 MIT chapters don't — known-transcript
# alignment only) — --time=06:00:00 above is a starting budget (plus ~5-10 min on first run for
# the venv install), not a guarantee; if the job times out partway through a podcast file, that
# file's progress is lost (no intra-file resumability, see scripts/forced-align-corpus.py's
# docstring) but every FILE that finished keeps its
# eval/results/forced-align-<job>/.done/<name>.ok marker and is skipped on resubmit. Resubmitting
# after a timeout is the expected recovery path, not a bug to fix first.
#
# Submit:  sbatch scripts/submit-forced-align.sh   (that's it — venv + deps install on first run)
set -euo pipefail

cd "${SLURM_SUBMIT_DIR:-$(pwd)}"
source scripts/athena-env.sh

if [ ! -d .venv-align ]; then
  echo "=== .venv-align not found — creating it (one-time, ~5-10 min: CUDA torch + transformers) ==="
  python3 -m venv .venv-align
  source .venv-align/bin/activate
  pip install --quiet --upgrade pip
  # torch + torchaudio MUST come from the same cu128 index in the SAME command — installing them
  # separately is exactly what broke .venv-qwen once (docs/tts-eval-audio.md §6.2): a later,
  # unrelated package pulled in a plain-PyPI torchaudio linked against a different CUDA runtime.
  pip install --quiet torch torchaudio --index-url https://download.pytorch.org/whl/cu128
  pip install --quiet transformers accelerate num2words
else
  source .venv-align/bin/activate
fi

python3 -c "import torch; assert torch.cuda.is_available()" || {
  echo "ERROR: torch.cuda.is_available() is False in this job (despite --gres=gpu:a100:1) —" >&2
  echo "       something is wrong with the venv or the allocation, not just a slow CPU fallback." >&2
  echo "       See docs/forced-alignment-setup.md §4 for how to debug this interactively." >&2
  exit 1
}

if [ ! -d eval/lecture-corpus ]; then
  echo "ERROR: eval/lecture-corpus not found — run scripts/submit-fetch-lecture-corpus.sh first" >&2
  exit 1
fi

JOB="${SLURM_JOB_ID:-manual}"
RESULTS_DIR="eval/results/forced-align-${JOB}"
mkdir -p "$RESULTS_DIR"

echo "=== forced alignment: results -> $RESULTS_DIR ==="
if python3 scripts/forced-align-corpus.py "$RESULTS_DIR"; then
  STATUS=0
else
  STATUS=$?
fi

deactivate

echo "=== done (exit $STATUS): $RESULTS_DIR ==="
echo "Sync back with:  rsync -av <athena>:.../aidedx/$RESULTS_DIR/ $RESULTS_DIR/"
echo "Then analyze locally (no GPU needed):  python3 scripts/forced-align-analyze.py $RESULTS_DIR"
exit $STATUS
