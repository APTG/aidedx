#!/bin/bash
# Pull eval/audio/ and/or eval/results/ from Athena down to this machine's cernbox copy of the
# repo, via rsync. These are the two directories Athena job output lands in: eval/audio/ is
# fully gitignored (TTS batches, voice-clone reference audio — never committed as WAVs), and
# eval/results/ is git-tracked but Athena's own live copy is often ahead of whatever was last
# committed from a manually-pulled snapshot (see docs/whisper-model-bench.md's own "partial
# results" pattern this session).
#
# No --delete: this only adds/updates files, never removes anything that exists locally but not
# (or no longer) on Athena — safer default for a results directory you don't want silently
# pruned. Add --delete yourself if you specifically want a mirror instead.
#
# Safe to run while Athena jobs are still writing into eval/results/ — rsync just takes a
# best-effort snapshot of whatever's on disk at transfer time (same as this session's earlier
# manual copies of in-progress whisper-bench-2805165 results), not a consistency guarantee.
#
# Usage:
#   scripts/sync-athena-to-local.sh                                  # eval/audio/ + eval/results/
#   scripts/sync-athena-to-local.sh eval/audio/tts-clone-refs-pl      # just one subdir
#   scripts/sync-athena-to-local.sh eval/results/whisper-bench-2805165

set -euo pipefail

ATHENA_HOST="plgkongruencj@athena.cyfronet.pl"
ATHENA_DIR="/net/tscratch/people/plgkongruencj/aidedx"
LOCAL_DIR="$HOME/cernbox/Documents/aidedx"

if [ "$#" -eq 0 ]; then
  paths=("eval/audio" "eval/results")
else
  paths=("$@")
fi

for p in "${paths[@]}"; do
  mkdir -p "$LOCAL_DIR/$p"
  echo "=== pull: $ATHENA_HOST:$ATHENA_DIR/$p/ -> $LOCAL_DIR/$p/ ==="
  rsync -avz --progress "$ATHENA_HOST:$ATHENA_DIR/$p/" "$LOCAL_DIR/$p/"
done

echo "=== done ==="
