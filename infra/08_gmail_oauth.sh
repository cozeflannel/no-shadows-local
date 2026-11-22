#!/usr/bin/env bash
# Google sign-in client for the Console: "Connect Gmail" for each person, and "Sign in as the QA chatbot" for Chat.
#
# The QA chatbot's account signs in once (Integrations -> Google Chat) so the Console can read and post in Chat as that
# account, the way the sheet-based bot does. It asks for: chat.messages.readonly, chat.messages.create,
# chat.messages.reactions.create, chat.spaces.readonly, chat.memberships.readonly. Its token is kept in Secret Manager
# under its own name. The same client and the same redirect URI below serve both sign-ins.
#
# Each Incident Manager connects their own Gmail once (scopes: gmail.compose + gmail.metadata) so the agent can
# create Social Alert drafts in their mailbox (From: the Brand Social send-as alias) and see when they're sent.
# The Triage Agent account connects too (scope: gmail.send) if the outbox doorbell is "email".
# Refresh tokens live in Secret Manager (one secret per person, gmail-token-<sha256>), never in Firestore.
#
# OAuth web clients can't be created from the CLI, so:
#   1. Cloud console -> Google Auth Platform -> Branding: app name "SLRR Triage Agent", audience **Internal**.
#   2. Data access: add .../auth/gmail.compose, .../auth/gmail.metadata, .../auth/gmail.send, and the five
#      .../auth/chat.* permissions listed above.
#   3. Clients: open a Web application client the project already has, or Create client -> Web application.
#      (Not a Desktop client, and not the one IAP uses.) Authorized redirect URIs:
#        <Console URL from 07_console.sh>/api/gmail/callback
#        http://localhost:8000/api/gmail/callback          (local development, optional)
#   4. Download the JSON, then run:  infra/08_gmail_oauth.sh path/to/client_secret.json
#   5. APIs & Services -> Google Chat API -> Configuration: fill App name, Avatar URL and Description, save.
#      Reading Chat as a signed-in account works without this page; posting and adding emojis do not.
#
# Idempotent: re-running adds a new secret version (the Console always reads "latest").
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

CLIENT_JSON="${1:-}"
if [[ -z "${CLIENT_JSON}" || ! -f "${CLIENT_JSON}" ]]; then
  sed -n '2,24p' "$0"
  echo
  echo "Usage: infra/08_gmail_oauth.sh path/to/client_secret.json" >&2
  exit 1
fi
python3 - "${CLIENT_JSON}" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
web = data.get("web")
if not web:
    sys.exit("This is not a *Web application* OAuth client JSON (missing the 'web' key).")
uris = web.get("redirect_uris") or []
print("Redirect URIs in the client:", *uris, sep="\n  ")
if not any(u.endswith("/api/gmail/callback") for u in uris):
    sys.exit("Add <Console URL>/api/gmail/callback as an authorized redirect URI, download the JSON again, re-run.")
PY

if gcloud secrets describe "${OAUTH_CLIENT_SECRET}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud secrets versions add "${OAUTH_CLIENT_SECRET}" --project="${PROJECT_ID}" --data-file="${CLIENT_JSON}" >/dev/null
  echo "Added a new version of ${OAUTH_CLIENT_SECRET}"
else
  gcloud secrets create "${OAUTH_CLIENT_SECRET}" --project="${PROJECT_ID}" --replication-policy=automatic \
    --labels=app=slrr-triage-agent --data-file="${CLIENT_JSON}" >/dev/null
  echo "Created ${OAUTH_CLIENT_SECRET}"
fi
gcloud secrets add-iam-policy-binding "${OAUTH_CLIENT_SECRET}" --project="${PROJECT_ID}" \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor --quiet >/dev/null

cat <<EOF

Done. Delete the downloaded client_secret JSON from your laptop.
Next: each IM opens the Agent Console -> "Connect Gmail" (one time). If the doorbell is "email", sign in to the
Console as the Triage Agent account (${TRIAGE_AGENT_ACCOUNT}) and connect its mailbox too: the Console asks that
account for gmail.send only (it must have IAP access: add it to IAP_MEMBERS).
EOF
