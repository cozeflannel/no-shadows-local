"""Eval harness: does the agent decide like an Incident Manager?

  .venv/bin/python -m evals.run_evals                 # offline (FakeLLM: rules + simulated Gemini answers)
  .venv/bin/python -m evals.run_evals --live          # real Gemini on Vertex AI (GOOGLE_CLOUD_PROJECT)
  .venv/bin/python -m evals.run_evals --json out.json # machine-readable report

Golden files: evals/golden/*.yaml and evals/golden/real/*.yaml (see collection_requirements.yaml).
"""

import argparse
import json
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import yaml

from triage_agent.cases import HISTORY_START_KEY
from triage_agent.config import load_config
from triage_agent.context import AgentContext
from triage_agent.events import SqliteEventLogger
from triage_agent.llm import FakeLLM, get_llm
from triage_agent.models import Case, CaseStatus, ChatMessage, ChatUser
from triage_agent.operations import handle
from triage_agent.outbox import NoopDoorbell
from triage_agent.qa.requirements import issue_tokens
from triage_agent.store import SqliteStore

GOLDEN_DIR = Path(__file__).parent / "golden"
NOW = datetime(2026, 10, 12, 18, 0, tzinfo=timezone.utc)
CHECK_IDS = ["exposure_tag_fit", "product_fit", "sensitive_topics_fit", "kof_fit", "issue_name_neutral", "summary_grammar"]


def load_cases(paths: list[Path] | None = None) -> list[dict[str, Any]]:
    files = paths or sorted(GOLDEN_DIR.glob("*.yaml")) + sorted((GOLDEN_DIR / "real").glob("*.yaml"))
    cases = []
    for path in files:
        doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        defaults = doc.get("defaults", {})
        for case in doc.get("cases", []):
            fields = {**defaults, **(case.get("alert") or {})}
            cases.append({**case, "fields": fields, "file": path.name})
    return cases


def render_alert(config, fields: dict[str, Any], n: int) -> str:
    tpl = config.alert_template
    fields = dict(fields)
    if "post_url" not in fields:
        fields["post_url"] = f"https://x.com/evalauthor/status/1845{n:015d}"
    lines = ["🚨 Burson Automated Alert"]
    for name, value in fields.items():
        spec = tpl.field(name)
        if spec is None or value is None:
            continue
        if isinstance(value, list):
            value = ", ".join(str(v) for v in value)
        lines.append(f"{spec.labels[0]}: {value}")
    return "\n".join(lines)


def fake_llm_for(case: dict[str, Any]) -> FakeLLM:
    overrides = case.get("llm") or {}

    def respond(call):
        return {"checks": [{"id": c, "ok": True, "confidence": 0.95, **overrides.get(c, {})} for c in CHECK_IDS],
                "enrichment": overrides.get("enrichment", {})}

    return FakeLLM().on("triage.assess", respond)


def build_ctx(tmp: Path, llm) -> AgentContext:
    store = SqliteStore(tmp / "eval.db")
    ctx = AgentContext(config=load_config(store), store=store, events=SqliteEventLogger(tmp / "eval.db"), llm=llm,
                       now=lambda: NOW, doorbell=NoopDoorbell())
    store.put_kv(HISTORY_START_KEY, {"at": (NOW - timedelta(days=60)).isoformat()})
    return ctx


def seed_history(ctx: AgentContext, history: list[dict[str, Any]]) -> None:
    for i, h in enumerate(history or []):
        posted = NOW - timedelta(minutes=h.get("posted_minutes_ago", 60))
        tokens = issue_tokens(h.get("issue_name"), ctx.config.collection.issue_stopwords)
        ctx.store.save_case(Case(
            case_id=f"HIST-{i + 1}", record_key=f"history/{i}", status=CaseStatus.VERIFIED, source="burson_chat",
            exposure_tag=h.get("exposure_tag"), issue_name=h.get("issue_name"), issue_fingerprint=" ".join(tokens),
            product=h.get("product", "Gemini App"), clean_posted_at=posted, created_at=posted, updated_at=posted,
        ))


def evaluate_case(case: dict[str, Any], n: int, live: bool) -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as tmp:
        ctx = build_ctx(Path(tmp), get_llm() if live else fake_llm_for(case))
        seed_history(ctx, case.get("history"))
        text = render_alert(ctx.config, case["fields"], n)
        msg = ChatMessage(message_id=f"eval-{n}", text=text, sender=ChatUser(name="Zapier", type="BOT"),
                          space_id="spaces/AAQAaa_0I9g", create_time=NOW)
        resp = handle({"op": "triage_message", "payload": {"message": msg.model_dump(mode="json")}}, ctx)
        got: dict[str, Any] = {"verdict": resp.outputs.get("verdict"), "error": resp.error}
        result = None
        if resp.outputs.get("case_id"):
            c = ctx.store.get_case(resp.outputs["case_id"])
            result = c.latest.result
            a = result.assessment
            got.update({
                "track": a.track if a else None, "issue_status": a.issue_status if a else None,
                "suppression_reason": a.suppression_reason if a else None, "alert_action": a.alert_action if a else None,
                "ts_recommended": a.ts_recommended if a else None, "actions": a.suggested_actions if a else [],
                "protocols": sorted(p for p, on in (("youtube", resp.outputs.get("has_youtube") == "yes"),
                                                    ("doodle", resp.outputs.get("has_doodle") == "yes"),
                                                    ("leadership", bool(a and a.leadership_protocol))) if on),
                "corrections": {x.field: x.new for x in result.applied_corrections},
            })
    failures = []
    for key, want in (case.get("expect") or {}).items():
        have = got.get(key)
        if key == "corrections":
            bad = {f: (v, (have or {}).get(f)) for f, v in want.items() if str((have or {}).get(f)) != str(v)}
            if bad:
                failures.append(f"corrections {bad}")
        elif key in ("protocols", "actions"):
            missing = [x for x in want if x not in (have or [])]
            if missing:
                failures.append(f"{key}: missing {missing} (have {have})")
        elif have != want:
            failures.append(f"{key}: want {want!r}, got {have!r}")
    return {"id": case["id"], "file": case["file"], "description": case.get("description", ""), "ok": not failures,
            "failures": failures, "got": got}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--live", action="store_true", help="call Gemini on Vertex AI instead of simulated answers")
    ap.add_argument("--json", help="write the report to this file")
    ap.add_argument("files", nargs="*", type=Path)
    args = ap.parse_args(argv)
    results = [evaluate_case(c, i, args.live) for i, c in enumerate(load_cases(args.files or None), start=1)]
    passed = sum(r["ok"] for r in results)
    for r in results:
        mark = "✅" if r["ok"] else "❌"
        print(f"{mark} {r['id']:<32} {r['description']}")
        for f in r["failures"]:
            print(f"     ↳ {f}")
    print(f"\n{passed}/{len(results)} golden cases match the IM decision ({'live Gemini' if args.live else 'offline'})")
    if args.json:
        Path(args.json).write_text(json.dumps({"passed": passed, "total": len(results), "results": results}, indent=2, default=str))
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
