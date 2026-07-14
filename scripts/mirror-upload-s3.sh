#!/usr/bin/env bash
# Uploads a staged model mirror (see scripts/mirror-fetch-model.ts) to
# Cyfronet's S3-compatible object storage using s3cmd, per Cyfronet's own
# recommended tooling:
# https://guide.s3p.cloud.cyfronet.pl/narzedzia_cli.html
#
# Prerequisites:
#   1. `s3cmd` installed — either system-wide, or via the project-local venv
#      (`python3 -m venv .venv && .venv/bin/pip install s3cmd`), which this
#      script prefers automatically if present.
#   2. Credentials configured — either `~/.s3cfg`, or a project-local
#      `.s3cmd` file (git-ignored, preferred automatically if present) —
#      copy scripts/.s3cfg.cyfronet.example, fill in the access_key/secret_key
#      from https://storage-panel.cloud.cyfronet.pl (Credentials page -> pick
#      your PLGrid group + region -> "Generate credential"), and set
#      host_base/host_bucket to your region's endpoint (s3.cloud.cyfronet.pl
#      for DC-Nawojki, s3p.cloud.cyfronet.pl for DC-Podole).
#   3. The bucket exists (`s3cmd mb s3://<bucket>`) and CORS is set — see
#      docs/model-hosting-cyfronet.md and scripts/cyfronet-cors-policy.xml
#      (one-time setup, not done by this script).
#
# Usage:
#   CYFRONET_S3_BUCKET=aidedx-models scripts/mirror-upload-s3.sh <staging-dir>
#
# `staging-dir` is the --out directory passed to mirror-fetch-model.ts (its
# *contents* — e.g. `onnx-community/...` — get synced to the bucket root, not
# the directory itself). `s3cmd sync` only adds/updates objects by default
# (no --delete-removed passed), so it never removes files already in the
# bucket (e.g. from a previous mirror run for a different model) — delete
# stale prefixes manually if ever needed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

STAGING_DIR="${1:?Usage: $0 <staging-dir>}"
: "${CYFRONET_S3_BUCKET:?Set CYFRONET_S3_BUCKET to the target bucket name}"

if [ -x "$PROJECT_ROOT/.venv/bin/s3cmd" ]; then
  S3CMD_BIN="$PROJECT_ROOT/.venv/bin/s3cmd"
elif command -v s3cmd >/dev/null 2>&1; then
  S3CMD_BIN="s3cmd"
else
  echo "error: s3cmd not found — install it first (see script header)" >&2
  exit 1
fi

S3CMD_CONFIG_ARGS=()
if [ -f "$PROJECT_ROOT/.s3cmd" ]; then
  S3CMD_CONFIG_ARGS=(-c "$PROJECT_ROOT/.s3cmd")
fi

s3cmd() { "$S3CMD_BIN" "${S3CMD_CONFIG_ARGS[@]}" "$@"; }

if [ ! -d "$STAGING_DIR" ]; then
  echo "error: staging dir '$STAGING_DIR' does not exist" >&2
  exit 1
fi

echo "Uploading contents of $STAGING_DIR -> s3://$CYFRONET_S3_BUCKET/"
s3cmd sync "$STAGING_DIR/" "s3://$CYFRONET_S3_BUCKET/" \
  --acl-public \
  --no-progress

echo
echo "Verifying object count under each uploaded model prefix:"
for model_dir in "$STAGING_DIR"/*/*; do
  [ -d "$model_dir" ] || continue
  prefix="$(realpath --relative-to="$STAGING_DIR" "$model_dir")"
  local_count=$(find "$model_dir" -type f | wc -l)
  remote_count=$(s3cmd ls -r "s3://$CYFRONET_S3_BUCKET/$prefix/" | wc -l)
  status="OK"
  [ "$local_count" -eq "$remote_count" ] || status="MISMATCH"
  echo "  $prefix: local=$local_count remote=$remote_count [$status]"
done

echo
echo "Spot-check a file is publicly reachable, e.g.:"
echo "  curl -I https://\$CYFRONET_S3_BUCKET.<host_base>/onnx-community/whisper-small/resolve/main/config.json"
