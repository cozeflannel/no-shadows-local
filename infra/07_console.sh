#!/usr/bin/env bash
# Agent Console on Cloud Run behind Identity-Aware Proxy (IAP enabled directly on the service).
# Idempotent: re-running rebuilds the image and redeploys.
#
# First IAP use in a project without an organization needs one click in the Cloud Run UI
# (Security tab -> Require authentication -> Identity-Aware Proxy); google.com projects are fine.
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

IMAGE="${IMAGE_BASE}/console:$(image_tag)"
PROJECT_NUMBER="$(project_number)"
IAP_AGENT="service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com"
AUDIENCE="/projects/${PROJECT_NUMBER}/locations/${REGION}/services/${CONSOLE_SERVICE}"

echo "Building ${IMAGE}"
build_image "${IMAGE}" Dockerfile.console

ENV_VARS="$(common_env_vars)|TRIAGE_IAP_AUDIENCE=${AUDIENCE}|TRIAGE_OAUTH_CLIENT=projects/${PROJECT_ID}/secrets/${OAUTH_CLIENT_SECRET}"
# Keep the Gmail OAuth redirect base across redeploys (--set-env-vars replaces every variable).
EXISTING_URL="$(gcloud run services describe "${CONSOLE_SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)')"
if [[ "${URL}" != "${EXISTING_URL}" ]]; then  # first deploy: the URL is only known now
  echo "Setting TRIAGE_CONSOLE_BASE_URL=${URL} (Gmail OAuth redirect)"
  gcloud run services update "${CONSOLE_SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" \
    --update-env-vars="TRIAGE_CONSOLE_BASE_URL=${URL}" --quiet >/dev/null
fi

cat <<EOF

Agent Console: ${URL}
Access is controlled by IAP (roles/iap.httpsResourceAccessor); roles inside the Console come from
config.analysts (admin | lead | analyst) and the slrr_im roster; other @google.com users are read-only.

Gmail connect (IMs draft Social Alerts in their own mailbox) needs the OAuth client from 08_gmail_oauth.sh with
this authorized redirect URI:
  ${URL}/api/gmail/callback
EOF
