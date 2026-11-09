"""Live Google Sheets reader & merger for the `Brand safety groups` worksheet and `Control!B30` test recipients.

Reads `Brand safety groups!A1:B250` (and `Control!A30:B30` when testing) from the `slrr-agentic-assistant`
workbook (`1dVGeQjLOfEYoCm_iIOmXd5hLM3rOTY_71IF-J8Hl2AI` / `SLRR_STORE_SHEET_ID`), strictly read-only, so zero
email addresses ever need to be hardcoded in repository files or compiled `.gs` bundles.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
import urllib.parse
import urllib.request
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .config import AgentConfig

log = logging.getLogger(__name__)

DEFAULT_STORE_SHEET_ID = "1dVGeQjLOfEYoCm_iIOmXd5hLM3rOTY_71IF-J8Hl2AI"
BRAND_SAFETY_GROUPS_TAB = "Brand safety groups"
CONTROL_TESTERS_RANGE = "Control!A30:B30"
TESTERS_LABEL = "Testing: send to"
TESTERS_MAX = 5
CACHE_TTL_S = 600.0

EMAIL_TOKEN_RE = re.compile(r"[^\s<>\",;:()]+@[^\s<>\",;:()]+")
VALID_EMAIL_RE = re.compile(r"^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$", re.IGNORECASE)
NORM_KEY_RE = re.compile(r"[^a-z0-9]+")

# Optional operational rows supported on `Brand safety groups` in addition to product / team groups.
SYSTEM_ROW_KEYS: dict[str, str] = {
    "defaultcc": "default_cc",
    "defaultto": "default_to",
    "fromemail": "from_email",
    "brandsocialsender": "from_email",
    "brandsocialsends": "from_email",
    "tnsurgent": "tns_urgent",
    "tsurgent": "tns_urgent",
    "trustsafetyurgent": "tns_urgent",
    "leadership": "leadership",
    "slrrleads": "leadership",
}

# Group row aliases -> Distribution.groups action_code
GROUP_ROW_ALIASES: dict[str, str] = {
    "executives": "exec_comms",
    "executivecomms": "exec_comms",
    "execcomms": "exec_comms",
    "civics": "civics",
    "peoplecomms": "people_comms",
    "stopleaks": "stop_leaks",
    "lss": "lss",
    "lssexecsecurity": "lss",
    "execsecurity": "lss",
    "influencerteam": "influencer_team",
    "gcpa": "gcpa",
    "gsoc": "gsoc",
    "channelowner": "channel_owner",
    "channelowners": "channel_owner",
}

_SHEET_CACHE: dict[str, tuple[float, list[tuple[str, list[str]]], str]] = {}


def norm_group_key(name: str | None) -> str:
    return NORM_KEY_RE.sub("", (name or "").strip().lower())


def parse_email_list(raw: str | Sequence[str] | None) -> list[str]:
    if not raw:
        return []
    chunks = [raw] if isinstance(raw, str) else [str(x) for x in raw if x]
    out: list[str] = []
    seen: set[str] = set()
    for chunk in chunks:
        for tok in EMAIL_TOKEN_RE.findall(chunk):
            cleaned = tok.strip(".'\"").lower()
            if VALID_EMAIL_RE.match(cleaned) and cleaned not in seen:
                seen.add(cleaned)
                out.append(cleaned)
    return out


def parse_group_rows(values: Sequence[Sequence[Any]] | None) -> list[tuple[str, list[str]]]:
    """Parse raw 2-column sheet values (`Google Group Name`, `Google Group Email`) into `(name, [emails])`."""
    if not values:
        return []
    rows: list[tuple[str, list[str]]] = []
    for idx, row in enumerate(values):
        if not row or len(row) < 2:
            continue
        name = str(row[0] or "").strip()
        raw_emails = str(row[1] or "").strip()
        if not name or not raw_emails:
            continue
        if idx == 0 and norm_group_key(name) in ("googlegroupname", "groupname", "group", "product"):
            continue
        emails = parse_email_list(raw_emails)
        if emails:
            rows.append((name, emails))
    return rows


def _adc_access_token() -> str:
    """Obtain an OAuth bearer token with Sheets read scope from ADC credentials."""
    try:
        import google.auth
        import google.auth.transport.requests

        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
        if not creds.valid:
            creds.refresh(google.auth.transport.requests.Request())
        if creds.token:
            return str(creds.token)
    except Exception:  # noqa: BLE001
        pass

    adc_path = Path(
        os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        or Path.home() / ".config" / "gcloud" / "application_default_credentials.json"
    )
    if adc_path.is_file():
        creds_doc = json.loads(adc_path.read_text(encoding="utf-8"))
        if creds_doc.get("type") == "authorized_user" and creds_doc.get("refresh_token"):
            body = urllib.parse.urlencode(
                {
                    "client_id": creds_doc["client_id"],
                    "client_secret": creds_doc["client_secret"],
                    "refresh_token": creds_doc["refresh_token"],
                    "grant_type": "refresh_token",
                }
            ).encode("utf-8")
            req = urllib.request.Request(
                "https://oauth2.googleapis.com/token",
                data=body,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310
                token_doc = json.loads(resp.read().decode("utf-8"))
                if token_doc.get("access_token"):
                    return str(token_doc["access_token"])
    raise RuntimeError("Unable to obtain Google Cloud ADC token to read Brand safety groups")


def fetch_workbook_email_config(
    sheet_id: str | None = None,
    *,
    token: str | None = None,
    force: bool = False,
) -> tuple[list[tuple[str, list[str]]], str]:
    """Read `Brand safety groups!A1:B250` and `Control!A30:B30` in one batchGet call (cached 10 min)."""
    sid = (sheet_id or os.environ.get("SLRR_STORE_SHEET_ID") or DEFAULT_STORE_SHEET_ID).strip()
    now = time.monotonic()
    cached = _SHEET_CACHE.get(sid)
    if not force and cached and (now - cached[0]) < CACHE_TTL_S:
        return list(cached[1]), cached[2]

    bearer = token or _adc_access_token()
    project = os.environ.get("GOOGLE_CLOUD_PROJECT") or "brand-social-central-data"
    ranges = [f"{BRAND_SAFETY_GROUPS_TAB}!A1:B250", CONTROL_TESTERS_RANGE]
    query = "&".join(["valueRenderOption=FORMATTED_VALUE", *(f"ranges={urllib.parse.quote(r)}" for r in ranges)])
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{urllib.parse.quote(sid)}/values:batchGet?{query}"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {bearer}",
            "x-goog-user-project": project,
        },
    )
    with urllib.request.urlopen(req, timeout=20) as resp:  # noqa: S310
        doc = json.loads(resp.read().decode("utf-8"))

    value_ranges = doc.get("valueRanges") or []
    bsg_values = (value_ranges[0].get("values") if len(value_ranges) > 0 else None) or []
    ctrl_values = (value_ranges[1].get("values") if len(value_ranges) > 1 else None) or []

    group_rows = parse_group_rows(bsg_values)
    raw_testers = ""
    if ctrl_values and ctrl_values[0]:
        label = str(ctrl_values[0][0] or "").strip()
        val = str(ctrl_values[0][1] if len(ctrl_values[0]) > 1 else "").strip()
        if label == TESTERS_LABEL:
            raw_testers = val

    _SHEET_CACHE[sid] = (now, group_rows, raw_testers)
    return list(group_rows), raw_testers


def _dedupe_preserve(items: Iterable[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for item in items:
        lc = item.strip().lower()
        if lc and lc not in seen:
            seen.add(lc)
            out.append(item.strip())
    return out


def apply_brand_safety_groups(
    cfg: AgentConfig,
    rows: Iterable[tuple[str, Sequence[str]]],
    *,
    raw_testers: str | None = None,
) -> AgentConfig:
    """Populate `cfg.distribution` (and optional system email slots + `Control!B30` testers) from sheet rows."""
    from .config import ProductDistro

    parsed_rows = [(str(name).strip(), _dedupe_preserve(emails)) for name, emails in rows if name and emails]
    by_norm: dict[str, list[str]] = {}
    for name, emails in parsed_rows:
        key = norm_group_key(name)
        if key:
            by_norm[key] = _dedupe_preserve([*by_norm.get(key, []), *emails])

    matched_keys: set[str] = set()

    # 1. Operational / system email slots if present on the sheet
    for key, slot in SYSTEM_ROW_KEYS.items():
        if key not in by_norm:
            continue
        matched_keys.add(key)
        emails = by_norm[key]
        if slot == "default_cc":
            cfg.escalation.default_cc = list(emails)
        elif slot == "default_to":
            cfg.escalation.default_to = list(emails)
        elif slot == "from_email" and emails:
            cfg.escalation.from_email = emails[0]
            cfg.agent.email = emails[0]
            cfg.burson_qa.speed_im_sender = emails[0]
        elif slot == "tns_urgent" and emails:
            cfg.tns.urgent_alias = emails[0]
        elif slot == "leadership":
            cfg.protocols.leadership.recipients = list(emails)

    # 2. Product Area distros (match explicit group_name first, then product name, then aliases)
    for prod in cfg.distribution.products:
        if prod.deprecated:
            continue
        candidates = [c for c in [prod.group_name, prod.name, *prod.aliases] if c]
        hit_emails: list[str] = []
        for cand in candidates:
            ck = norm_group_key(cand)
            if ck and ck in by_norm:
                matched_keys.add(ck)
                hit_emails.extend(by_norm[ck])
                break
        if hit_emails:
            prod.pa = _dedupe_preserve(hit_emails)

    # 3. Non-product specialty groups (e.g. Executive Comms <- Executives, Civics, Stop Leaks, People Comms)
    for grp in cfg.distribution.groups:
        g_candidates = [
            grp.name,
            grp.action_code,
            *[alias for alias, code in GROUP_ROW_ALIASES.items() if code == grp.action_code],
        ]
        for cand in g_candidates:
            ck = norm_group_key(cand)
            if ck and ck in by_norm:
                matched_keys.add(ck)
                grp.recipients = _dedupe_preserve(by_norm[ck])
                break

    # 4. Regional leads if regional Google Groups are added to the sheet
    for rl in cfg.distribution.regional_leads:
        for cand in [rl.region, *rl.aliases]:
            ck = norm_group_key(cand)
            if ck and ck in by_norm:
                matched_keys.add(ck)
                rl.recipients = _dedupe_preserve(by_norm[ck])
                break

    # 5. Dynamically register any brand-new product group added on the sheet that wasn't in distribution.yaml yet
    for name, emails in parsed_rows:
        ck = norm_group_key(name)
        if ck and ck not in matched_keys:
            cfg.distribution.products.append(ProductDistro(name=name, group_name=name, pa=list(emails)))
            matched_keys.add(ck)

    # 6. Testing recipient cell (`Control!B30`) when in non-prod mode
    if raw_testers is not None and cfg.env != "prod":
        real_set = {
            e.lower()
            for p in cfg.distribution.products
            for e in (*p.pa, *p.gup, *p.execs, *(r for c in p.conditional for r in c.recipients))
        }
        real_set.update(e.lower() for g in cfg.distribution.groups for e in g.recipients)
        real_set.update(e.lower() for rl in cfg.distribution.regional_leads for e in rl.recipients)
        if cfg.escalation.from_email:
            real_set.add(cfg.escalation.from_email.lower())
        if cfg.tns.urgent_alias:
            real_set.add(cfg.tns.urgent_alias.lower())
        testers = [e for e in parse_email_list(raw_testers) if e.lower() not in real_set][:TESTERS_MAX]
        cfg.escalation.stand_in = ", ".join(testers)

    return cfg
