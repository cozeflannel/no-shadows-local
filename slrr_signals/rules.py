"""Track 1's deterministic rules (no LLM): what may go to Gemini at all.

In order, for each landed post:
1. Exclusions (config/default_config.yaml collection.exclusions and patterns): Google used as a verb, Drive links,
   spam; skipped when a risk signal (Sensitive Topic language) is present. Comparisons and benchmarks need judgment:
   Gemini and the Collection Requirements engine handle them.
2. Previously reported: the same post alerted in the last 14 days (issue_history) never goes again.
3. The urgent track (0 engagement is enough): Sensitive Topic language (track1.sensitive_keywords, or the taxonomy
   table's sensitive_keyword rows) or a source's own Sensitive Topic tag, a KOF author (kof_list, or the source's
   KOF lists), or a P0 hint (a source tag naming a P0 exposure tag, or track1.p0_keywords).
4. Otherwise the 2K+ track: track1.high_engagement engagements or more.
Everything else stops here (logged as not passed, never sent to Gemini or the chat).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .settings import Settings

KNOWN_EXCLUSIONS = {"google_as_verb", "drive_link", "spam", "ai_comparison", "benchmark"}


def norm(s: Any) -> str:
    """A tag name compared loosely: lower case, dashes alike, single spaces, no 'risk - ' prefix."""
    t = re.sub(r"[\u2013\u2014]", "-", str(s or "").lower())
    t = re.sub(r"\s+", " ", t).strip()
    return re.sub(r"^risk\s*-\s*", "", t)


def norm_handle(s: Any) -> str:
    return str(s or "").strip().lstrip("@").lower()


@dataclass
class RuleResult:
    passed: bool
    track: str  # urgent | 2k | none
    reasons: list[str] = field(default_factory=list)
    sensitive: list[str] = field(default_factory=list)
    p0_hint: bool = False
    is_kof: bool = False
    previously_reported: bool = False
    previous_alert_id: str | None = None


class Rules:
    def __init__(self, settings: Settings, agent_cfg: Any, taxonomy: list[dict[str, Any]] | None = None,
                 kof_handles: list[str] | None = None, history: list[dict[str, Any]] | None = None):
        col = agent_cfg.collection
        taxonomy = taxonomy or []
        self.patterns = {k: re.compile(v, re.I) for k, v in (col.patterns or {}).items()}
        self.exclusions = {e.id: e for e in (col.exclusions or []) if getattr(e, "enabled", True)}
        self.high = int(settings.get("track1.high_engagement", col.high_engagement_threshold or 2000))
        kw_rows = [r for r in taxonomy if r.get("kind") == "sensitive_keyword" and r.get("is_on", True) and r.get("value")]
        kws = {str(r["name"]): str(r["value"]) for r in kw_rows} or dict(settings.get("track1.sensitive_keywords", {}) or {})
        self.sensitive = {name: re.compile(rx, re.I) for name, rx in kws.items()}
        p0_rows = [str(r["value"]) for r in taxonomy if r.get("kind") == "p0_keyword" and r.get("is_on", True) and r.get("value")]
        p0 = "|".join(f"(?:{x})" for x in p0_rows) or str(settings.get("track1.p0_keywords", "") or "")
        self.p0_rx = re.compile(p0, re.I) if p0 else None
        # every tag's priority by its loose name (the taxonomy table when it has tags, else the playbook config)
        self.priority_of: dict[str, str] = {}
        tag_rows = [r for r in taxonomy if r.get("kind") == "tag" and r.get("is_on", True)]
        if tag_rows:
            for r in tag_rows:
                for n in [r.get("name"), *(r.get("also_known_as") or [])]:
                    if n:
                        self.priority_of[norm(n)] = str(r.get("priority") or "")
        else:
            for t in col.exposure_tags or []:
                for n in [t.name, *(t.aliases or [])]:
                    self.priority_of[norm(n)] = t.priority
            for s in col.sensitive_topics or []:
                for n in [s.name, *(s.aliases or [])]:
                    self.priority_of[norm(n)] = "Sensitive"
        self.kof = {norm_handle(h) for h in (kof_handles or []) if h}
        self.history = {str(r["record_key"]): str(r.get("alert_id") or "") for r in (history or []) if r.get("record_key")}

    def exclusion(self, text: str, risk: bool) -> str | None:
        p = self.patterns
        if not risk:
            if "google_as_verb" in self.exclusions and p.get("google_verb") and p["google_verb"].search(text):
                return "EXCLUDED_GOOGLE_AS_VERB"
            if "drive_link" in self.exclusions and p.get("drive_link") and p["drive_link"].search(text):
                return "EXCLUDED_DRIVE_LINK"
            if "spam" in self.exclusions and ((p.get("spam") and p["spam"].search(text))
                                              or len(re.findall(r"https?://", text)) >= 4 or text.count("#") >= 12):
                return "EXCLUDED_SPAM"
        for e in self.exclusions.values():
            if e.id in KNOWN_EXCLUSIONS or not e.pattern:
                continue
            if re.search(e.pattern, text, re.I) and not (e.unless_risk_keywords and risk):
                return f"EXCLUDED_{e.id.upper()}"
        return None

    def evaluate(self, m: dict[str, Any]) -> RuleResult:
        text = "\n".join(str(m.get(k) or "") for k in ("title", "text", "summary")).lower()
        tags = [str(t) for t in (m.get("source_tags") or [])]
        sensitive = [name for name, rx in self.sensitive.items() if rx.search(text)]
        sensitive_tags = [t for t in tags if self.priority_of.get(norm(t)) == "Sensitive"]
        risk = bool(sensitive or sensitive_tags)
        excl = self.exclusion(text, risk)
        if excl:
            return RuleResult(False, "none", [excl], sensitive)
        prev = self.history.get(str(m.get("mention_key") or ""))
        if prev is not None:
            return RuleResult(False, "none", ["PREVIOUSLY_REPORTED"], sensitive, previously_reported=True,
                              previous_alert_id=prev or None)
        is_kof = bool(m.get("kof_lists")) or (norm_handle(m.get("author")) in self.kof if m.get("author") else False)
        p0_tags = [t for t in tags if self.priority_of.get(norm(t)) == "P0"]
        p0_hint = bool(p0_tags) or bool(self.p0_rx and self.p0_rx.search(text))
        reasons = [f"SENSITIVE_KEYWORD:{s}" for s in sensitive] + [f"SENSITIVE_TAG:{t}" for t in sensitive_tags[:2]]
        if is_kof:
            reasons.append("KOF")
        if p0_hint:
            reasons.append(f"P0_HINT:{p0_tags[0]}" if p0_tags else "P0_HINT:keyword")
        if risk or is_kof or p0_hint:
            return RuleResult(True, "urgent", reasons, sensitive + sensitive_tags, p0_hint, is_kof)
        if int(m.get("engagement") or 0) >= self.high:
            return RuleResult(True, "2k", [*reasons, "HIGH_ENGAGEMENT"], sensitive, p0_hint, is_kof)
        return RuleResult(False, "none", ["BELOW_THRESHOLD"], sensitive, p0_hint, is_kof)
