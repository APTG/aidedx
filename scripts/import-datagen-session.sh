#!/usr/bin/env bash
# Imports a DataGenActivity session (issue #130 Part 3): pulls filesDir/out/<speaker>/ off the
# device and lands it as eval/audio/<speaker>/ (WAVs, gitignored, same convention as every
# other recording session in this repo) + eval/results/datagen-<speaker>-<date>/
# (session.json + results-{parakeet,whisper}-<lang>.json, git-tracked).
#
# Pulling an app's private storage needs the same run-as trick every other on-device doc in
# this repo already uses (plain `adb pull` can't read filesDir directly without root) —
# `adb shell run-as <pkg> sh -c 'cd files/out/<speaker> && tar cf - .'` streamed straight into
# a local `tar xf -`, one command, no intermediate on-device copy.
#
# Usage:
#   scripts/import-datagen-session.sh <speaker> [--from-dir <local-dir>] [--date YYYY-MM-DD]
#
#   --from-dir <dir>   skip adb entirely — <dir> must already look like a pulled session
#                       (session.json + *.wav + results-*.json). Lets this script (and the
#                       scoring commands it prints) be exercised without a phone attached —
#                       useful for testing, and for importing a session someone else already
#                       pulled by hand.
#   --date YYYY-MM-DD  eval/results/ subdir date suffix (default: today, UTC)
set -euo pipefail

SPEAKER=${1:?Usage: $0 <speaker> [--from-dir <local-dir>] [--date YYYY-MM-DD]}
shift
if [[ ! "$SPEAKER" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Error: speaker tag must contain only letters, digits, hyphens, and underscores" >&2
  exit 1
fi

FROM_DIR=""
DATE_SUFFIX=$(date -u +%Y-%m-%d)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-dir)
      FROM_DIR=${2:?--from-dir needs a path}
      shift 2
      ;;
    --date)
      DATE_SUFFIX=${2:?--date needs a value}
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

PULL_DIR="$FROM_DIR"
CLEANUP_PULL_DIR=0
if [[ -z "$PULL_DIR" ]]; then
  if ! command -v adb >/dev/null 2>&1; then
    echo "Error: adb not found on PATH, and no --from-dir given." >&2
    exit 1
  fi
  PULL_DIR=$(mktemp -d)
  CLEANUP_PULL_DIR=1
  echo "Pulling filesDir/out/$SPEAKER from device..."
  adb shell run-as com.aidedx.sherpabench sh -c "cd files/out/$SPEAKER && tar cf - ." \
    | tar xf - -C "$PULL_DIR"
fi
if [[ "$CLEANUP_PULL_DIR" -eq 1 ]]; then
  trap 'rm -rf "$PULL_DIR"' EXIT
fi

if [[ ! -f "$PULL_DIR/session.json" ]]; then
  echo "Error: $PULL_DIR/session.json not found — not a DataGenActivity session dir?" >&2
  exit 1
fi

AUDIO_DIR="eval/audio/$SPEAKER"
RESULTS_DIR="eval/results/datagen-$SPEAKER-$DATE_SUFFIX"
mkdir -p "$AUDIO_DIR" "$RESULTS_DIR"

wav_count=0
for wav in "$PULL_DIR"/*.wav; do
  [[ -e "$wav" ]] || continue
  # Verify 16kHz mono 16-bit PCM — the format DataGenActivity's writeWavFile() emits — rather
  # than trusting the extension; a truncated or corrupt pull should be caught here, not
  # downstream as a silent misparse in a scoring script.
  if command -v ffprobe >/dev/null 2>&1; then
    # ffprobe's csv output orders fields by its own internal stream-entry order, not the
    # order given to -show_entries (confirmed empirically: codec_name,sample_rate,channels,
    # not the sample_rate,channels,codec_name order requested below) — compared accordingly.
    info=$(ffprobe -v error -select_streams a:0 \
      -show_entries stream=sample_rate,channels,codec_name -of csv=p=0 "$wav" 2>/dev/null || echo "")
    if [[ "$info" != "pcm_s16le,16000,1" ]]; then
      echo "WARNING: $wav is not 16kHz mono pcm_s16le (got: ${info:-unreadable})" >&2
    fi
  fi
  cp "$wav" "$AUDIO_DIR/"
  wav_count=$((wav_count + 1))
done

cp "$PULL_DIR/session.json" "$RESULTS_DIR/"
results_count=0
for f in "$PULL_DIR"/results-*.json; do
  [[ -e "$f" ]] || continue
  cp "$f" "$RESULTS_DIR/"
  results_count=$((results_count + 1))
done

echo "Imported $wav_count WAV(s) -> $AUDIO_DIR"
echo "Imported session.json + $results_count results file(s) -> $RESULTS_DIR"
echo ""
echo "Next — regenerate the flat per-language manifests (derived, not committed) once:"
echo "  node scripts/datagen-to-manifest.mjs en"
echo "  node scripts/datagen-to-manifest.mjs pl"
echo ""
echo "Then score each results file, e.g.:"
for f in "$RESULTS_DIR"/results-*.json; do
  [[ -e "$f" ]] || continue
  base=$(basename "$f" .json)
  lang="${base##*-}"
  echo "  node scripts/asr-score-slots-generic.mjs eval/datagen-manifest-$lang.json $f --new"
  echo "  node scripts/e2e-audio-intents-datagen.ts $lang $f"
done
