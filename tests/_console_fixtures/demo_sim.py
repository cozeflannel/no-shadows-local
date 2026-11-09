"""Simulator core for the demo seed: deterministic ids/events, alert specs, assessments and triage results.

Everything random comes from one seeded `random.Random`, so the same (seed, now, days)
always produces the same data. Event and state changes are only recorded when they
happen before `now`; later steps of a lifecycle simply haven't happened yet.
"""

from __future__ import annotations

import math
import random
import string
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Callable
from urllib.parse import parse_qsl, urlencode, urlsplit
from zoneinfo import ZoneInfo

from triage_agent.config import AgentConfig
from triage_agent.events import EventType as E
from triage_agent.models import (
    AgentEvent,
    AlertAssessment,
    Case,
    ChatMessage,
    ChatUser,
    Correction,
    Escalation,
    Issue,
    IssueSource,
    OutboxItem,
    Person,
    Roster,
    Severity,
    TriageResult,
    Verdict,
)
from triage_agent.oncall.roster import resolve_on_call
from triage_agent.render import fmt_value
from triage_agent.routing import plan_recipients, suggest_actions

from . import demo_data as D

CHECKS_RUN = ["parse", "field_rules", "cross_field_rules", "reference_lists", "llm_assess", "collection_requirements"]
VERDICT_EVENTS = {
    Verdict.PASS: E.TRIAGE_PASSED, Verdict.CORRECTED: E.TRIAGE_CORRECTED, Verdict.FAIL: E.TRIAGE_FAILED,
    Verdict.NEEDS_REVIEW: E.TRIAGE_NEEDS_REVIEW, Verdict.SUPPRESSED: E.TRIAGE_SUPPRESSED,
}
MESSAGE_LABELS = [
    ("Alert Name", "alert_name"), ("Issue Name", "issue_name"), ("Issue Status", "issue_status"),
    ("Engagement Level", "engagement_level"), ("Total Engagement", "total_engagement"), ("Likes", "likes"),
    ("Comments", "comments"), ("Shares", "shares"), ("Views", "views"), ("Product", "product"),
    ("Other Products", "other_products"), ("Social Network", "social_network"), ("Exposure Tag", "exposure_tag"),
    ("Priority", "priority"), ("Risk Tags", "risk_tags"), ("KOF", "kof"), ("T&S", "ts"), ("Author", "author"),
    ("Followers", "followers"), ("Post Date", "post_date"), ("Location", "location"), ("View Post", "post_url"),
    ("Summary", "summary"), ("Post Content", "post_content"),
]
TRACKING_PARAMS = ("utm_", "s", "t", "ref", "si", "igsh", "fbclid")


@dataclass
class Spec:
    """One planned alert, before it becomes a Case."""

    source: str
    received: datetime
    tpl: dict
    outcome: str  # PASS | CORRECTED | SUPPRESSED | FAIL | NEEDS_REVIEW
    platform: str = "X"
    handle: str = ""
    url: str = ""
    record_key: str = ""
    location: str = "US"
    is_kof: bool = False
    total: int = 0
    followers: int = 0
    detect_s: float = 1800.0
    latency_ms: int = 3000
    issue_status: str = "NEW"
    related: "Spec | None" = None
    suppression: str | None = None
    fail_mode: str | None = None
    fail_resolution: str | None = None  # rerun | abandon
    review_decision: str | None = None  # forward | bounce | suppress
    decision_delay_min: float = 15.0
    force: dict = field(default_factory=dict)
    parity: str | None = None  # matched | burson_only | inhouse_only
    counterpart: "Spec | None" = None
    tag_override: str | None = None  # in-house disagreement with Burson
    product_override: str | None = None
    source_ref: str | None = None
    case_id: str | None = None
    case: Case | None = None


class Sim:
    """Shared state + helpers for one seeding run."""

    def __init__(self, cfg: AgentConfig, now: datetime, days: int, seed: int, next_id: Callable[[str], str]):
        self.cfg = cfg
        self.now = now
        self.days = days
        self.start = now - timedelta(days=days)
        self.rng = random.Random(seed)
        self.tz = ZoneInfo(cfg.timezone)
        self.next_id = next_id
        self.config_version = cfg.config_version()
        self.events: list[AgentEvent] = []
        self.cases: dict[str, Case] = {}
        self.specs: list[Spec] = []
        self.escalations: dict[str, Escalation] = {}
        self.outbox: list[OutboxItem] = []
        self.rosters: dict[str, Roster] = {}
        self.gmail_connected: set[str] = set()
        self.leadership_pinged: dict[str, datetime] = {}
        burson = cfg.space("burson")
        self.burson_space_id = (burson.space_id if burson and burson.space_id else "spaces/BURSON").removeprefix("spaces/")
        self.burson_space_name = burson.display_name if burson else "Burson"

    # -- randomness -------------------------------------------------------------
    def uid(self) -> str:
        return str(uuid.UUID(int=self.rng.getrandbits(128), version=4))

    def token(self, n: int, alphabet: str = string.ascii_letters + string.digits) -> str:
        return "".join(self.rng.choice(alphabet) for _ in range(n))

    def digits(self, n: int) -> str:
        return self.token(n, string.digits)

    def chance(self, p: float) -> bool:
        return self.rng.random() < p

    def pick(self, weighted: list[tuple[Any, float]]) -> Any:
        total = sum(w for _, w in weighted)
        x = self.rng.uniform(0, total)
        for value, w in weighted:
            x -= w
            if x <= 0:
                return value
        return weighted[-1][0]

    def loguniform(self, lo: float, hi: float) -> float:
        return math.exp(self.rng.uniform(math.log(lo), math.log(hi)))

    def poisson(self, lam: float) -> int:
        limit, k, p = math.exp(-lam), 0, 1.0
        while True:
            p *= self.rng.random()
            if p <= limit:
                return k
            k += 1

    def after(self, t: datetime, lo_s: float, hi_s: float) -> datetime:
        return t + timedelta(seconds=self.rng.uniform(lo_s, hi_s))

    # -- time + events -------------------------------------------------------------
    def ok(self, t: datetime | None) -> bool:
        return t is not None and t < self.now

    def emit(self, t: datetime, event_type: str, **fields: Any) -> bool:
        if not self.ok(t):
            return False
        self.events.append(AgentEvent(event_id=self.uid(), event_ts=t, event_type=event_type, env=self.cfg.env,
                                      config_version=self.config_version, **fields))
        return True

    def enqueue(self, t: datetime, target: str, text: str, *, recipients: list[str] | None = None, case_id: str | None = None,
                escalation_id: str | None = None, source: str = "agent", delay_s: float | None = None) -> OutboxItem | None:
        """Queue an outbox item at t; it's delivered delay_s later (if that's before now)."""
        if not self.ok(t):
            return None
        delivered = t + timedelta(seconds=self.rng.uniform(4, 45) if delay_s is None else delay_s)
        done = self.ok(delivered)
        item = OutboxItem(
            outbox_id=f"OBX-{self.token(12, '0123456789abcdef')}", target=target, text=text, recipients=recipients or [],  # type: ignore[arg-type]
            case_id=case_id, escalation_id=escalation_id, source=source, created_at=t,
            delivered_at=delivered if done else None, delivered_by=f"outbox-flow-{self.token(6).lower()}" if done else None,
            env=self.cfg.env,
        )
        self.outbox.append(item)
        if done:
            self.emit(delivered, E.OUTBOX_DELIVERED, space="system", actor="agent",
                      payload={"count": 1, "targets": [target], "remaining": 0})
        return item

    # -- people -----------------------------------------------------------------------
    def im_at(self, t: datetime) -> Person:
        person = resolve_on_call(self.rosters["slrr_im"], t).person
        assert person is not None
        return person

    def burson_at(self, t: datetime) -> tuple[Person, str]:
        res = resolve_on_call(self.rosters["burson"], t)
        assert res.person is not None
        return res.person, res.source

    # -- alert content ------------------------------------------------------------------
    def post_url(self, platform: str, handle: str) -> str:
        h = handle.lstrip("@").removeprefix("u/").replace(" ", "").lower()
        slug = self.token(7, string.ascii_lowercase + string.digits)
        if platform == "X":
            return f"https://x.com/{h}/status/18{self.digits(17)}"
        if platform == "Reddit":
            sub = self.rng.choice(["technology", "google", "GooglePixel", "Android", "artificial", "news", "Parenting"])
            return f"https://www.reddit.com/r/{sub}/comments/{slug}/post_{self.digits(4)}/?utm_source=share"
        if platform == "Bluesky":
            return f"https://bsky.app/profile/{h}/post/3l{self.token(11, string.ascii_lowercase + string.digits)}"
        if platform == "Threads":
            return f"https://www.threads.net/@{h}/post/C{self.token(10)}"
        if platform == "TikTok":
            return f"https://www.tiktok.com/@{h}/video/74{self.digits(17)}"
        if platform == "Instagram":
            return f"https://www.instagram.com/p/C{self.token(10)}/?igsh={self.token(8)}"
        if platform == "Facebook":
            return f"https://www.facebook.com/groups/{self.digits(15)}/posts/{self.digits(16)}/"
        if platform == "YouTube":
            return f"https://www.youtube.com/watch?v={self.token(11)}"
        if platform == "LinkedIn":
            return f"https://www.linkedin.com/posts/{h}_activity-72{self.digits(17)}-{self.token(4)}"
        return f"https://truthsocial.com/@{h}/11{self.digits(16)}"

    @staticmethod
    def record_key(url: str) -> str:
        """Normalized post URL (docs/CONTRACTS.md §4.10)."""
        parts = urlsplit(url.strip())
        host = parts.netloc.lower()
        for prefix in ("www.", "m."):
            host = host.removeprefix(prefix)
        host = "x.com" if host == "twitter.com" else host
        query = [(k, v) for k, v in parse_qsl(parts.query) if not k.startswith(TRACKING_PARAMS)]
        return host + parts.path.rstrip("/") + (f"?{urlencode(query)}" if query else "")

    def new_spec(self, source: str, received: datetime, tpl: dict, outcome: str, **kw: Any) -> Spec:
        platform = kw.pop("platform", None) or self.rng.choice(tpl["platforms"])
        handle = self.rng.choice(D.HANDLES.get(platform, ["user"]))
        url = self.post_url(platform, handle)
        politics = "Politics" in tpl.get("topics", [])
        location = "US" if politics else self.pick([("US", 0.78), ("", 0.06), (self.rng.choice(D.MARKETS), 0.16)])
        spec = Spec(source=source, received=received, tpl=tpl, outcome=outcome, platform=platform, handle=handle, url=url,
                    record_key=self.record_key(url), location=location,
                    detect_s={"burson_chat": self.loguniform(600, 7200), "inhouse": self.loguniform(300, 2400)}.get(source, self.loguniform(1800, 21600)),
                    latency_ms=int(self.loguniform(1400, 7200)))
        for k, v in kw.items():
            setattr(spec, k, v)
        return spec

    def tag(self, name: str):
        tag = self.cfg.collection.tag(name)
        assert tag is not None, f"unknown exposure tag {name!r}"
        return tag

    def sensitive(self, spec: Spec, tag_name: str) -> list[str]:
        topics = [t for t in spec.tpl.get("topics", []) if not self.cfg.collection.is_redundant(tag_name, t)]
        if "Politics" in topics and spec.location not in ("US", ""):
            topics.remove("Politics")
        return topics

    def urgent_eligible(self, spec: Spec, tag_name: str | None = None) -> bool:
        name = tag_name or spec.tpl["tag"]
        return self.tag(name).priority == "P0" or bool(self.sensitive(spec, name)) or spec.is_kof

    def set_engagement(self, spec: Spec, lo: float, hi: float) -> None:
        spec.total = int(self.loguniform(lo, hi))
        spec.followers = int(self.loguniform(150_000, 3_000_000) if spec.is_kof else self.loguniform(800, 120_000))

    # -- assessment + fields --------------------------------------------------------------
    def assess(self, spec: Spec, *, tag_name: str | None = None, product: str | None = None, total: int | None = None,
               at: datetime | None = None) -> AlertAssessment:
        cfg, tpl = self.cfg, spec.tpl
        tag = self.tag(tag_name or spec.tag_override or tpl["tag"])
        product = product or spec.product_override or tpl["product"]
        total = spec.total if total is None else total
        at = at or spec.received
        topics = self.sensitive(spec, tag.name)
        high = total >= cfg.collection.high_engagement_threshold
        reasons = (["P0_TOPIC"] if tag.priority == "P0" else []) + (["SENSITIVE_TOPIC"] if topics else []) + (["KOF"] if spec.is_kof else [])
        ongoing = spec.issue_status == "ONGOING"
        alertable = spec.suppression is None
        track = None
        if alertable:
            track = "URGENT" if reasons and (not ongoing or spec.is_kof) else ("HIGH_ENGAGEMENT" if high else None)
            track = track or "HIGH_ENGAGEMENT"
        tier = cfg.collection.tier_for(spec.platform)
        sla = tier.sla_minutes if tier and alertable else None
        yt_subject = bool(tpl.get("yt"))
        a = AlertAssessment(
            track=track,  # type: ignore[arg-type]
            alert_action=(("YOUTUBE_CHAT_ONLY" if yt_subject and not tpl.get("bias") else "EMAIL_ALERT") if alertable else None),  # type: ignore[arg-type]
            reason_codes=reasons + (["HIGH_ENGAGEMENT"] if high else []) + ([spec.suppression] if spec.suppression and spec.suppression.startswith("EXCLUDED_") else []),
            issue_status=spec.issue_status,  # type: ignore[arg-type]
            issue_name=tpl["issue"],
            issue_fingerprint=f"fp-{abs(hash_key(tpl['key'])):012x}"[:15],
            related_case_id=spec.related.case_id if spec.related else None,
            priority=tag.priority,
            exposure_tag=tag.name,
            product=product,
            sensitive_topics=topics,
            is_kof=spec.is_kof,
            kof_lists=self.rng.choice(D.KOF_LISTS) if spec.is_kof else [],
            engagement_total=total,
            engagement_level=cfg.collection.level_for(total, spec.is_kof),
            platform=spec.platform,
            platform_tier=tier.name if tier else None,
            sla_minutes=sla,
            sla_due_at=(spec.received + timedelta(minutes=sla)) if sla else None,
            alertable=alertable,
            suppression_reason=spec.suppression,
            sundar_mention=bool(tpl.get("sundar")),
            non_us_markets=[spec.location] if spec.location not in ("US", "") else [],
            secondary_products=list(tpl.get("other", [])),
            owned_post=bool(tpl.get("owned")),
            video_timestamp=f"{self.rng.randint(1, 40)}:{self.rng.randint(0, 59):02d}" if spec.platform == "YouTube" and self.chance(0.6) else None,
            video_timestamp_needed=spec.platform in cfg.collection.long_video_platforms,
            youtube_subject=yt_subject,
            youtube_protocol=("chat_only" if yt_subject else ("email_and_ping" if tpl.get("mentions_yt") else "none")) if alertable else "none",  # type: ignore[arg-type]
            bias_allegation=bool(tpl.get("bias")),
            doodle_protocol=alertable and product in cfg.protocols.doodle.products,
        )
        lead = cfg.protocols.leadership
        last = self.leadership_pinged.get(tpl["key"])
        a.leadership_protocol = bool(
            alertable and lead.enabled and not ongoing and (tag.priority in lead.priorities or topics)
            and (tag.name in cfg.collection.product_mistake_tags or tag.name.startswith("Content - "))
            and (last is None or at - last > timedelta(days=lead.dedupe_days))
        )
        ts_reasons = (["viral KOF"] if spec.is_kof else []) + (["child safety"] if "Child Safety" in topics else [])
        if tag.name in cfg.collection.hallucination_tags and ("Gemini" in product or product == "Nano Banana"):
            ts_reasons.append("Gemini hallucination")
        a.ts_recommended, a.ts_reasons = bool(ts_reasons) and alertable, ts_reasons
        text = " ".join((tpl["content"], tpl["issue"], tpl["summary"]))
        a.suggested_actions = suggest_actions(cfg, a, text) if alertable else []
        a.recipients = plan_recipients(cfg, a, text) if alertable else None
        return a

    def alert_name(self, spec: Spec, a: AlertAssessment) -> str:
        track = a.track or ("URGENT" if self.urgent_eligible(spec) else "HIGH_ENGAGEMENT")
        label = "URGENT" if track == "URGENT" else "HIGH ENGAGEMENT"
        status = "ONGOING" if spec.issue_status == "ONGOING" else "NEW"
        return f"[{label}] [{status}] {a.product} – {spec.tpl['title']}"

    def fields(self, spec: Spec, a: AlertAssessment) -> dict[str, Any]:
        total = a.engagement_total or spec.total
        likes = round(total * self.rng.uniform(0.72, 0.86))
        comments = round(total * self.rng.uniform(0.06, 0.13))
        post_date = spec.received - timedelta(seconds=spec.detect_s)
        out: dict[str, Any] = {
            "alert_name": self.alert_name(spec, a), "issue_name": spec.tpl["issue"],
            "issue_status": "Ongoing Issue" if spec.issue_status == "ONGOING" else "NEW",
            "engagement_level": a.engagement_level, "total_engagement": total, "likes": likes, "comments": comments,
            "shares": max(0, total - likes - comments), "product": a.product, "other_products": list(spec.tpl.get("other", [])),
            "social_network": spec.platform, "exposure_tag": a.exposure_tag, "priority": a.priority,
            "risk_tags": list(spec.tpl.get("topics", [])), "kof": spec.is_kof, "kof_lists": a.kof_lists, "ts": a.ts_recommended,
            "author": spec.handle, "followers": spec.followers, "post_date": post_date.isoformat(), "post_url": spec.url,
            "post_content": spec.tpl["content"], "summary": spec.tpl["summary"], "location": spec.location or None,
        }
        if spec.platform in ("YouTube", "TikTok", "Instagram"):
            out["views"] = total * self.rng.randint(8, 45)
        if a.video_timestamp:
            out["video_timestamp"] = a.video_timestamp
        return out

    @staticmethod
    def fmt(value: Any) -> str:
        if isinstance(value, bool):
            return "Yes" if value else "No"
        if isinstance(value, int):
            return f"{value:,}"
        return fmt_value(value)

    def chat_message(self, spec: Spec, t: datetime, fields: dict[str, Any], *, drop: tuple[str, ...] = (), truncated: bool = False) -> ChatMessage:
        if spec.source == "inhouse":
            text = "\n".join([f"brand_safety_alert_log row {spec.source_ref}"] + [f"{k}: {self.fmt(fields.get(k))}" for k in
                             ("alert_name", "exposure_tag", "product", "social_network", "total_engagement", "post_url")])
            return ChatMessage(message_id=f"bsa:{spec.source_ref}", text=text, sender=ChatUser(name="brand_safety_alerting", type="BOT"),
                               create_time=t)
        if spec.source == "watchdog":
            text = f"Subject: Watchdog Anti-Abuse Alert: {spec.tpl['title']}\n\n{spec.tpl['summary']}\nLink: {spec.url}"
            return ChatMessage(message_id=f"gmail:{self.token(16).lower()}", text=text,
                               sender=ChatUser(name="Watchdog Anti-Abuse Alert", email="watchdog-noreply@alerts.test", type="HUMAN"), create_time=t)
        lines = ["🚨 Burson Automated Alert"] + [f"{label}: {self.fmt(fields[key])}" for label, key in MESSAGE_LABELS
                                                 if key not in drop and fields.get(key) not in (None, "", [])]
        if truncated:
            lines = lines[:4]
        mid = f"{self.token(11)}.{self.token(11)}"
        return ChatMessage(
            message_id=f"spaces/{self.burson_space_id}/messages/{mid}", text="\n".join(lines),
            sender=ChatUser(name="Zapier", type="BOT"), space_id=f"spaces/{self.burson_space_id}", space_name=self.burson_space_name,
            thread_id=f"spaces/{self.burson_space_id}/threads/{self.token(11)}",
            link=f"https://chat.google.com/room/{self.burson_space_id}/{self.token(11)}", create_time=t, conversation_type="SPACE",
        )

    def result(self, spec: Spec, verdict: Verdict, a: AlertAssessment, fields: dict[str, Any], *, corrections: list[Correction] | None = None,
               issues: list[Issue] | None = None, review_reasons: list[str] | None = None, confidence: float | None = None) -> TriageResult:
        issues = list(issues or [])
        if spec.platform in self.cfg.collection.long_video_platforms and not fields.get("video_timestamp"):
            issues.append(Issue(field="video_timestamp", rule="video_needs_timestamp", severity=Severity.WARNING,
                                fix="Add the timestamp of the Google mention."))
        if self.chance(0.1):
            issues.append(Issue(field="summary", rule="llm:summary_grammar", severity=Severity.WARNING, source=IssueSource.LLM,
                                confidence=round(self.rng.uniform(0.6, 0.8), 2), fix="Summary has minor grammar issues."))
        lo, hi = {Verdict.NEEDS_REVIEW: (0.52, 0.69), Verdict.CORRECTED: (0.8, 0.96), Verdict.FAIL: (0.9, 1.0)}.get(verdict, (0.86, 0.99))
        return TriageResult(
            verdict=verdict, confidence=round(confidence if confidence is not None else self.rng.uniform(lo, hi), 2), issues=issues,
            corrections=list(corrections or []), assessment=a, record_key=spec.record_key, normalized=fields, checks_run=CHECKS_RUN,
            review_reasons=list(review_reasons or []), model=self.cfg.models.triage, rules_version=self.cfg.collection.version,
            latency_ms=spec.latency_ms,
        )

    # -- corrections -------------------------------------------------------------------------
    def correction_candidates(self, spec: Spec, a: AlertAssessment, fields: dict[str, Any]) -> list[tuple[float, Correction]]:
        tpl, rule, llm = spec.tpl, IssueSource.RULE, IssueSource.LLM
        conf = lambda: round(self.rng.uniform(0.86, 0.97), 2)  # noqa: E731
        out: list[tuple[float, Correction]] = []
        if tpl.get("remap_from"):
            out.append((6, Correction(field="exposure_tag", old=tpl["remap_from"], new=a.exposure_tag, source=rule,
                                      reason="suspension + censorship claim → Product - Perceived bias")))
        elif tpl.get("alias_tag"):
            out.append((3, Correction(field="exposure_tag", old=tpl["alias_tag"], new=a.exposure_tag, source=rule, reason="merged tag → canonical name")))
        elif tpl.get("llm_tag"):
            out.append((2, Correction(field="exposure_tag", old=tpl["llm_tag"][0], new=a.exposure_tag, source=llm, confidence=conf(), reason=tpl["llm_tag"][1])))
        if tpl.get("product_alias"):
            why = "Gems distro removed → Gemini App" if tpl["product_alias"] == "Gems" else "product alias → distribution name"
            out.append((3, Correction(field="product", old=tpl["product_alias"], new=a.product, source=rule, reason=why)))
        wrong_p = self.rng.choice([p for p in ("P0", "P1", "P2") if p != a.priority])
        out.append((2, Correction(field="priority", old=wrong_p, new=a.priority, source=rule, reason="priority from the exposure tag")))
        total = int(fields["total_engagement"])
        out.append((3, Correction(field="total_engagement", old=max(0, total - self.rng.randint(40, 400)), new=total, source=rule,
                                  reason="likes + comments + shares")))
        levels = [lv.name for lv in self.cfg.collection.engagement_levels if lv.name != a.engagement_level]
        if a.engagement_level and levels:
            out.append((2, Correction(field="engagement_level", old=self.rng.choice(levels), new=a.engagement_level, source=rule,
                                      reason="KOF author" if spec.is_kof else "engagement level from the total")))
        other_net = self.rng.choice([n for n in ("X", "Threads", "Bluesky", "Reddit") if n != spec.platform])
        out.append((1.5, Correction(field="social_network", old=other_net, new=spec.platform, source=rule, reason="network from the post URL domain")))
        if spec.issue_status == "ONGOING" and spec.related:
            out.append((3, Correction(field="issue_status", old="NEW", new="Ongoing Issue", source=rule,
                                      reason=f"alerted within 14 days ({spec.related.case_id})")))
        prefix_wrong = fields["alert_name"].replace("[URGENT]", "[HIGH ENGAGEMENT]") if "[URGENT]" in fields["alert_name"] \
            else fields["alert_name"].replace("[HIGH ENGAGEMENT]", "[URGENT]")
        out.append((2.5, Correction(field="alert_name", old=prefix_wrong, new=fields["alert_name"], source=rule,
                                    reason="prefix from the computed track and status")))
        if "Politics" in tpl.get("topics", []):
            out.append((3, Correction(field="risk_tags", old=["World Politics"], new=["Politics"], source=rule, reason="risk-tag alias → canonical name")))
        if spec.is_kof:
            out.append((1.5, Correction(field="kof", old=False, new=True, source=llm, confidence=conf(), reason="author is on a P0 KOF list")))
        if tpl.get("biased_issue"):
            out.append((3, Correction(field="issue_name", old=tpl["biased_issue"], new=tpl["issue"], source=llm, confidence=conf(),
                                      reason="neutral, descriptive issue name")))
        garbled = tpl["summary"].replace(" says ", " say ").replace(" the ", " ").replace("; ", ", and ", 1)
        if garbled != tpl["summary"]:
            out.append((1.2, Correction(field="summary", old=garbled, new=tpl["summary"], source=llm, confidence=conf(), reason="grammar and accuracy")))
        return out

    def choose_corrections(self, spec: Spec, a: AlertAssessment, fields: dict[str, Any], n: int) -> list[Correction]:
        pool = self.correction_candidates(spec, a, fields)
        chosen: list[Correction] = []
        while pool and len(chosen) < n:
            c = self.pick([(c, w) for w, c in pool])
            chosen.append(c)
            pool = [(w, x) for w, x in pool if x.field != c.field]
        return chosen

    @staticmethod
    def burson_fields(fields: dict[str, Any], corrections: list[Correction]) -> dict[str, Any]:
        """The fields as Burson sent them (before the agent's corrections)."""
        out = dict(fields)
        for c in corrections:
            if c.applied:
                out[c.field] = c.old
        return out

    def correction_events(self, case: Case, attempt: int, t: datetime, corrections: list[Correction]) -> None:
        for c in corrections:
            self.emit(t, E.CORRECTION_APPLIED if c.applied else E.CORRECTION_PROPOSED, case_id=case.case_id, attempt=attempt, space="burson",
                      payload={"field": c.field, "old": fmt_value(c.old), "new": fmt_value(c.new), "confidence": c.confidence,
                               "source": c.source.value, "reason": c.reason})


def hash_key(text: str) -> int:
    """Stable (process-independent) hash for fingerprints."""
    import hashlib

    return int(hashlib.sha256(text.encode()).hexdigest()[:12], 16)
