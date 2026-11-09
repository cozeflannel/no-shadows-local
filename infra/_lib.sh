#!/usr/bin/env bash
# Shared helpers for infra/*.sh. Sourced, not executed.
# shellcheck disable=SC2034  # variables are used by the scripts that source this file

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${INFRA_DIR}/.." && pwd)"

if [[ ! -f "${INFRA_DIR}/.env" ]]; then
  echo "infra/.env not found: cp infra/00_env.example infra/.env and edit it." >&2
  exit 1
fi
# shellcheck source=/dev/null
source "${INFRA_DIR}/.env"

if [[ "${PROJECT_ID}" == "REPLACE_ME" || -z "${PROJECT_ID}" ]]; then
  echo "Set PROJECT_ID in infra/.env first." >&2
  exit 1
fi

project_number() {
  gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)'
}

image_tag() {  # git short sha (+ -dirty), else a timestamp
  local sha
  if sha="$(git -C "${ROOT}" rev-parse --short HEAD 2>/dev/null)"; then
    if [[ -n "$(git -C "${ROOT}" status --porcelain 2>/dev/null)" ]]; then
      sha="${sha}-dirty-$(date +%Y%m%d%H%M%S)"
    fi
    echo "${sha}"
  else
    date +%Y%m%d%H%M%S
  fi
}

ensure_repo() {  # Artifact Registry docker repo for the job and Console images
  if ! gcloud artifacts repositories describe "${AR_REPO}" --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud artifacts repositories create "${AR_REPO}" --repository-format=docker --location="${REGION}" \
      --project="${PROJECT_ID}" --description="SLRR Triage Agent images" --labels=app=slrr-triage-agent
  fi
}

build_image() {  # build_image <image-uri> <Dockerfile>
  local image="$1" dockerfile="$2"
  ensure_repo
  gcloud builds submit "${ROOT}" --project="${PROJECT_ID}" --region="${REGION}" \
    --config="${INFRA_DIR}/cloudbuild.yaml" \
    --substitutions="_IMAGE=${image},_DOCKERFILE=${dockerfile}"
}

# Environment shared by the Cloud Run jobs and the Console (the Agent Runtime gets the same values
# from infra/05_deploy_agent_engine.py; Agent Runtime sets GOOGLE_CLOUD_PROJECT itself, Cloud Run doesn't).
common_env_vars() {
  local vars=(
    "TRIAGE_BACKEND=gcp"
    "TRIAGE_ENV=${TRIAGE_ENV}"
    "GOOGLE_CLOUD_PROJECT=${PROJECT_ID}"
    "TRIAGE_FIRESTORE_DB=${FIRESTORE_DB}"
    "TRIAGE_BQ_TABLE=${PROJECT_ID}.${DATASET}.agent_events"
    "TRIAGE_LLM=vertex"
    "TRIAGE_LLM_LOCATION=${TRIAGE_LLM_LOCATION:-global}"
    "TRIAGE_GMAIL=google"
    "TRIAGE_GMAIL_READ_SCOPE=${TRIAGE_GMAIL_READ_SCOPE:-metadata}"
    "TRIAGE_TOKEN_VAULT=secretmanager"
  )
  local IFS='|'
  echo "${vars[*]}"
}
