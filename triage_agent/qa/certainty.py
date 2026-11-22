"""The numbers shown and acted on for an alert. No model is asked to state one.

    Burson's score        Python: of the fields Burson filled in, how many stood up to the rulebook and the checks.
    chance of a fix       Gemini Decisions: the probability that a fix Gemini proposed is right. A fix is applied
                          without a person only at or above the bar in Settings; with no answer it waits for a person.
    chance of review      Gemini Decisions: the probability that a person needs to look at the alert.
    measured agreement    Python: per field, how often incident managers kept the app's value in their own assessments.

Gemini still judges and proposes (it reads the post and the documents). It no longer rates itself: a number a model
writes about its own certainty is not a measurement.
"""

from __future__ import annotations

import json
from collections import Counter
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from ..models import Correction, Issue, IssueSource, Severity

if TYPE_CHECKING:  # pragma: no cover
    from ..context import AgentContext

REVIEW = "review"


def burson_score(config: Any, received: list[str], corrections: list[Correction], issues: list[Issue]) -> dict[str, Any]:
    """Of the fields Burson filled in (`received`: their names), how many were right.

    wrong: a fix was applied to it, or a rule found a blocking problem with it. in_question: a fix is proposed or
    Gemini raised a problem, and a person has not decided yet. pct counts only what is settled:
    (filled - wrong) / filled. Five fields filled and three wrong is 40%."""
    filled = [f.name for f in config.alert_template.fields if f.name in set(received)]
    wrong = {c.field for c in corrections if c.applied and not c.reverted_by and c.field in filled}
    wrong |= {i.field for i in issues if i.severity == Severity.BLOCKING and i.source == IssueSource.RULE and i.field in filled}
    unsure = {c.field for c in corrections if not c.applied and not c.reverted_by and c.field in filled}
    unsure |= {i.field for i in issues if i.severity == Severity.BLOCKING and i.source == IssueSource.LLM and i.field in filled}
    unsure -= wrong
    n = len(filled)
    return {"filled": n, "right": n - len(wrong), "wrong": [f for f in filled if f in wrong], "in_question": [f for f in filled if f in unsure],
            "pct": round((n - len(wrong)) / n, 3) if n else None, "fields": filled}


def _noul(ask: str, yes: str, no: str) -> dict[str, Any]:
    return {"type": "noul", "instructions": ask, "criteria": {"true_description": yes, "false_description": no}}


def questions(config: Any, proposals: list[dict[str, Any]], complaints: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """What Gemini Decisions is asked about one alert: one question for each proposed fix ({key, field, old, new}),
    one for each problem Gemini raised ({key, finding}), and whether a person needs to look at it."""
    out: dict[str, dict[str, Any]] = {}
    for p in proposals:
        spec = config.alert_template.field(p["field"])
        label = spec.labels[0] if spec and spec.labels else p["field"].replace("_", " ")
        out[p["key"]] = _noul(f'In the alert in the input, should the {label} be "{p["new"]}" rather than "{p["old"]}"?',
                              f'"{p["new"]}" is the right {label} for the post the alert describes.',
                              f'"{p["old"]}" is right as written, or "{p["new"]}" is not the right {label}.')
    for c in complaints:
        out[c["key"]] = _noul(f'Is this problem with the alert in the input real: {c["finding"]}',
                              "The problem is real: the alert is wrong on this point.", "The alert is fine on this point.")
    out[REVIEW] = _noul("Does a person need to check the alert in the input before it is used?",
                        "A field is wrong, missing or not supported by the post, or it is unclear whether the alert should be sent.",
                        "Every field fits the post and the alert is ready to use.")
    return out


def alert_text(fields: dict[str, Any], limit: int) -> str:
    """The alert as Gemini Decisions is given it: its fields, without links, handles or ids."""
    from .. import decisions

    lines = {k: decisions.clean_text(v.isoformat() if hasattr(v, "isoformat") else v, 600) for k, v in fields.items() if v not in (None, "", [])}
    return json.dumps({k: v for k, v in lines.items() if v}, ensure_ascii=False)[:limit]


def judge(ctx: "AgentContext", fields: dict[str, Any], proposals: list[dict[str, Any]], complaints: list[dict[str, Any]]) -> dict[str, float]:
    """Gemini Decisions' probabilities for one alert, by key ({} when the switch is OFF or it gave no answer)."""
    from .. import decisions

    if not ctx.config.platform.flag("decisions_review"):
        return {}
    r = decisions.ask(ctx, alert_text(fields, ctx.config.platform.decisions.input_max_chars), questions(ctx.config, proposals, complaints),
                      purpose="triage.certainty")
    return {k: round(a["p"], 3) for k, a in r["answers"].items()} if r["ok"] else {}


def field_agreement(ctx: "AgentContext", days: int = 30) -> dict[str, Any]:
    """Per field, how often incident managers kept the app's value in their own assessments over the last `days`.
    Counted from the assessments people recorded; a field an IM corrected counts against it."""
    from ..events import PlatformEvent

    rows = ctx.events.query(since=ctx.now() - timedelta(days=days), types=[PlatformEvent.ASSESSMENT_RECORDED], limit=20000)
    total = len(rows)
    corrected = Counter(f for e in rows for f in ((e.payload or {}).get("fields") or []))
    names = [f.name for f in ctx.config.alert_template.fields]
    return {"days": days, "assessments": total,
            "fields": {n: {"kept": total - corrected[n], "of": total, "rate": round((total - corrected[n]) / total, 3)} for n in names} if total else {}}
