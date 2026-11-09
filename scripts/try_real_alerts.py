"""Run the 3 real Burson V3 alerts from your transcript through the agent and write out the HTML email preview.

Usage:
    PYTHONPATH=. .venv/bin/python -m scripts.try_real_alerts
"""

import os
from pathlib import Path

os.environ.setdefault("TRIAGE_BACKEND", "local")
os.environ.setdefault("TRIAGE_LOCAL_DB", ".local/real_test.db")
os.environ.setdefault("TRIAGE_LLM", "vertex")
os.environ.setdefault("TRIAGE_GMAIL", "fake")

from triage_agent.context import build_context
from triage_agent.escalation import drafting
from triage_agent.operations import handle
from tests.test_production_artifacts import (
    BURSON_ALERT_1_P1_AIO,
    BURSON_ALERT_2_P2_MAPS,
    BURSON_ALERT_3_P0_PARIS,
)


def main() -> None:
    db_file = Path(".local/real_test.db")
    if db_file.exists():
        db_file.unlink()
    ctx = build_context()
    out_dir = Path(".local/email_previews")
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1. Simulate natural shift sign-in in the Burson space
    print("\n=== 1. Natural Shift Sign-In in Burson Space ===")
    signin = handle(
        {
            "op": "triage_message",
            "payload": {
                "message": {
                    "message_id": "real-signin-1",
                    "space_id": "AAQAaa_0I9g",
                    "sender": {"name": "Adrija Chakraborty", "email": ""},
                    "text": "Hi team, I will be on alerts from 12pm to 6pm PST",
                }
            },
        },
        ctx,
    )
    print("Summary:", signin.outputs["summary"])
    print("Active Burson On-Call:", ctx.burson_on_call().person.name)

    # 2. Triage all 3 real Burson V3 alerts
    for idx, (label, text) in enumerate(
        [
            ("Alert 1 (P1 AI Overviews)", BURSON_ALERT_1_P1_AIO),
            ("Alert 2 (P2 Maps Meme)", BURSON_ALERT_2_P2_MAPS),
            ("Alert 3 (P0 Search Paris Riots)", BURSON_ALERT_3_P0_PARIS),
        ],
        start=1,
    ):
        print(f"\n=== 2.{idx} Triaging {label} ===")
        res = handle(
            {
                "op": "triage_message",
                "payload": {
                    "message": {
                        "message_id": f"real-burson-{idx}",
                        "space_id": "AAQAaa_0I9g",
                        "sender": {
                            "name": "Agency Analyst",
                            "email": "analyst@agency.test",
                        },
                        "text": text,
                    }
                },
            },
            ctx,
        )
        case_id = res.outputs["case_id"]
        print(f"Case ID: {case_id} | Verdict: {res.outputs['verdict']}")
        print("\n--- Clean Space Post (sent to Google Analysts) ---")
        print(res.outputs["clean_text"])

        # 3. Simulate analyst reacting 📦 (or auto-draft on P0) to generate the Social Alert Email + T&S prefill
        case = ctx.store.get_case(case_id)
        subj = drafting.subject_for(ctx, case)
        html = drafting.render_alert_html(ctx, case)
        preview_file = out_dir / f"{case_id}_social_alert.html"
        preview_file.write_text(html, encoding="utf-8")
        print(f"\n--- Generated Social Alert Email ({case_id}) ---")
        print("Subject:", subj)
        print("HTML Preview written to:", preview_file.resolve())

    # 4. Simulate analyst reacting ✍️ on the P0 alert for Trust & Safety
    print("\n=== 3. Analyst Reacts ✍️ (Trust & Safety) on TRG-1003 ===")
    tns_res = handle(
        {
            "op": "record_reaction",
            "payload": {
                "emoji": "✍️",
                "user": {
                    "email": "im@ops.test",
                    "name": "Incident Manager",
                },
                "message": {"text": "TRG-1003", "space_id": "clean-space"},
            },
        },
        ctx,
    )
    print(tns_res.outputs["reply_text"])


if __name__ == "__main__":
    main()
