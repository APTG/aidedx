#!/usr/bin/env bash
# Before/after battery + thermal snapshot helper for the issue #120 Android ASR runtime bench.
# Wraps `adb shell dumpsys battery` (level/temperature) and `adb shell dumpsys thermalservice`
# (throttling status) — the "rough before/after battery-percentage reading" the issue asks for,
# no more. Needs a connected device (`adb devices`) and cannot run in a sandboxed Claude Code
# session (no adb, no device — see docs/android-asr-runtime-bench.md §0).
#
# Usage:
#   scripts/android-asr-battery-bench.sh snapshot <label>   # e.g. before-whisper-cpp
#   scripts/android-asr-battery-bench.sh diff <before-label> <after-label>
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${PROJECT_ROOT}/.android-asr-cache/battery-snapshots"
mkdir -p "$OUT_DIR"

cmd="${1:-}"

battery_level() {
  # `dumpsys battery` prints "  level: 87" among other fields.
  adb shell dumpsys battery | grep -oE 'level: [0-9]+' | grep -oE '[0-9]+' || echo "unknown"
}

battery_temp_tenths_c() {
  # `dumpsys battery` prints temperature in tenths of a degree C, e.g. "temperature: 312" = 31.2C.
  adb shell dumpsys battery | grep -oE 'temperature: [0-9]+' | grep -oE '[0-9]+' || echo "unknown"
}

thermal_status() {
  # Enum: 0=NONE 1=LIGHT 2=MODERATE 3=SEVERE 4=CRITICAL 5=EMERGENCY 6=SHUTDOWN.
  # Best-effort parse only — the exact `dumpsys thermalservice` text format varies across Android
  # versions/vendors and this hasn't been verified against a real device in this session (no
  # device available, see docs/android-asr-runtime-bench.md §0). The full raw dump is always
  # saved alongside (see `snapshot` below) so a wrong/empty parse here never loses data — read
  # the `.raw.txt` file directly if this looks off.
  adb shell dumpsys thermalservice 2>/dev/null | grep -oE 'mStatus[^0-9]*[0-9]+' | head -1 || echo "unknown"
}

case "$cmd" in
  snapshot)
    label="${2:?Usage: $0 snapshot <label>}"
    file="${OUT_DIR}/${label}.txt"
    raw_file="${OUT_DIR}/${label}.raw.txt"
    {
      echo "timestamp_epoch_s=$(adb shell date +%s | tr -d '\r')"
      echo "battery_level_pct=$(battery_level)"
      echo "battery_temp_tenths_c=$(battery_temp_tenths_c)"
      echo "thermal_status_raw=$(thermal_status)"
    } > "$file"
    # Full untouched dumpsys output — source of truth if the best-effort parse above is wrong.
    {
      echo "=== dumpsys battery ==="
      adb shell dumpsys battery
      echo "=== dumpsys thermalservice ==="
      adb shell dumpsys thermalservice 2>/dev/null || echo "(unavailable on this device/API level)"
    } > "$raw_file"
    echo "wrote ${file} (parsed) and ${raw_file} (raw):"
    cat "$file"
    ;;
  diff)
    before_label="${2:?Usage: $0 diff <before-label> <after-label>}"
    after_label="${3:?Usage: $0 diff <before-label> <after-label>}"
    before_file="${OUT_DIR}/${before_label}.txt"
    after_file="${OUT_DIR}/${after_label}.txt"
    [[ -f "$before_file" ]] || { echo "missing ${before_file} — run 'snapshot ${before_label}' first" >&2; exit 1; }
    [[ -f "$after_file" ]] || { echo "missing ${after_file} — run 'snapshot ${after_label}' first" >&2; exit 1; }
    before_level=$(grep battery_level_pct "$before_file" | cut -d= -f2)
    after_level=$(grep battery_level_pct "$after_file" | cut -d= -f2)
    before_ts=$(grep timestamp_epoch_s "$before_file" | cut -d= -f2)
    after_ts=$(grep timestamp_epoch_s "$after_file" | cut -d= -f2)
    echo "=== ${before_label} -> ${after_label} ==="
    if [[ "$before_ts" =~ ^[0-9]+$ && "$after_ts" =~ ^[0-9]+$ ]]; then
      echo "duration: $(( after_ts - before_ts ))s"
    else
      echo "duration: unknown (non-numeric timestamp — check the .raw.txt snapshots)"
    fi
    if [[ "$before_level" =~ ^[0-9]+$ && "$after_level" =~ ^[0-9]+$ ]]; then
      echo "battery: ${before_level}% -> ${after_level}% (delta: $(( after_level - before_level ))pp)"
    else
      echo "battery: ${before_level}% -> ${after_level}% (delta: unknown — non-numeric reading, check the .raw.txt snapshots)"
    fi
    echo "before: $(cat "$before_file")"
    echo "after:  $(cat "$after_file")"
    ;;
  *)
    echo "Usage: $0 snapshot <label> | $0 diff <before-label> <after-label>" >&2
    exit 1
    ;;
esac
