#!/usr/bin/env bash
# Firestore (native mode) database + the composite indexes from docs/CONTRACTS.md §16. Idempotent.
set -euo pipefail
source "$(dirname "$0")/.env"

if ! gcloud firestore databases describe --database="${FIRESTORE_DB}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud firestore databases create --database="${FIRESTORE_DB}" --location="${REGION}" \
    --type=firestore-native --project="${PROJECT_ID}"
fi

index() {  # index <collection> <field:order> [<field:order> ...]
  local collection="$1"; shift
  local args=()
  for spec in "$@"; do
    args+=(--field-config="field-path=${spec%%:*},order=${spec##*:}")
  done
  local err
  if err="$(gcloud firestore indexes composite create --project="${PROJECT_ID}" --database="${FIRESTORE_DB}" \
      --collection-group="${collection}" --query-scope=COLLECTION "${args[@]}" --async 2>&1)"; then
    echo "  index ${collection}: $*"
  elif [[ "${err}" == *ALREADY_EXISTS* ]]; then
    echo "  index ${collection}: $* (exists)"
  else
    echo "  index ${collection}: $* FAILED: ${err}" >&2
    return 1
  fi
}

index cases record_key:ascending updated_at:descending
index cases record_key:ascending source:ascending updated_at:descending
index cases status:ascending updated_at:descending
index cases exposure_tag:ascending updated_at:descending
index cases source:ascending updated_at:descending
index cases source:ascending source_ref:ascending
index escalations case_id:ascending updated_at:descending
index escalations analyst_email:ascending updated_at:descending
index outbox delivered_at:ascending created_at:ascending

echo "Firestore ready (indexes build asynchronously; see the console)."
