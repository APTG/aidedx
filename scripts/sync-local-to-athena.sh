#!/bin/bash
# Push eval/audio/ and/or eval/results/ from this machine's cernbox copy of the repo up to
# Athena, via rsync — the reverse of scripts/sync-athena-to-local.sh. Mainly for locally-prepared
# audio a subsequent Athena job needs to read (e.g. scripts/prepare-voice-clone-refs.py's output,
# eval/audio/tts-clone-refs-pl/, issue #106).
#
# No --delete: only adds/updates files, never removes anything that exists on Athena but not
# locally. Skips any requested path that doesn't exist locally rather than erroring the whole
# run, since eval/audio/ and eval/results/ won't both always be populated on a given machine.
#
# Avoid pushing eval/results/ while an Athena job is actively writing into the same directory —
# unlike the pull direction (a live-job-writes/rsync-reads race is just a stale snapshot), this
# direction risks rsync overwriting a file mid-write from the job's side with an older local
# copy. Check `squeue` first if unsure.
#
# Usage:
#   scripts/sync-local-to-athena.sh                                  # eval/audio/ + eval/results/
#   scripts/sync-local-to-athena.sh eval/audio/tts-clone-refs-pl      # just one subdir

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
  if [ ! -d "$LOCAL_DIR/$p" ]; then
    echo "SKIP $p — $LOCAL_DIR/$p does not exist locally" >&2
    continue
  fi
  echo "=== push: $LOCAL_DIR/$p/ -> $ATHENA_HOST:$ATHENA_DIR/$p/ ==="
  rsync -avz --progress "$LOCAL_DIR/$p/" "$ATHENA_HOST:$ATHENA_DIR/$p/"
done

echo "=== done ==="
