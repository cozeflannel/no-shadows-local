#!/usr/bin/env bash
# Agent alerts: what it needs on Google Cloud beyond the agent's own. Safe to run again.
#
#   1. A BigQuery connection in the dataset's location. BigQuery calls Vertex AI through it (the embedding model and
#      the fast Gemini model of the triage procedure). The connection's own account gets Vertex AI User, and the
#      agent's runtime account may use this one connection.
#   2. A secret that holds the salt an author's handle is hashed with, made once from random bytes.
#   3. Vertex AI's in-memory cache turned off, for zero data retention. The setting is the project's: off for every
#      Gemini call in the project, in every region. It takes roles/aiplatform.admin.
#
#   infra/11_own_alerts.sh                 # 1, 2 and 3
#   infra/11_own_alerts.sh --keep-cache    # 1 and 2: the project's cache setting is left as it is
#
# The rest is set in the Console: Integrations (Find and fill), then Settings, Agent alerts.
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

CONNECTION="${OWN_CONNECTION:-slrr_vertex_conn}"
SALT_SECRET="${OWN_SALT_SECRET:-slrr-author-hash-salt}"
KEEP_CACHE=""
for arg in "$@"; do
  case "${arg}" in
    --keep-cache) KEEP_CACHE=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Unknown option ${arg}" >&2; exit 2 ;;
  esac
done
LEFT=("Share the KOF sheet (Viewer) with ${RUNTIME_SA}" "Open the Console: Integrations, Find and fill. Then Settings, Agent alerts.")

# BigQuery names a connection project.location.name with the location in lower case (us, not US).
LOCATION="$(echo "${BQ_LOCATION}" | tr '[:upper:]' '[:lower:]')"
FULL="${PROJECT_ID}.${LOCATION}.${CONNECTION}"
if bq show --connection "${FULL}" >/dev/null 2>&1; then
  echo "Connection ${FULL} exists"
else
  bq mk --connection --project_id="${PROJECT_ID}" --location="${BQ_LOCATION}" --connection_type=CLOUD_RESOURCE "${CONNECTION}" >/dev/null
  echo "Created connection ${FULL}"
fi
CONNECTION_SA="$(bq show --format=json --connection "${FULL}" 2>/dev/null | python3 -c 'import json, sys
try:
    print(json.load(sys.stdin)["cloudResource"]["serviceAccountId"])
except Exception:
    sys.exit(1)')" || { echo "BigQuery did not show the account of connection ${FULL}. Nothing else was changed." >&2; exit 1; }
gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member="serviceAccount:${CONNECTION_SA}" --role=roles/aiplatform.user \
  --condition=None --quiet >/dev/null
echo "  roles/aiplatform.user -> ${CONNECTION_SA} (the connection's own account)"

# The runtime account creates the two remote models on this connection and runs them. That takes the Connection Admin
# role, given here on this connection alone (bq and gcloud have no command for a connection's access, so the API is asked).
TOKEN="$(gcloud auth print-access-token)"
API="https://bigqueryconnection.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/connections/${CONNECTION}"
grant_connection() {
  local policy updated
  policy="$(curl -sf -X POST -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" "${API}:getIamPolicy" -d '{}')" || return 1
  updated="$(MEMBER="serviceAccount:${RUNTIME_SA}" python3 -c '
import json, os, sys
policy = json.load(sys.stdin)
member, role = os.environ["MEMBER"], "roles/bigquery.connectionAdmin"
binding = next((b for b in policy.setdefault("bindings", []) if b.get("role") == role), None)
if binding is None:
    policy["bindings"].append({"role": role, "members": [member]})
elif member not in binding.setdefault("members", []):
    binding["members"].append(member)
print(json.dumps({"policy": policy}))' <<<"${policy}")" || return 1
  curl -sf -X POST -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" "${API}:setIamPolicy" -d "${updated}" >/dev/null
}
if grant_connection; then
  echo "  roles/bigquery.connectionAdmin on ${CONNECTION} -> ${RUNTIME_SA}"
else
  GRANT="gcloud projects add-iam-policy-binding ${PROJECT_ID} --member=serviceAccount:${RUNTIME_SA} --role=roles/bigquery.connectionAdmin --condition=None"
  echo "Could not let ${RUNTIME_SA} use the connection. Agent alerts cannot create its models until it can. Run:" >&2
  echo "  ${GRANT}" >&2
  LEFT+=("Let the runtime account use the connection: ${GRANT}")
fi

if gcloud secrets describe "${SALT_SECRET}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "Secret ${SALT_SECRET} exists (left as it is: a new salt would change every author's hash)"
else
  python3 -c 'import secrets; print(secrets.token_hex(32), end="")' \
    | gcloud secrets create "${SALT_SECRET}" --project="${PROJECT_ID}" --replication-policy=automatic --data-file=- --labels=app=slrr-triage-agent >/dev/null
  echo "Created secret ${SALT_SECRET}"
fi

if [[ -z "${KEEP_CACHE}" ]]; then
  # Vertex AI keeps Gemini inputs in memory for up to 24 hours to answer repeats faster. Off means off for every
  # Gemini call in the project, this app's or not, in every region.
  if curl -sf -X PATCH -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
      "https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/cacheConfig" \
      -d "{\"name\": \"projects/${PROJECT_ID}/cacheConfig\", \"disableCache\": true}" >/dev/null; then
    echo "Vertex AI's cache is off for ${PROJECT_ID} (every Gemini call in the project)"
  else
    echo "Could not turn Vertex AI's cache off. It takes roles/aiplatform.admin on ${PROJECT_ID}." >&2
    LEFT+=("Vertex AI's cache is still on. With roles/aiplatform.admin on ${PROJECT_ID}, run infra/11_own_alerts.sh again.")
  fi
else
  echo "Vertex AI's cache setting was left as it is (--keep-cache)"
fi

echo
echo "Agent alerts on Google Cloud. Left for a person:"
n=0
for line in "${LEFT[@]}"; do
  n=$((n + 1))
  echo "  ${n}. ${line}"
done
echo "Google keeps prompts for abuse monitoring until it exempts a project. Only Google can do that, on request."
