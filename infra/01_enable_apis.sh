#!/usr/bin/env bash
# Enable the Google Cloud APIs the agent uses. Idempotent.
set -euo pipefail
source "$(dirname "$0")/.env"

APIS=(
  aiplatform.googleapis.com
  firestore.googleapis.com
  bigquery.googleapis.com
  run.googleapis.com
  cloudscheduler.googleapis.com
  cloudbuild.googleapis.com
  artifactregistry.googleapis.com
  secretmanager.googleapis.com
  iap.googleapis.com
  sheets.googleapis.com
  gmail.googleapis.com
  iam.googleapis.com
  cloudresourcemanager.googleapis.com
  logging.googleapis.com
  storage.googleapis.com
  pubsub.googleapis.com
  drive.googleapis.com
  chat.googleapis.com
  telemetry.googleapis.com
  cloudtrace.googleapis.com
  dlp.googleapis.com
  bigqueryconnection.googleapis.com
)

# Google takes at most 20 services in one call.
for ((i = 0; i < ${#APIS[@]}; i += 20)); do
  gcloud services enable --project="${PROJECT_ID}" "${APIS[@]:i:20}"
done

echo "APIs enabled for ${PROJECT_ID}"
