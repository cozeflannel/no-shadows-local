"""Planning for the demo seed: arrival times, outcomes, templates, novelty (NEW/ONGOING),
scripted rare paths (so every KPI is non-trivial) and Path B in-house parity pairs."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from . import demo_data as D
from .demo_sim import Sim, Spec

Arrival = tuple[datetime, str, dict]  # (received, source, directive)
TEMPLATE_BY_KEY = {t["key"]: t for t in D.TEMPLATES}
PRODUCT_DISAGREEMENT = {"Gemini App": "Gemini Model", "AI Overviews": "AI Mode", "Pixel": "Android (Android OS & Google TV)",
                        "Search": "AI Overviews", "Workspace": "Cloud", "Brand": "Search", "Nano Banana": "Gemini App"}
WATCHDOG_TEMPLATES = ["child_safety", "aio_medical", "nano_offensive", "personification"]


def _random_arrivals(sim: Sim) -> list[Arrival]:
    out: list[Arrival] = []
    for h in range(sim.days * 24):
        hour = sim.start + timedelta(hours=h)
        local_hour = hour.astimezone(sim.tz).hour
        for _ in range(sim.poisson(0.9 if 8 <= local_hour < 20 else 0.35)):
            t = hour + timedelta(seconds=sim.rng.uniform(0, 3600))
            if t < sim.now - timedelta(minutes=20):
                out.append((t, "burson_chat", {}))
    return out


def _scripted_arrivals(sim: Sim) -> list[Arrival]:
    """Fixed offsets from now covering every rare path (pending queue items, T&S outcomes, reverts…)."""
    now = sim.now
    m, h, d = (lambda x: timedelta(minutes=x)), (lambda x: timedelta(hours=x)), (lambda x: timedelta(days=x))
    rows: list[tuple[timedelta, dict]] = [
        (m(95), dict(outcome="NEEDS_REVIEW", tpl="citations", decision_delay_min=900, platform="X")),
        (m(41), dict(outcome="NEEDS_REVIEW", tpl="notebooklm_policy", decision_delay_min=900)),
        (m(14), dict(outcome="NEEDS_REVIEW", tpl="image_bias", decision_delay_min=900, kof=True)),
        (m(63), dict(outcome="FAIL", tpl="pixel_heat", fail_mode="post_content:required", fail_resolution="rerun", force={"rerun_delay_min": 400})),
        (m(9), dict(outcome="PASS", tpl="veo_deepfake", platform="X", force={"ack": False})),
        (m(3), dict(outcome="CORRECTED", tpl="ai_studio", platform="X", force={"ack": False})),
        (h(5), dict(outcome="PASS", tpl="whistleblower", platform="X", force={"email": "open", "esc": "auto"})),
        (d(6) + h(6), dict(outcome="PASS", tpl="child_safety", platform="Reddit", kof=True, force={"tns": "Fixed", "esc": "reaction"})),
        (d(6), dict(outcome="CORRECTED", tpl="aio_medical", platform="X", force={"tns": "Infeasible"})),
        (d(3), dict(outcome="FAIL", tpl="waymo", fail_mode="post_url:dead_link", fail_resolution="abandon")),
        (d(2) + h(4), dict(outcome="CORRECTED", tpl="nano_offensive", force={"thumbs_down": True, "revert": True, "crisis": True, "jon": True,
                                                                             "other_team": True})),
        (d(1), dict(outcome="NEEDS_REVIEW", tpl="litigation", kof=True, review_decision="bounce", fail_resolution="rerun", decision_delay_min=8)),
        (h(30), dict(outcome="NEEDS_REVIEW", tpl="aio_meme", review_decision="suppress", decision_delay_min=12)),
        (h(20), dict(outcome="NEEDS_REVIEW", tpl="maps_reviews", review_decision="forward", decision_delay_min=6, force={"im_override": True})),
        (d(3) + h(5), dict(outcome="PASS", tpl="seo_drop", force={"email": "discarded", "revise": True, "esc": "reaction"})),
        (d(2), dict(outcome="PASS", tpl="pixel_leak", platform="Reddit", force={"update": True, "groups": ["stop_leaks", "people_comms"], "esc": "reaction"})),
        (d(6) + h(9), dict(outcome="PASS", tpl="doodle", platform="X")),
        (d(5), dict(outcome="PASS", tpl="doodle", platform="X", kof=True, force={"supersede": True})),
        (d(3) + h(2), dict(outcome="CORRECTED", tpl="personification", force={"tns": "withdrawn"})),
        (d(2) + h(1), dict(outcome="PASS", tpl="chrome_privacy", kof=True, force={"tns": "not_eligible"})),
        (d(2) + h(7), dict(outcome="PASS", tpl="sundar", kof=True, force={"close": "manual", "email": "sent", "esc": "reaction"})),
        (d(4), dict(outcome="PASS", tpl="yt_demonetize", platform="YouTube")),
        (d(1) + h(3), dict(outcome="CORRECTED", tpl="suspension_bias", platform="X")),
    ]
    out = [(now - delta, "burson_chat", dict(directive)) for delta, directive in rows]
    # An URGENT alert on the weekend IM's shift: her Gmail isn't connected, so 📦 fails (email.failed).
    local = now.astimezone(sim.tz)
    sat = (local - timedelta(days=(local.weekday() - 5) % 7)).replace(hour=10, minute=12, second=0, microsecond=0)
    if sat.astimezone(timezone.utc) >= now:
        sat -= timedelta(days=7)
    if sat.astimezone(timezone.utc) > sim.start:
        out.append((sat.astimezone(timezone.utc), "burson_chat", dict(outcome="PASS", tpl="image_bias", platform="X", force={"esc": "reaction"})))
    return out


def _watchdog_arrivals(sim: Sim) -> list[Arrival]:
    out: list[Arrival] = []
    for i, days_ago in enumerate((1.5, 5.2, 8.7, 12.1)):
        if days_ago < sim.days:
            out.append((sim.now - timedelta(days=days_ago), "watchdog",
                        dict(outcome="PASS" if i % 2 == 0 else "CORRECTED", tpl=WATCHDOG_TEMPLATES[i % len(WATCHDOG_TEMPLATES)])))
    return out


def _recent_verified(history: dict[str, list[Spec]], key: str, t: datetime, days: int) -> Spec | None:
    for s in reversed(history.get(key, [])):
        if t - timedelta(days=days) <= s.received < t:
            return s
    return None


def _will_verify(spec: Spec) -> bool:
    return (spec.outcome in ("PASS", "CORRECTED") or (spec.outcome == "FAIL" and spec.fail_resolution == "rerun")
            or (spec.outcome == "NEEDS_REVIEW" and spec.review_decision == "forward"))


def _plan_suppressed(sim: Sim, t: datetime, source: str, d: dict, history: dict[str, list[Spec]]) -> Spec:
    reason = d.get("suppression") or sim.pick(D.SUPPRESSION_WEIGHTS)
    related = None
    if reason == "ongoing_no_kof":
        candidates = [s for key, specs in history.items() for s in specs[-1:]
                      if t - timedelta(days=sim.cfg.collection.novelty_days) <= s.received < t and s.source == source
                      and (sim.tag(s.tpl["tag"]).priority == "P0" or sim.sensitive(s, s.tpl["tag"]))]
        related = sim.rng.choice(candidates) if candidates else None
        reason = reason if related else "below_threshold"
    if reason in D.SUPPRESSION_TEMPLATES:
        tpl = D.SUPPRESSION_TEMPLATES[reason]
    elif related is not None:
        tpl = related.tpl
    else:
        quiet = [x for x in D.TEMPLATES if sim.tag(x["tag"]).priority != "P0"
                 and not [tp for tp in x["topics"] if not sim.cfg.collection.is_redundant(x["tag"], tp)] and not x.get("yt")]
        tpl = sim.rng.choice(quiet)
    spec = sim.new_spec(source, t, tpl, "SUPPRESSED", suppression=reason, is_kof=False)
    if related is not None:
        spec.issue_status, spec.related, spec.location = "ONGOING", related, related.location
    sim.set_engagement(spec, 60, 6000 if reason.startswith("EXCLUDED_") else 1900)
    return spec


def _plan_alert(sim: Sim, t: datetime, source: str, d: dict, history: dict[str, list[Spec]]) -> Spec:
    outcome = d.get("outcome") or sim.pick([("PASS", 0.31), ("CORRECTED", 0.25), ("SUPPRESSED", 0.21), ("FAIL", 0.11), ("NEEDS_REVIEW", 0.12)])
    if outcome == "SUPPRESSED":
        return _plan_suppressed(sim, t, source, d, history)
    tpl = TEMPLATE_BY_KEY[d["tpl"]] if d.get("tpl") else sim.rng.choice(D.TEMPLATES)
    spec = sim.new_spec(source, t, tpl, outcome, **({"platform": d["platform"]} if d.get("platform") else {}))
    spec.is_kof = d["kof"] if "kof" in d else sim.chance(tpl.get("kof", 0.25))
    related = _recent_verified(history, tpl["key"], t, sim.cfg.collection.novelty_days)
    if related is not None and related.source == source and (d.get("tpl") or sim.chance(0.3)):
        spec.issue_status, spec.related = "ONGOING", related
    if sim.urgent_eligible(spec):
        sim.set_engagement(spec, 150, 18000)
    else:
        sim.set_engagement(spec, 2050, 40000)
    if spec.issue_status == "ONGOING" and not spec.is_kof and spec.total < 2000:
        spec.total = int(sim.loguniform(2100, 25000))  # alerts as an update on the thread
    if outcome == "FAIL":
        spec.fail_mode = d.get("fail_mode") or sim.rng.choice(list(D.FAIL_MODES))
        spec.fail_resolution = d.get("fail_resolution") or sim.pick([("rerun", 0.65), ("abandon", 0.35)])
    if outcome == "NEEDS_REVIEW":
        spec.review_decision = d.get("review_decision") or sim.pick([("forward", 0.62), ("bounce", 0.19), ("suppress", 0.19)])
        spec.decision_delay_min = d.get("decision_delay_min") or sim.loguniform(3, 45)
        spec.fail_resolution = d.get("fail_resolution") or (sim.pick([("rerun", 0.6), ("abandon", 0.4)]) if spec.review_decision == "bounce" else None)
    spec.force = dict(d.get("force") or {})
    if d.get("tpl"):
        spec.force.setdefault("ack", True)  # scripted paths need the IM to act
    if _will_verify(spec):
        history.setdefault(tpl["key"], []).append(spec)
    return spec


def _inhouse_specs(sim: Sim, specs: list[Spec]) -> list[Spec]:
    """Path B: the in-house pipeline alerts most of the same posts (parity mode), plus a few of its own."""
    start = sim.now - timedelta(days=min(10, sim.days))
    out: list[Spec] = []
    for b in specs:
        if b.source != "burson_chat" or b.received < start or b.outcome == "SUPPRESSED":
            continue
        t = b.received + timedelta(minutes=sim.rng.uniform(-25, 15))
        if not sim.chance(0.8) or t >= sim.now - timedelta(minutes=1) or t <= start:
            b.parity = "burson_only"
            continue
        i = Spec(source="inhouse", received=t, tpl=b.tpl, outcome="PASS" if sim.chance(0.88) else "CORRECTED", platform=b.platform,
                 handle=b.handle, url=b.url, record_key=b.record_key, location=b.location, followers=b.followers,
                 is_kof=(not b.is_kof) if sim.chance(0.05) else b.is_kof, total=max(1, int(b.total * sim.rng.uniform(0.7, 1.3))),
                 detect_s=sim.loguniform(300, 2400), latency_ms=int(sim.loguniform(1200, 5200)), issue_status=b.issue_status,
                 parity="matched", counterpart=b, source_ref=f"bsa_{t:%Y%m%d}_{sim.digits(4)}")
        if sim.chance(0.07):
            i.issue_status = "NEW" if b.issue_status == "ONGOING" else "ONGOING"
        if sim.chance(0.12):
            tag = sim.tag(b.tpl["tag"])
            i.tag_override = sim.rng.choice([x.name for x in sim.cfg.collection.exposure_tags if x.category == tag.category and x.name != tag.name])
        if sim.chance(0.06) and b.tpl["product"] in PRODUCT_DISAGREEMENT:
            i.product_override = PRODUCT_DISAGREEMENT[b.tpl["product"]]
        if i.issue_status == "ONGOING" and not i.is_kof and i.total < 2000:
            i.total = 2000 + sim.rng.randint(1, 900)
        b.parity, b.counterpart = "matched", i
        out.append(i)
    for day in range(min(10, sim.days)):
        t = start + timedelta(days=day, hours=sim.rng.uniform(1, 23))
        if t >= sim.now - timedelta(minutes=5):
            continue
        tpl = sim.rng.choice(D.TEMPLATES)
        spec = sim.new_spec("inhouse", t, tpl, "PASS", parity="inhouse_only", is_kof=sim.chance(tpl.get("kof", 0.25)))
        spec.source_ref = f"bsa_{t:%Y%m%d}_{sim.digits(4)}"
        sim.set_engagement(spec, 150, 18000) if sim.urgent_eligible(spec) else sim.set_engagement(spec, 2050, 30000)
        out.append(spec)
    return out


def plan(sim: Sim) -> list[Spec]:
    arrivals = _random_arrivals(sim) + _scripted_arrivals(sim) + _watchdog_arrivals(sim)
    arrivals.sort(key=lambda a: a[0])
    history: dict[str, list[Spec]] = {}
    specs = [_plan_alert(sim, t, source, directive, history) for t, source, directive in arrivals]
    specs += _inhouse_specs(sim, specs)
    specs.sort(key=lambda s: s.received)
    return specs
