"""Stories: alerts that tell the same story, grouped by the Chat bot's own rules (apps-script-chat-bot/AlertMemory.gs).

A story's text is "<issue name>. <product>. <exposure tag>. <summary without Burson's boilerplate, its first characters>".
Two alerts are the same story when their texts mean the same (cosine of their embeddings at or above
`same_story_similarity`, or at or above `gray_similarity` with the same exposure tag and product), and never when both
name identifiers of one kind (CVE ids, long numbers, @handles) and share none. Without an embedding model the check is
the one from before: the same exposure tag and issue words at least `collection.novelty_min_jaccard` alike. A story
silent for `keep_days` is over; a later alert on it starts a new one. Every threshold is in Settings → Stories.

A story is made of its smaller stories: the alerts under one issue name. The story map sizes each circle by engagement
or by alerts, and the growth line is the running total by the hour.
"""

from __future__ import annotations

import logging
import math
import re
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, Field

from . import knowledge
from .cases import name_key
from .config import StoriesConfig
from .models import Case, CaseStatus, utc_isoformat
from .qa.requirements import issue_name_of, issue_tokens, jaccard

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

log = logging.getLogger(__name__)

COLLECTION = "stories"
VECTORS = "story_vectors"  # a story's vector, apart from the story so the map never loads it
MEMBERS = "story_members"  # case id -> the story it is on
CURSOR = "stories:cursor"
LOCK = "stories:refresh"
BATCH = 5000
EMBED_BATCH = 50
IDENTS_KEPT = 8
GROWTH_POINTS = 96

_URL = re.compile(r"https?://\S+", re.I)
_CVE = re.compile(r"\bCVE-\d{4}-\d{4,}\b", re.I)
_COUNT = re.compile(r"\b\d[\d,.]*\s*[kKmM]?\+?\s*(?:likes?|views?|engagements?|followers?|comments?|shares?|retweets?|reposts?|"
                    r"repl(?:y|ies)|interactions?|impressions?|upvotes?|reactions?|subscribers?|votes?)\b", re.I)
_NUMBER = re.compile(r"\b\d{4,}\b")
_HANDLE = re.compile(r"(?:^|[^\w.@])@([A-Za-z0-9_]{2,30})")
_URL_AUTHOR = re.compile(r"https?://(?:www\.|mobile\.)?(?:x|twitter|threads|instagram|tiktok)\.(?:com|net)/@?([A-Za-z0-9_.]{2,30})/", re.I)
OPEN_STATUSES = {CaseStatus.NEEDS_REVIEW.value, CaseStatus.FAILED.value}


class Member(BaseModel):
    """One alert on a story, as the map needs it."""

    case_id: str
    at: datetime  # when the alert first came in
    name: str = ""  # its issue name: the smaller story it belongs to
    engagement: int = 0
    platform: str = ""
    url: str = ""
    author: str = ""
    source: str = ""
    status: str = ""
    acknowledged: bool = False
    how: str = "lead"  # lead | meaning | words: why it is on this story
    sim: float | None = None
    also: list[str] = Field(default_factory=list)  # the same post alerted by the other path

    @property
    def open(self) -> bool:
        return self.status in OPEN_STATUSES or (self.status == CaseStatus.VERIFIED.value and not self.acknowledged)


class Story(BaseModel):
    story_id: str
    title: str = ""
    tag: str = ""
    product: str = ""
    tok: list[str] = Field(default_factory=list)
    idt: dict[str, list[str]] = Field(default_factory=dict)
    by_meaning: bool = False  # it has a vector to compare by
    first_at: datetime
    last_at: datetime
    members: list[Member] = Field(default_factory=list)
    env: str = "dev"

    def view(self) -> dict[str, Any]:
        return {"tag": self.tag, "product": self.product, "tok": self.tok, "idt": self.idt}


# -- the rules -------------------------------------------------------------------------------------------------------------------
def story_text(fields: dict[str, Any], cfg: StoriesConfig) -> str:
    """The text a story is told by; '' without an issue name or a summary."""
    name = (issue_name_of(fields) or "").strip()
    summary = str(fields.get("summary") or "")
    for pattern in cfg.boilerplate_patterns:
        summary = re.sub(pattern, " ", summary, flags=re.I)
    summary = summary.strip()[: cfg.summary_chars]
    if not name and not summary:
        return ""
    return f"{name}. {str(fields.get('product') or '').strip()}. {str(fields.get('exposure_tag') or '').strip()}. {summary}"


def _uniq(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))[:IDENTS_KEPT]


def idents(text: str | None, authors: list[str | None] | None = None) -> dict[str, list[str]]:
    """The identifiers a story's text names, which two different stories can't share: CVE ids (c), numbers of four or more
    digits that aren't an engagement count (n), and @handles other than the post's own author (a)."""
    s = _URL.sub(" ", str(text or ""))
    cve = [m.upper() for m in _CVE.findall(s)]
    numbers = _NUMBER.findall(_COUNT.sub(" ", _CVE.sub(" ", s)))
    skip = {str(a or "").lstrip("@").strip().lower() for a in (authors or [])} - {""}
    handles = [h.lower() for h in _HANDLE.findall(s) if h.lower() not in skip]
    return {"c": _uniq(cve), "n": _uniq(numbers), "a": _uniq(handles)}


def idents_clash(a: dict[str, list[str]] | None, b: dict[str, list[str]] | None) -> bool:
    """Both name identifiers of one kind and share none of them: never the same story."""
    a, b = a or {}, b or {}
    return any(a.get(k) and b.get(k) and not set(a[k]) & set(b[k]) for k in ("c", "n", "a"))


def _same_name(x: Any, y: Any) -> bool:
    p = str(x or "").strip().lower()
    return bool(p) and p == str(y or "").strip().lower()


def same_story(sim: float, a: dict[str, Any], b: dict[str, Any], cfg: StoriesConfig) -> bool:
    """Same story by meaning. `sim`: the cosine of their vectors; `a`, `b`: {tag, product, idt}."""
    if idents_clash(a.get("idt"), b.get("idt")):
        return False
    if sim >= cfg.same_story_similarity:
        return True
    return sim >= cfg.gray_similarity and _same_name(a.get("tag"), b.get("tag")) and _same_name(a.get("product"), b.get("product"))


def same_story_words(a: dict[str, Any], b: dict[str, Any], min_jaccard: float) -> float:
    """Same story by words (no vector to compare): the same exposure tag and issue words alike enough. Their likeness, else 0."""
    if idents_clash(a.get("idt"), b.get("idt")) or not _same_name(a.get("tag"), b.get("tag")):
        return 0.0
    ta, tb = a.get("tok") or [], b.get("tok") or []
    if not ta or not tb:
        return 0.0
    j = jaccard(ta, tb)
    return j if j >= min_jaccard else 0.0


# -- an alert as a story sees it ----------------------------------------------------------------------------------------------
def _fields(case: Case) -> dict[str, Any]:
    result = case.latest.result if case.latest else None
    fields = dict((result.normalized if result else None) or {})
    for key in ("issue_name", "product", "exposure_tag", "alert_name"):
        fields.setdefault(key, getattr(case, key))
    return fields


def post_text(case: Case) -> str:
    """The alert's post in its own words (Burson's summary when the post's words did not come with it)."""
    fields = _fields(case)
    return str(fields.get("post_content") or fields.get("summary") or "").strip()


def _int(value: Any) -> int:
    try:
        return max(0, int(float(str(value).replace(",", "").strip())))
    except (TypeError, ValueError):
        return 0


def _received(case: Case) -> datetime:
    return case.attempts[0].received_at if case.attempts else case.created_at


def view_of(ctx: "AgentContext", case: Case) -> dict[str, Any]:
    fields = _fields(case)
    text = story_text(fields, ctx.config.platform.stories)
    url_author = _URL_AUTHOR.match(str(fields.get("post_url") or ""))
    authors = [fields.get("author"), url_author.group(1) if url_author else None]
    return {"text": text, "tag": str(fields.get("exposure_tag") or "").strip(), "product": str(fields.get("product") or "").strip(),
            "tok": issue_tokens(issue_name_of(fields), ctx.config.collection.issue_stopwords), "idt": idents(text, authors)}


def member_of(case: Case) -> Member:
    fields = _fields(case)
    result = case.latest.result if case.latest else None
    a = result.assessment if result else None
    engagement = a.engagement_total if a and a.engagement_total is not None else fields.get("total_engagement")
    return Member(case_id=case.case_id, at=_received(case), name=(issue_name_of(fields) or "").strip(), engagement=_int(engagement),
                  platform=str(case.platform or fields.get("social_network") or "").strip(), url=str(fields.get("post_url") or ""),
                  author=str(fields.get("author") or ""), source=case.source, status=case.status.value,
                  acknowledged=case.acknowledged_at is not None)


# -- placing alerts on stories --------------------------------------------------------------------------------------------------
def _load(ctx: "AgentContext", since: datetime) -> dict[str, Story]:
    rows = ctx.store.list_docs(COLLECTION, since=since, limit=BATCH)
    return {s.story_id: s for s in (Story.model_validate(r) for r in rows) if s.last_at >= since}


def _save(ctx: "AgentContext", story: Story, vec: list[float] | None = None) -> None:
    ctx.store.put_doc(COLLECTION, story.story_id, story.model_dump(mode="json"))
    if vec is not None:
        ctx.store.put_doc(VECTORS, story.story_id, {"story_id": story.story_id, "vec": vec, "last_at": utc_isoformat(story.last_at)})


def _embed(ctx: "AgentContext", texts: list[str]) -> dict[str, list[float]]:
    out: dict[str, list[float]] = {}
    unique = list(dict.fromkeys(t for t in texts if t))
    for i in range(0, len(unique), EMBED_BATCH):
        part = unique[i:i + EMBED_BATCH]
        vectors = knowledge.embed(ctx, part)
        if not vectors or len(vectors) != len(part):
            break  # no embedding model, or it can't be reached: the word check decides
        out.update(zip(part, vectors))
    return out


def _best(view: dict[str, Any], vec: list[float] | None, candidates: list[Story], vectors: dict[str, list[float]],
          cfg: StoriesConfig, min_jaccard: float) -> tuple[Story, float, str] | None:
    best: tuple[Story, float, str] | None = None
    if vec is not None:
        for s in candidates:
            sv = vectors.get(s.story_id)
            if sv is None:
                continue
            sim = knowledge.cosine(vec, sv)
            if same_story(sim, view, s.view(), cfg) and (best is None or sim > best[1]):
                best = (s, sim, "meaning")
    if best is None:
        for s in candidates:
            if vec is not None and s.story_id in vectors:
                continue  # both have a vector: their meaning already said no
            j = same_story_words(view, s.view(), min_jaccard)
            if j and (best is None or j > best[1]):
                best = (s, j, "words")
    return best


def _pending(ctx: "AgentContext") -> tuple[list[Case], dict[str, Any]]:
    """Cases changed since the last pass that this pass hasn't read yet, oldest first, and the mark to keep after it."""
    cfg = ctx.config.platform.stories
    mark = ctx.store.get_kv(CURSOR) or {}
    since = datetime.fromisoformat(mark["at"]) if mark.get("at") else ctx.now() - timedelta(days=max(cfg.keep_days, math.ceil(cfg.map_hours / 24)))
    done = mark.get("done") or {}
    cases = [c for c in ctx.store.list_cases(since=since, limit=BATCH) if done.get(c.case_id) != utc_isoformat(c.updated_at)]
    cases.sort(key=lambda c: (_received(c), c.case_id))
    return cases, mark


def refresh(ctx: "AgentContext") -> int:
    """Put every alert that came in since the last pass on its story. Returns how many were placed."""
    cases, mark = _pending(ctx)
    if not cases:
        return 0
    if not ctx.store.claim_idempotent(LOCK, ttl_s=120):
        return 0  # another process is placing them
    try:
        return _place(ctx, cases, mark)
    finally:
        ctx.store.release_idempotent(LOCK)


def _place(ctx: "AgentContext", cases: list[Case], mark: dict[str, Any]) -> int:
    cfg = ctx.config.platform.stories
    keep = timedelta(days=cfg.keep_days)
    min_jaccard = ctx.config.collection.novelty_min_jaccard
    placed_at = {c.case_id: ctx.store.get_doc(MEMBERS, c.case_id) for c in cases}
    todo = [c for c in cases if not (placed_at[c.case_id] or {}).get("story_id")]
    views = {c.case_id: view_of(ctx, c) for c in todo}
    stories = _load(ctx, _received(todo[0]) - keep) if todo else {}
    vectors = {r["story_id"]: r["vec"] for r in ctx.store.list_docs(VECTORS, since=_received(todo[0]) - keep, limit=BATCH)
               if r.get("story_id") in stories} if todo else {}
    embedded = _embed(ctx, [v["text"] for v in views.values()]) if todo else {}
    changed: dict[str, list[float] | None] = {}
    placed = 0

    def story_of(story_id: str) -> Story | None:
        if story_id not in stories:
            row = ctx.store.get_doc(COLLECTION, story_id)
            if row is None:
                return None
            stories[story_id] = Story.model_validate(row)
        return stories[story_id]

    for case in cases:
        snap = member_of(case)
        known = placed_at[case.case_id] or {}
        if known.get("story_id"):  # already on a story: keep its numbers and status current
            story = story_of(known["story_id"])
            if story and not known.get("also_of"):
                for i, m in enumerate(story.members):
                    if m.case_id == case.case_id:
                        snap.how, snap.sim, snap.also = m.how, m.sim, m.also
                        if snap != m:
                            story.members[i] = snap
                            changed.setdefault(story.story_id, None)
            continue
        view = views[case.case_id]
        if not view["text"]:
            ctx.store.put_doc(MEMBERS, case.case_id, {"case_id": case.case_id, "story_id": ""})
            continue  # nothing to tell its story by yet
        twin = ctx.store.get_doc(MEMBERS, case.counterpart_case_id) if case.counterpart_case_id else None
        if twin and twin.get("story_id") and (story := story_of(twin["story_id"])):  # the same post, alerted by the other path
            for m in story.members:
                if m.case_id == (twin.get("also_of") or case.counterpart_case_id) and case.case_id not in m.also:
                    m.also.append(case.case_id)
                    changed.setdefault(story.story_id, None)
            ctx.store.put_doc(MEMBERS, case.case_id, {"case_id": case.case_id, "story_id": story.story_id,
                                                      "also_of": twin.get("also_of") or case.counterpart_case_id})
            continue
        vec = embedded.get(view["text"])
        candidates = [s for s in stories.values() if s.env == case.env and s.last_at >= snap.at - keep]
        match = _best(view, vec, candidates, vectors, cfg, min_jaccard)
        if match:
            story, sim, how = match
            snap.how, snap.sim = how, round(sim, 3)
            story.members.append(snap)
            story.last_at = max(story.last_at, snap.at)
            changed[story.story_id] = vectors.get(story.story_id)  # written again so its keep-time moves with the story
        else:
            story = Story(story_id=ctx.store.next_id("STORY"), title=snap.name or (case.alert_name or ""), tag=view["tag"],
                          product=view["product"], tok=view["tok"], idt=view["idt"], by_meaning=vec is not None,
                          first_at=snap.at, last_at=snap.at, members=[snap], env=case.env)
            stories[story.story_id] = story
            if vec is not None:
                vectors[story.story_id] = vec
            changed[story.story_id] = vec
        ctx.store.put_doc(MEMBERS, case.case_id, {"case_id": case.case_id, "story_id": story.story_id})
        placed += 1

    for story_id, vec in changed.items():
        _save(ctx, stories[story_id], vec)
    newest = max(c.updated_at for c in cases)
    floor = utc_isoformat(newest)
    done = {cid: at for cid, at in (mark.get("done") or {}).items() if at == floor}
    done.update({c.case_id: floor for c in cases if utc_isoformat(c.updated_at) == floor})
    ctx.store.put_kv(CURSOR, {"at": newest.isoformat(), "done": done})
    return placed


# -- reading stories ------------------------------------------------------------------------------------------------------------
def list_stories(ctx: "AgentContext", since: datetime, env: str | None = None) -> list[Story]:
    """Stories with an alert at or after `since`, the latest first."""
    found = [s for s in _load(ctx, since).values() if env is None or s.env == env]
    return sorted(found, key=lambda s: s.last_at, reverse=True)


def get(ctx: "AgentContext", story_id: str) -> Story | None:
    row = ctx.store.get_doc(COLLECTION, story_id)
    return Story.model_validate(row) if row else None


def story_id_of(ctx: "AgentContext", case_id: str) -> str | None:
    return (ctx.store.get_doc(MEMBERS, case_id) or {}).get("story_id") or None


def _hour(at: datetime) -> datetime:
    return at.replace(minute=0, second=0, microsecond=0)


def summary(ctx: "AgentContext", story: Story, since: datetime | None = None) -> dict[str, Any]:
    """A story as the map and the list show it: its size, its smaller stories and how it grew."""
    cfg = ctx.config.platform.stories
    now = ctx.now()
    members = sorted(story.members, key=lambda m: (m.at, m.case_id))
    subs: dict[str, dict[str, Any]] = {}
    points = []
    for m in members:
        key = name_key(m.name) or "unnamed"
        sub = subs.setdefault(key, {"key": key, "name": m.name or "No issue name", "alerts": 0, "engagement": 0, "first_at": m.at, "last_at": m.at})
        sub["alerts"] += 1
        sub["engagement"] += m.engagement
        sub["last_at"] = max(sub["last_at"], m.at)
        points.append({"t": m.at, "e": m.engagement, "s": list(subs).index(key), "id": m.case_id, "a": m.author})  # a: the account that posted it
    start = _hour(max(story.first_at, since) if since else story.first_at)
    step = max(1, math.ceil(((now - start).total_seconds() / 3600 + 1) / GROWTH_POINTS))
    growth = []
    t = start
    while t <= now:
        upto = t + timedelta(hours=step)
        seen = [m for m in members if m.at < upto]
        growth.append({"t": t, "alerts": len(seen), "engagement": sum(m.engagement for m in seen)})
        t = upto
    alerts, engagement = len(members), sum(m.engagement for m in members)
    recent = story.last_at >= now - timedelta(hours=cfg.active_hours)
    return {
        "story_id": story.story_id, "title": story.title or "No issue name", "tag": story.tag, "product": story.product, "env": story.env,
        "first_at": story.first_at, "last_at": story.last_at, "alerts": alerts, "engagement": engagement,
        "size": engagement if cfg.size_by == "engagement" else alerts,
        "status": "quiet" if not recent else ("new" if alerts == 1 else "growing"),
        "needs": sum(1 for m in members if m.open), "platforms": sorted({m.platform for m in members if m.platform}),
        "by_meaning": story.by_meaning, "sub": sorted(subs.values(), key=lambda s: (-s["alerts"], s["first_at"])),
        "points": points, "growth": growth,
    }
