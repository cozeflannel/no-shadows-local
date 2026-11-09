#!/usr/bin/env bash
set -euo pipefail

export CLOUDSDK_METRICS_ENVIRONMENT="${CLOUDSDK_METRICS_ENVIRONMENT:+$CLOUDSDK_METRICS_ENVIRONMENT }datacloud.antigravity"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT}"

OAUTH_CLIENT_JSON_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --oauth-client-json)
      OAUTH_CLIENT_JSON_ARG="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: ./setup.sh [--oauth-client-json /path/to/client_secret.json]" >&2
      exit 1
      ;;
  esac
done

echo "=== Step 0: Running ./check.sh pre-gate ==="
./check.sh

cfg_get() {
  local key="$1"
  .venv/bin/python - "${key}" <<'PY'
import sys
import yaml

key = sys.argv[1]
with open("config/campaigns.yaml", encoding="utf-8") as fh:
    cur = yaml.safe_load(fh)
for part in key.split("."):
    cur = cur[part]
if isinstance(cur, list):
    print(",".join(str(x) for x in cur))
else:
    print("" if cur is None else str(cur))
PY
}

run_with_role() {
  local required_role="$1"
  shift
  local err_file
  err_file="$(mktemp)"
  if ! "$@" 2>"${err_file}"; then
    local err_txt
    err_txt="$(cat "${err_file}")"
    rm -f "${err_file}"
    echo "SETUP STOPPED: command failed: $*" >&2
    echo "Exact error: ${err_txt}" >&2
    echo "Required IAM role: ${required_role}" >&2
    exit 1
  fi
  rm -f "${err_file}"
}

GCP_PROJECT="$(cfg_get gcp_project_id)"
CHAT_PROJECT="$(cfg_get chat_project_id)"
CLOUD_RUN_REGION="$(cfg_get cloud_run_region)"
CLOUD_RUN_SERVICE="$(cfg_get cloud_run_service)"
FIRESTORE_DB="$(cfg_get firestore_database)"
ALERTS_SPACE="$(cfg_get alerts_space)"
FORBIDDEN_SPACE="$(cfg_get forbidden_burson_space)"
DRIVE_FOLDER_ID="$(cfg_get drive_folder_id)"
REGISTRY_SHEET_ID="$(cfg_get registry_spreadsheet_id)"
KOF_SHEET_ID="$(cfg_get kof_spreadsheet_id)"
BQ_SUNDAR_TABLE="$(cfg_get bigquery_sundar_table)"
BQ_BW_TABLE="$(cfg_get bigquery_brandwatch_table)"
BW_PROJECT_IDS="$(cfg_get brandwatch_project_ids)"
SECRET_OAUTH_CLIENT="$(cfg_get secrets.oauth_client_json)"
SECRET_OAUTH_REFRESH="$(cfg_get secrets.oauth_refresh_token)"
SECRET_BW_USER="$(cfg_get secrets.brandwatch_username)"
SECRET_BW_PASS="$(cfg_get secrets.brandwatch_password)"
SECRET_BW_TOKEN="$(cfg_get secrets.brandwatch_token)"

if [[ "${ALERTS_SPACE}" == "${FORBIDDEN_SPACE}" ]]; then
  echo "FATAL: alerts_space (${ALERTS_SPACE}) must never equal forbidden_burson_space." >&2
  exit 1
fi
if [[ -z "${KOF_SHEET_ID}" ]]; then
  echo "FATAL: kof_spreadsheet_id is empty in config/campaigns.yaml." >&2
  exit 1
fi

echo "=== Step 1: Confirming gcloud account and project ==="
ACTIVE_ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
ACTIVE_PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
if [[ -z "${ACTIVE_ACCOUNT}" ]]; then
  echo "FATAL: No active gcloud account. Run 'gcloud auth login' first." >&2
  exit 1
fi
if [[ "${ACTIVE_PROJECT}" != "${GCP_PROJECT}" ]]; then
  run_with_role "roles/viewer" gcloud config set project "${GCP_PROJECT}" >/dev/null
fi
echo "Active account: ${ACTIVE_ACCOUNT} | GCP project: ${GCP_PROJECT} | Chat project: ${CHAT_PROJECT}"

echo "=== Step 2: Enabling required APIs ==="
enable_missing_apis() {
  local project="$1"
  shift
  local enabled
  enabled="$(gcloud services list --enabled --project="${project}" --format='value(config.name)')"
  local to_enable=()
  local api
  for api in "$@"; do
    if ! grep -Fxq "${api}" <<<"${enabled}"; then
      to_enable+=("${api}")
    fi
  done
  if [[ ${#to_enable[@]} -gt 0 ]]; then
    echo "Enabling in ${project}: ${to_enable[*]}"
    run_with_role "roles/serviceusage.serviceUsageAdmin" \
      gcloud services enable "${to_enable[@]}" --project="${project}"
  else
    echo "All required APIs already enabled in ${project}."
  fi
}

enable_missing_apis "${GCP_PROJECT}" \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  secretmanager.googleapis.com \
  firestore.googleapis.com \
  aiplatform.googleapis.com \
  bigquery.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com

enable_missing_apis "${CHAT_PROJECT}" \
  chat.googleapis.com \
  gmail.googleapis.com \
  sheets.googleapis.com \
  drive.googleapis.com \
  docs.googleapis.com \
  people.googleapis.com

echo "=== Step 3: Ensuring service accounts and least-privilege IAM ==="
RUNTIME_SA_NAME="slrr-campaigns-sa"
SCHEDULER_SA_NAME="slrr-campaigns-sched"
RUNTIME_SA="${RUNTIME_SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com"
SCHEDULER_SA="${SCHEDULER_SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com"

ensure_sa() {
  local sa_name="$1" sa_email="$2" display="$3"
  if ! gcloud iam service-accounts describe "${sa_email}" --project="${GCP_PROJECT}" >/dev/null 2>&1; then
    run_with_role "roles/iam.serviceAccountAdmin" \
      gcloud iam service-accounts create "${sa_name}" \
      --project="${GCP_PROJECT}" \
      --display-name="${display}"
  fi
}

ensure_sa "${RUNTIME_SA_NAME}" "${RUNTIME_SA}" "SLRR Campaigns Cloud Run Runtime"
ensure_sa "${SCHEDULER_SA_NAME}" "${SCHEDULER_SA}" "SLRR Campaigns Cloud Scheduler Invoker"

PROJECT_NUM="$(gcloud projects describe "${GCP_PROJECT}" --format='value(projectNumber)')"
PROJECT_IAM_JSON="$(gcloud projects get-iam-policy "${GCP_PROJECT}" --format=json)"

ensure_project_binding() {
  local member="$1" role="$2" cond_title="$3" cond_expr="$4"
  local has_binding
  has_binding="$(
    .venv/bin/python - "${role}" "${member}" "${cond_title}" "${cond_expr}" "${PROJECT_IAM_JSON}" <<'PY'
import json
import sys

role, member, cond_title, cond_expr, raw = sys.argv[1:6]
policy = json.loads(raw)
found = False
for b in policy.get("bindings") or []:
    if b.get("role") != role or member not in (b.get("members") or []):
        continue
    cond = b.get("condition") or {}
    if not cond_title:
        if not cond:
            found = True
            break
    elif cond.get("title") == cond_title and cond.get("expression") == cond_expr:
        found = True
        break
print("yes" if found else "no")
PY
  )"
  if [[ "${has_binding}" != "yes" ]]; then
    if [[ -z "${cond_title}" ]]; then
      run_with_role "roles/resourcemanager.projectIamAdmin" \
        gcloud projects add-iam-policy-binding "${GCP_PROJECT}" \
        --member="${member}" \
        --role="${role}" \
        --condition=None >/dev/null
    else
      local cond_file
      cond_file="$(mktemp)"
      .venv/bin/python - "${cond_title}" "${cond_expr}" "${cond_file}" <<'PY'
import json
import sys
from pathlib import Path

Path(sys.argv[3]).write_text(
    json.dumps({"title": sys.argv[1], "expression": sys.argv[2]}),
    encoding="utf-8",
)
PY
      run_with_role "roles/resourcemanager.projectIamAdmin" \
        gcloud projects add-iam-policy-binding "${GCP_PROJECT}" \
        --member="${member}" \
        --role="${role}" \
        --condition-from-file="${cond_file}" >/dev/null
      rm -f "${cond_file}"
    fi
    PROJECT_IAM_JSON="$(gcloud projects get-iam-policy "${GCP_PROJECT}" --format=json)"
  fi
}

for role in roles/datastore.user roles/aiplatform.user roles/bigquery.jobUser; do
  ensure_project_binding "serviceAccount:${RUNTIME_SA}" "${role}" "" ""
done

echo "Ensuring table-scoped BigQuery read access on mention tables..."
bq_table_resource() {
  local dotted="$1"
  local proj ds tbl
  proj="$(cut -d. -f1 <<<"${dotted}")"
  ds="$(cut -d. -f2 <<<"${dotted}")"
  tbl="$(cut -d. -f3 <<<"${dotted}")"
  echo "projects/${proj}/datasets/${ds}/tables/${tbl}"
}
BQ_SUNDAR_RES="$(bq_table_resource "${BQ_SUNDAR_TABLE}")"
BQ_BW_RES="$(bq_table_resource "${BQ_BW_TABLE}")"
BQ_COND_EXPR="resource.service == \"bigquery.googleapis.com\" && (resource.name == \"${BQ_SUNDAR_RES}\" || resource.name == \"${BQ_BW_RES}\")"
ensure_project_binding "serviceAccount:${RUNTIME_SA}" "roles/bigquery.dataViewer" "slrr-campaigns-mention-tables" "${BQ_COND_EXPR}"

SCHED_AGENT="service-${PROJECT_NUM}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"
ensure_project_binding "serviceAccount:${SCHED_AGENT}" "roles/cloudscheduler.serviceAgent" "" ""

echo "=== Step 4: Ensuring Secret Manager secrets and secret-scoped IAM ==="
ALL_SECRETS=(
  "${SECRET_OAUTH_CLIENT}"
  "${SECRET_OAUTH_REFRESH}"
  "${SECRET_BW_USER}"
  "${SECRET_BW_PASS}"
  "${SECRET_BW_TOKEN}"
)
for sec in "${ALL_SECRETS[@]}"; do
  if ! gcloud secrets describe "${sec}" --project="${GCP_PROJECT}" >/dev/null 2>&1; then
    run_with_role "roles/secretmanager.admin" \
      gcloud secrets create "${sec}" \
      --project="${GCP_PROJECT}" \
      --replication-policy="automatic" \
      --labels="app=slrr-campaigns,datacloud=antigravity" >/dev/null
  fi
done

SEC_COND_EXPR="resource.service == \"secretmanager.googleapis.com\" && resource.name.startsWith(\"projects/${PROJECT_NUM}/secrets/slrr-campaigns-\")"
ensure_project_binding "serviceAccount:${RUNTIME_SA}" "roles/secretmanager.secretAccessor" "slrr-campaigns-secrets" "${SEC_COND_EXPR}"
ensure_project_binding "user:${ACTIVE_ACCOUNT}" "roles/secretmanager.secretAccessor" "slrr-campaigns-secrets" "${SEC_COND_EXPR}"
ensure_project_binding "serviceAccount:${RUNTIME_SA}" "roles/secretmanager.secretVersionAdder" "slrr-campaigns-secrets" "${SEC_COND_EXPR}"

echo "=== Step 5: Ensuring Firestore database '${FIRESTORE_DB}' ==="
if ! gcloud firestore databases describe --database="${FIRESTORE_DB}" --project="${GCP_PROJECT}" >/dev/null 2>&1; then
  run_with_role "roles/datastore.owner" \
    gcloud firestore databases create \
    --database="${FIRESTORE_DB}" \
    --location="nam5" \
    --type="firestore-native" \
    --project="${GCP_PROJECT}"
fi

echo "=== Step 6: Verifying or minting Brandwatch API token ==="
BW_READY="$(
  .venv/bin/python - <<'PY'
import httpx
from slrr_campaigns.auth import AuthFailureError, BRANDWATCH_BASE_URL, BrandwatchTokenProvider, SecretStore
from slrr_campaigns.config import load_config

cfg = load_config()
secrets = SecretStore(cfg.gcp_project_id)
provider = BrandwatchTokenProvider(cfg, secrets)
try:
    tok = provider.get_token()
    resp = httpx.get(
        f"{BRANDWATCH_BASE_URL}/me",
        headers={"Authorization": f"bearer {tok}"},
        timeout=20.0,
    )
    if resp.status_code == 401:
        tok = provider.refresh_on_unauthorized()
        resp = httpx.get(
            f"{BRANDWATCH_BASE_URL}/me",
            headers={"Authorization": f"bearer {tok}"},
            timeout=20.0,
        )
    print("yes" if resp.status_code == 200 else "no")
except AuthFailureError:
    print("no")
PY
)"

if [[ "${BW_READY}" != "yes" ]]; then
  printf "Enter Brandwatch API username (email, or email|platform_client_id): "
  read -r BW_INPUT_USER
  printf "Enter Brandwatch API password (hidden): "
  read -r -s BW_INPUT_PASS
  printf "\n"
  if [[ -z "${BW_INPUT_USER}" || -z "${BW_INPUT_PASS}" ]]; then
    echo "FATAL: Brandwatch API username and password are required." >&2
    exit 1
  fi
  BW_MINT_STATUS="$(
    BW_INPUT_USER="${BW_INPUT_USER}" BW_INPUT_PASS="${BW_INPUT_PASS}" .venv/bin/python - <<'PY'
import os
import sys
import yaml
import httpx
from slrr_campaigns.auth import AuthFailureError, BRANDWATCH_BASE_URL, SecretStore, mint_brandwatch_token
from slrr_campaigns.config import load_config, resolve_config_path

cfg_path = resolve_config_path()
cfg = load_config(cfg_path)
secrets = SecretStore(cfg.gcp_project_id)
user = os.environ["BW_INPUT_USER"].strip()
pw = os.environ["BW_INPUT_PASS"]
try:
    token, _ = mint_brandwatch_token(user, pw)
except AuthFailureError as exc:
    msg = str(exc)
    if "HTTP 500" in msg and "|" not in user:
        print("NEEDS_PLATFORM_CLIENT_ID")
        sys.exit(0)
    sys.stderr.write(f"{msg}\n")
    sys.exit(1)

secrets.write_secret(cfg.secrets.brandwatch_username, user)
secrets.write_secret(cfg.secrets.brandwatch_password, pw)
secrets.write_secret(cfg.secrets.brandwatch_token, token)

resp = httpx.get(
    f"{BRANDWATCH_BASE_URL}/projects",
    params={"pageSize": 100, "page": 0},
    headers={"Authorization": f"bearer {token}"},
    timeout=30.0,
)
if resp.status_code == 200:
    items = resp.json().get("results") or []
    pids = sorted({int(p["id"]) for p in items if isinstance(p, dict) and isinstance(p.get("id"), int)})
    if pids:
        raw = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
        if not raw.get("brandwatch_project_ids"):
            raw["brandwatch_project_ids"] = pids
            cfg_path.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")
print("OK")
PY
  )"
  if [[ "${BW_MINT_STATUS}" == "NEEDS_PLATFORM_CLIENT_ID" ]]; then
    echo "Brandwatch /oauth/token returned HTTP 500 for '${BW_INPUT_USER}'."
    echo "Per Brandwatch API docs, multi-client (Organization Switching) accounts require platform_client_id."
    printf "Enter Brandwatch platform_client_id for '%s' (or press Enter to use a different API user): " "${BW_INPUT_USER}"
    read -r BW_PLATFORM_CID
    if [[ -n "${BW_PLATFORM_CID}" ]]; then
      BW_INPUT_USER="${BW_INPUT_USER}|${BW_PLATFORM_CID}"
    else
      printf "Enter single-client Regular/Admin Brandwatch API username (email): "
      read -r BW_INPUT_USER
      printf "Enter Brandwatch API password (hidden): "
      read -r -s BW_INPUT_PASS
      printf "\n"
    fi
    BW_INPUT_USER="${BW_INPUT_USER}" BW_INPUT_PASS="${BW_INPUT_PASS}" .venv/bin/python - <<'PY'
import os
import yaml
import httpx
from slrr_campaigns.auth import BRANDWATCH_BASE_URL, SecretStore, mint_brandwatch_token
from slrr_campaigns.config import load_config, resolve_config_path

cfg_path = resolve_config_path()
cfg = load_config(cfg_path)
secrets = SecretStore(cfg.gcp_project_id)
user = os.environ["BW_INPUT_USER"].strip()
pw = os.environ["BW_INPUT_PASS"]
token, _ = mint_brandwatch_token(user, pw)
secrets.write_secret(cfg.secrets.brandwatch_username, user)
secrets.write_secret(cfg.secrets.brandwatch_password, pw)
secrets.write_secret(cfg.secrets.brandwatch_token, token)

resp = httpx.get(
    f"{BRANDWATCH_BASE_URL}/projects",
    params={"pageSize": 100, "page": 0},
    headers={"Authorization": f"bearer {token}"},
    timeout=30.0,
)
if resp.status_code == 200:
    items = resp.json().get("results") or []
    pids = sorted({int(p["id"]) for p in items if isinstance(p, dict) and isinstance(p.get("id"), int)})
    if pids:
        raw = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
        if not raw.get("brandwatch_project_ids"):
            raw["brandwatch_project_ids"] = pids
            cfg_path.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")
PY
  fi
  BW_PROJECT_IDS="$(cfg_get brandwatch_project_ids)"
else
  echo "Brandwatch API token in Secret Manager is already valid (projects: ${BW_PROJECT_IDS})."
fi

echo "=== Step 7: Verifying Google User OAuth credentials ==="
if [[ -n "${OAUTH_CLIENT_JSON_ARG}" ]]; then
  .venv/bin/python -m scripts.authorize_user --client-secrets "${OAUTH_CLIENT_JSON_ARG}"
else
  .venv/bin/python -m scripts.authorize_user
fi

echo "=== Step 8: Bootstrapping Drive folder and Campaign Registry spreadsheet ==="
echo "Configured IDs before bootstrap: folder='${DRIVE_FOLDER_ID}' registry='${REGISTRY_SHEET_ID}'"
.venv/bin/python -m slrr_campaigns.service bootstrap
DRIVE_FOLDER_ID="$(cfg_get drive_folder_id)"
REGISTRY_SHEET_ID="$(cfg_get registry_spreadsheet_id)"
if [[ -z "${DRIVE_FOLDER_ID}" || -z "${REGISTRY_SHEET_ID}" ]]; then
  echo "FATAL: bootstrap did not populate drive_folder_id and registry_spreadsheet_id." >&2
  exit 1
fi
echo "Provisioned IDs: folder='${DRIVE_FOLDER_ID}' registry='${REGISTRY_SHEET_ID}'"

echo "=== Step 9: Running ./check.sh before Cloud Build and Cloud Run deploy ==="
./check.sh

echo "=== Step 10: Building image and deploying private Cloud Run service '${CLOUD_RUN_SERVICE}' ==="
AR_REPO="slrr-triage-agent"
if ! gcloud artifacts repositories describe "${AR_REPO}" \
  --location="${CLOUD_RUN_REGION}" \
  --project="${GCP_PROJECT}" >/dev/null 2>&1; then
  run_with_role "roles/artifactregistry.admin" \
    gcloud artifacts repositories create "${AR_REPO}" \
    --repository-format=docker \
    --location="${CLOUD_RUN_REGION}" \
    --project="${GCP_PROJECT}" \
    --description="SLRR Triage and Campaigns container images" \
    --labels="app=slrr-campaigns,datacloud=antigravity"
fi

IMAGE_TAG="$(
  .venv/bin/python - <<'PY'
import hashlib
from pathlib import Path

h = hashlib.sha256()
paths = [
    Path("Dockerfile.campaigns"),
    Path("pyproject.toml"),
    Path("README.md"),
    Path("config/campaigns.yaml"),
    Path("triage_agent/__init__.py"),
    Path("triage_agent/llm.py"),
    Path("triage_agent/qa/__init__.py"),
    Path("triage_agent/qa/record_key.py"),
    *sorted(p for p in Path("slrr_campaigns").rglob("*.py") if p.is_file()),
]
for p in paths:
    h.update(p.as_posix().encode("utf-8"))
    h.update(b"\0")
    h.update(p.read_bytes())
    h.update(b"\0")
print("sha-" + h.hexdigest()[:16])
PY
)"
IMAGE_URI="${CLOUD_RUN_REGION}-docker.pkg.dev/${GCP_PROJECT}/${AR_REPO}/${CLOUD_RUN_SERVICE}:${IMAGE_TAG}"

if gcloud artifacts docker images describe "${IMAGE_URI}" --project="${GCP_PROJECT}" >/dev/null 2>&1; then
  echo "Container image ${IMAGE_URI} already exists in Artifact Registry; skipping build."
else
  run_with_role "roles/cloudbuild.builds.editor" \
    gcloud builds submit "${ROOT}" \
    --project="${GCP_PROJECT}" \
    --region="${CLOUD_RUN_REGION}" \
    --config="${ROOT}/infra/cloudbuild.yaml" \
    --substitutions="_IMAGE=${IMAGE_URI},_DOCKERFILE=Dockerfile.campaigns"
fi

CURRENT_RUN_JSON="$(
  gcloud run services describe "${CLOUD_RUN_SERVICE}" \
    --project="${GCP_PROJECT}" \
    --region="${CLOUD_RUN_REGION}" \
    --format=json 2>/dev/null || echo "{}"
)"
NEEDS_RUN_DEPLOY="$(
  .venv/bin/python - "${IMAGE_URI}" "${RUNTIME_SA}" "${CURRENT_RUN_JSON}" <<'PY'
import json
import sys

want_img, want_sa, raw = sys.argv[1:4]
svc = json.loads(raw or "{}")
spec = ((svc.get("spec") or {}).get("template") or {}).get("spec") or {}
containers = spec.get("containers") or []
cur_img = containers[0].get("image") if containers else ""
cur_sa = spec.get("serviceAccountName") or ""
env_list = containers[0].get("env") or [] if containers else []
cur_cfg_env = next((e.get("value") for e in env_list if e.get("name") == "SLRR_CAMPAIGNS_CONFIG"), "")
ready = any(
    c.get("type") == "Ready" and c.get("status") == "True"
    for c in ((svc.get("status") or {}).get("conditions") or [])
)
if ready and cur_img == want_img and cur_sa == want_sa and cur_cfg_env == "/app/config/campaigns.yaml":
    print("no")
else:
    print("yes")
PY
)"
if [[ "${NEEDS_RUN_DEPLOY}" == "yes" ]]; then
  run_with_role "roles/run.admin" \
    gcloud run deploy "${CLOUD_RUN_SERVICE}" \
    --project="${GCP_PROJECT}" \
    --region="${CLOUD_RUN_REGION}" \
    --image="${IMAGE_URI}" \
    --service-account="${RUNTIME_SA}" \
    --no-allow-unauthenticated \
    --ingress=all \
    --memory=1Gi \
    --cpu=1 \
    --timeout=300 \
    --max-instances=3 \
    --concurrency=1 \
    --set-env-vars="SLRR_CAMPAIGNS_CONFIG=/app/config/campaigns.yaml" \
    --labels="app=slrr-campaigns,datacloud=antigravity" \
    --quiet
else
  echo "Cloud Run service ${CLOUD_RUN_SERVICE} already serves ${IMAGE_URI}; skipping deploy."
fi

SERVICE_URL="$(
  gcloud run services describe "${CLOUD_RUN_SERVICE}" \
    --project="${GCP_PROJECT}" \
    --region="${CLOUD_RUN_REGION}" \
    --format='value(status.url)'
)"

RUN_IAM_JSON="$(
  gcloud run services get-iam-policy "${CLOUD_RUN_SERVICE}" \
    --project="${GCP_PROJECT}" \
    --region="${CLOUD_RUN_REGION}" \
    --format=json
)"
has_invoker="$(
  .venv/bin/python - "roles/run.invoker" "serviceAccount:${SCHEDULER_SA}" "${RUN_IAM_JSON}" <<'PY'
import json
import sys

role, member, raw = sys.argv[1], sys.argv[2], sys.argv[3]
pol = json.loads(raw)
found = any(b.get("role") == role and member in (b.get("members") or []) for b in (pol.get("bindings") or []))
print("yes" if found else "no")
PY
)"
if [[ "${has_invoker}" != "yes" ]]; then
  run_with_role "roles/run.admin" \
    gcloud run services add-iam-policy-binding "${CLOUD_RUN_SERVICE}" \
    --project="${GCP_PROJECT}" \
    --region="${CLOUD_RUN_REGION}" \
    --member="serviceAccount:${SCHEDULER_SA}" \
    --role="roles/run.invoker" >/dev/null
fi

echo "=== Step 11: Creating or updating Cloud Scheduler OIDC jobs ==="
upsert_scheduler_job() {
  local job_name="$1" schedule="$2" path_suffix="$3" deadline="$4"
  local target_uri="${SERVICE_URL}${path_suffix}"
  local existing_json
  if existing_json="$(
    gcloud scheduler jobs describe "${job_name}" \
      --location="${CLOUD_RUN_REGION}" \
      --project="${GCP_PROJECT}" \
      --format=json 2>/dev/null
  )"; then
    local job_matches
    job_matches="$(
      .venv/bin/python - "${schedule}" "${target_uri}" "${deadline}" "${SCHEDULER_SA}" "${SERVICE_URL}" "${existing_json}" <<'PY'
import json
import sys

sched, uri, deadline, sa_email, aud, raw = sys.argv[1:7]
j = json.loads(raw)
ht = j.get("httpTarget") or {}
oidc = ht.get("oidcToken") or {}
same = (
    j.get("schedule") == sched
    and j.get("timeZone") == "America/New_York"
    and j.get("attemptDeadline") == deadline
    and j.get("state") == "ENABLED"
    and ht.get("uri") == uri
    and ht.get("httpMethod") == "POST"
    and oidc.get("serviceAccountEmail") == sa_email
    and oidc.get("audience") == aud
)
print("yes" if same else "no")
PY
    )"
    if [[ "${job_matches}" == "yes" ]]; then
      echo "Scheduler job ${job_name} already matches target configuration."
    else
      run_with_role "roles/cloudscheduler.admin" \
        gcloud scheduler jobs update http "${job_name}" \
        --location="${CLOUD_RUN_REGION}" \
        --project="${GCP_PROJECT}" \
        --schedule="${schedule}" \
        --time-zone="America/New_York" \
        --uri="${target_uri}" \
        --http-method=POST \
        --attempt-deadline="${deadline}" \
        --oidc-service-account-email="${SCHEDULER_SA}" \
        --oidc-token-audience="${SERVICE_URL}" \
        --quiet >/dev/null
      if [[ "$(gcloud scheduler jobs describe "${job_name}" --location="${CLOUD_RUN_REGION}" --project="${GCP_PROJECT}" --format='value(state)')" != "ENABLED" ]]; then
        run_with_role "roles/cloudscheduler.admin" \
          gcloud scheduler jobs resume "${job_name}" \
          --location="${CLOUD_RUN_REGION}" \
          --project="${GCP_PROJECT}" \
          --quiet >/dev/null
      fi
    fi
  else
    run_with_role "roles/cloudscheduler.admin" \
      gcloud scheduler jobs create http "${job_name}" \
      --location="${CLOUD_RUN_REGION}" \
      --project="${GCP_PROJECT}" \
      --schedule="${schedule}" \
      --time-zone="America/New_York" \
      --uri="${target_uri}" \
      --http-method=POST \
      --attempt-deadline="${deadline}" \
      --oidc-service-account-email="${SCHEDULER_SA}" \
      --oidc-token-audience="${SERVICE_URL}" \
      --quiet >/dev/null
  fi
}

upsert_scheduler_job "slrr-campaigns-tick" "* * * * *" "/tick" "180s"
upsert_scheduler_job "slrr-campaigns-hourly" "5 * * * *" "/hourly" "300s"
upsert_scheduler_job "slrr-campaigns-daily" "15 6 * * *" "/daily" "300s"

echo "=== Step 12: Warming 24h Brandwatch metadata cache and running live preflight ==="
PREFLIGHT_JSON="$(.venv/bin/python -m slrr_campaigns.service preflight)"

.venv/bin/python - "${PREFLIGHT_JSON}" "${SERVICE_URL}" "${RUNTIME_SA}" "${SCHEDULER_SA}" <<'PY'
import json
import sys
from slrr_campaigns.config import load_config

preflight = json.loads(sys.argv[1])
service_url, runtime_sa, scheduler_sa = sys.argv[2:5]
cfg = load_config()

rows = [
    ("GCP Project", "PASS", cfg.gcp_project_id),
    ("Chat OAuth Project", "PASS", cfg.chat_project_id),
    ("Cloud Run Service", "PASS", f"{cfg.cloud_run_service} ({service_url})"),
    ("Runtime Service Account", "PASS", runtime_sa),
    ("Scheduler Service Account", "PASS", scheduler_sa),
    ("Scheduler Jobs", "PASS", "slrr-campaigns-tick, slrr-campaigns-hourly, slrr-campaigns-daily"),
    ("Firestore Database", "PASS", cfg.firestore_database),
    ("Alerts Mirror Space Read", "PASS", f"{cfg.alerts_space} ({preflight['alerts_space_messages_read']} msgs)"),
    ("Chat Temp Space Write+Delete", "PASS", str(preflight["temp_space_verified_deleted"])),
    ("Docs Temp File Write+Delete", "PASS", str(preflight["temp_doc_verified_deleted"])),
    ("Drive Folder", "PASS", cfg.drive_folder_id),
    ("Campaign Registry Sheet", "PASS", cfg.registry_spreadsheet_id),
    ("KOF Reference Sheet", "PASS", cfg.kof_spreadsheet_id),
    ("Brandwatch Auth + Rate Headers", "PASS", f"user={preflight['brandwatch_user_id']} limit={preflight['brandwatch_rate_limit']} used={preflight['brandwatch_rate_used']}"),
    ("Vertex AI Gemini 3.8 Flash", "PASS", str(preflight["gemini_preflight_boolean"])),
    ("Gmail Partition Disjoint", "PASS", str(preflight["mailbox_email"])),
    ("People API User Lookup", "PASS", str(preflight["setup_user_id"])),
    ("BigQuery Mention Tables", "PASS", f"sundar_7d={preflight['bigquery_sundar_7d']} bw_total={preflight['bigquery_brandwatch_total']}"),
]

print("\n================ SLRR CAMPAIGNS SETUP & PREFLIGHT SUMMARY ================")
print(f"{'CHECK':<32} | {'STATUS':<6} | RESOURCE / DETAIL")
print("-" * 92)
for label, status, detail in rows:
    print(f"{label:<32} | {status:<6} | {detail}")
print("=" * 92)
PY
