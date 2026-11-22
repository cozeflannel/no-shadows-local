"""Early Detection: posts on one theme are grouped into a story before anyone raises an alert.

The sheet-based bot's Early wave check (apps-script-chat-bot/EarlyWaveSource.gs, EarlyDetection.gs, FastTriage.gs),
with the heavy work moved into BigQuery, where Vertex AI is called next to the data:

    read      every few minutes each post table hands over its new low-reach posts (the old gates: few followers, low
              engagement, long enough, recent, not from a skipped account), and Vertex AI turns each into an embedding
              (AI.EMBED, SEMANTIC_SIMILARITY) in the same query.
    group     in BigQuery: a post joins the nearest story when it is close enough to the story's centre; posts with
              no story start one together when they are close to each other and come from two or more accounts.
    raise     a story is raised when enough separate accounts posted it within the window; one already raised goes
              out again only as an update when it grew to twice the accounts and three more, or reached a new platform.
    decide    Gemini Decisions scores each raised story (about the company, a risk, first-hand, routine, category,
              severity): plain noise is held back, a small story that scores high is raised as an early signal, and
              the most severe are written up first. Switch: Score early stories with Gemini Decisions.
    write up  Gemini writes the headline, the call (escalate, monitor, dismiss) and the story, reading the Knowledge
              documents. People act on it from the Console's Early Detection page.

The similarity bars and the raise bars are the sheet-based bot's, calibrated on real posts (EarlyWaveSource.gs).
Everything is a setting. Nothing here reads a table that is not named under Settings, Temp check, sources.
"""

from __future__ import annotations

import logging
import re
import statistics
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, Field

from . import audit, decisions

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

log = logging.getLogger(__name__)

SIGNALS = "early_signals"   # the Console's record of each raised story
STATE = "early:state"       # {last, day, raised, cursors: {source: iso}, sources: {key: {...}}, error}
TABLES = ("early_posts", "early_members", "early_signals")
SEVERITIES = ("none", "low", "medium", "high", "critical")
CALLS = ("escalate", "monitor", "dismiss")
CARD_PREFIX = "client-zeda-"
PURPOSE = "early.review"
LABELS = {"app": "triage-agent", "job": "early"}
OTHER_RISK, NO_CATEGORY = "Other risk to the brand", "No brand-safety issue"
_NAME = re.compile(r"^[\w.-]+$")


class Review(BaseModel):
    """Gemini's write-up of one story."""

    headline: str = Field(..., description="What is happening, in one plain line of 12 words or fewer.")
    call: Literal["escalate", "monitor", "dismiss"]
    severity: Literal["none", "low", "medium", "high", "critical"] = "low"
    story: str = Field("", description="Two to four sentences: what the accounts say, in their own terms.")
    why: str = Field("", description="One sentence: why this call.")
    exposure_tag: str = ""
    product: str = ""
    next_steps: list[str] = Field(default_factory=list)
    temp_check_query: str = Field("", description="Words to search for when sizing this story.")
    citations: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------------------------------------------
# Tables and SQL
# ---------------------------------------------------------------------------------------------------------------

def tables(ctx: "AgentContext") -> dict[str, str]:
    """Early Detection's three tables: the ones mapped under Settings, BigQuery, else the agent's own dataset."""
    from . import bq_admin

    cfg = ctx.config.platform.bigquery
    project = cfg.project or bq_admin.get_gateway(ctx).project
    dataset = cfg.dataset if "." in cfg.dataset else f"{project}.{cfg.dataset}"
    out = {}
    for name in TABLES:
        out[name] = bq_admin.table(ctx, name) or (bq_admin.check_table_id(f"{dataset}.agent_{name}") if cfg.dataset else "")
    if not all(out.values()):
        raise ValueError("Set the agent's dataset first (Settings, BigQuery, Dataset).")
    return out


def provision(ctx: "AgentContext") -> list[dict[str, Any]]:
    """Creates Early Detection's own tables when they are missing. Needs the switch Change BigQuery from here."""
    from . import bq_admin

    return bq_admin.ensure_standard_tables(ctx, only=TABLES)


def _connection(cfg: Any) -> str:
    if not cfg.ai_connection:
        return ""
    if not _NAME.match(cfg.ai_connection):
        raise ValueError("The AI connection name has characters that are not allowed.")
    return f", connection_id => '{cfg.ai_connection}'"


def ingest_sql(src: Any, cfg: Any, home: str = "") -> str:
    """One table's new low-reach posts, each with its embedding from Vertex AI. With `home` (the posts table, when the
    source is in the same BigQuery location) the rows are written there in the same job and posts already held are
    left out; otherwise the rows come back to be written by the caller."""
    from .bq_admin import check_table_id
    from .tempcheck import _ident, read_of

    if not _NAME.match(cfg.embedding_endpoint):
        raise ValueError("The embedding model name has characters that are not allowed.")
    held = (f"  LEFT JOIN `{check_table_id(home)}` h ON h.post_id = n.post_id AND h.seen >= @keep_since\n  WHERE h.post_id IS NULL AND " if home else "  WHERE ")
    if src.read_sql.strip():  # a table with its own read: the rows that arrived since the last read, in the shape the read gives
        gates = ["seen >= @since AND seen < @until", "posted >= @posted_since", "LOWER(IFNULL(sentiment, '')) != 'positive'"]
        if "language" in src.has:
            gates.append("LOWER(IFNULL(language, 'en')) LIKE 'en%'")
        new_posts = (
            "WITH new_posts AS (\n"
            "  SELECT TO_HEX(MD5(one)) AS post_id, platform, author, TRIM(REGEXP_REPLACE(IFNULL(text, ''), r'\\s+', ' ')) AS txt, url, posted,\n"
            "    SAFE_CAST(followers AS INT64) AS followers, SAFE_CAST(eng AS FLOAT64) AS engagement\n"
            f"  FROM (\n    {read_of(src)}\n  )\n  WHERE {' AND '.join(gates)}\n"
            "  QUALIFY ROW_NUMBER() OVER (PARTITION BY one ORDER BY seen DESC) = 1\n),\n")
        return _ingest_statement(new_posts, held, cfg, home)
    if not src.time_column or not src.text_columns or not src.url_column:
        raise ValueError("The source needs a time column, a text column and a link column (Settings, Temp check, sources).")
    t = _ident(src.time_column, "time column")
    url = f"CAST({_ident(src.url_column, 'url column')} AS STRING)"
    key = f"CAST({_ident(src.id_column, 'id column')} AS STRING)" if src.dedupe_by == "id" and src.id_column else url
    text = " , ' ', ".join(f"IFNULL(CAST({_ident(c, 'text column')} AS STRING), '')" for c in src.text_columns)
    platform = (f"LOWER(CAST({_ident(src.platform_column, 'platform column')} AS STRING))" if src.platform_column
                else (f"'{src.platform_value.lower()}'" if re.fullmatch(r"[\w -]+", src.platform_value or "") else "''"))
    followers = f"SAFE_CAST({_ident(src.followers_column, 'followers column')} AS INT64)" if src.followers_column else "CAST(NULL AS INT64)"
    eng = f"SAFE_CAST(({src.engagement_expr}) AS FLOAT64)" if src.engagement_expr.strip() else "CAST(NULL AS FLOAT64)"
    author = f"CAST({_ident(src.author_column, 'author column')} AS STRING)" if src.author_column else "CAST(NULL AS STRING)"
    gates = [f"{t} >= @since AND {t} < @until", f"{t} >= @posted_since"]
    if src.language_column:
        gates.append(f"LOWER(IFNULL(CAST({_ident(src.language_column, 'language column')} AS STRING), 'en')) LIKE 'en%'")
    if src.sentiment_column:
        gates.append(f"LOWER(IFNULL(CAST({_ident(src.sentiment_column, 'sentiment column')} AS STRING), '')) != 'positive'")
    if src.filter_sql.strip():
        gates.append(f"({src.filter_sql})")
    new_posts = (
        "WITH new_posts AS (\n"
        f"  SELECT TO_HEX(MD5({key})) AS post_id, IF({platform} = 'twitter', 'x', {platform}) AS platform, {author} AS author,\n"
        f"    TRIM(REGEXP_REPLACE(CONCAT({text}), r'\\s+', ' ')) AS txt, {url} AS url, {t} AS posted, {followers} AS followers, {eng} AS engagement\n"
        f"  FROM `{check_table_id(src.table)}`\n  WHERE {' AND '.join(gates)}\n"
        f"  QUALIFY ROW_NUMBER() OVER (PARTITION BY {key} ORDER BY {t} DESC) = 1\n),\n")
    return _ingest_statement(new_posts, held, cfg, home)


def _ingest_statement(new_posts: str, held: str, cfg: Any, home: str) -> str:
    """The rest of one table's read, after its new posts: the low-reach ones not held yet, each with its embedding."""
    from .bq_admin import check_table_id

    select = (
        new_posts +
        "fresh AS (\n  SELECT n.* FROM new_posts n\n" + held +
        "n.url IS NOT NULL AND IFNULL(n.followers, 0) <= @max_followers AND IFNULL(n.engagement, 0) < @max_engagement\n"
        "    AND LENGTH(n.txt) >= @min_chars AND ARRAY_LENGTH(REGEXP_EXTRACT_ALL(LOWER(n.txt), r'[a-z0-9]+')) >= @min_words\n"
        "    AND LOWER(IFNULL(n.author, '')) NOT IN UNNEST(@skip_authors)\n"
        "  ORDER BY n.posted DESC\n  LIMIT @cap\n),\n"
        "embedded AS (\n"
        f"  SELECT f.*, AI.EMBED(f.txt, endpoint => '{cfg.embedding_endpoint}', task_type => 'SEMANTIC_SIMILARITY'{_connection(cfg)}) AS e\n"
        "  FROM fresh f\n)\n"
        "SELECT post_id, @source AS source, platform, author, SUBSTR(txt, 1, 2000) AS text, url, posted, @now AS seen, followers, engagement,\n"
        "  e.result AS embedding\nFROM embedded\nWHERE ARRAY_LENGTH(e.result) > 0"
    )
    if not home:
        return select
    return (f"INSERT INTO `{check_table_id(home)}` (post_id, source, platform, author, text, url, posted, seen, followers, engagement, embedding)\n" + select)


def join_sql(t: dict[str, str]) -> str:
    """Each post with no story joins the nearest story still taking posts, when it is close enough to its centre."""
    return (
        f"INSERT INTO `{t['early_members']}` (post_id, story_id, sim, joined)\n"
        "WITH pool AS (\n"
        f"  SELECT p.post_id, p.embedding FROM `{t['early_posts']}` p\n"
        f"  LEFT JOIN `{t['early_members']}` m ON m.post_id = p.post_id AND m.joined >= @keep_since\n"
        "  WHERE p.seen >= @pool_since AND m.post_id IS NULL\n"
        "  QUALIFY ROW_NUMBER() OVER (PARTITION BY p.post_id ORDER BY p.seen) = 1\n),\n"
        "active AS (\n"
        f"  SELECT m.story_id, p.embedding FROM `{t['early_members']}` m\n"
        f"  JOIN `{t['early_posts']}` p ON p.post_id = m.post_id AND p.seen >= @keep_since\n"
        f"  WHERE m.joined >= @keep_since AND m.story_id IN (SELECT story_id FROM `{t['early_members']}` WHERE joined >= @active_since)\n),\n"
        "centres AS (\n  SELECT story_id, ARRAY_AGG(v ORDER BY i) AS centre\n"
        "  FROM (SELECT story_id, i, AVG(x) AS v FROM active, UNNEST(embedding) AS x WITH OFFSET AS i GROUP BY story_id, i)\n"
        "  GROUP BY story_id\n),\n"
        "best AS (\n  SELECT pool.post_id, c.story_id, 1 - ML.DISTANCE(pool.embedding, c.centre, 'COSINE') AS sim\n"
        "  FROM pool CROSS JOIN centres c\n  WHERE TRUE\n"
        "  QUALIFY ROW_NUMBER() OVER (PARTITION BY pool.post_id ORDER BY ML.DISTANCE(pool.embedding, c.centre, 'COSINE')) = 1\n)\n"
        "SELECT post_id, story_id, sim, @now FROM best WHERE sim >= @join_sim"
    )


def start_sql(t: dict[str, str]) -> str:
    """Posts with no story start one together: around each new post, its closest posts, when two or more accounts are
    among them. A post near two such groups goes to the bigger one. The story is named after the post it formed around."""
    return (
        f"INSERT INTO `{t['early_members']}` (post_id, story_id, sim, joined)\n"
        "WITH pool AS (\n"
        f"  SELECT p.post_id, p.author, p.embedding, p.seen FROM `{t['early_posts']}` p\n"
        f"  LEFT JOIN `{t['early_members']}` m ON m.post_id = p.post_id AND m.joined >= @keep_since\n"
        "  WHERE p.seen >= @pool_since AND m.post_id IS NULL\n"
        "  QUALIFY ROW_NUMBER() OVER (PARTITION BY p.post_id ORDER BY p.seen) = 1\n),\n"
        "near AS (\n  SELECT a.post_id AS anchor, b.post_id, b.author, 1 - ML.DISTANCE(a.embedding, b.embedding, 'COSINE') AS sim\n"
        "  FROM pool a CROSS JOIN pool b\n"
        "  WHERE a.seen >= @new_since AND 1 - ML.DISTANCE(a.embedding, b.embedding, 'COSINE') >= @start_sim\n"
        "  QUALIFY ROW_NUMBER() OVER (PARTITION BY a.post_id ORDER BY ML.DISTANCE(a.embedding, b.embedding, 'COSINE')) <= @top_k\n),\n"
        "anchors AS (\n  SELECT anchor, COUNT(*) AS size FROM near GROUP BY anchor HAVING COUNT(DISTINCT IFNULL(author, post_id)) >= 2\n),\n"
        "choice AS (\n  SELECT n.post_id, n.anchor, n.sim FROM near n JOIN anchors a ON a.anchor = n.anchor\n  WHERE TRUE\n"
        "  QUALIFY ROW_NUMBER() OVER (PARTITION BY n.post_id ORDER BY a.size DESC, n.anchor) = 1\n)\n"
        "SELECT post_id, anchor, sim, @now FROM choice"
    )


def raise_sql(t: dict[str, str]) -> str:
    """Stories that reached the bar in the window (story), ones already raised that grew (update), and, when asked
    for, small ones worth an early look (early). One story is raised once a day unless it grew."""
    return (
        f"INSERT INTO `{t['early_signals']}` (signal_id, story_id, kind, raised, accounts, posts, platforms, first_posted, last_posted)\n"
        "WITH recent AS (\n"
        f"  SELECT m.story_id, IFNULL(p.author, p.post_id) AS author, p.platform, p.url, p.posted FROM `{t['early_members']}` m\n"
        f"  JOIN `{t['early_posts']}` p ON p.post_id = m.post_id AND p.seen >= @keep_since\n"
        "  WHERE m.joined >= @keep_since AND p.posted >= @window_since\n),\n"
        "stats AS (\n  SELECT story_id, COUNT(DISTINCT author) AS accounts, COUNT(DISTINCT url) AS posts, COUNT(DISTINCT platform) AS n_platforms,\n"
        "    STRING_AGG(DISTINCT platform, ',' ORDER BY platform) AS platforms, MIN(posted) AS first_posted, MAX(posted) AS last_posted\n"
        "  FROM recent GROUP BY story_id\n),\n"
        "scored AS (\n  SELECT *, (accounts >= @min_accounts OR (accounts >= @min_accounts_multi AND n_platforms >= 2)) AND posts >= @min_links AS bar\n"
        "  FROM stats\n),\n"
        "last AS (\n"
        f"  SELECT story_id, kind, accounts, platforms FROM `{t['early_signals']}` WHERE raised >= @day_since\n"
        "  QUALIFY ROW_NUMBER() OVER (PARTITION BY story_id ORDER BY raised DESC) = 1\n)\n"
        "SELECT GENERATE_UUID(), s.story_id,\n"
        "  CASE WHEN l.story_id IS NULL AND s.bar THEN 'story' WHEN l.story_id IS NULL THEN 'early'\n"
        "       WHEN l.kind = 'early' AND s.bar THEN 'story' ELSE 'update' END,\n"
        "  @now, s.accounts, s.posts, s.platforms, s.first_posted, s.last_posted\n"
        "FROM scored s LEFT JOIN last l ON l.story_id = s.story_id\n"
        "WHERE (l.story_id IS NULL AND (s.bar OR (@early AND s.accounts >= @early_accounts AND s.posts >= @min_links)))\n"
        "   OR (l.kind = 'early' AND s.bar)\n"
        "   OR (l.kind IN ('story', 'update') AND ((s.accounts >= 2 * l.accounts AND s.accounts >= l.accounts + 3)\n"
        "       OR s.n_platforms > ARRAY_LENGTH(SPLIT(l.platforms, ','))))"
    )


def read_sql(t: dict[str, str], posts_shown: int) -> str:
    """The stories raised in this read, each with its posts (the most engaged first)."""
    return (
        "SELECT g.signal_id, g.story_id, g.kind, g.raised, g.accounts, g.posts, g.platforms, g.first_posted, g.last_posted,\n"
        "  ARRAY_AGG(STRUCT(p.url AS url, p.platform AS platform, p.author AS author, SUBSTR(p.text, 1, 400) AS text, p.posted AS posted,\n"
        f"    p.followers AS followers, p.engagement AS engagement) ORDER BY IFNULL(p.engagement, 0) DESC, p.posted LIMIT {int(posts_shown)}) AS items\n"
        f"FROM `{t['early_signals']}` g\n"
        f"JOIN `{t['early_members']}` m ON m.story_id = g.story_id AND m.joined >= @keep_since\n"
        f"JOIN `{t['early_posts']}` p ON p.post_id = m.post_id AND p.seen >= @keep_since\n"
        "WHERE g.raised = @now\n"
        "GROUP BY g.signal_id, g.story_id, g.kind, g.raised, g.accounts, g.posts, g.platforms, g.first_posted, g.last_posted"
    )


def _sources(ctx: "AgentContext") -> list[Any]:
    by_key = {s.key: s for s in ctx.config.platform.temp_check.sources if s.enabled and s.table}
    return [by_key[k] for k in ctx.config.platform.early.sources if k in by_key]


def plan(ctx: "AgentContext", now: datetime, cursors: dict[str, str] | None = None) -> list[dict[str, Any]]:
    """Every statement one read runs, in order, each with its own parameters and BigQuery location:
    {what, kind (ingest | ingest_remote | join | start | raise | read), source, location, sql, params}."""
    cfg = ctx.config.platform
    e = cfg.early
    t = tables(ctx)
    home = cfg.bigquery.location or None
    keep = now - timedelta(hours=max(e.active_hours, e.pool_hours) + 24)
    out: list[dict[str, Any]] = []
    for src in _sources(ctx):
        cursor = datetime.fromisoformat(cursors[src.key]) if (cursors or {}).get(src.key) else now - timedelta(minutes=e.interval_minutes)
        location = src.location or home
        same = (location or "").lower() == (home or "").lower()
        prm = {"since": cursor - timedelta(minutes=e.lag_minutes), "until": now, "posted_since": now - timedelta(hours=e.posted_within_hours),
               "max_followers": e.max_followers, "max_engagement": e.max_engagement, "min_chars": e.min_chars, "min_words": e.min_words,
               "skip_authors": [a.lower() for a in e.skip_authors] or [""], "cap": e.posts_per_check, "source": src.key, "now": now}
        if same:
            prm["keep_since"] = keep
        if src.read_sql.strip():  # the stretch a table's own read covers
            prm.update({"t_from": prm["since"], "t_to": now})
        out.append({"what": f"read {src.label or src.key}", "kind": "ingest" if same else "ingest_remote", "source": src.key, "location": location,
                    "sql": ingest_sql(src, e, t["early_posts"] if same else ""), "params": prm})
    base = {"now": now, "keep_since": keep}
    out += [
        {"what": "posts join their story", "kind": "join", "source": "", "location": home, "sql": join_sql(t),
         "params": {**base, "pool_since": now - timedelta(hours=e.pool_hours), "active_since": now - timedelta(hours=e.active_hours), "join_sim": float(e.join_similarity)}},
        {"what": "new stories start", "kind": "start", "source": "", "location": home, "sql": start_sql(t),
         "params": {**base, "pool_since": now - timedelta(hours=e.pool_hours), "start_sim": float(e.start_similarity), "top_k": e.neighbours,
                    "new_since": now - timedelta(minutes=e.interval_minutes + e.lag_minutes)}},
        {"what": "stories are raised", "kind": "raise", "source": "", "location": home, "sql": raise_sql(t),
         "params": {**base, "window_since": now - timedelta(minutes=e.window_minutes), "day_since": now - timedelta(hours=24), "min_accounts": e.min_accounts,
                    "min_accounts_multi": e.min_accounts_two_platforms, "min_links": e.min_links, "early_accounts": e.early_accounts,
                    "early": cfg.flag("early_fast_triage")}},
        {"what": "raised stories are read", "kind": "read", "source": "", "location": home, "sql": read_sql(t, e.posts_shown), "params": dict(base)},
    ]
    return out


# ---------------------------------------------------------------------------------------------------------------
# One read: BigQuery does the reading, the embedding and the grouping
# ---------------------------------------------------------------------------------------------------------------

def _load_state(ctx: "AgentContext", now: datetime) -> dict[str, Any]:
    st = ctx.store.get_kv(STATE) or {}
    day = now.strftime("%Y-%m-%d")
    if st.get("day") != day:
        st.update(day=day, raised=0)
    st.setdefault("cursors", {})
    st.setdefault("sources", {})
    return st


def _ingest(ctx: "AgentContext", gw: Any, step: dict[str, Any], st: dict[str, Any], now: datetime) -> None:
    """One table's read. One table failing never stops the others; it is read again from the same start."""
    e = ctx.config.platform.early
    entry: dict[str, Any] = {"label": step["what"][5:], "at": now.isoformat(), "error": ""}
    try:
        if step["kind"] == "ingest":
            gw.query(step["sql"], step["params"], location=step["location"], labels=LABELS)
            entry["how"] = "written in BigQuery"
        else:  # another location: the rows come back and are written to the agent's table
            posts = tables(ctx)["early_posts"]
            rows = gw.query(step["sql"], step["params"], location=step["location"], max_rows=e.posts_per_check, labels=LABELS)
            held = set()
            if rows:
                held = {r["post_id"] for r in gw.query(f"SELECT post_id FROM `{posts}` WHERE seen >= @keep_since AND post_id IN UNNEST(@ids)",
                                                       {"keep_since": now - timedelta(hours=max(e.active_hours, e.pool_hours) + 24),
                                                        "ids": [r["post_id"] for r in rows]}, labels=LABELS)}
            fresh = [{**r, "posted": _iso(r.get("posted")), "seen": now.isoformat()} for r in rows if r["post_id"] not in held]
            for i in range(0, len(fresh), 100):
                gw.insert_rows(posts, fresh[i:i + 100])
            entry.update(how="read there, written here", posts=len(fresh))
        st["cursors"][step["source"]] = now.isoformat()
        entry["status"] = "live"
    except Exception as exc:  # noqa: BLE001
        entry.update(status="failing", error=str(exc)[:400])
    st["sources"][step["source"]] = entry


def _iso(value: Any) -> Any:
    return value.isoformat() if hasattr(value, "isoformat") else value


def check(ctx: "AgentContext", force: bool = False) -> dict[str, Any]:
    """One read of the post tables, when one is due. Raised stories are kept for their write-up (drain)."""
    from . import bq_admin

    if not ctx.config.platform.flag("early_detection"):
        return {"ok": True, "off": True}
    cfg = ctx.config.platform.early
    now = ctx.now()
    st = _load_state(ctx, now)
    if not force and st.get("last") and now - datetime.fromisoformat(st["last"]) < timedelta(minutes=cfg.interval_minutes):
        return {"ok": True, "due": False}
    out: dict[str, Any] = {"ok": True, "due": True, "raised": 0, "held": 0, "error": ""}
    try:
        if not _sources(ctx):
            raise ValueError("No post table is named. Add one under Settings, Early Detection, sources.")
        gw = bq_admin.get_gateway(ctx)
        steps = plan(ctx, now, st["cursors"])
        if not st.get("tables_ready"):
            provision(ctx)
            st["tables_ready"] = True
        rows: list[dict[str, Any]] = []
        for step in steps:
            if step["kind"].startswith("ingest"):
                _ingest(ctx, gw, step, st, now)
            else:
                rows = gw.query(step["sql"], step["params"], location=step["location"], max_rows=500, labels=LABELS)
        for row in sorted(rows, key=lambda r: ({"story": 0, "update": 1, "early": 2}.get(r["kind"], 3), -int(r.get("accounts") or 0))):
            if out["raised"] >= cfg.max_per_check or st["raised"] >= cfg.max_per_day:
                break
            signal = _record(ctx, row, now)
            out["held" if signal["status"] == "held" else "raised"] += 1
            st["raised"] += signal["status"] != "held"
        failing = [k for k, v in st["sources"].items() if v.get("status") == "failing" and k in cfg.sources]
        if failing:
            out.update(ok=False, error="Could not read: " + ", ".join(failing))
    except Exception as exc:  # noqa: BLE001 - shown on the Early Detection page; the next read tries again
        out.update(ok=False, error=str(exc)[:400])
    st.update(last=now.isoformat(), error=out["error"], last_result={k: out[k] for k in ("raised", "held")})
    ctx.store.put_kv(STATE, st)
    return out


# ---------------------------------------------------------------------------------------------------------------
# Decide: Gemini Decisions scores each raised story
# ---------------------------------------------------------------------------------------------------------------

def signal_input(signal: dict[str, Any], limit: int) -> str:
    """Everything Gemini Decisions is told about a story: counts, platforms, the window and cleaned post snippets."""
    import json

    snippets = [{"platform": i.get("platform") or "", "posted": str(i.get("posted") or "")[:16], "text": decisions.clean_text(i.get("text"), 280)}
                for i in signal["items"][:8]]
    return json.dumps({"kind": "posts on one theme from separate accounts", "accounts": signal["accounts"], "posts": signal["posts"],
                       "platforms": signal["platforms"], "first_posted": str(signal["first_posted"])[:16], "last_posted": str(signal["last_posted"])[:16],
                       "snippets": [s for s in snippets if s["text"]]}, ensure_ascii=False)[:limit]


def questions(ctx: "AgentContext") -> dict[str, dict[str, Any]]:
    """The six questions about a story, in the team's own words (Decisions.gs decSignalQuestions_)."""
    e = ctx.config.platform.early
    company = e.company
    category = {t.name[:128].strip(): (t.description or t.name).strip() for t in ctx.config.collection.exposure_tags if t.name.strip()}
    category[OTHER_RISK] = f"A risk to {company}'s reputation that none of the other options describes."
    category[NO_CATEGORY] = f"No brand-safety issue for {company}: praise, promotion, routine chatter, an unrelated keyword or homonym, or posts that are not about {company}."
    levels = {
        "none": "not a brand-safety issue: an unrelated keyword or homonym, disconnected everyday gripes, routine one-off troubleshooting with no broader incident, fan or promotional content, edited or doctored memes, or copy-paste spam making no real claim.",
        "low": "criticism or a complaint of the kind the lowest-priority Exposure Tags describe (general criticism, a feature request, a meme, a known long-running complaint), with no sign of a wider incident.",
        "medium": "something real may be starting to coalesce: an unverified claim, early bug reports, or a multi-account spike whose root cause is unclear.",
        "high": "multiple independent users converge on a concrete, credible emerging issue: new product breakage, an outage or regression, account lockouts, a security or privacy exposure, a scam or malware using a product, a coordinated boycott or backlash, viral misinformation, or an executive or employee flashpoint.",
        "critical": "an issue the team escalates at any size: dangerous or harmful AI or Search output, child safety or self-harm, offensive or explicit results, perceived bias, a data breach or private data exposed, threats to physical safety, whistleblower or employee misconduct allegations, or backlash against one of the company's own posts or ads.",
    }
    noul = lambda ask, yes, no: {"type": "noul", "instructions": ask, "criteria": {"true_description": yes, "false_description": no}}  # noqa: E731
    return {
        "about": noul(f"Are the posts in `snippets` about {company}: the company, one of its executives, or one of its products or services?", e.about_true, e.about_false),
        "risk": noul(f"Do the posts in `snippets` describe a problem, harm, accusation, security or safety issue, outage, or legal or policy controversy that could damage {company}'s reputation?",
                     "A concrete issue: product breakage, an outage or a regression, account lockouts, dangerous or harmful AI or Search output, a security or privacy exposure, a scam or malware using a product, a boycott or backlash, misinformation, an executive or employee flashpoint, or a lawsuit, antitrust or layoffs controversy.",
                     "Praise, promotion, lifestyle or fan content, a how-to, a feature request, an edited or doctored meme, or copy-paste spam making no real claim."),
        "independent": noul("Are separate accounts in `snippets` reporting the same thing first-hand?",
                            "Multiple independent users converge on the same concrete claim, each in their own words or from their own experience.",
                            "Copies or near-copies of one post, replies in one thread, promotion, or copy-paste spam."),
        "noise": noul("Are the posts in `snippets` routine chatter: support requests, how-to questions, fan or promotional content, or a long-running complaint with nothing new?",
                      "Disconnected everyday gripes, routine one-off troubleshooting with no broader incident, how-to questions, fan or promotional content, or a known, long-running complaint with nothing materially new.",
                      "A new or specific problem, claim or controversy that the accounts raise together."),
        "category": {"type": "choice", "instructions": f"Which of {company}'s brand-safety Exposure Tags best describes what the posts in `snippets` are about?", "criteria": category},
        "severity": {"type": "score", "instructions": f"How severe, for {company}'s reputation, is what the posts in `snippets` describe?",
                     "criteria": [f"{name}: {levels[name]}" for name in SEVERITIES]},
    }


def score(ctx: "AgentContext", signal: dict[str, Any]) -> dict[str, Any] | None:
    """Gemini Decisions' answers about a story, compact ({about, risk, independent, noise, category, severity, level,
    confidence}), or None when it gave none (the story goes on as it would without it)."""
    r = decisions.ask(ctx, signal_input(signal, ctx.config.platform.decisions.input_max_chars), questions(ctx), purpose="early.score")
    if not r["ok"]:
        return None
    a = r["answers"]
    return {"about": round(a["about"]["p"], 2), "risk": round(a["risk"]["p"], 2), "independent": round(a["independent"]["p"], 2),
            "noise": round(a["noise"]["p"], 2), "category": a["category"]["choice"], "severity": round(a["severity"]["score"], 2),
            "level": a["severity"]["level"], "confidence": round(statistics.fmean(a[k]["confidence"] for k in ("about", "risk", "independent", "noise")), 2)}


def held_why(ctx: "AgentContext", kind: str, dec: dict[str, Any] | None) -> str:
    """Why a story is held back on Gemini Decisions' answers ("" when it is not). Without answers nothing is held:
    a story that reached the bar goes on to its write-up, and an early one is simply not raised."""
    d = ctx.config.platform.decisions
    if dec is None:
        return "Gemini Decisions gave no answer, and an early signal is raised only on its answers" if kind == "early" else ""
    sure = dec["confidence"] >= d.confidence_min
    if kind == "early":
        ok = sure and dec["about"] >= d.watch_min and dec["risk"] >= d.watch_min and dec["independent"] >= d.independent_min and dec["level"] >= d.watch_min_level
        return "" if ok else "below the early-signal bars"
    p0 = any(t.name == dec["category"] and t.priority == "P0" for t in ctx.config.collection.exposure_tags)
    if sure and not p0 and dec["level"] <= 1 and (dec["about"] <= d.hold_about_max or dec["noise"] >= d.hold_noise_min):
        return "not about the company" if dec["about"] <= d.hold_about_max else "routine chatter"
    return ""


def _record(ctx: "AgentContext", row: dict[str, Any], now: datetime) -> dict[str, Any]:
    """Keeps one raised story for the Console, scored when Gemini Decisions scoring is ON."""
    items = [{**i, "posted": _iso(i.get("posted"))} for i in (row.get("items") or [])]
    signal: dict[str, Any] = {
        "id": row["signal_id"], "story_id": row["story_id"], "kind": row["kind"], "raised": _iso(row["raised"]), "accounts": int(row.get("accounts") or 0),
        "posts": int(row.get("posts") or 0), "platforms": [p for p in str(row.get("platforms") or "").split(",") if p],
        "first_posted": _iso(row.get("first_posted")), "last_posted": _iso(row.get("last_posted")), "items": items, "env": ctx.config.env,
        "decisions": None, "held_why": "", "review": None, "status": "queued", "by": "", "note": "", "card": "", "tries": 0,
    }
    if ctx.config.platform.flag("early_fast_triage"):
        signal["decisions"] = score(ctx, signal)
        signal["held_why"] = held_why(ctx, signal["kind"], signal["decisions"])
    elif signal["kind"] == "early":
        signal["held_why"] = "early signals need Gemini Decisions scoring"
    if signal["held_why"]:
        signal["status"] = "held"
    dec = signal["decisions"] or {}
    signal["rank"] = [0 if signal["kind"] != "early" else 1, -float(dec.get("severity", 99)), -float(dec.get("risk", 99)), -signal["accounts"]]
    ctx.store.put_doc(SIGNALS, signal["id"], signal)
    ctx.emit("early.raised", actor="agent", payload={k: signal[k] for k in ("id", "story_id", "kind", "accounts", "posts", "platforms", "status", "held_why")})
    return signal


# ---------------------------------------------------------------------------------------------------------------
# Write up: Gemini reads the story with the Knowledge documents
# ---------------------------------------------------------------------------------------------------------------

def _system(ctx: "AgentContext") -> str:
    company = ctx.config.platform.early.company
    tags = "\n".join(f"- {t.name} ({t.priority}): {t.description}" for t in ctx.config.collection.exposure_tags)
    return (
        f"You are the brand-safety early-detection reviewer for {company}. You are given posts from separate low-reach accounts that an "
        "embedding model grouped as one theme. Decide what, if anything, is building.\n"
        f"escalate: several independent accounts converge on a concrete, credible issue for {company}, or it matches a P0 exposure tag.\n"
        "monitor: something real may be starting; worth analyst eyes and a temp check before an alert.\n"
        "dismiss: coincidence, evergreen noise, routine support chatter, promotion, spam, or not about the company.\n"
        "Write for a busy incident manager: plain words, no hype. Name people and outlets only when the posts do. "
        "Use an exposure tag only from this list, spelled exactly, or leave it blank:\n" + tags + "\n"
        "Cite a <knowledge> passage by its id in `citations` when it shaped the call. temp_check_query: a few search words that would find these posts."
    )


def review(ctx: "AgentContext", signal: dict[str, Any]) -> dict[str, Any]:
    """Gemini's write-up of one story: headline, call, severity, the story and next steps."""
    import json

    from . import knowledge

    cfg = ctx.config
    posts = "\n".join(f"P{n + 1} [{i.get('platform') or '?'}, {str(i.get('posted') or '')[:16]}] {i.get('text') or ''}" for n, i in enumerate(signal["items"]))
    passages = []
    if cfg.platform.flag("knowledge_rag"):
        try:
            passages = knowledge.retrieve(ctx, " ".join((i.get("text") or "")[:200] for i in signal["items"][:4]))
        except Exception:  # noqa: BLE001 - the write-up still runs without documents
            log.warning("early review: knowledge unavailable", exc_info=True)
    prompt = (f"<story accounts=\"{signal['accounts']}\" posts=\"{signal['posts']}\" platforms=\"{', '.join(signal['platforms'])}\" "
              f"first=\"{signal['first_posted']}\" last=\"{signal['last_posted']}\">\n{posts}\n</story>\n"
              + (f"<decisions>{json.dumps(signal['decisions'])}</decisions>\n" if signal.get("decisions") else "")
              + (f"<knowledge>\n{knowledge.render_passages(passages, 8000)}\n</knowledge>\n" if passages else ""))
    out = ctx.llm.generate_json(model=cfg.models.triage, system=_system(ctx), prompt=prompt, schema=Review, temperature=0.1, purpose=PURPOSE)
    names = {t.name.lower(): t for t in cfg.collection.exposure_tags}
    tag = names.get(out.exposure_tag.strip().lower())
    out.exposure_tag = tag.name if tag else ""
    data = out.model_dump()
    data["citations"] = knowledge.citations(passages, out.citations) if passages else []
    return data


def card_text(signal: dict[str, Any]) -> str:
    """The story as posted in Chat: headline, the call and the spread, the story, next steps and every post as a link."""
    r = signal["review"]
    head = "*EARLY SIGNAL*" if signal["kind"] == "early" else "*UPDATE*" if signal["kind"] == "update" else "*EARLY DETECTION*"
    lines = [f"{head} · {r['call'].title()} · {r['severity']}", f"*{r['headline']}*",
             f"{signal['accounts']} accounts, {signal['posts']} posts on {', '.join(signal['platforms']) or 'one platform'}", "", r["story"]]
    if r.get("next_steps"):
        lines += ["", "*Next steps*"] + [f"• {s}" for s in r["next_steps"][:4]]
    lines += ["", "*Posts*"] + [f"• <{i['url']}|{(i.get('platform') or 'post')} {n + 1}>" for n, i in enumerate(signal["items"]) if i.get("url")]
    return "\n".join(lines)[:3900]


def drain(ctx: "AgentContext") -> dict[str, Any]:
    """Each minute: Gemini writes up the next raised stories, the most severe first. A dismissed one is kept, not shown as new."""
    if not ctx.config.platform.flag("early_detection"):
        return {"ok": True, "off": True}
    cfg = ctx.config.platform.early
    waiting = sorted(ctx.store.list_docs(SIGNALS, where={"status": "queued"}, limit=200), key=lambda s: (s.get("rank") or [9], s["raised"], s["id"]))
    done, failed = 0, 0
    for signal in waiting[: cfg.reviews_per_minute]:
        try:
            signal["review"] = review(ctx, signal)
            signal["status"] = "dismissed" if signal["review"]["call"] == "dismiss" else "new"
            if signal["status"] == "new" and ctx.config.platform.flag("early_cards"):
                signal["card"] = _post_card(ctx, signal)
            done += 1
        except Exception as exc:  # noqa: BLE001 - tried again next minute, three times at most
            signal["tries"] = int(signal.get("tries") or 0) + 1
            signal["note"] = f"The write-up failed: {exc}"[:300]
            if signal["tries"] >= 3:
                signal["status"] = "failed"
            failed += 1
        ctx.store.put_doc(SIGNALS, signal["id"], signal)
        if signal["status"] == "new":
            ctx.emit("early.reviewed", actor="agent", payload={"id": signal["id"], "kind": signal["kind"], "call": signal["review"]["call"],
                                                               "severity": signal["review"]["severity"], "headline": signal["review"]["headline"]})
    return {"ok": not failed, "written": done, "failed": failed, "waiting": max(0, len(waiting) - done - failed)}


def _post_card(ctx: "AgentContext", signal: dict[str, Any]) -> str:
    """Posts the story in the Routing page's second space (a Google-only space). "" when there is none or Chat refused."""
    from . import chatapi, mirror

    space = mirror._ref(ctx.config.platform.routing.mirror)
    if not space:
        return ""
    try:
        return chatapi.client_for(ctx).post_message(space, card_text(signal), key=f"zeda:{signal['id']}", id_prefix=CARD_PREFIX)["name"]
    except Exception as exc:  # noqa: BLE001 - the story still shows in the Console
        signal["note"] = f"Not posted in Chat: {exc}"[:300]
        return ""


# ---------------------------------------------------------------------------------------------------------------
# The Console's side
# ---------------------------------------------------------------------------------------------------------------

def view(signal: dict[str, Any]) -> dict[str, Any]:
    return {k: signal.get(k) for k in ("id", "story_id", "kind", "raised", "accounts", "posts", "platforms", "first_posted", "last_posted", "items",
                                       "decisions", "held_why", "review", "status", "by", "note", "card", "env")}


def list_signals(ctx: "AgentContext", hours: int = 72, status: str = "") -> list[dict[str, Any]]:
    since = ctx.now() - timedelta(hours=hours)
    rows = ctx.store.list_docs(SIGNALS, where={"status": status} if status else None, limit=1000)
    return [view(s) for s in sorted(rows, key=lambda s: s["raised"], reverse=True) if s["raised"] >= since.isoformat()]


def act(ctx: "AgentContext", signal_id: str, action: str, actor: str, note: str = "") -> dict[str, Any]:
    """A person's step on a story: acknowledge it, escalate it, or dismiss it. Each is on the record."""
    to = {"acknowledge": "acknowledged", "escalate": "escalated", "dismiss": "dismissed", "reopen": "new"}.get(action)
    signal = ctx.store.get_doc(SIGNALS, signal_id)
    if not signal:
        raise KeyError(signal_id)
    if not to:
        raise ValueError("Choose acknowledge, escalate, dismiss or reopen.")
    signal.update(status=to, by=actor, note=note.strip()[:500], decided_at=ctx.now().isoformat())
    ctx.store.put_doc(SIGNALS, signal_id, signal)
    headline = (signal.get("review") or {}).get("headline") or signal["story_id"]
    audit.record(ctx, actor=actor, action=f"early.{action}", surface="console", target_type="early_story", target_id=signal_id,
                 summary=f"{action.title()}d an early story: {headline}"[:300], detail={"note": note[:300]})
    ctx.emit("early.actioned", actor=actor, payload={"id": signal_id, "action": action})
    return view(signal)


def status(ctx: "AgentContext") -> dict[str, Any]:
    st = ctx.store.get_kv(STATE) or {}
    cfg = ctx.config.platform
    return {"on": cfg.flag("early_detection"), "scoring": cfg.flag("early_fast_triage"), "cards": cfg.flag("early_cards"),
            "last": st.get("last", ""), "error": st.get("error", ""), "raised_today": int(st.get("raised") or 0), "last_result": st.get("last_result") or {},
            "sources": [{"key": k, **v} for k, v in sorted((st.get("sources") or {}).items())], "named_sources": list(cfg.early.sources),
            "interval_minutes": cfg.early.interval_minutes, "endpoint": cfg.early.embedding_endpoint}

