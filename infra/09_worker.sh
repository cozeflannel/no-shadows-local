#!/usr/bin/env bash
# The worker on Cloud Run: receives the Pub/Sub pushes for outbound delivery and dead letters, and runs the
# platform's scheduled work (knowledge refresh, watches, temp checks, forecast) once a minute. How often each of
# those really runs is a Console setting; the tick only asks "is anything due?".
# Private: only the scheduler service account may call it (Cloud Scheduler and Pub/Sub both sign as it).
# Idempotent. Uses the Console image (same code, different entry point); set CONSOLE_IMAGE to reuse a built one.
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

WORKER_SERVICE="${WORKER_SERVICE:-${CONSOLE_SERVICE}-worker}"
IMAGE="${CONSOLE_IMAGE:-${IMAGE_BASE}/console:$(image_tag)}"
if [[ -z "${CONSOLE_IMAGE:-}" ]] && ! gcloud artifacts docker images describe "${IMAGE}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "Building ${IMAGE}"
  build_image "${IMAGE}" Dockerfile.console
fi

echo "Deploying ${WORKER_SERVICE}"
gcloud run deploy "${WORKER_SERVICE}" \
  --project="${PROJECT_ID}" --region="${REGION}" --image="${IMAGE}" \
  --service-account="${RUNTIME_SA}" --no-allow-unauthenticated \
  --command=uvicorn --args=console.backend.worker:app,--host,0.0.0.0,--port,8080 --port=8080 \
  --set-env-vars="^|^$(common_env_vars)|TRIAGE_SCHEDULER_SA=${SCHEDULER_SA}" \
  --cpu=1 --memory=1Gi --timeout=600 --concurrency=20 \
  --labels=app=slrr-triage-agent,env="${TRIAGE_ENV}" --quiet

gcloud run services add-iam-policy-binding "${WORKER_SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" \
  --member="serviceAccount:${SCHEDULER_SA}" --role=roles/run.invoker --quiet >/dev/null

WORKER_URL="$(gcloud run services describe "${WORKER_SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" --format="value(status.url)")"

NAME="slrr-platform-every-minute"
VERB=create
if gcloud scheduler jobs describe "${NAME}" --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  VERB=update
fi
gcloud scheduler jobs "${VERB}" http "${NAME}" --project="${PROJECT_ID}" --location="${REGION}" \
  --schedule="* * * * *" --time-zone="Etc/UTC" --uri="${WORKER_URL}/jobs/maintenance" --http-method=POST \
  --oidc-service-account-email="${SCHEDULER_SA}" --oidc-token-audience="${WORKER_URL}" --attempt-deadline=540s --quiet >/dev/null
echo "  schedule ${NAME}: every minute -> ${WORKER_URL}/jobs/maintenance"

mkdir -p "${ROOT}/.local"
echo "${WORKER_URL}" > "${ROOT}/.local/worker_url.txt"

cat <<EOF

Worker: ${WORKER_URL}
Next: infra/10_seed_settings.py writes this URL and the push identity into the Console's Delivery settings.
EOF
