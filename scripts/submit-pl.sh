#!/bin/bash
#SBATCH --job-name=aidedx-tts1000-pl
#SBATCH --partition=plgrid-gpu-a100
#SBATCH --account=plgccbmc15-gpu-a100
#SBATCH --qos=normal
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=16
#SBATCH --mem=64G
#SBATCH --gres=gpu:a100:1
#SBATCH --time=08:00:00
#SBATCH --output=%x-%j.out
#SBATCH --error=%x-%j.err
#
# Runs the first Polish 1000-sentence TTS eval-audio batch (issue #79 Track 3 / #87),
# through TWO independent TTS engines for side-by-side comparison — not one engine picked
# in advance:
#
#  - Piper (scripts/tts-piper-1000.py): real pl_PL voice models (5 of them — every Polish
#    voice actually published in rhasspy/piper-voices). The vetted path.
#  - Qwen3-TTS (scripts/tts-qwen-1000-pl.py): deliberately EXPERIMENTAL. Qwen3-TTS's own
#    documented language support is 10 languages (Chinese/English/Japanese/Korean/German/
#    French/Russian/Portuguese/Spanish/Italian) — Polish is not among them, confirmed
#    before this was written, not assumed. Tries `language="Polish"` first, falls back to
#    `language="Auto"` per-clip on error; some clips may simply fail (recorded, not fatal
#    to the batch). Whatever this batch sounds like is exactly the data point requested.
#
# The 1000 sentences themselves are identical for both engines (same generator, same fixed
# seed, same 600/250/150 csdaRange/energyFromRange/stoppingPower balance and single/multi
# fractions as the English 1000-sentence batches) — only the synthesis engine differs.
#
# Prerequisite (one-time, mirrors docs/athena-setup.md's .venv-tts/.venv-qwen convention):
#   python3 -m venv .venv-piper && source .venv-piper/bin/activate && pip install piper-tts
# .venv-qwen must already exist per the existing English-batch setup (docs/athena-setup.md).
#
# Safe to resubmit as-is if it fails or times out partway through — every step below is
# resumable (skips already-done clips/ids), same discipline as submit-v3.sh.
#
# Usage (from the repo root, after pulling this branch/commit onto Athena):
#   sbatch scripts/submit-pl.sh

set -euo pipefail

if ! type module &>/dev/null; then
  source /net/software/v1/software/Lmod/8.5.8/lmod/lmod/init/bash
fi

cd /net/tscratch/people/plgkongruencj/aidedx
source scripts/athena-env.sh

SENTENCES_FILE=scripts/tts-1000-sentences-pl.json
PIPER_AUDIO_DIR=eval/audio/tts-piper-1000-pl
QWEN_AUDIO_DIR=eval/audio/tts-qwen-1000-pl

echo "=== Step 0/4: generate + validate the 1000 Polish sentences ==="
# --experimental-strip-types: same reason as submit-v3.sh — Athena's Node 22.17.1 doesn't
# strip .ts imports unflagged (generate-1000-sentences-pl.mjs imports tts-sentence-check.ts
# directly for inline validation against the real Polish matcher + libdedx WASM).
node --experimental-strip-types scripts/generate-1000-sentences-pl.mjs "$SENTENCES_FILE"
node --experimental-strip-types scripts/tts-sentence-check.ts "$SENTENCES_FILE" --lang pl

echo "=== Step 1/4: Piper TTS generation (resumes automatically from existing $PIPER_AUDIO_DIR/*.wav) ==="
source .venv-piper/bin/activate
python scripts/tts-piper-1000.py "$SENTENCES_FILE" "$PIPER_AUDIO_DIR"
deactivate

echo "=== Step 2/4: Qwen3-TTS Polish generation — experimental, unsupported language (resumes automatically) ==="
source .venv-qwen/bin/activate
python scripts/tts-qwen-1000-pl.py "$SENTENCES_FILE" "$QWEN_AUDIO_DIR"
deactivate

for dir in "$PIPER_AUDIO_DIR" "$QWEN_AUDIO_DIR"; do
  count=$(find "$dir" -maxdepth 1 -name '*.wav' | wc -l)
  echo "$dir: $count wav files"
done

RESULTS_DIR="eval/results/tts-1000-pl-$(date +%F)"
mkdir -p "$RESULTS_DIR"

echo "=== Step 3/4: ASR transcription, both engines (whisper-small q8, Polish token + Polish domain prompt) ==="
node scripts/asr-transcribe-manifest.mjs "$PIPER_AUDIO_DIR" "$PIPER_AUDIO_DIR/manifest.json" \
  onnx-community/whisper-small q8 "$RESULTS_DIR/piper-small-q8-prompt.json" --lang pl
node scripts/asr-transcribe-manifest.mjs "$QWEN_AUDIO_DIR" "$QWEN_AUDIO_DIR/manifest.json" \
  onnx-community/whisper-small q8 "$RESULTS_DIR/qwen-small-q8-prompt.json" --lang pl

echo "=== Step 4/4: score both engines against all three correction layers ==="
for engine in piper qwen; do
  audio_dir_var="${engine^^}_AUDIO_DIR"
  audio_dir="${!audio_dir_var}"
  node scripts/asr-score-slots-generic.mjs "$audio_dir/manifest.json" "$RESULTS_DIR/${engine}-small-q8-prompt.json" \
    --json "$RESULTS_DIR/${engine}-score-base.json" | tee "$RESULTS_DIR/${engine}-score-base.log"
  node scripts/asr-score-slots-generic.mjs "$audio_dir/manifest.json" "$RESULTS_DIR/${engine}-small-q8-prompt.json" --ext \
    --json "$RESULTS_DIR/${engine}-score-ext.json" | tee "$RESULTS_DIR/${engine}-score-ext.log"
  node scripts/asr-score-slots-generic.mjs "$audio_dir/manifest.json" "$RESULTS_DIR/${engine}-small-q8-prompt.json" --new \
    --json "$RESULTS_DIR/${engine}-score-new.json" | tee "$RESULTS_DIR/${engine}-score-new.log"
done

echo "=== Done — results in $RESULTS_DIR ==="
