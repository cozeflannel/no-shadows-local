"""Generate the Workspace Studio add-on manifest + step constants from the Python contract.

  .venv/bin/python studio-addon/build_manifest.py          # writes appsscript.json and Steps.gs
  .venv/bin/python studio-addon/build_manifest.py --check  # exit 1 if the files are stale (CI / tests)

Every step returns all STUDIO_OUTPUT_KEYS as STRING outputs (docs/CONTRACTS.md §3, §13).
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))

from triage_agent.models import STUDIO_OUTPUT_KEYS  # noqa: E402

LOGO = "https://www.gstatic.com/images/icons/material/system/1x/fact_check_black_48dp.png"

OUTPUT_DESCRIPTIONS = {
    "has_reply": "yes/no: run 'Reply to a message' (clean space / DM only)",
    "reply_text": "Thread reply text",
    "has_burson": "yes/no: post in the Burson space",
    "burson_text": "Text for the Burson space (Notify space members ON)",
    "has_clean": "yes/no: post in the clean triage space",
    "clean_text": "Text for the clean triage space",
    "has_dm": "yes/no: send a direct message",
    "dm_text": "Direct message text",
    "dm_recipients": "Comma-separated DM recipients",
    "has_youtube": "yes/no: post in [S-F] YouTube Social",
    "youtube_text": "Text for [S-F] YouTube Social",
    "has_doodle": "yes/no: post in the Doodle Team space",
    "doodle_text": "Text for the Doodle Team space",
    "has_team": "yes/no: post in the 24/7 SL team chat",
    "team_text": "Text for the 24/7 SL team chat",
    "has_crisis": "yes/no: post in the crisis chat",
    "crisis_text": "Text for the crisis chat",
    "has_handover": "yes/no: append to the Handover doc",
    "handover_text": "Text to append to the Handover doc",
    "case_id": "Alert case id (TRG-…)",
    "escalation_id": "Escalation id (ESC-…)",
    "verdict": "Triage verdict / case status",
    "summary": "What the agent did (one line)",
}

COMMON = [
    {"id": "targets", "label": "Targets this flow can post to (constant)", "hint": "e.g. burson,clean,dm,youtube,doodle", "mode": "PLAIN_TEXT"},
    {"id": "flow", "label": "Flow name (constant, for logs)", "hint": "e.g. burson_alerts", "mode": "PLAIN_TEXT"},
]

# id, display name, op, description, inputs (id, label, required, mode)
STEPS = [
    {
        "id": "triage_alert", "name": "Triage Agent: Triage alert", "op": "triage_message",
        "description": "QA a Burson alert against the SLRR Collection Requirements and return what to post.",
        "inputs": [
            {"id": "message_text", "label": "Message text", "required": True, "mode": "RICH_TEXT"},
            {"id": "sender_name", "label": "Sender name"}, {"id": "sender_email", "label": "Sender email"},
            {"id": "space", "label": "Space (id or name)"}, {"id": "message_id", "label": "Message id"},
            {"id": "message_link", "label": "Message link"}, {"id": "thread_id", "label": "Thread id"},
            {"id": "sent_at", "label": "Sent at"},
        ],
    },
    {
        "id": "record_reaction", "name": "Triage Agent: Record reaction", "op": "record_reaction",
        "description": "Carry out the IM emoji-legend action (📦 draft, ✍️ T&S, 📰 💬 … teams, 🔥, ❌, 👍, 👎).",
        "inputs": [
            {"id": "emoji", "label": "Emoji", "required": True}, {"id": "reactor_email", "label": "Reactor email", "required": True},
            {"id": "reactor_name", "label": "Reactor name"}, {"id": "message_text", "label": "Reacted message text", "mode": "RICH_TEXT"},
            {"id": "message_id", "label": "Reacted message id"}, {"id": "message_link", "label": "Reacted message link"},
            {"id": "space", "label": "Space (id or name)"},
        ],
    },
    {
        "id": "converse", "name": "Triage Agent: Converse", "op": "converse",
        "description": "Answer a question or act on a command sent to the Triage Agent (mention or DM).",
        "inputs": [
            {"id": "message_text", "label": "Message text", "required": True, "mode": "RICH_TEXT"},
            {"id": "sender_name", "label": "Sender name"}, {"id": "sender_email", "label": "Sender email", "required": True},
            {"id": "space", "label": "Space (id or name; empty for DMs)"}, {"id": "conversation_type", "label": "SPACE or DM"},
            {"id": "message_id", "label": "Message id"}, {"id": "message_link", "label": "Message link"},
            {"id": "thread_id", "label": "Thread id"},
        ],
    },
    {
        "id": "ingest_email", "name": "Triage Agent: Ingest email", "op": "ingest_email",
        "description": "Process WD intake / outcome emails and Watchdog Anti-Abuse Alerts.",
        "inputs": [
            {"id": "subject", "label": "Subject", "required": True}, {"id": "from", "label": "From"},
            {"id": "to", "label": "To"}, {"id": "cc", "label": "Cc"},
            {"id": "body", "label": "Body", "required": True, "mode": "RICH_TEXT"}, {"id": "message_id", "label": "Message id"},
            {"id": "thread_id", "label": "Thread id"}, {"id": "received_at", "label": "Received at"},
            {"id": "link", "label": "Email link"},
        ],
    },
    {
        "id": "deliver_outbox", "name": "Triage Agent: Deliver outbox", "op": "drain_outbox",
        "description": "Deliver queued posts (SLA nudges, reminders, handovers, digests, Console decisions).",
        "inputs": [],
    },
    {
        "id": "record_post", "name": "Triage Agent: Record post", "op": "record_post",
        "description": "Optional: remember the message id/link of a clean-space post for reaction lookups.",
        "inputs": [
            {"id": "case_id", "label": "Case id (TRG-…)", "required": True}, {"id": "message_id", "label": "Posted message id"},
            {"id": "message_link", "label": "Posted message link"},
        ],
    },
]

INSPECT = {
    "id": "inspect_variables", "name": "Triage Agent: Inspect variables (Phase 0)", "op": None,
    "description": "Phase 0 spike: log up to 8 starter variables to the Activity log to learn their exact names and formats.",
    "inputs": [{"id": f"var{i}", "label": f"Variable {i}", "mode": "RICH_TEXT"} for i in range(1, 9)],
}


def _string(id_: str, description: str) -> dict:
    return {"id": id_, "description": description, "cardinality": "SINGLE", "dataType": {"basicType": "STRING"}}


def camel(step_id: str) -> str:
    return "".join(part.capitalize() for part in step_id.split("_"))


def manifest() -> dict:
    elements = []
    for step in STEPS + [INSPECT]:
        inputs = step["inputs"] + (COMMON if step["op"] else [])
        outputs = [_string(k, OUTPUT_DESCRIPTIONS[k]) for k in STUDIO_OUTPUT_KEYS] if step["op"] else [
            _string("summary", "Logged variables (JSON)")]
        elements.append({
            "id": step["id"], "state": "ACTIVE", "name": step["name"], "description": step["description"],
            "workflowAction": {
                "inputs": [_string(i["id"], i["label"]) for i in inputs],
                "outputs": outputs,
                "onConfigFunction": f"onConfig{camel(step['id'])}",
                "onExecuteFunction": f"onExecute{camel(step['id'])}",
            },
        })
    return {
        "timeZone": "America/New_York",
        "exceptionLogging": "STACKDRIVER",
        "runtimeVersion": "V8",
        "oauthScopes": [
            "https://www.googleapis.com/auth/cloud-platform",
            "https://www.googleapis.com/auth/script.external_request",
            "https://www.googleapis.com/auth/userinfo.email",
        ],
        "urlFetchWhitelist": ["https://*.googleapis.com/"],
        "addOns": {
            "common": {"name": "SLRR Triage Agent", "logoUrl": LOGO, "useLocaleFromApp": True},
            "flows": {"workflowElements": elements},
        },
    }


def steps_gs() -> str:
    defs = {s["id"]: {"op": s["op"], "name": s["name"], "inputs": s["inputs"] + COMMON} for s in STEPS}
    defs[INSPECT["id"]] = {"op": None, "name": INSPECT["name"], "inputs": INSPECT["inputs"]}
    lines = [
        "// GENERATED by studio-addon/build_manifest.py from triage_agent.models — do not edit by hand.",
        f"var OUTPUT_KEYS = {json.dumps(list(STUDIO_OUTPUT_KEYS))};",
        f"var STEP_DEFS = {json.dumps(defs, indent=2, ensure_ascii=False)};",
        "",
    ]
    for step in STEPS + [INSPECT]:
        c = camel(step["id"])
        lines.append(f"function onConfig{c}(e) {{ return buildConfigCard_('{step['id']}'); }}")
        lines.append(f"function onExecute{c}(e) {{ return executeStep_('{step['id']}', e); }}")
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    files = {ROOT / "appsscript.json": json.dumps(manifest(), indent=2, ensure_ascii=False) + "\n", ROOT / "Steps.gs": steps_gs()}
    stale = [p.name for p, content in files.items() if not p.exists() or p.read_text(encoding="utf-8") != content]
    if args.check:
        if stale:
            print("stale:", ", ".join(stale))
            return 1
        print("up to date")
        return 0
    for path, content in files.items():
        path.write_text(content, encoding="utf-8")
    print("wrote", ", ".join(p.name for p in files))
    return 0


if __name__ == "__main__":
    sys.exit(main())
