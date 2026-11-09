#!/usr/bin/env bash
# Service accounts + IAM. Idempotent (re-running only re-applies bindings).
#
#   runtime SA     Agent Runtime (custom service account) + jobs + Console: Gemini, Firestore, BigQuery jobs,
#                  Secret Manager (Gmail tokens / OAuth client), Sheets doorbell (share the sheet with it)
#   RE agent       the Reasoning Engine service agent gets the same data access (only used if the agent is
#                  ever deployed without the custom service account)
#   scheduler SA   Cloud Scheduler -> Cloud Run jobs
set -euo pipefail
source "$(dirname "$0")/.env"

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
RE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-aiplatform-re.iam.gserviceaccount.com"

create_sa() {
  local name="$1" display="$2"
  if ! gcloud iam service-accounts describe "${name}@${PROJECT_ID}.iam.gserviceaccount.com" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud iam service-accounts create "${name}" --project="${PROJECT_ID}" --display-name="${display}"
  fi
}
bind() {
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member="$1" --role="$2" --condition=None --quiet >/dev/null
  echo "  ${2} -> ${1}"
}

create_sa "${RUNTIME_SA_NAME}" "SLRR Triage Agent runtime"
create_sa "${SCHEDULER_SA_NAME}" "SLRR Triage Agent scheduler"

echo "Runtime SA roles:"
# secretmanager.admin: the Console's Gmail-connect callback creates one gmail-token-<hash> secret per IM.
# Tighter alternative: a custom role with secretmanager.secrets.create/delete + versions.add/access, or a
# dedicated project for token secrets.
for role in roles/aiplatform.user roles/datastore.user roles/bigquery.jobUser roles/secretmanager.admin \
            roles/logging.logWriter; do
  bind "serviceAccount:${RUNTIME_SA}" "${role}"
done

echo "Agent Engine service agent roles (created on first Agent Engine deploy; re-run after 05 if this fails):"
for role in roles/aiplatform.user roles/datastore.user roles/bigquery.jobUser roles/secretmanager.secretAccessor \
            roles/secretmanager.secretVersionAdder; do
  bind "serviceAccount:${RE_AGENT}" "${role}" || echo "  (service agent not created yet)"
done

echo "Scheduler SA roles:"
bind "serviceAccount:${SCHEDULER_SA}" roles/run.invoker

# The Studio custom steps call the Agent Runtime's :query with the Triage Agent account's OAuth token
# (ScriptApp.getOAuthToken), which needs aiplatform.reasoningEngines.query (in roles/aiplatform.user).
if [[ "${TRIAGE_AGENT_ACCOUNT}" == *@example.com ]]; then
  echo "Skipping the Triage Agent account binding: set TRIAGE_AGENT_ACCOUNT in infra/.env and re-run."
else
  echo "Triage Agent account (Studio flows -> Agent Runtime):"
  bind "user:${TRIAGE_AGENT_ACCOUNT}" roles/aiplatform.user
fi

cat <<EOF

Dataset-level BigQuery access is granted in 04_bigquery.sh.

Request from the owners of ${SONAR_PROJECT}.${SONAR_DATASET} (Path B + Sonar lookups):
  - roles/bigquery.dataViewer on dataset ${SONAR_PROJECT}:${SONAR_DATASET} for ${RUNTIME_SA} and ${RE_AGENT}
  - roles/bigquery.dataEditor on table brand_safety_alert_log (only if inhouse.mark_delivered: true after cutover)
EOF
