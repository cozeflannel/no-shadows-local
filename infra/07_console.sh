#!/usr/bin/env bash
# Agent Console on Cloud Run behind Identity-Aware Proxy (IAP enabled directly on the service).
# Idempotent: re-running rebuilds the image and redeploys (or set CONSOLE_IMAGE to skip build).
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

IMAGE="${CONSOLE_IMAGE:-${IMAGE_BASE}/console:$(image_tag)}"
PROJECT_NUMBER="$(project_number)"
IAP_AGENT="service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com"
AUDIENCE="/projects/${PROJECT_NUMBER}/locations/${REGION}/services/${CONSOLE_SERVICE}"

if [[ -z "${CONSOLE_IMAGE:-}" ]]; then
  echo "Building ${IMAGE}"
  build_image "${IMAGE}" Dockerfile.console
else
  echo "Using existing image ${IMAGE}"
fi

EXISTING_URL="$(gcloud run services describe "${CONSOLE_SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" --format="value(status.url)" 2>/dev/null || true)"
ENV_VARS="$(common_env_vars)|TRIAGE_IAP_AUDIENCE=${AUDIENCE}|TRIAGE_OAUTH_CLIENT=projects/${PROJECT_ID}/secrets/${OAUTH_CLIENT_SECRET}"
# The person deploying is the Console's first admin, only until an admin is named in Settings (Analysts & roles).
if [[ -n "${BOOTSTRAP_ADMIN:-}" ]]; then
  ENV_VARS="${ENV_VARS}|TRIAGE_BOOTSTRAP_ADMIN=${BOOTSTRAP_ADMIN}"
fi
# (The Console's owner, who is always an admin, is in common_env_vars: TRIAGE_OWNER_ADMIN, from OWNER_ADMIN.)
if [[ -n "${EXISTING_URL}" ]]; then
  ENV_VARS="${ENV_VARS}|TRIAGE_CONSOLE_BASE_URL=${EXISTING_URL}"
fi

echo "Deploying ${CONSOLE_SERVICE}"
gcloud beta run deploy "${CONSOLE_SERVICE}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --image="${IMAGE}" \
  --service-account="${RUNTIME_SA}" \
  --no-allow-unauthenticated \
  --iap \
  --set-env-vars="^|^${ENV_VARS}" \
  --quiet

gcloud run services add-iam-policy-binding "${CONSOLE_SERVICE}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --member="serviceAccount:${IAP_AGENT}" \
  --role="roles/run.invoker" \
  --quiet >/dev/null || true

IFS=',' read -ra MEMBERS <<< "${IAP_MEMBERS:-}"
for member in "${MEMBERS[@]}"; do
  [[ -z "${member}" || "${member}" == *@domain.invalid ]] && continue
  gcloud beta iap web add-iam-policy-binding --project="${PROJECT_ID}" --region="${REGION}" --resource-type=cloud-run \
    --service="${CONSOLE_SERVICE}" --member="${member}" --role=roles/iap.httpsResourceAccessor --condition=None --quiet >/dev/null \
    && echo "  may open the Console: ${member}"
done

URL="$(gcloud run services describe "${CONSOLE_SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" --format="value(status.url)")"
if [[ "${URL}" != "${EXISTING_URL}" ]]; then
  echo "Setting TRIAGE_CONSOLE_BASE_URL=${URL} (Gmail OAuth redirect)"
  gcloud run services update "${CONSOLE_SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" \
    --update-env-vars="TRIAGE_CONSOLE_BASE_URL=${URL}" --quiet >/dev/null
fi

cat <<EOF

Agent Console: ${URL}
Who may open it is controlled by IAP (roles/iap.httpsResourceAccessor, granted above to IAP_MEMBERS). Roles inside
the Console come from Settings: Analysts & roles, the IM roster, and the viewer domains under Access.

Gmail connect (IMs draft Social Alerts in their own mailbox) needs the OAuth client from 08_gmail_oauth.sh with
this authorized redirect URI:
  ${URL}/api/gmail/callback
EOF
