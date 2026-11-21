#!/usr/bin/env bash
# BigQuery: agent dataset, agent_events table, KPI views; dataset access for the runtime identities. Idempotent.
set -euo pipefail
source "$(dirname "$0")/.env"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

render() {  # substitute ${PROJECT} ${DATASET} ${BQ_LOCATION}
  sed -e "s/\${PROJECT}/${PROJECT_ID}/g" -e "s/\${DATASET}/${DATASET}/g" -e "s/\${BQ_LOCATION}/${BQ_LOCATION}/g" "$1"
}

for sql in "${ROOT}/analytics/01_agent_events.sql" "${ROOT}/analytics/02_metric_views.sql"; do
  echo "Applying $(basename "${sql}")"
  render "${sql}" | bq query --project_id="${PROJECT_ID}" --location="${BQ_LOCATION}" --use_legacy_sql=false \
    ${BQ_LABELS} --nouse_cache >/dev/null
done

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
RE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-aiplatform-re.iam.gserviceaccount.com"
# Dataset access is granted with GRANT ... ON SCHEMA: `bq add-iam-policy-binding` only works on tables and views.
grant_editor() {  # grant_editor <member>: prints bq's own message when it fails
  bq query --project_id="${PROJECT_ID}" --location="${BQ_LOCATION}" --use_legacy_sql=false ${BQ_LABELS} \
    "GRANT \`roles/bigquery.dataEditor\` ON SCHEMA \`${PROJECT_ID}\`.\`${DATASET}\` TO \"$1\"" 2>&1
}

granted=""
for _ in 1 2 3 4 5 6; do  # a service account made a moment ago can take up to a minute to be known to BigQuery
  if out="$(grant_editor "serviceAccount:${RUNTIME_SA}")"; then granted=1; break; fi
  sleep "${GRANT_RETRY_SECONDS:-10}"
done
if [[ -n "${granted}" ]]; then
  echo "  dataEditor on ${DATASET} -> ${RUNTIME_SA}"
else
  echo "Could not give ${RUNTIME_SA} write access to ${PROJECT_ID}.${DATASET}. Without it the agent cannot write events." >&2
  echo "${out}" >&2
  exit 1
fi
# The Agent Runtime's own service agent exists only after the first agent deploy; deploy.sh runs this script again after it.
if out="$(grant_editor "serviceAccount:${RE_AGENT}")"; then
  echo "  dataEditor on ${DATASET} -> ${RE_AGENT}"
else
  echo "  not granted yet to ${RE_AGENT}: it is created by the first Agent Runtime deploy. Re-run this script after 05."
  echo "${out}" | tail -n 2 | sed 's/^/    /'
fi

echo "Events table: ${PROJECT_ID}.${DATASET}.agent_events  (set TRIAGE_BQ_TABLE to this)"
