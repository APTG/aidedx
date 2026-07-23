#!/usr/bin/env bash
# Downloads model weights for the issue #120 Android ASR runtime bench (whisper.cpp, sherpa-onnx,
# Vosk). Run this on a machine with normal network access — it cannot run in a sandboxed Claude
# Code session (huggingface.co and alphacephei.com are both firewalled there, see
# docs/android-asr-runtime-bench.md §0).
#
# Usage: scripts/android-asr-fetch-models.sh [whispercpp|sherpa-onnx|vosk|all]
# Default: all
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="${PROJECT_ROOT}/.android-asr-cache"
WHAT="${1:-all}"

fetch() {
  local url="$1" out="$2"
  if [[ -f "$out" ]]; then
    echo "  already have $(basename "$out") ($(du -h "$out" | cut -f1)) — skipping"
    return 0
  fi
  echo "  fetching $(basename "$out") from $url"
  # -f: fail loudly (no partial/garbage file) on 404 rather than saving an HTML error page.
  curl -fL --progress-bar -o "$out" "$url"
  echo "  got $(basename "$out") ($(du -h "$out" | cut -f1))"
}

fetch_whispercpp() {
  echo "=== whisper.cpp (ggml-small, q5_1 + q8_0) ==="
  local dir="${CACHE_DIR}/whispercpp"
  mkdir -p "$dir"
  # Sizes per issue #120's own text (190 MB / 264 MB) — not independently re-confirmed in the
  # session that wrote this script (huggingface.co was firewalled there); sanity-check the
  # printed size below against that expectation.
  fetch "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin" \
    "${dir}/ggml-small-q5_1.bin"
  fetch "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q8_0.bin" \
    "${dir}/ggml-small-q8_0.bin"
}

fetch_sherpa_onnx() {
  echo "=== sherpa-onnx (whisper-small, int8) ==="
  local dir="${CACHE_DIR}/sherpa-onnx"
  mkdir -p "$dir"
  # Best-guess URL from k2-fsa's usual GitHub-releases convention for pretrained model bundles —
  # NOT independently confirmed (docs/android-asr-runtime-bench.md §1.2/§4.1). curl -f fails
  # loudly instead of silently saving a 404 page, so a wrong guess here is safe, just noisy.
  local url="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-small.tar.bz2"
  local archive="${dir}/sherpa-onnx-whisper-small.tar.bz2"
  if fetch "$url" "$archive"; then
    tar xjf "$archive" -C "$dir"
    echo "  extracted to ${dir}"
  else
    echo "  FAILED — get the real URL from:"
    echo "    https://k2-fsa.github.io/sherpa/onnx/pretrained_models/whisper/"
    echo "    https://github.com/k2-fsa/sherpa-onnx/releases"
    return 1
  fi
}

fetch_vosk() {
  echo "=== Vosk (small en-us + small pl) ==="
  local dir="${CACHE_DIR}/vosk"
  mkdir -p "$dir"
  fetch "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip" \
    "${dir}/vosk-model-small-en-us-0.15.zip"
  fetch "https://alphacephei.com/vosk/models/vosk-model-small-pl-0.22.zip" \
    "${dir}/vosk-model-small-pl-0.22.zip"
  (cd "$dir" && unzip -oq vosk-model-small-en-us-0.15.zip && unzip -oq vosk-model-small-pl-0.22.zip)
  echo "  extracted both models to ${dir}"
}

mkdir -p "$CACHE_DIR"
case "$WHAT" in
  whispercpp) fetch_whispercpp ;;
  sherpa-onnx) fetch_sherpa_onnx ;;
  vosk) fetch_vosk ;;
  all)
    fetch_whispercpp
    fetch_sherpa_onnx
    fetch_vosk
    ;;
  *)
    echo "Usage: $0 [whispercpp|sherpa-onnx|vosk|all]" >&2
    exit 1
    ;;
esac

echo
echo "Done. Contents of ${CACHE_DIR}:"
du -sh "${CACHE_DIR}"/*/* 2>/dev/null || true
