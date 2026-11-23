#!/usr/bin/env bash
# Cloud Run jobs + Cloud Scheduler for the minute-level work. Studio's "On a schedule" starter only
# repeats daily/weekly, so these jobs queue their chat output in the outbox and ring the doorbell;
# Studio flow 5 (Outbox) posts it. Idempotent: re-running rebuilds the image and updates in place.
#
#   slrr-followups   every minute    SLA nudges, review reminders, Burson re-pings, Gmail sent detection,
#                                    daily Burson digest, shift handovers, parity reconciliation, re-rings
#   slrr-inhouse     every 2 min     Path B: brand_safety_alert_log -> triage (parity mode until cutover); then one
#                                    run of agent alerts when that switch is ON (read, clean, stage, BigQuery's triage)
#
# On demand (needs run.jobs.runWithOverrides, e.g. roles/run.developer):
#   gcloud run jobs execute slrr-followups --region=$REGION --args=handover
#   gcloud run jobs execute slrr-followups --region=$REGION --args=digest
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

IMAGE="${IMAGE_BASE}/jobs:$(image_tag)"
FOLLOWUPS_SCHEDULE="${FOLLOWUPS_SCHEDULE:-* * * * *}"
INHOUSE_SCHEDULE="${INHOUSE_SCHEDULE:-*/2 * * * *}"

echo "Building ${IMAGE}"
build_image "${IMAGE}" Dockerfile.jobs

deploy_job() {  # deploy_job <name> <job-arg> <task-timeout>
  local name="$1" arg="$2" timeout="$3"
  gcloud run jobs deploy "${name}" --project="${PROJECT_ID}" --region="${REGION}" \
    --image="${IMAGE}" --args="${arg}" \
    --service-account="${RUNTIME_SA}" \
    --set-env-vars="^|^$(common_env_vars)" \
    --tasks=1 --max-retries=0 --task-timeout="${timeout}" \
    --cpu=1 --memory=1Gi \
    --labels=app=slrr-triage-agent,env="${TRIAGE_ENV}" --quiet
  echo "  job ${name} -> ${arg}"
}

schedule() {  # schedule <scheduler-name> <cron> <job-name>
  local name="$1" cron="$2" job="$3" verb=create
  local uri="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/${job}:run"
  if gcloud scheduler jobs describe "${name}" --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    verb=update
  fi
  gcloud scheduler jobs "${verb}" http "${name}" --project="${PROJECT_ID}" --location="${REGION}" \
    --schedule="${cron}" --time-zone="Etc/UTC" --uri="${uri}" --http-method=POST \
    --oauth-service-account-email="${SCHEDULER_SA}" --quiet >/dev/null
  echo "  schedule ${name}: '${cron}' -> ${job}"
}

echo "Deploying jobs"
# Followups must finish well inside a minute so runs rarely overlap (overlaps are safe: claims are atomic
# and every step is idempotent via kv markers).
deploy_job slrr-followups followups 120s
# A run of agent alerts reads every source, cleans each post and waits for BigQuery's procedure, which asks Gemini.
# Ten minutes is also how long a run holds its lock, so a run cut off here never overlaps the next one.
deploy_job slrr-inhouse inhouse 600s

echo "Scheduling"
schedule slrr-followups-every-minute "${FOLLOWUPS_SCHEDULE}" slrr-followups
schedule slrr-inhouse-every-2-min "${INHOUSE_SCHEDULE}" slrr-inhouse

cat <<EOF

Jobs deployed with ${IMAGE}.
Check a run:   gcloud run jobs executions list --job=slrr-followups --region=${REGION} --limit=5
Logs:          gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="slrr-followups"' --limit=20 --project=${PROJECT_ID}
Pause Path B:  gcloud scheduler jobs pause slrr-inhouse-every-2-min --location=${REGION}
EOF
