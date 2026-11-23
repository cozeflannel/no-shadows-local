"""Safety invariants, enforced at runtime.

Three things live here:
  * the leak guard: what must never be said in a space people outside the company can read
    (ported from the chat bot's Voice.gs GUARD_PATTERNS_ / RAW_GUARD_PATTERNS_ and Outbox.gs OUTBOX_GUARD_PATTERNS_);
  * outbound guards applied to every operation's outputs and to every email draft (allow-listed targets,
    Testing recipients, allowed recipient domains);
  * runtime checks an admin can run from the Console and that run before outbound delivery
    (no hardcoded addresses, switches default OFF, allow-lists sane, identity verified, audit writable).
"""

from __future__ import annotations

import logging
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable

from pydantic import BaseModel, Field

from .config import AgentConfig, FeatureFlags, space_id_of
from .events import PlatformEvent
from .models import SPACE_TARGETS, ChatOutputs

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

log = logging.getLogger(__name__)

EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
TESTERS_MAX = 5
# Addresses that can never reach a mailbox: allowed in source files (tests, docs, the local dev fallback).
SAFE_EMAIL_SUFFIXES = (".test", ".invalid", ".example", ".localhost")
SAFE_EMAIL_DOMAINS = ("example.com", "example.org", "example.net", "system.gserviceaccount.com")

# -- leak guard ------------------------------------------------------------------------------------------------
GUARD_PATTERNS = [
    r"\bforward(?:ed|ing|s)?\b", r"\bsuppress", r"\bdry run\b",
    r"\b(?:clean(?:\s+data)?|triage|triaged|internal|analyst|second|separate|another|other)\s+(?:space|chat|room|channel)s?\b",
    r"\banalysts?\s+(?:space|chat|room|channel)\b",
    r"\breduc(?:e|es|ed|ing)\s+(?:our\s+|google'?s\s+|the\s+)?reliance\b",
    r"\breplac(?:e|es|ed|ing)\s+burson\b", r"\bphase\s+out\s+burson\b",
    r"\bbrand-social-sends\b", r"\bslrr-updates\b", r"\bwd-triage\b", r"\bwatchdog\b", r"[\"“]this is fine[\"”]",
    r"\bpendulum\b", r"\bbig\s?query\b", r"\blistening feeds?\b",
    # wider set, checked on everything bound for an external space
    r"\bauto[\s-]*correct\w*", r"\bwrite-?backs?\b", r"\bwritten\s+back\b", r"\bslrr\b", r"\bmirror(?:s|ed|ing)?\b",
    r"\brelay(?:s|ed|ing)?\b", r"\b(?:the|our|my)\s+bot\b", r"\b(?:qa|q&a|triage)[\s-]*bot\b",
    r"\bautomat(?:ion|ions|ed|ically)\b", r"\bauto[\s-]*(?:sent|submitted)\b",
    r"\bzapier\b", r"\bstand-?ins?\b", r"\boutbox(?:es)?\b", r"\b(?:control|relay|results)\s+tab\b",
    r"\bconsole\b", r"\bpub\s?/?\s?sub\b", r"\bfirestore\b", r"\bagent runtime\b", r"\bdead[\s-]letter",
]
_GUARD_RX = [re.compile(p, re.IGNORECASE) for p in GUARD_PATTERNS]
_GO_LINK_RX = re.compile(r"(?<![\w/])go/[\w-]+", re.IGNORECASE)


_ROBOT = re.compile("\U0001F916\ufe0f?")


def unmarked(config: AgentConfig, text: str) -> str:
    """A text for Burson's space, or for the copy that shows what Burson would read, without the agent's prefix or the
    robot emoji: nothing there shows it was written by a bot. Posts in the internal spaces keep the prefix."""
    t = str(text or "")
    prefix = (config.agent.message_prefix or "").strip()
    if prefix:
        t = re.sub(rf"(?m)^([ \t]*){re.escape(prefix)}[ \t]*", r"\1", t)
    t = _ROBOT.sub("", t)
    return re.sub(r"(?m)[ \t]+$", "", re.sub(r"[ \t]{2,}", " ", t)).strip()


class GuardResult(BaseModel):
    ok: bool = True
    hits: list[str] = Field(default_factory=list)


def _taxonomy_rx(config: AgentConfig) -> re.Pattern[str] | None:
    names: list[str] = []
    for t in config.collection.exposure_tags:
        names += [t.name, *getattr(t, "aliases", [])]
    for t in config.collection.sensitive_topics:
        names += [t.name, *getattr(t, "aliases", [])]
    for p in config.distribution.products:
        names += [p.name, *getattr(p, "aliases", [])]
    alts = "|".join(re.escape(n) for n in sorted({n for n in names if n and len(n) > 2}, key=len, reverse=True))
    return re.compile(rf"(?<![\w-])(?:{alts})(?![\w-])", re.IGNORECASE) if alts else None


def guard_terms(config: AgentConfig, external_key: str | None = None) -> list[str]:
    """Names and ids of every space that is not the external one, plus the configured terms."""
    terms = [t for t in config.platform.safety.leak_terms if t and t.strip()]
    external = set(config.platform.safety.external_spaces)
    for s in config.spaces:
        if s.key in external or s.key == external_key:
            continue
        if s.display_name and len(s.display_name) > 3:
            terms.append(s.display_name)
        sid = space_id_of(s.space_id) or space_id_of(s.url)
        if sid:
            terms.append(sid)
    return terms


def internal_addresses(config: AgentConfig) -> set[str]:
    """Every address the settings hold for the company's own people and lists."""
    found: set[str] = set()

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for v in node.values():
                walk(v)
        elif isinstance(node, (list, tuple)):
            for v in node:
                walk(v)
        elif isinstance(node, str) and "@" in node:
            found.update(m.lower().rstrip(".") for m in EMAIL_RE.findall(node))

    dump = config.model_dump(mode="json", include={"analysts", "distribution", "escalation", "tns", "protocols", "stakeholders", "agent"})
    walk(dump)
    return found


def leak_guard(config: AgentConfig, text: str, *, allow: Iterable[str] = (), allow_emails: Iterable[str] = (),
               external_key: str | None = None) -> GuardResult:
    """What `text` names that an external space must not see. Pure.

    Taxonomy names (products, exposure tags, Sensitive Topics) are set aside first, as are `allow` values taken from
    the external party's own message. Case ids stay allowed: the correction loop ties a rerun to its case by id.
    Escalation ids, go/ links and the company's own addresses (its domains, and every address in the settings) are
    hits; an outside person's own address is not (a reply mentions the person it answers).
    """
    t = str(text or "")
    for a in allow:
        if a and len(str(a)) > 1:
            t = t.replace(str(a), " ")
    hits: list[str] = []
    allowed = {e.lower() for e in allow_emails if e}
    domains = {d.strip().lower().lstrip("@") for d in config.platform.access.viewer_domains if d.strip()}
    known = internal_addresses(config)
    for m in EMAIL_RE.findall(t):
        addr = m.lower().rstrip(".")
        if addr in allowed:
            continue
        if addr in known or addr.rsplit("@", 1)[-1] in domains:
            hits.append(m)
    m = _GO_LINK_RX.search(t)
    if m:
        hits.append(m.group(0))
    m = re.search(rf"\b{re.escape(config.escalation_id_prefix)}-\d+", t, re.IGNORECASE)
    if m:
        hits.append(m.group(0))
    rx = _taxonomy_rx(config)
    if rx is not None:
        t = rx.sub(" ", t)
    for pattern in _GUARD_RX:
        m = pattern.search(t)
        if m:
            hits.append(m.group(0))
    low = t.lower()
    for term in guard_terms(config, external_key):
        if term.lower() in low:
            hits.append(term)
    return GuardResult(ok=not hits, hits=list(dict.fromkeys(hits)))


# -- outbound guards -------------------------------------------------------------------------------------------
def _external_roster_emails(ctx: "AgentContext") -> list[str]:
    try:
        return [p.email for p in ctx.roster("burson").people if p.email]
    except Exception:  # noqa: BLE001
        return []


LIVE_GROUP_TARGETS = frozenset({"team", "youtube", "doodle", "crisis", "handover"})


def testing_space_block(ctx: "AgentContext", target: str = "", space: str = "") -> str:
    """When Testing (`Safety valve`) is ON, hold writes to live team and partner group spaces (`24/7 SL Team`,
    `YouTube`, `Doodle`, `Crisis`, `Handover`) unless the target points at the sandbox clean/copy space."""
    if not ctx.config.platform.safety.testing:
        return ""
    from . import chatapi, mirror

    r = ctx.config.platform.routing
    sandbox: list[str] = []
    for raw in (r.mirror, r.third):
        s = mirror._ref(raw)
        if s:
            sandbox.append(s)
    clean_ref = ctx.config.space("clean")
    if clean_ref:
        cs = chatapi.space_name(clean_ref.space_id, clean_ref.url)
        if cs:
            sandbox.append(cs)
    if space and any(mirror._same(space, s) for s in sandbox):
        return ""
    tgt = target.strip().lower()
    if tgt in LIVE_GROUP_TARGETS:
        return "Testing is ON: nothing is posted to live team or partner spaces (only the clean/copy space and testing DMs)."
    if space:
        for key in LIVE_GROUP_TARGETS:
            ref = ctx.config.space(key)
            if ref:
                ks = chatapi.space_name(ref.space_id, ref.url)
                if ks and mirror._same(space, ks):
                    return "Testing is ON: nothing is posted to live team or partner spaces."
    return ""


def target_block(ctx: "AgentContext", target: str, text: str) -> tuple[str, list[str]]:
    """Why a message for `target` may not be posted as things stand ("" when it may), and the leak terms found.
    Asked when an operation hands over its outputs, and again when a queued post is about to be posted."""
    from . import mirror

    cfg = ctx.config
    safety = cfg.platform.safety
    if target not in {t.strip().lower() for t in safety.allowed_post_targets}:
        return "target_not_allowed", []
    if mirror.is_source_target(ctx, target) and not mirror.mode(ctx)["live"]:  # the Routing page's source space: written only when it is open
        return ("safety_valve" if safety.testing else "routing"), []
    if target in set(safety.external_spaces):
        result = leak_guard(cfg, text, allow_emails=_external_roster_emails(ctx), external_key=target)
        if not result.ok:
            return "leak_guard", result.hits
    return "", []


def _shown_in_copies(ctx: "AgentContext", text: str, thread: str, op: str, case_id: str) -> dict[str, Any]:
    """A reply held only because the source space is closed is shown in the second space, when one is set. One that
    names something internal is not: it would not have gone to the source space either. When that cannot be told
    (Chat did not answer), it is not shown."""
    from . import mirror

    r = ctx.config.platform.routing
    if not r.bot_on or not r.mirror.strip():
        return {}
    try:
        hits = mirror._leaks(ctx, text)
    except Exception:  # noqa: BLE001 - not shown rather than shown wrongly
        log.warning("could not check a held reply before showing it in the second space", exc_info=True)
        return {}
    if hits:
        return {"hits": hits}
    return {"copied_to": "the second space"} if mirror.reply_in_copies(ctx, text, thread=thread, origin=op, case_id=case_id) else {}


def guard_outputs(ctx: "AgentContext", outputs: ChatOutputs, *, op: str = "", actor: str = "agent",
                  thread: str = "") -> tuple[ChatOutputs, list[dict[str, Any]]]:
    """Hold back any output that fails a guard. Returns (safe outputs, what was held and why).
    `thread`: the thread, in the source space, of the message these outputs answer. A post held only because the
    source space is closed is still shown in the second space, under that message's copy (mirror.reply_in_copies)."""
    cfg = ctx.config
    safety = cfg.platform.safety
    held: list[dict[str, Any]] = []
    out = outputs
    allowed_targets = {t.strip().lower() for t in safety.allowed_post_targets}
    for target, text in list(outputs.target_texts().items()):
        from . import mirror

        reason, hits = target_block(ctx, target, text)
        source = mirror.is_source_target(ctx, target)
        closed = source and reason in ("safety_valve", "routing")  # held for where it goes, not for what it says
        if not reason and source and cfg.platform.routing.ask_before_source:
            queued = mirror.send(ctx, text, thread=thread, origin=op, case_id=outputs.case_id, actor=actor)
            reason = "waits_for_send" if queued["status"] == "waiting" else "routing"
        if reason:
            if out is outputs:
                out = outputs.model_copy(deep=True)
            out.set_target(target, "")
            held.append({"target": target, "check": reason, "hits": hits, "chars": len(text)})
            if closed:
                held[-1].update(_shown_in_copies(ctx, text, thread, op, outputs.case_id))
    if outputs.dm_text.strip() and outputs.dm_recipients and "dm" not in allowed_targets:
        if out is outputs:
            out = outputs.model_copy(deep=True)
        out.dm_text, out.dm_recipients = "", []
        held.append({"target": "dm", "check": "target_not_allowed", "hits": [], "chars": len(outputs.dm_text)})
    for h in held:
        if h["check"] == "waits_for_send":
            continue  # not blocked: it waits on the Routing page for a person's Send (recorded there)
        try:
            ctx.emit(PlatformEvent.SAFETY_BLOCKED, actor=actor, case_id=outputs.case_id or None,
                     escalation_id=outputs.escalation_id or None, payload={"op": op, **h})
        except Exception:  # noqa: BLE001
            log.warning("could not record a blocked output", exc_info=True)
        from . import audit

        audit.record(ctx, actor=actor, action="safety.block", surface="agent", target_type="output", target_id=h["target"],
                     summary=f"Held a message to {h['target']}: {h['check']}" + (f" ({', '.join(h['hits'][:4])})" if h["hits"] else ""),
                     status="blocked", case_id=outputs.case_id or None, escalation_id=outputs.escalation_id or None,
                     detail={"op": op, **h})
    return out, held


def testing_recipients(cfg: AgentConfig) -> list[str] | None:
    """The stand-in recipients while Testing, or None when Testing is off.

    Testing is ON when the Console switch says so or when the control sheet supplied stand-ins
    (escalation.stand_in, filled from its "Testing: send to" cell outside prod)."""
    safety = cfg.platform.safety
    stand_in = [e.strip() for e in re.split(r"[,;\s]+", cfg.escalation.stand_in or "") if e.strip()]
    if not safety.testing and not stand_in:
        return None
    merged = list(dict.fromkeys([*(e.strip() for e in safety.testing_recipients if e.strip()), *stand_in]))
    return [e for e in merged if EMAIL_RE.fullmatch(e)][:TESTERS_MAX]


def filter_recipients(cfg: AgentConfig, recipients: Iterable[str]) -> tuple[list[str], list[str]]:
    """(kept, dropped) by the allowed recipient domains. No list = nothing dropped."""
    domains = {d.strip().lower().lstrip("@") for d in cfg.platform.safety.allowed_recipient_domains if d.strip()}
    kept, dropped = [], []
    for r in recipients:
        if not r:
            continue
        domain = r.rsplit("@", 1)[-1].lower()
        (kept if not domains or domain in domains else dropped).append(r)
    return kept, dropped


class SafeGmail:
    """Wraps the Gmail gateway: Testing recipients and the recipient allow-list apply to every draft.

    While Testing, each draft goes only to the stand-ins, with one last line naming how many real recipients it
    would have had (never their addresses). With Testing on and no stand-in, the draft is made with no recipients:
    nothing can be sent by mistake.
    """

    def __init__(self, inner: Any, ctx_getter: Any):
        self._inner = inner
        self._ctx = ctx_getter

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    def _apply(self, fields: dict[str, Any]) -> dict[str, Any]:
        ctx = self._ctx()
        cfg = ctx.config
        present = [k for k in ("to", "cc", "bcc") if k in fields and fields[k] is not None]
        if not present:
            return fields
        fields = dict(fields)
        dropped_all: list[str] = []
        for key in present:
            kept, dropped = filter_recipients(cfg, fields[key] or [])
            fields[key] = kept
            dropped_all += dropped
        stand_ins = testing_recipients(cfg)
        note = ""
        if stand_ins is not None:
            real = sum(len(fields[k] or []) for k in present)
            for key in present:
                fields[key] = []
            fields["to"] = list(stand_ins)
            note = f"[Testing: this draft would have gone to {real} recipient{'s' if real != 1 else ''}.]"
            if isinstance(fields.get("body"), str) and note not in fields["body"]:
                fields["body"] = f"{fields['body'].rstrip()}\n\n{note}"
        if dropped_all or stand_ins is not None:
            try:
                ctx.emit(PlatformEvent.SAFETY_CHECKED, payload={
                    "check": "email_recipients", "testing": stand_ins is not None,
                    "stand_ins": len(stand_ins or []), "dropped_by_domain": len(dropped_all)})
            except Exception:  # noqa: BLE001
                log.warning("could not record the recipient check", exc_info=True)
        return fields

    def create_draft(self, user_email: str, **fields: Any) -> dict:
        return self._inner.create_draft(user_email, **self._apply(fields))

    def update_draft(self, user_email: str, draft_id: str, **fields: Any) -> dict:
        return self._inner.update_draft(user_email, draft_id, **self._apply(fields))


# -- runtime checks --------------------------------------------------------------------------------------------
class CheckResult(BaseModel):
    id: str
    title: str
    passed: bool
    severity: str = "blocker"  # blocker | warning
    detail: str = ""
    fix: str = ""


def _safe_address(addr: str) -> bool:
    domain = addr.rsplit("@", 1)[-1].lower().rstrip(".")
    return domain.endswith(SAFE_EMAIL_SUFFIXES) or domain in SAFE_EMAIL_DOMAINS or any(domain.endswith("." + d) for d in SAFE_EMAIL_DOMAINS)


@lru_cache(maxsize=1)
def scan_source_for_addresses() -> tuple[str, ...]:
    """Email addresses written in the deployed code (never allowed: recipients come from the Console)."""
    root = Path(__file__).resolve().parent.parent
    found: list[str] = []
    for folder in ("triage_agent", "console/backend", "jobs", "slrr_campaigns"):
        base = root / folder
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*.py")):
            try:
                text = path.read_text(encoding="utf-8")
            except OSError:
                continue
            for lineno, line in enumerate(text.splitlines(), start=1):
                for m in EMAIL_RE.findall(line):
                    if "{" in m or "}" in m or _safe_address(m) or m.lower().startswith(("noreply@", "git@")):
                        continue
                    found.append(f"{path.relative_to(root)}:{lineno}")
    return tuple(found)


def run_checks(ctx: "AgentContext") -> list[CheckResult]:
    cfg = ctx.config
    safety, flags = cfg.platform.safety, cfg.platform.flags
    out: list[CheckResult] = []

    hits = scan_source_for_addresses()
    out.append(CheckResult(
        id="no_hardcoded_emails", title="No email address is written in the code", passed=not hits,
        detail="None found." if not hits else f"{len(hits)} found: {', '.join(hits[:5])}",
        fix="Move each address into Settings (Distribution, Rosters or Safety)."))

    defaults_on = [name for name, field in FeatureFlags.model_fields.items() if field.default is not False]
    out.append(CheckResult(
        id="switches_default_off", title="Every switch starts OFF", passed=not defaults_on,
        detail="All feature switches default to OFF." if not defaults_on else f"Default ON: {', '.join(defaults_on)}",
        fix="Set the default of each listed switch to False."))

    known_targets = set(SPACE_TARGETS) | {"dm", "handover"}
    unknown = sorted(set(safety.allowed_post_targets) - known_targets)
    out.append(CheckResult(
        id="post_allow_list", title="Post targets are an explicit allow-list", passed=bool(safety.allowed_post_targets) and not unknown,
        detail=f"Allowed: {', '.join(safety.allowed_post_targets) or 'none'}." + (f" Unknown: {', '.join(unknown)}." if unknown else ""),
        fix="Settings → Safety: list only targets the agent should post to."))

    missing_ext = [k for k in safety.external_spaces if cfg.space(k) is None]
    out.append(CheckResult(
        id="external_spaces", title="External spaces are named", passed=bool(safety.external_spaces) and not missing_ext,
        detail=f"Guarded: {', '.join(safety.external_spaces) or 'none'}." + (f" Not in Spaces: {', '.join(missing_ext)}." if missing_ext else ""),
        fix="Settings → Safety: list every space key people outside the company can read."))

    probe_bad = leak_guard(cfg, "We will forward this to the analyst space; the bot auto-corrected it.")
    probe_good = leak_guard(cfg, "Please update the link on this alert and resend it. Thank you.")
    out.append(CheckResult(
        id="leak_guard", title="The leak guard holds internal wording and passes plain wording",
        passed=(not probe_bad.ok) and probe_good.ok,
        detail=f"Internal sample held ({len(probe_bad.hits)} terms); plain sample {'passed' if probe_good.ok else 'held: ' + ', '.join(probe_good.hits)}.",
        fix="A configured leak term matches plain wording: narrow it in Settings → Safety."))

    stand_ins = testing_recipients(cfg)
    if stand_ins is None:
        out.append(CheckResult(id="testing_mode", title="Testing mode", passed=True, severity="warning",
                               detail="Testing is OFF: drafts carry their real recipients.", fix=""))
    else:
        over = len([e for e in safety.testing_recipients if e.strip()]) > TESTERS_MAX
        out.append(CheckResult(
            id="testing_mode", title="Testing mode", passed=not over, severity="warning",
            detail=(f"Testing is ON: every draft and DM goes to {len(stand_ins)} stand-in recipient(s), and live team/partner spaces are held." if stand_ins
                    else "Testing is ON with no stand-in: drafts are made with no recipients, and DMs plus live team/partner spaces are held."),
            fix=f"At most {TESTERS_MAX} testing recipients are used."))

    bad_domains = [d for d in safety.allowed_recipient_domains if not re.fullmatch(r"@?[\w-]+(\.[\w-]+)+", d.strip())]
    out.append(CheckResult(
        id="recipient_domains", title="Recipient domains are well formed", passed=not bad_domains, severity="warning",
        detail=(f"Drafts are limited to: {', '.join(safety.allowed_recipient_domains)}." if safety.allowed_recipient_domains
                else "No domain restriction is set.") + (f" Invalid: {', '.join(bad_domains)}." if bad_domains else ""),
        fix="Enter domains like corp.test, one per line."))

    out.append(CheckResult(
        id="agent_identity", title="The agent's own account is set", passed=bool(cfg.agent.email.strip()), severity="warning",
        detail="Set." if cfg.agent.email.strip() else "Not set: the agent can only tell its own messages by their prefix.",
        fix="Settings → Agent behavior → Agent identity: enter the Triage Agent account."))

    deployed = os.environ.get("TRIAGE_BACKEND", "local") == "gcp" or bool(os.environ.get("K_SERVICE", "").strip())
    if in_worker(ctx):  # the worker has no sign-in page: it verifies the token Google signs for each caller instead
        sched = os.environ.get("TRIAGE_SCHEDULER_SA", "").strip().lower()
        push = (cfg.platform.pubsub.push_service_account or "").strip().lower()
        callers = (["the scheduler's account"] if sched else []) + (["the push account"] if push and push != sched else [])
        out.append(CheckResult(
            id="signed_identity", title="Calls to the worker are verified", passed=bool(callers) or not deployed,
            detail=(f"The worker only takes calls signed by {' or '.join(callers)}." if callers else
                    ("Local run: no signed calls are needed." if not deployed else "No account may call the worker, so it refuses every call.")),
            fix="Redeploy the worker with infra/09_worker.sh: it sets the scheduler's account."))
    else:
        audience = bool(os.environ.get("TRIAGE_IAP_AUDIENCE", "").strip())
        out.append(CheckResult(
            id="signed_identity", title="Console identity is verified", passed=(audience or not deployed),
            detail=("The signed IAP assertion is verified." if audience else
                    ("Local run: the dev identity is used." if not deployed else "The IAP audience is not set: sign-in is refused.")),
            fix="Redeploy the Console with the deploy script: it sets the IAP audience."))

    try:
        ctx.store.put_doc("health", "audit_probe", {"at": ctx.now().isoformat()})
        ok = ctx.store.get_doc("health", "audit_probe") is not None
    except Exception as exc:  # noqa: BLE001
        ok = False
        log.warning("store probe failed: %s", exc)
    out.append(CheckResult(id="audit_store", title="The audit store can be written", passed=ok,
                           detail="Write and read succeeded." if ok else "The store refused a write.",
                           fix="Check the service account's Firestore access."))

    ps = cfg.platform.pubsub
    if flags.pubsub_delivery:
        ready = bool(ps.outbound_topic and ps.dead_letter_topic)
        out.append(CheckResult(
            id="pubsub", title="Outbound delivery has a topic and a dead-letter topic", passed=ready,
            detail="Both are set." if ready else "Pub/Sub delivery is ON but a topic is missing: actions are delivered directly.",
            fix="Settings → Delivery: set both topics, or use Provision."))

    secretish = []
    overrides = {}
    try:
        overrides = ctx.store.get_config_overrides() or {}
    except Exception:  # noqa: BLE001
        log.warning("could not read overrides for the secret check", exc_info=True)

    def walk(node: Any, path: str) -> None:
        if isinstance(node, dict):
            for k, v in node.items():
                walk(v, f"{path}.{k}" if path else str(k))
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, f"{path}[{i}]")
        elif isinstance(node, str) and re.search(r"(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bya29\.[\w-]{20,}|\bAIza[\w-]{30,}|\bsk-[\w-]{20,})", node):
            secretish.append(path)

    walk(overrides, "")
    out.append(CheckResult(
        id="no_secrets_in_settings", title="No secret value is kept in settings", passed=not secretish,
        detail="None found." if not secretish else f"Looks like a secret: {', '.join(secretish[:5])}",
        fix="Put the value in Settings → Secrets and keep only the secret's name in the setting."))
    return out


def in_worker(ctx: "AgentContext") -> bool:
    """True in the worker service: it marks the context it works with (console/backend/worker.py get_ctx), and Cloud Run
    names it after the Console with "-worker" at the end (infra/09_worker.sh). The worker takes only calls Google signed
    for the scheduler's account or the Pub/Sub push account (worker.verify_caller)."""
    return getattr(ctx, "service", "") == "worker" or os.environ.get("K_SERVICE", "").strip().endswith("-worker")


def blocking_failures(ctx: "AgentContext") -> list[CheckResult]:
    return [c for c in run_checks(ctx) if not c.passed and c.severity == "blocker"]
