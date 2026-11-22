"""Gemini Decisions: the decision maker (a port of apps-script-chat-bot/Decisions.gs).

The Decisions API answers typed questions about one input with calibrated probabilities and writes no text, so the
agent can sort, rank and filter on numbers. Everything a person reads is still written by Gemini. Three kinds of
question: `noul` (yes or no), `choice` (one of the options) and `score` (a level on a rubric).

One call, never retried. A failure pauses every call for a while and the caller carries on as it did without it
(fail open). The safety filter refusing one input is counted and pauses nothing. The API key is the value of the
secret named in Settings; it is sent in a header, never in an address, and never logged.
"""

from __future__ import annotations

import json
import logging
import re
import time
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

log = logging.getLogger(__name__)

STATE = "decisions:state"   # {day, asked, failed, refused, tokens, until, why}
REFUSAL_CODES = ("safety", "blocked", "prohibited_content", "content_filter", "blocklist")
ID_DIGITS = 8               # a run of this many digits is taken for an id and cut (a CVE number has 4 to 7)
_CUT = (re.compile(r"https?://\S+|www\.\S+", re.I), re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"), re.compile(r"(?<![\w/])@\w{1,40}"),
        re.compile(r"\bu/[\w-]{1,40}", re.I), re.compile(r"\b(?:spaces|users)/[\w/-]+"), re.compile(r"\d{%d,}" % ID_DIGITS))


def clean_text(text: Any, limit: int) -> str:
    """Public post text as it may be sent: no link, email address, @handle, u/ name, Chat name or long id, on one line."""
    out = str(text or "")
    for rx in _CUT:
        out = rx.sub("", out)
    return re.sub(r"\s+", " ", out).strip()[:limit]


def _key(ctx: "AgentContext") -> str:
    from . import secret_admin

    return secret_admin.read(ctx, ctx.config.platform.decisions.secret).strip()


def _post(url: str, key: str, body: dict[str, Any], timeout: float) -> tuple[int, str]:
    import requests

    resp = requests.post(url, headers={"x-goog-api-key": key, "Content-Type": "application/json"}, data=json.dumps(body), timeout=timeout)
    return resp.status_code, resp.text


def _state(ctx: "AgentContext") -> dict[str, Any]:
    day = ctx.now().strftime("%Y-%m-%d")
    st = ctx.store.get_kv(STATE) or {}
    if st.get("day") != day:
        st = {"day": day, "asked": 0, "failed": 0, "refused": 0, "tokens": 0, "until": st.get("until", ""), "why": st.get("why", "")}
    return st


def _unit(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if 0 <= f <= 1 else None


def read_answer(a: Any, q: dict[str, Any]) -> dict[str, Any] | None:
    """One answer as the agent reads it, or None when it is not the answer to question `q`."""
    if not isinstance(a, dict) or a.get("type") != q.get("type"):
        return None
    conf = _unit(a.get("confidence"))
    if q["type"] == "noul":
        p = _unit(a.get("noul"))
        return None if p is None else {"type": "noul", "p": p, "confidence": conf if conf is not None else max(p, 1 - p)}
    probs = a.get("probabilities")
    if not isinstance(probs, dict):
        return None
    if q["type"] == "choice":
        options = list(q.get("criteria") or {})
        choice = str(a.get("choice") or "")
        p = _unit(probs.get(choice))
        if choice not in options or p is None:
            return None
        return {"type": "choice", "choice": choice, "p": p, "probabilities": {o: _unit(probs.get(o)) for o in options if _unit(probs.get(o)) is not None},
                "confidence": conf if conf is not None else p}
    if q["type"] == "score":
        levels = len(q.get("criteria") or [])
        try:
            score = float(a.get("score"))
        except (TypeError, ValueError):
            return None
        each = [_unit(probs.get(str(i))) for i in range(levels)]
        if not levels or not 0 <= score <= levels - 1 or any(p is None for p in each):
            return None
        level = max(range(levels), key=lambda i: each[i])
        return {"type": "score", "score": score, "level": level, "probabilities": each, "confidence": conf if conf is not None else each[level]}
    return None


def _read(status: int, text: str, questions: dict[str, Any], ms: int, slow_ms: int) -> dict[str, Any]:
    try:
        body = json.loads(text or "null")
    except ValueError:
        body = None
    body = body if isinstance(body, dict) else {}
    if status != 200:
        err = body.get("error") if isinstance(body.get("error"), dict) else {}
        name = next((str(v).strip() for v in (err.get("code"), err.get("status")) if v not in (None, "") and str(v).strip() != str(status)), "")
        label = re.sub(r"\s+", " ", re.sub(r"[^A-Za-z0-9_ -]+", " ", name)).strip().lower()[:40]
        if status == 400 and label in REFUSAL_CODES:
            return {"ok": False, "refused": True, "why": f"the safety filter refused the input ({label})"}
        return {"ok": False, "why": f"HTTP {status}" + (f": {label}" if label else "")}
    block = str(((body.get("prompt_feedback") or {}) if isinstance(body.get("prompt_feedback"), dict) else {}).get("block_reason") or "")
    if block:
        return {"ok": False, "refused": True, "why": f"the safety filter refused the input ({block.lower()[:40]})"}
    got = body.get("answers") if isinstance(body.get("answers"), dict) else None
    if got is None:
        return {"ok": False, "why": "an answer that couldn't be read"}
    answers = {}
    for key, q in questions.items():
        answer = read_answer(got.get(key), q)
        if not answer:
            return {"ok": False, "why": f"an answer that couldn't be read ({key})"}
        answers[key] = answer
    if ms > slow_ms:
        return {"ok": False, "why": f"a slow answer ({round(ms / 1000)} s)"}
    tokens = (body.get("usage") or {}).get("total_input_tokens") if isinstance(body.get("usage"), dict) else 0
    return {"ok": True, "answers": answers, "tokens": int(tokens or 0), "ms": ms}


def ask(ctx: "AgentContext", text: str, questions: dict[str, dict[str, Any]], *, purpose: str = "") -> dict[str, Any]:
    """Asks `questions` ({key: {type, instructions, criteria}}) about `text` in ONE call. Never raises.

    {ok: True, answers, tokens, ms}, or {ok: False, why} with `skipped` when no call was made (a cap, a pause, no key)
    or `refused` when the safety filter turned the input down."""
    cfg = ctx.config.platform.decisions
    text = (text or "").strip()[: cfg.input_max_chars]
    if not text or not questions:
        return {"ok": False, "skipped": True, "why": "nothing to ask"}
    if not cfg.secret.strip():
        return {"ok": False, "skipped": True, "why": "no API key is set (Settings, Gemini Decisions)"}
    now = ctx.now()
    st = _state(ctx)
    if st.get("until") and datetime.fromisoformat(st["until"]) > now:
        return {"ok": False, "skipped": True, "why": "paused after a failure" + (f" ({st['why']})" if st.get("why") else "")}
    if st["asked"] >= cfg.max_per_day:
        return {"ok": False, "skipped": True, "why": f"{cfg.max_per_day} calls today"}
    key = ""
    st.update(asked=st["asked"] + 1, until="", why="")  # counted before the call: one that dies mid-call still counts
    ctx.store.put_kv(STATE, st)
    try:
        key = _key(ctx)
        if not key:
            raise RuntimeError("the secret is empty")
        t0 = time.monotonic()
        status, body = _post(f"{cfg.base_url.rstrip('/')}/{cfg.api_version}/decisions", key,
                             {"model": cfg.model, "input": text, "questions": questions}, max(5.0, cfg.slow_ms / 1000 * 2))
        out = _read(status, body, questions, int((time.monotonic() - t0) * 1000), cfg.slow_ms)
    except Exception as exc:  # noqa: BLE001 - fail open: the caller carries on without an answer
        why = str(exc)
        out = {"ok": False, "why": re.sub(r"\s+", " ", why.replace(key, "[key]") if key else why).strip()[:120] or "no answer"}
    st = _state(ctx)
    if out["ok"]:
        st["tokens"] += out["tokens"]
    elif out.get("refused"):
        st["refused"] += 1
    else:
        st.update(failed=st["failed"] + 1, until=(now + timedelta(minutes=cfg.pause_minutes)).isoformat(), why=out["why"])
        log.warning("Gemini Decisions: %s; no calls for %s minutes (work goes on without it)", out["why"], cfg.pause_minutes)
    ctx.store.put_kv(STATE, st)
    try:
        ctx.emit("decisions.asked", actor="agent", payload={"purpose": purpose, "ok": out["ok"], "why": out.get("why", ""),
                                                             "tokens": out.get("tokens", 0), "ms": out.get("ms", 0), "questions": list(questions)})
    except Exception:  # noqa: BLE001 - the record is best effort
        log.debug("could not record a Decisions call", exc_info=True)
    return out


def status(ctx: "AgentContext") -> dict[str, Any]:
    """Today's calls, and whether calls are paused (the AI page)."""
    st = _state(ctx)
    paused = bool(st.get("until")) and datetime.fromisoformat(st["until"]) > ctx.now()
    return {"connected": bool(ctx.config.platform.decisions.secret.strip()), "model": ctx.config.platform.decisions.model,
            "today": {k: int(st.get(k) or 0) for k in ("asked", "failed", "refused", "tokens")},
            "paused_until": st["until"] if paused else "", "paused_why": st.get("why", "") if paused else ""}


# ---------------------------------------------------------------------------------------------------------------
# What it is asked
# ---------------------------------------------------------------------------------------------------------------

def class_question(classes: list[Any]) -> dict[str, Any]:
    """Which class an alert falls in: one option for each class, described in the team's own words (Settings)."""
    return {"type": "choice", "instructions": "Which kind of brand-safety alert is described in the input?",
            "criteria": {c.name[:128].strip(): (c.description or c.name).strip() for c in classes if c.name.strip()}}


def classify(ctx: "AgentContext", fields: dict[str, Any], classes: list[Any]) -> dict[str, Any] | None:
    """The alert's class as Gemini Decisions sees it ({label, confidence}), or None when it gave no usable answer."""
    cfg = ctx.config.platform.decisions
    parts = [str(fields.get(k) or "") for k in ("alert_name", "summary", "description", "post_text", "product", "exposure_tag", "sensitive_topic")]
    text = clean_text(" | ".join(p for p in parts if p) or json.dumps(fields, default=str), cfg.input_max_chars)
    r = ask(ctx, text, {"class": class_question(classes)}, purpose="triage.classify")
    if not r["ok"]:
        return None
    a = r["answers"]["class"]
    return {"label": a["choice"], "confidence": round(a["confidence"], 2), "sure": a["confidence"] >= cfg.class_min_confidence}
