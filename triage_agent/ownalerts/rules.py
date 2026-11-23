"""The rules agent alerts checks each new post against.

A rule is mandatory (a post that meets it goes straight to review, and the review cannot turn it down) or a candidate
(Gemini reads the post against the rule first). Rules are kept in the store, which the Console reads, and copied to
BigQuery (`policy_rules_config`), where the procedure joins every new post to them. A copy that fails is made again
before the next run.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, Field

from ..events import PlatformEvent
from . import schema, sources

if TYPE_CHECKING:
    from ..context import AgentContext

RULES = "own_rules"
STATE = "own:rules"  # {pending: the copy in BigQuery is behind the store}
MODES = ("HARD_MANDATE", "SOFT_CANDIDATE")
LISTS = ("target_sources", "platforms", "required_keywords_any", "required_keywords_all", "excluded_keywords")
COLUMNS = ("rule_name", "process_doc_section", "execution_mode", "target_sources", "platforms", "require_kof", "min_followers", "min_engagements",
           "required_keywords_any", "required_keywords_all", "excluded_keywords", "forced_severity", "forced_escalation_path", "active", "updated_by")


class Rule(BaseModel):
    rule_id: str
    rule_name: str
    process_doc_section: str = ""
    execution_mode: Literal["HARD_MANDATE", "SOFT_CANDIDATE"]
    target_sources: list[str] = Field(default_factory=list)  # blank = every source
    platforms: list[str] = Field(default_factory=list)       # blank = every platform
    require_kof: bool = False
    min_followers: int = 0
    min_engagements: int = 0
    required_keywords_any: list[str] = Field(default_factory=list)
    required_keywords_all: list[str] = Field(default_factory=list)
    excluded_keywords: list[str] = Field(default_factory=list)
    forced_severity: str = ""          # blank = the review sets it
    forced_escalation_path: str = ""   # blank = the review sets it
    active: bool = True
    updated_by: str = ""
    updated_at: datetime


def _tidy(values: Any, lower: bool = False) -> list[str]:
    out: list[str] = []
    for value in values or []:
        item = str(value or "").strip()
        item = item.lower() if lower else item
        if item and item not in out:
            out.append(item)
    return out


def _checked(ctx: "AgentContext", data: dict[str, Any]) -> dict[str, Any]:
    """The rule as it will be kept, or a ValueError that says what to change."""
    own = ctx.config.platform.own_alerts
    name = str(data.get("rule_name") or "").strip()
    if not name:
        raise ValueError("Give the rule a name.")
    mode = str(data.get("execution_mode") or "").strip().upper()
    if mode not in MODES:
        raise ValueError("A rule is either mandatory (HARD_MANDATE) or a candidate Gemini reads the post for (SOFT_CANDIDATE).")
    out: dict[str, Any] = {"rule_name": name[:120], "process_doc_section": str(data.get("process_doc_section") or "").strip()[:200],
                           "execution_mode": mode, "require_kof": bool(data.get("require_kof")), "active": bool(data.get("active", True))}
    for field, what in (("min_followers", "followers"), ("min_engagements", "engagements")):
        try:
            number = int(data.get(field) or 0)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"The fewest {what} must be a whole number.") from exc
        if number < 0:
            raise ValueError(f"The fewest {what} cannot be below zero.")
        out[field] = number
    for field in LISTS:
        out[field] = _tidy(data.get(field), lower=field == "platforms")
    out["platforms"] = _tidy(["x" if p == "twitter" else p for p in out["platforms"]])
    known = {s.system for s in sources.listing(ctx)}
    for source in out["target_sources"]:
        if source not in known:
            raise ValueError(f"Agent alerts reads no source called {source}. The sources it reads: {', '.join(sorted(known)) or 'none yet'}.")
    severity, path = str(data.get("forced_severity") or "").strip(), str(data.get("forced_escalation_path") or "").strip()
    if severity and severity not in own.severities:
        raise ValueError(f"The severity a rule sets must be one of the severities under Settings, Agent alerts ({', '.join(own.severities)}), or blank.")
    if path and path not in own.escalation_paths:
        raise ValueError(f"The path a rule sets must be one of the escalation paths under Settings, Agent alerts ({', '.join(own.escalation_paths)}), or blank.")
    out.update(forced_severity=severity, forced_escalation_path=path)
    narrows = (out["required_keywords_any"] or out["required_keywords_all"] or out["require_kof"] or out["min_followers"] or out["min_engagements"]
               or out["target_sources"] or out["platforms"])
    if not narrows:
        raise ValueError("A rule needs at least one condition (words, a KOF author, followers, engagements, a source or a platform): "
                         "without one it would match every post.")
    return out


def list_rules(ctx: "AgentContext") -> list[Rule]:
    out = [Rule.model_validate(r) for r in ctx.store.list_docs(RULES, limit=2000)]
    out.sort(key=lambda r: (r.rule_name.lower(), r.rule_id))
    return out


def get(ctx: "AgentContext", rule_id: str) -> Rule | None:
    row = ctx.store.get_doc(RULES, rule_id)
    return Rule.model_validate(row) if row else None


def pending(ctx: "AgentContext") -> bool:
    return bool((ctx.store.get_kv(STATE) or {}).get("pending"))


def mark_pending(ctx: "AgentContext", value: bool = True) -> None:
    ctx.store.put_kv(STATE, {"pending": value})


def _params(rule: Rule) -> dict[str, Any]:
    data = rule.model_dump()
    return {"rule_id": rule.rule_id, **{c: data[c] for c in COLUMNS}}


def _merge(ctx: "AgentContext", gw: Any, rule: Rule) -> None:
    sets = ", ".join(f"{c} = @{c}" for c in COLUMNS)
    sql = (f"MERGE `{schema.table(ctx, 'policy_rules_config')}` T\nUSING (SELECT @rule_id AS rule_id) S ON T.rule_id = S.rule_id\n"
           f"WHEN MATCHED THEN UPDATE SET {sets}, updated_at = CURRENT_TIMESTAMP()\n"
           f"WHEN NOT MATCHED THEN INSERT (rule_id, {', '.join(COLUMNS)}) VALUES (@rule_id, {', '.join('@' + c for c in COLUMNS)})")
    gw.query(sql, _params(rule), location=ctx.config.platform.bigquery.location or None, labels=schema.LABELS)


def save(ctx: "AgentContext", actor: str, data: dict[str, Any]) -> Rule:
    """Creates a rule, or changes the one whose id is given."""
    from .. import bq_admin

    fields = _checked(ctx, data)
    rule_id = str(data.get("rule_id") or "").strip()
    if rule_id and ctx.store.get_doc(RULES, rule_id) is None:
        raise ValueError("That rule is no longer there.")
    same = next((r for r in list_rules(ctx) if r.rule_name.lower() == fields["rule_name"].lower() and r.rule_id != rule_id), None)
    if same is not None:  # an alert names its rule: two rules with one name could not be told apart
        raise ValueError(f"Another rule is already called {same.rule_name}.")
    rule = Rule(rule_id=rule_id or f"rule-{uuid.uuid4().hex[:12]}", updated_by=actor, updated_at=ctx.now(), **fields)
    ctx.store.put_doc(RULES, rule.rule_id, rule.model_dump(mode="json"))
    try:
        _merge(ctx, bq_admin.get_gateway(ctx), rule)
    except Exception:  # noqa: BLE001 - the rule is kept; the next run copies it before any post is checked
        mark_pending(ctx)
    ctx.emit(PlatformEvent.OWN_RULE_SAVED, actor=actor, space="console",
             payload={"rule_id": rule.rule_id, "name": rule.rule_name, "mode": rule.execution_mode, "active": rule.active})
    return rule


def delete(ctx: "AgentContext", actor: str, rule_id: str) -> bool:
    from .. import bq_admin

    if ctx.store.get_doc(RULES, rule_id) is None:
        return False
    ctx.store.delete_doc(RULES, rule_id)
    try:
        bq_admin.get_gateway(ctx).query(f"DELETE FROM `{schema.table(ctx, 'policy_rules_config')}` WHERE rule_id = @rule_id", {"rule_id": rule_id},
                                        location=ctx.config.platform.bigquery.location or None, labels=schema.LABELS)
    except Exception:  # noqa: BLE001 - the next run's sweep removes the row
        mark_pending(ctx)
    ctx.emit(PlatformEvent.OWN_RULE_SAVED, actor=actor, space="console", payload={"rule_id": rule_id, "removed": True})
    return True


def sync(ctx: "AgentContext") -> int:
    """Makes BigQuery's copy match the store: rows for rules that are gone are removed, every rule is written."""
    from .. import bq_admin

    gw = bq_admin.get_gateway(ctx)
    kept = list_rules(ctx)
    gw.query(f"DELETE FROM `{schema.table(ctx, 'policy_rules_config')}` WHERE rule_id NOT IN UNNEST(@ids)", {"ids": [r.rule_id for r in kept]},
             location=ctx.config.platform.bigquery.location or None, labels=schema.LABELS)
    for rule in kept:
        _merge(ctx, gw, rule)
    mark_pending(ctx, False)
    return len(kept)


def sync_if_pending(ctx: "AgentContext") -> None:
    if pending(ctx):
        sync(ctx)
