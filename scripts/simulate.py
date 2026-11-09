"""Local end-to-end simulation of the Workspace Studio flows (no Chat, no GCP).

  .venv/bin/python -m scripts.simulate                # offline (simulated Gemini, fake Gmail)
  .venv/bin/python -m scripts.simulate --live         # real Gemini on Vertex AI
  .venv/bin/python -m scripts.simulate --db .local/demo.db   # then open the Agent Console on that DB

Each step calls the same operation a Studio custom step would call and prints
what that flow's "Post in a space" / "Send a message" / "Reply" steps would post.
"""

import argparse
import os
import sys
import textwrap
from datetime import datetime, timedelta, timezone
from pathlib import Path

os.environ.setdefault("TRIAGE_LLM", "fake")
os.environ.setdefault("TRIAGE_GMAIL", "fake")

from triage_agent.config import load_config  # noqa: E402
from triage_agent.context import AgentContext  # noqa: E402
from triage_agent.events import SqliteEventLogger  # noqa: E402
from triage_agent.llm import FakeLLM, get_llm  # noqa: E402
from triage_agent.metrics import KPI_DEFINITIONS, compute_kpis  # noqa: E402
from triage_agent.models import ChatMessage, ChatUser  # noqa: E402
from triage_agent.operations import handle, registered_operations  # noqa: E402
from triage_agent.outbox import NoopDoorbell  # noqa: E402
from triage_agent.store import SqliteStore  # noqa: E402

START = datetime(2026, 10, 12, 18, 0, tzinfo=timezone.utc)  # Mon 2:00 pm ET (AMER late shift)
BURSON = {
    "space_id": "spaces/AAQAaa_0I9g",
    "space_name": "[S-F] Burson Automated Alerts V3",
}
CLEAN = {"space_name": "SLRR Triaged Alerts"}
TARGETS = (
    "reply",
    "burson",
    "clean",
    "dm",
    "youtube",
    "doodle",
    "team",
    "crisis",
    "handover",
)

ALERTS = {
    "good": """🚨 Burson Automated Alert
Alert Name: [HIGH ENGAGEMENT] [NEW] Gemini App – Users report fabricated citations in research answers
Issue Name: Gemini fabricates academic citations
Issue Status: NEW
Total Engagement: 2450
Likes: 2000
Comments: 300
Shares: 150
Product: Gemini App
Social Network: X
Exposure Tag: Product - Factual inaccuracies (not dangerous/offensive)
KOF: No
Author: @techwatcher
Followers: 152,300
Post Date: 2026-10-12T13:05:00Z
Location: US
View Post: https://x.com/techwatcher/status/1845123456789012345
Summary: User claims Gemini fabricated three academic sources in a research answer.
Post Content: Asked Gemini for sources on microplastics research and it invented three papers.""",
    "urgent": """🚨 Burson Automated Alert
This alert meets P0 criteria
Alert Name: [URGENT] [NEW] Gems – Gemini gives unsafe medication dosage advice
Issue Name: Gemini gives unsafe medication dosage advice
Issue Status: NEW
Total Engagement: 3140
Likes: 2900
Comments: 200
Shares: 40
Product: Gems
Social Network: Reddit
Exposure Tag: Product - Factual inaccuracies (not dangerous/offensive)
Risk Tags: Medical Content / Medical Misinformation
KOF: Yes
KOF Lists: P0 KOFs
Author: @drhealthwatch
Followers: 410,000
Post Date: 2026-10-12T17:41:00Z
Location: US
View Post: https://x.com/drhealthwatch/status/1845999999999999999
Summary: A physician KOF shows a Gem recommending a dangerous ibuprofen dose for a child.
Post Content: I asked a Gemini Gem about ibuprofen for my 4 year old and it suggested 3x the safe dose. Screenshot of my prompt attached.""",
    "meme": """🚨 Burson Automated Alert
Alert Name: [HIGH ENGAGEMENT] [NEW] Pixel – Pixel camera meme
Issue Name: Pixel camera meme
Total Engagement: 310
Likes: 300
Comments: 10
Shares: 0
Product: Pixel
Social Network: X
Exposure Tag: Product - Meme about Google products
Author: @memer
View Post: https://x.com/memer/status/1845000000000000001
Post Content: when your pixel camera makes the moon look like a potato""",
    "review": """🚨 Burson Automated Alert
Alert Name: [HIGH ENGAGEMENT] [NEW] Gemini App – Gemini refuses to summarize court rulings
Issue Name: Gemini refuses to summarize court rulings
Issue Status: NEW
Total Engagement: 2610
Likes: 2300
Comments: 210
Shares: 100
Product: Gemini App
Social Network: X
Exposure Tag: Product - Factual inaccuracies (not dangerous/offensive)
KOF: No
Author: @lawprof_amy
Followers: 88,000
Post Date: 2026-10-12T13:40:00Z
Location: US
View Post: https://x.com/lawprof_amy/status/1845333333333333333
Summary: A law professor says Gemini refused to summarize rulings from one political party's appointees.
Post Content: Gemini summarized rulings by judges appointed by one party but refused for the other. Why?""",
    "no_link": """🚨 Burson Automated Alert
Alert Name: [URGENT] [NEW] Waymo – Rider says car blocked an ambulance
Issue Name: Waymo vehicle blocks ambulance
Total Engagement: 50
Likes: 50
Comments: 0
Shares: 0
Product: Waymo
Social Network: X
Exposure Tag: Product - Product failures - physical safety issues
Risk Tags: Violence / Weapons
Author: @sfresident
Post Content: A Waymo just sat in the middle of the road while an ambulance tried to get by""",
}


class SimClock:
    def __init__(self) -> None:
        self.now = START

    def __call__(self) -> datetime:
        return self.now


def simulated_gemini() -> FakeLLM:
    checks = [
        "exposure_tag_fit",
        "product_fit",
        "sensitive_topics_fit",
        "kof_fit",
        "issue_name_neutral",
        "summary_grammar",
    ]

    def assess(call):
        prompt = call["prompt"]
        out = [{"id": c, "ok": True, "confidence": 0.95} for c in checks]
        enrichment = {}
        if "court rulings" in prompt:  # Gemini isn't sure: proposal -> IM review
            out[0] = {
                "id": "exposure_tag_fit",
                "ok": False,
                "confidence": 0.74,
                "finding": "claims of political bias",
                "proposed_value": "Product - Perceived bias",
            }
        if "ibuprofen" in prompt:
            out[0] = {
                "id": "exposure_tag_fit",
                "ok": False,
                "confidence": 0.93,
                "finding": "harmful medical dosage advice",
                "proposed_value": "Product - Dangerous results (e.g. medical/legal)",
            }
            enrichment = {"ts_evidence": "input_shown"}
        return {"checks": out, "enrichment": enrichment}

    fake = FakeLLM(default_text="I don't know.")
    fake.on("triage.assess", assess)
    fake.on("triage.parse_fallback", {"looks_like_alert": True, "fields": []})
    fake.on(
        "escalation.draft_email",
        lambda call: {
            "subject": "",
            "body": "Bottom line: see the alert details below.",
            "notes": [],
        },
    )
    fake.on(
        "escalation.revise_email",
        lambda call: {
            "subject": "",
            "notes": [],
            "body": "Bottom line: a physician KOF (410K followers) shows a Gemini Gem recommending 3x the safe pediatric "
            "ibuprofen dose; 3,140 engagements and climbing. T&S urgent report filed.",
        },
    )
    fake.on(
        "tns.assess",
        {
            "eligible": True,
            "category": "Dangerous content",
            "criteria_ids": ["product_abuse", "viral_kof"],
            "rationale": "Harmful dosage output with the prompt shown",
            "evidence": "input_shown",
            "description": "Gemini Gem recommended a dangerous pediatric ibuprofen dose.",
        },
    )
    return fake


def show(step: str, resp, quiet: bool = False) -> None:
    print(f"\n━━ {step} ━━  ok={resp.ok} {resp.outputs.get('summary', '')}")
    if resp.error:
        print(f"   error: {resp.error}")
    if quiet:
        return
    for t in TARGETS:
        key = f"{t}_text"
        if resp.outputs.get(f"has_{t}") == "yes":
            who = f" → {resp.outputs['dm_recipients']}" if t == "dm" else ""
            print(f"  [{t}{who}]")
            print(textwrap.indent(resp.outputs[key], "    "))


def chat(
    text: str,
    sender="Zapier",
    email=None,
    space=BURSON,
    mid=None,
    now=START,
    kind="BOT",
    conv="SPACE",
) -> dict:
    return ChatMessage(
        message_id=mid,
        text=text,
        sender=ChatUser(name=sender, email=email, type=kind),
        create_time=now,
        conversation_type=conv,
        **space,
    ).model_dump(mode="json")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=".local/sim.db")
    ap.add_argument("--live", action="store_true")
    args = ap.parse_args(argv)
    db = Path(args.db)
    if db.exists():
        db.unlink()
    store = SqliteStore(db)
    clock = SimClock()
    ctx = AgentContext(
        config=load_config(store),
        store=store,
        events=SqliteEventLogger(db),
        llm=get_llm() if args.live else simulated_gemini(),
        now=clock,
        doorbell=NoopDoorbell(),
    )
    try:
        from triage_agent.escalation.gmail import FakeGmail

        ctx.gmail = FakeGmail(connect_all=True)
    except Exception:  # noqa: BLE001 - escalation workstream not built yet
        ctx.gmail = None
    ops = set(registered_operations())
    im = ctx.im_on_shift().person.email
    print(
        f"Simulating {START:%a %Y-%m-%d %H:%M} UTC · IM on shift: {im} · Burson on-call: {ctx.burson_on_call().person.email}"
    )
    print(f"Operations available: {', '.join(sorted(ops))}")

    flow1 = {
        "flow": "burson_alerts",
        "targets": ["burson", "clean", "dm", "youtube", "doodle"],
    }
    ids = {}
    later = {"review"}  # posted later in the day (review queue demo)
    for i, (name, text) in enumerate([(n, t) for n, t in ALERTS.items() if n not in later], start=1):
        clock.now = START + timedelta(minutes=i)
        r = handle(
            {
                "op": "triage_message",
                "payload": {"message": chat(text, mid=f"burson-{name}", now=clock.now)},
                "context": flow1,
            },
            ctx,
        )
        ids[name] = r.outputs.get("case_id")
        show(f"Flow 1 · Burson alert '{name}'", r)

    if "record_reaction" in ops:
        flow2 = {"flow": "im_actions", "targets": ["reply", "dm", "crisis"]}
        clean_text = store.get_case(ids["urgent"]).alert_name or ids["urgent"]
        for emoji in ("👍", "📦", "✍️", "⚖️"):
            clock.now += timedelta(minutes=1)
            r = handle(
                {
                    "op": "record_reaction",
                    "payload": {
                        "emoji": emoji,
                        "user": {"email": im, "name": "IM"},
                        "message": chat(
                            f"🤖 *{clean_text}* · {ids['urgent']}",
                            sender="Triage Agent",
                            space=CLEAN,
                            now=clock.now,
                        ),
                    },
                    "context": flow2,
                },
                ctx,
            )
            show(f"Flow 2 · IM reacts {emoji} on {ids['urgent']}", r)
    else:
        print("\n(skip Flow 2: record_reaction not built yet)")

    flow3a = {"flow": "mentions", "targets": ["reply", "dm"]}
    flow3b = {"flow": "dms", "targets": ["reply", "dm"]}
    esc = next(iter(store.list_escalations(case_id=ids["urgent"])), None) if ids.get("urgent") else None
    if "converse" in ops and esc:
        clock.now += timedelta(minutes=1)
        r = handle(
            {
                "op": "converse",
                "payload": {
                    "message": chat(
                        f"@Triage Agent revise {ids['urgent']}: shorter, lead with the KOF",
                        sender="IM",
                        email=im,
                        space=CLEAN,
                        kind="HUMAN",
                        mid="clean-thread-revise",
                        now=clock.now,
                    )
                },
                "context": flow3a,
            },
            ctx,
        )
        show(f"Flow 3a · IM in the alert thread: revise {ids['urgent']}", r)
        alert_email = store.get_escalation(esc.escalation_id).email_for("alert")
        if alert_email and alert_email.draft_id and ctx.gmail is not None:
            clock.now += timedelta(minutes=2)
            ctx.gmail.mark_sent(alert_email.draft_id, sent_at=clock.now)
            print(
                f"\n━━ Gmail · {im} sends the revised Social Alert from Brand Social ({clock.now:%H:%M} UTC) ━━"
            )
            clock.now += timedelta(minutes=1)
            r = handle(
                {
                    "op": "run_followups",
                    "payload": {"steps": ["sent"]},
                    "context": {"deliver": "outbox", "flow": "job"},
                },
                ctx,
            )
            show("Job · run_followups: Gmail sent detection", r, quiet=True)

    if "converse" in ops:
        flow3 = flow3b
        for text in ("who's on shift?", "how many alerts were corrected today?"):
            clock.now += timedelta(minutes=1)
            r = handle(
                {
                    "op": "converse",
                    "payload": {
                        "message": chat(
                            text,
                            sender="IM",
                            email=im,
                            space={"space_name": None},
                            kind="HUMAN",
                            conv="DM",
                            now=clock.now,
                        )
                    },
                    "context": flow3,
                },
                ctx,
            )
            show(f"Flow 3 · DM: {text!r}", r)

    clock.now += timedelta(minutes=1)
    r = handle(
        {
            "op": "triage_message",
            "payload": {"message": chat(ALERTS["review"], mid="burson-review", now=clock.now)},
            "context": flow1,
        },
        ctx,
    )
    ids["review"] = r.outputs.get("case_id")
    show("Flow 1 · Burson alert 'review' (Gemini unsure about the tag)", r)
    if "converse" in ops and r.outputs.get("verdict") == "NEEDS_REVIEW":
        clock.now += timedelta(minutes=2)
        r = handle(
            {
                "op": "converse",
                "payload": {
                    "message": chat(
                        f"forward {ids['review']} exposure_tag=Product - Perceived bias",
                        sender="IM",
                        email=im,
                        space={"space_name": None},
                        kind="HUMAN",
                        conv="DM",
                        mid="dm-forward",
                        now=clock.now,
                    )
                },
                "context": {**flow3b, "targets": ["reply", "dm", "clean"]},
            },
            ctx,
        )
        show(f"Flow 3b · IM DMs: forward {ids['review']} with the bias tag", r)

    clock.now += timedelta(minutes=4)
    fixed = ALERTS["no_link"].replace(
        "Post Content:",
        "View Post: https://x.com/sfresident/status/1845000000000000777\nPost Content:",
    )
    r = handle(
        {
            "op": "triage_message",
            "payload": {"message": chat(fixed, mid="burson-no_link-rerun", now=clock.now)},
            "context": flow1,
        },
        ctx,
    )
    show(
        f"Flow 1 · Burson reruns the bounced alert with the link (same case {ids['no_link']}?)",
        r,
    )

    if "converse" in ops:
        clock.now += timedelta(minutes=1)
        r = handle(
            {
                "op": "converse",
                "payload": {
                    "message": chat(
                        f"@Triage Agent status {ids['no_link']}",
                        sender="Jane Doe",
                        email="analyst@agency.test",
                        kind="HUMAN",
                        mid="burson-question",
                        now=clock.now,
                    )
                },
                "context": {"flow": "mentions", "targets": ["burson", "dm"]},
            },
            ctx,
        )
        show("Flow 3a · Burson asks in the Burson space (external-safe answer)", r)
        clock.now += timedelta(minutes=1)
        r = handle(
            {
                "op": "converse",
                "payload": {
                    "message": chat(
                        "remember that Doodle questions go to the Doodle Team",
                        sender="IM",
                        email=im,
                        space={"space_name": None},
                        kind="HUMAN",
                        conv="DM",
                        mid="dm-teach",
                        now=clock.now,
                    )
                },
                "context": flow3b,
            },
            ctx,
        )
        show("Flow 3b · IM teaches the agent (pending lead approval)", r)

    if "ingest_email" in ops and ids.get("urgent"):
        esc = next(iter(store.list_escalations(case_id=ids["urgent"])), None)
        if esc:
            flow4 = {
                "flow": "agent_inbox",
                "targets": ["clean", "dm", "youtube", "doodle"],
            }
            clock.now += timedelta(minutes=30)
            ref = ctx.config.tns.reference_format.format(
                escalation_id=esc.escalation_id, case_id=ids["urgent"]
            )
            for subject, body in (
                (
                    f"Issue [4821337]: WD Intake Request",
                    f"Thanks for your report. {ref}",
                ),
                (
                    "Re: Issue [4821337]: WD Intake Request",
                    "Status: Fixed. Tracked in b/398112345.",
                ),
            ):
                r = handle(
                    {
                        "op": "ingest_email",
                        "payload": {
                            "subject": subject,
                            "body": body,
                            "from_email": "watchdog@tns.test",
                            "received_at": clock.now.isoformat(),
                        },
                        "context": flow4,
                    },
                    ctx,
                )
                show(f"Flow 4 · email '{subject}'", r)

    clock.now += timedelta(minutes=1)
    r = handle(
        {
            "op": "run_followups",
            "payload": {"steps": ["sla", "reviews", "burson", "sent", "sla_misses"]},
            "context": {"deliver": "outbox", "flow": "job"},
        },
        ctx,
    )
    show(f"Job · run_followups ({clock.now:%H:%M} UTC)", r, quiet=True)
    for n in range(1, 6):
        d = handle({"op": "drain_outbox", "context": {"flow": "outbox"}}, ctx)
        if not d.data.get("delivered_ids"):
            break
        show(f"Flow 5 · Outbox drain #{n}", d)

    k = compute_kpis(ctx.events.query(), config=ctx.config)
    print("\n━━ KPIs (as on the Console Overview) ━━")
    for key in (
        "alerts_received",
        "forwarded_without_edits",
        "auto_corrected",
        "sent_back_for_edits",
        "burson_reruns_passed",
        "suppressed",
        "needs_review",
        "review_forwarded",
        "emails_drafted",
        "emails_returned_for_edits",
        "emails_redrafted",
        "emails_sent",
        "sla_met",
        "sla_missed",
        "tns_prepared",
        "tns_submitted",
        "tns_fixed",
        "questions_answered",
        "protocol_pings",
        "sla_at_risk",
    ):
        label = KPI_DEFINITIONS[key][0] if key in KPI_DEFINITIONS else key
        print(f"  {label:<30} {k['kpis'].get(key, 0)}")
    d = k["derived"]
    print(f"  {'Corrections by field':<30} {d['corrections_by_field']}")
    for key in ("post_to_send_min", "flag_to_send_min", "time_to_correction_min"):
        v = d.get(key) or {}
        if v.get("n"):
            print(f"  {key:<30} avg {v['avg']} min (n={v['n']})")
    print(f"\nState written to {db} (point the Agent Console at it with TRIAGE_LOCAL_DB={db}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
