"""Email routing + suggested IM actions.

Mirrors the distribution list (config/distribution.yaml) and the
`suggested_routing` rules of brand_safety_alerting/sql/02 so the agent, the
in-house pipeline and the IMs agree on who gets an alert.

  plan_recipients(...)  -> RecipientPlan for the 📦 Social Alert draft
  suggest_actions(...)  -> emoji-legend action codes shown on the clean post
"""

import re
from typing import Any, Iterable

from .config import AgentConfig, Distribution, NonProductGroup, ProductDistro
from .models import AlertAssessment, RecipientPlan

GUP_CODE = "gup"


def resolve_product(dist: Distribution, name: str | None) -> tuple[ProductDistro | None, str | None]:
    """Distro for a product name, following single-target redirects of deprecated distros.

    Returns (distro, note). A deprecated distro with several redirect targets
    (e.g. Central AI) returns (None, note): the QA step must reclassify it.
    """
    distro = dist.product(name)
    if distro is None:
        return None, (f"No distro for product {name!r}" if name else "No product")
    if distro.deprecated:
        if len(distro.redirect_to) == 1:
            target = dist.product(distro.redirect_to[0])
            if target:
                return target, f"{distro.name} distro removed → {target.name}"
        return None, f"{distro.name} distro removed; reclassify to one of: {', '.join(distro.redirect_to)}"
    return distro, None


def _casefold_in(value: str | None, options: Iterable[str]) -> bool:
    v = (value or "").strip().lower()
    return bool(v) and v in (o.strip().lower() for o in options)


def group_match_reason(group: NonProductGroup, a: AlertAssessment, text: str,
                       high_engagement_threshold: int = 2000) -> str | None:
    """Why `group`'s triggers match this alert (None = no match)."""
    t = group.triggers
    if t.is_empty():
        return None
    if t.exclude_products and _casefold_in(a.product, t.exclude_products):
        return None
    tag = a.exposure_tag or ""
    conds: list[tuple[bool, str]] = []
    if t.exposure_tags:
        conds.append((_casefold_in(tag, t.exposure_tags), f"exposure tag {tag}"))
    if t.exposure_tag_prefixes:
        conds.append((any(tag.lower().startswith(p.lower()) for p in t.exposure_tag_prefixes), f"exposure tag {tag}"))
    if t.priorities:
        conds.append((_casefold_in(a.priority, t.priorities), f"priority {a.priority}"))
    if t.sensitive_topics:
        topics = list(dict.fromkeys([*a.sensitive_topics, *a.risk_topics]))
        # urgent_only: the topic is why the alert is urgent (a KOF author, or under the high-engagement bar)
        urgent = a.is_kof or (a.engagement_total or 0) < high_engagement_threshold
        hits = [s for s in topics if _casefold_in(s, t.sensitive_topics) and
                (not t.sensitive_topics_urgent_only or urgent or _casefold_in(s, t.sensitive_topics_any_engagement))]
        conds.append((bool(hits), f"sensitive topic {', '.join(hits)}"))
    if t.keywords:
        hit = next((k for k in t.keywords if re.search(k, text or "", flags=re.IGNORECASE)), None)
        conds.append((hit is not None, "keyword match"))
    if t.sundar_mention:
        conds.append((a.sundar_mention, "Sundar mention"))
    if t.non_us_market:
        conds.append((bool(a.non_us_markets), f"non-US market {', '.join(a.non_us_markets)}"))
    if t.owned_post:
        conds.append((a.owned_post, "owned social post"))
    if t.match == "all":
        return "; ".join(r for _, r in conds) if all(ok for ok, _ in conds) else None
    hits = [r for ok, r in conds if ok]
    return hits[0] if hits else None


def _norm_url(url: str | None) -> str:
    if not url:
        return ""
    u = re.sub(r"^https?://(?:www\.)?", "", str(url).strip().lower())
    u = u.split("?", 1)[0].split("#", 1)[0].rstrip("/")
    return u


def resolve_regional_leads(dist: Distribution, a: AlertAssessment | None, text: str = "") -> list[str]:
    if not dist.regional_leads:
        return []
    markets = [m.strip() for m in (a.non_us_markets if a else []) if m and not m.startswith("language:")]
    matched = []
    for rl in dist.regional_leads:
        terms = [rl.region, *rl.aliases]
        if any(m.lower() in (t.lower() for t in terms) for m in markets):
            matched.append(rl)
    if not matched and text:
        for rl in dist.regional_leads:
            terms = [rl.region, *[al for al in rl.aliases if len(al) > 2]]
            if any(re.search(rf"\b{re.escape(t)}\b", text, re.I) for t in terms):
                matched.append(rl)
    out: list[str] = []
    parent_names: set[str] = set()
    is_p0 = bool(a and a.priority == "P0")
    for rl in matched:
        recs = rl.reputational_risk_recipients if (is_p0 and rl.reputational_risk_recipients) else rl.recipients
        for e in recs:
            if e and e.lower() not in (x.lower() for x in out):
                out.append(e)
        if rl.parent_region:
            parent_names.add(rl.parent_region.lower())
    for p_name in parent_names:
        parent = next((r for r in dist.regional_leads if r.region.lower() == p_name), None)
        if parent:
            for e in parent.recipients:
                if e and e.lower() not in (x.lower() for x in out):
                    out.append(e)
    return out


def resolve_channel_owners(
    dist: Distribution,
    a: AlertAssessment | None,
    product: ProductDistro | None = None,
    text: str = "",
) -> list[str]:
    if not dist.channel_owners:
        return []
    out: list[str] = []
    target_url = _norm_url(a.owned_profile_url if a else None)
    if target_url:
        for co in dist.channel_owners:
            co_url = _norm_url(co.account_url)
            if co_url and (co_url == target_url or target_url.startswith(co_url + "/")):
                for e in co.owners:
                    if e and e.lower() not in (x.lower() for x in out):
                        out.append(e)
    if not out and text:
        for co in dist.channel_owners:
            h = (co.handle or "").strip()
            if h.startswith("@") and len(h) > 2 and re.search(rf"(?<!\w){re.escape(h)}\b", text, re.I):
                for e in co.owners:
                    if e and e.lower() not in (x.lower() for x in out):
                        out.append(e)
    if not out:
        prod_name = (product.name if product else (a.product if a else "")) or ""
        plat = (a.platform if a else "") or ""
        if prod_name:
            for co in dist.channel_owners:
                if co.team_brand.lower() == prod_name.lower() or co.account_name.lower() == prod_name.lower():
                    if not plat or co.platform.lower() == plat.lower():
                        if co.region.upper() in ("US", "GLOBAL", ""):
                            for e in co.owners:
                                if e and e.lower() not in (x.lower() for x in out):
                                    out.append(e)
    return out


def group_recipients(
    group: NonProductGroup,
    product: ProductDistro | None,
    dist: Distribution | None = None,
    a: AlertAssessment | None = None,
    text: str = "",
) -> list[str]:
    if group.action_code == GUP_CODE:  # gUP POCs are per product
        return list(product.gup) if product else []
    if group.action_code == "regional_leads" and dist is not None:
        resolved = resolve_regional_leads(dist, a, text)
        if resolved:
            return resolved
    if group.action_code == "channel_owner" and dist is not None:
        resolved = resolve_channel_owners(dist, a, product, text)
        if resolved:
            return resolved
    return list(group.recipients)


def _execs_apply(product: ProductDistro, a: AlertAssessment, threshold: int) -> bool:
    rule = product.execs_rule
    high = (a.engagement_total or 0) >= threshold
    return (
        rule == "always"
        or (rule == "p0" and a.priority == "P0")
        or (rule == "high_engagement" and high)
        or (rule == "p0_or_high_engagement" and (a.priority == "P0" or high))
    )


def plan_recipients(
    config: AgentConfig,
    a: AlertAssessment,
    text: str = "",
    extra_groups: Iterable[str] = (),
    product_name: str | None = None,
) -> RecipientPlan:
    """Recipients for the Social Alert draft.

    to: product PA POCs (+ engagement add-ons, execs per rule, gUP when triggered)
    cc: auto-included non-product groups whose triggers match, plus `extra_groups`
        (added by IM emoji reactions, e.g. "gcpa" for 📰)
    """
    dist = config.distribution
    plan = RecipientPlan()
    product, note = resolve_product(dist, product_name or a.product)
    if note:
        plan.notes.append(note)

    def add(target: list[str], emails: Iterable[str]) -> None:
        for e in emails:
            if e and e.lower() not in (x.lower() for x in plan.to + plan.cc):
                target.append(e)

    def add_product_distro(prod: ProductDistro) -> None:
        add(plan.to, prod.pa)
        if prod.name not in plan.groups:
            plan.groups.append(prod.name)
            plan.reasons[prod.name] = "product alert POCs"
        for cond in prod.conditional:
            if (a.engagement_total or 0) >= cond.min_engagement:
                add(plan.to, cond.recipients)
                label = f"{prod.name} – {cond.label}"
                if label not in plan.groups:
                    plan.groups.append(label)
                    plan.reasons[label] = f"{a.engagement_total:,} engagements ≥ {cond.min_engagement:,}"
        if prod.execs:
            if _execs_apply(prod, a, config.collection.high_engagement_threshold):
                add(plan.to, prod.execs)
                exec_label = f"{prod.name} Execs"
                if exec_label not in plan.groups:
                    plan.groups.append(exec_label)
                    plan.reasons[exec_label] = f"execs rule: {prod.execs_rule}"
            else:
                plan.notes.append(f"{prod.name} Execs list not added (rule: {prod.execs_rule})")

    secondary_distros: list[ProductDistro] = []
    if not product_name and a.secondary_products:
        for sec_name in a.secondary_products:
            sec_prod, sec_note = resolve_product(dist, sec_name)
            if sec_note:
                plan.notes.append(sec_note)
            if sec_prod and (not product or sec_prod.name.lower() != product.name.lower()):
                if all(s.name.lower() != sec_prod.name.lower() for s in secondary_distros):
                    secondary_distros.append(sec_prod)

    if product:
        add_product_distro(product)
        for sec_prod in secondary_distros:
            add_product_distro(sec_prod)
    elif secondary_distros:
        for sec_prod in secondary_distros:
            add_product_distro(sec_prod)
    else:
        add(plan.to, config.escalation.default_to)

    extra = {g.strip().lower() for g in extra_groups if g}
    for group in dist.groups:
        key_match = (group.action_code or "").lower() in extra or group.name.lower() in extra
        reason = "added by IM" if key_match else (
            group_match_reason(group, a, text, config.collection.high_engagement_threshold) if group.auto_include else None)
        if not reason:
            continue
        emails = group_recipients(group, product, dist=dist, a=a, text=text)
        if group.action_code == GUP_CODE and secondary_distros:
            for sec_prod in secondary_distros:
                for gup_email in group_recipients(group, sec_prod, dist=dist, a=a, text=text):
                    if gup_email and gup_email.lower() not in (x.lower() for x in emails):
                        emails.append(gup_email)
        if not emails:
            plan.missing.append(group.name)
            continue
        add(plan.to if group.action_code == GUP_CODE else plan.cc, emails)
        plan.groups.append(group.name)
        plan.reasons[group.name] = reason
    add(plan.cc, config.escalation.default_cc)
    return plan


def suggest_actions(config: AgentConfig, a: AlertAssessment, text: str = "") -> list[str]:
    """Emoji-legend action codes to suggest on the clean post (legend order).

    Mirrors suggested_routing in brand_safety_alerting/sql/02: ✍️ when T&S is
    recommended, 📦 for Product tags (or YouTube as the subject), and every
    non-product group whose triggers match (whether or not it's auto-included).
    """
    tag = a.exposure_tag or ""
    codes: set[str] = set()
    if a.ts_recommended:
        codes.add("tns")
    if tag.startswith("Product - ") or a.youtube_subject:
        codes.add("pa")
    for group in config.distribution.groups:
        if group.action_code and group_match_reason(group, a, text, config.collection.high_engagement_threshold):
            codes.add(group.action_code)
    order = [act.code for act in config.actions]
    return [c for c in order if c in codes] + sorted(codes - set(order))


def emoji_for(config: AgentConfig, code: str) -> str:
    act = config.action(code)
    return f"{act.emoji} {act.label}" if act else code


def describe_plan(plan: RecipientPlan) -> dict[str, Any]:
    """Compact JSON for events / the Console."""
    return {"to": len(plan.to), "cc": len(plan.cc), "groups": plan.groups, "missing": plan.missing, "notes": plan.notes}
