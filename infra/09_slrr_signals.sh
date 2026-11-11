#!/usr/bin/env bash
# slrr-signals: the two-track SLRR system on Cloud Run (docs/TWO_TRACK_SIGNALS.md). Idempotent: re-running rebuilds the
# image and updates everything in place. Never deletes anything. Standalone (no infra/.env needed); override any value
# below with an environment variable.
#
#   ./infra/09_slrr_signals.sh            build, deploy, grant, schedule (schedules start PAUSED unless START=1)
#   START=1 ./infra/09_slrr_signals.sh    the same, with the two schedules running
#
# What it makes: the service account slrr-signals (reads the source tables, writes slrr_signals, calls Gemini), the
# scheduler account slrr-signals-sched (may only invoke the service), the private Cloud Run service slrr-signals (one
# request at a time, never two instances: runs can't overlap), and two Cloud Scheduler jobs (/tick every minute,
# /radar every 15 minutes). It posts nothing in Chat and touches no existing table, job or service.
set -euo pipefail

export CLOUDSDK_METRICS_ENVIRONMENT="${CLOUDSDK_METRICS_ENVIRONMENT:+$CLOUDSDK_METRICS_ENVIRONMENT }datacloud.antigravity"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_ID="${PROJECT_ID:-brand-social-central-data}"
REGION="${REGION:-us-central1}"
AR_REPO="${AR_REPO:-cloud-run-source-deploy}"
SERVICE="${SERVICE:-slrr-signals}"
SA_NAME="${SA_NAME:-slrr-signals}"
SCHED_SA_NAME="${SCHED_SA_NAME:-slrr-signals-sched}"
START="${START:-0}"
SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
SCHED_SA="${SCHED_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
TAG="$(git -C "${ROOT}" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)-$(date +%Y%m%d%H%M%S)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${SERVICE}:${TAG}"

say() { printf '\n== %s\n' "$*"; }

ensure_sa() {  # ensure_sa <name> <display name>
  local email="$1@${PROJECT_ID}.iam.gserviceaccount.com"
  if ! gcloud iam service-accounts describe "${email}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud iam service-accounts create "$1" --project="${PROJECT_ID}" --display-name="$2" --quiet
  fi
}

PY="${PY:-${ROOT}/.venv/bin/python}"
[[ -x "${PY}" ]] || PY=python3
grant_dataset() {  # grant_dataset <READER|WRITER> <project:dataset>... : additive (the dataset's access list)
  "${PY}" "${ROOT}/infra/grant_dataset_access.py" "${SA}" "$@" || true
}

say "Service accounts"
ensure_sa "${SA_NAME}" "slrr-signals (two-track SLRR runtime)"
ensure_sa "${SCHED_SA_NAME}" "slrr-signals scheduler"

say "Project roles for ${SA} (run BigQuery jobs, call Gemini)"
for role in roles/bigquery.jobUser roles/aiplatform.user roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member="serviceAccount:${SA}" --role="${role}" \
    --condition=None --quiet >/dev/null && echo "  ${role}"
done

say "Dataset access for ${SA} (read the sources, write slrr_signals)"
grant_dataset WRITER "${PROJECT_ID}:slrr_signals"
grant_dataset READER "${PROJECT_ID}:raw_data" "${PROJECT_ID}:reporting_data" "${PROJECT_ID}:google_tubular_mentions" \
  "${PROJECT_ID}:early_detection"
# Sonar lives in Burson's project: its owner must grant this (the line below says so if it can't)
grant_dataset READER "bsip-s-bsip-gg-26-2cf3:google_bg"

say "Building ${IMAGE}"
gcloud builds submit "${ROOT}" --project="${PROJECT_ID}" --region="${REGION}" \
  --config="${ROOT}/infra/cloudbuild.yaml" --substitutions="_IMAGE=${IMAGE},_DOCKERFILE=Dockerfile.signals"

say "Deploying ${SERVICE} (private; one request at a time; one instance at most)"
gcloud run deploy "${SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" --image="${IMAGE}" \
  --service-account="${SA}" --no-allow-unauthenticated --ingress=all \
  --concurrency=1 --max-instances=1 --min-instances=0 --cpu=1 --memory=1Gi --timeout=300 \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT_ID},TRIAGE_LLM=vertex,TRIAGE_LLM_LOCATION=global" \
  --labels=app=slrr-signals --quiet
URL="$(gcloud run services describe "${SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)')"
gcloud run services add-iam-policy-binding "${SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" \
  --member="serviceAccount:${SCHED_SA}" --role=roles/run.invoker --quiet >/dev/null
echo "  ${URL}"

schedule() {  # schedule <job> <cron> <path> <attempt deadline>
  local verb=create
  if gcloud scheduler jobs describe "$1" --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then verb=update; fi
  gcloud scheduler jobs "${verb}" http "$1" --project="${PROJECT_ID}" --location="${REGION}" --schedule="$2" \
    --time-zone="Etc/UTC" --uri="${URL}$3" --http-method=POST --attempt-deadline="$4" --max-retry-attempts=0 \
    --oidc-service-account-email="${SCHED_SA}" --oidc-token-audience="${URL}" --quiet >/dev/null
  if [[ "${START}" == "1" ]]; then
    gcloud scheduler jobs resume "$1" --location="${REGION}" --project="${PROJECT_ID}" --quiet >/dev/null
    echo "  $1: '$2' -> $3 (running)"
  else
    gcloud scheduler jobs pause "$1" --location="${REGION}" --project="${PROJECT_ID}" --quiet >/dev/null
    echo "  $1: '$2' -> $3 (PAUSED: START=1 to run it)"
  fi
}

say "Schedules (no retries: a missed tick is simply the next minute's)"
schedule slrr-signals-tick "* * * * *" /tick 120s
schedule slrr-signals-radar "*/15 * * * *" /radar 300s

cat <<EOF

Done. ${SERVICE}: ${URL}
Run one tick now:  gcloud scheduler jobs run slrr-signals-tick --location=${REGION} --project=${PROJECT_ID}   (once resumed)
Start schedules:   gcloud scheduler jobs resume slrr-signals-tick --location=${REGION} --project=${PROJECT_ID}
                   gcloud scheduler jobs resume slrr-signals-radar --location=${REGION} --project=${PROJECT_ID}
Stop everything:   gcloud scheduler jobs pause slrr-signals-tick --location=${REGION} --project=${PROJECT_ID}
                   gcloud scheduler jobs pause slrr-signals-radar --location=${REGION} --project=${PROJECT_ID}
Logs:              gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="${SERVICE}"' --limit=30 --project=${PROJECT_ID}
EOF
