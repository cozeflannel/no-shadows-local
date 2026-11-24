#!/usr/bin/env bash
# One command: everything the agent and the Console need on Google Cloud, in order. Safe to run again.
#
#   infra/deploy.sh [--project ID] [--region REGION] [--env dev|prod] [--agent-account ADDRESS]
#
# With no infra/.env, one is written from what gcloud already knows (the active project and account, the Cloud Run
# region) and the flags above; with one, it is used as it is and the flags update it. Nothing else is asked.
# Everything operational (spaces, rosters, recipients, switches, models, tables, topics) is set afterwards in the
# Console, whose Dashboard lists what is still missing.
set -euo pipefail

INFRA="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${INFRA}/.." && pwd)"
ENV_FILE="${INFRA}/.env"

PROJECT="" REGION_FLAG="" ENV_FLAG="" AGENT_ACCOUNT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --region) REGION_FLAG="$2"; shift 2 ;;
    --env) ENV_FLAG="$2"; shift 2 ;;
    --agent-account) AGENT_ACCOUNT="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option $1" >&2; exit 2 ;;
  esac
done

set_var() {  # set_var NAME VALUE: set an export line in infra/.env
  local name="$1" value="$2"
  if grep -q "^export ${name}=" "${ENV_FILE}"; then
    sed -i.bak -E "s|^export ${name}=.*|export ${name}=\"${value}\"|" "${ENV_FILE}" && rm -f "${ENV_FILE}.bak"
  else
    echo "export ${name}=\"${value}\"" >> "${ENV_FILE}"
  fi
}

ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
if [[ -z "${ACCOUNT}" ]]; then
  echo "Sign in first: gcloud auth login" >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
  REGION_FLAG="${REGION_FLAG:-$(gcloud config get-value run/region 2>/dev/null || true)}"
  if [[ -z "${PROJECT}" || -z "${REGION_FLAG}" ]]; then
    echo "Name the project and region: infra/deploy.sh --project ID --region REGION" >&2
    exit 1
  fi
  cp "${INFRA}/00_env.example" "${ENV_FILE}"
  set_var IAP_MEMBERS "user:${ACCOUNT}"
  echo "Wrote infra/.env for ${PROJECT} in ${REGION_FLAG}."
fi
[[ -n "${PROJECT}" ]] && set_var PROJECT_ID "${PROJECT}"
[[ -n "${REGION_FLAG}" ]] && set_var REGION "${REGION_FLAG}"
[[ -n "${ENV_FLAG}" ]] && set_var TRIAGE_ENV "${ENV_FLAG}"
[[ -n "${AGENT_ACCOUNT}" ]] && set_var TRIAGE_AGENT_ACCOUNT "${AGENT_ACCOUNT}"
# shellcheck source=/dev/null
source "${ENV_FILE}"
set_var PROJECT_NUMBER "$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
grep -q "^export BOOTSTRAP_ADMIN=" "${ENV_FILE}" || set_var BOOTSTRAP_ADMIN "${ACCOUNT}"   # the Console's first admin, until one is named there
grep -q "^export OWNER_ADMIN=" "${ENV_FILE}" || set_var OWNER_ADMIN "${ACCOUNT}"           # the Console's owner: always an admin, whatever People says

step() { echo; echo "== $1"; shift; "$@"; }

if [[ ! -x "${ROOT}/.venv/bin/python" ]]; then
  step "Python environment" python3 -m venv "${ROOT}/.venv"
  "${ROOT}/.venv/bin/pip" install --quiet --disable-pip-version-check -r "${ROOT}/requirements.txt"
fi

step "APIs" "${INFRA}/01_enable_apis.sh"
step "Service accounts and roles" "${INFRA}/02_service_accounts.sh"
step "Firestore" "${INFRA}/03_firestore.sh"
step "BigQuery" "${INFRA}/04_bigquery.sh"

# shellcheck source=/dev/null
source "${ENV_FILE}"
step "Agent Runtime" "${ROOT}/.venv/bin/python" "${INFRA}/05_deploy_agent_engine.py"
if [[ -z "${AGENT_RESOURCE:-}" && -f "${ROOT}/.local/agent_resource.txt" ]]; then
  set_var AGENT_RESOURCE "$(cat "${ROOT}/.local/agent_resource.txt")"
fi
step "Dataset access for the Agent Runtime" "${INFRA}/04_bigquery.sh"
step "Agent alerts: BigQuery connection and salt" "${INFRA}/11_own_alerts.sh"

step "Scheduled jobs" "${INFRA}/06_jobs.sh"
step "Console" "${INFRA}/07_console.sh"
step "Worker" "${INFRA}/09_worker.sh"

# shellcheck source=/dev/null
source "${ENV_FILE}"
step "Settings the deploy already knows" "${ROOT}/.venv/bin/python" "${INFRA}/10_seed_settings.py"

URL="$(gcloud run services describe "${CONSOLE_SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)')"
cat <<EOF

Done. Console: ${URL}
You (${ACCOUNT}) are its first admin. Open it: the Dashboard lists each setup step that is left, with a link.

Two things cannot be done from here:
  1. Gmail connect and the QA chatbot's Chat sign-in need a Google sign-in client, which Google only creates in the
     Cloud console. The steps are at the top of infra/08_gmail_oauth.sh; then run:
     infra/08_gmail_oauth.sh path/to/client_secret.json
  2. The Studio flows are built in Chat as the agent's account: flows/FLOW_SETUP.md

Agent alerts: what is left for a person is listed under "Agent alerts: BigQuery connection and salt" above.
EOF
