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
for member in "serviceAccount:${RUNTIME_SA}" "serviceAccount:${RE_AGENT}"; do
  bq add-iam-policy-binding --member="${member}" --role=roles/bigquery.dataEditor \
    "${PROJECT_ID}:${DATASET}" >/dev/null && echo "  dataEditor on ${DATASET} -> ${member}" \
    || echo "  could not bind ${member} (create the Agent Engine first, then re-run)"
done

echo "Events table: ${PROJECT_ID}.${DATASET}.agent_events  (set TRIAGE_BQ_TABLE to this)"
