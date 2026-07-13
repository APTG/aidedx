#!/usr/bin/env bash
# Uploads a staged model mirror (see scripts/mirror-fetch-model.ts) to an
# S3-compatible bucket — Cyfronet or any other endpoint. Requires the AWS CLI
# (`aws`) configured with credentials for the target endpoint; see
# docs/model-hosting-cyfronet.md for one-time bucket setup (public-read
# access + CORS), which this script deliberately does NOT do on every run.
#
# Usage:
#   CYFRONET_S3_ENDPOINT=https://... CYFRONET_S3_BUCKET=aidedx-models \
#     scripts/mirror-upload-s3.sh <staging-dir>
#
# `staging-dir` is the --out directory passed to mirror-fetch-model.ts (its
# *contents* — e.g. `onnx-community/...` — get synced to the bucket root, not
# the directory itself). Only adds/updates objects; does not pass --delete,
# so it never removes files already in the bucket (e.g. from a previous
# mirror run for a different model) — delete stale prefixes manually if ever
# needed.

set -euo pipefail

STAGING_DIR="${1:?Usage: $0 <staging-dir>}"
: "${CYFRONET_S3_ENDPOINT:?Set CYFRONET_S3_ENDPOINT to the Cyfronet S3 endpoint URL}"
: "${CYFRONET_S3_BUCKET:?Set CYFRONET_S3_BUCKET to the target bucket name}"

if [ ! -d "$STAGING_DIR" ]; then
  echo "error: staging dir '$STAGING_DIR' does not exist" >&2
  exit 1
fi

echo "Uploading contents of $STAGING_DIR -> s3://$CYFRONET_S3_BUCKET/ via $CYFRONET_S3_ENDPOINT"
aws s3 sync "$STAGING_DIR/" "s3://$CYFRONET_S3_BUCKET/" \
  --endpoint-url "$CYFRONET_S3_ENDPOINT" \
  --only-show-errors

echo
echo "Verifying object count under each uploaded model prefix:"
for model_dir in "$STAGING_DIR"/*/*; do
  [ -d "$model_dir" ] || continue
  prefix="$(realpath --relative-to="$STAGING_DIR" "$model_dir")"
  local_count=$(find "$model_dir" -type f | wc -l)
  remote_count=$(aws s3 ls "s3://$CYFRONET_S3_BUCKET/$prefix/" --recursive \
    --endpoint-url "$CYFRONET_S3_ENDPOINT" | wc -l)
  status="OK"
  [ "$local_count" -eq "$remote_count" ] || status="MISMATCH"
  echo "  $prefix: local=$local_count remote=$remote_count [$status]"
done

echo
echo "Spot-check a file is publicly reachable, e.g.:"
echo "  curl -I <bucket public base URL>/onnx-community/whisper-small/resolve/main/config.json"
