"""Unit tests for `triage_agent.brand_safety_groups` and repository-wide zero-hardcoded-email invariants."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

from triage_agent.brand_safety_groups import (
    TESTERS_MAX,
    apply_brand_safety_groups,
    norm_group_key,
    parse_email_list,
    parse_group_rows,
)
from triage_agent.config import ConditionalRecipients, load_config

ROOT = Path(__file__).resolve().parents[1]

EMAIL_SCAN_RE = re.compile(r"(?<![a-z0-9._%+-])([a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,}))", re.IGNORECASE)
ALLOWED_EXACT_EMAILS = frozenset({"chat@system.gserviceaccount.com"})
ALLOWED_TLD_SUFFIXES = (".test", ".invalid")

EXCLUDED_DIRS = frozenset(
    {
        ".git",
        ".venv",
        ".local",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        "node_modules",
        "dist",
        "__pycache__",
        "archive",
        "knowledge_docs",
        "data",
    }
)
EXCLUDED_FILES = frozenset({"burson_live_history.csv"})
BINARY_SUFFIXES = frozenset(
    {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".woff", ".woff2", ".ttf", ".db", ".sqlite"}
)


def _is_allowed_email(addr: str) -> bool:
    low = addr.strip().lower()
    if low in ALLOWED_EXACT_EMAILS:
        return True
    _, _, domain = low.partition("@")
    return domain.endswith(ALLOWED_TLD_SUFFIXES)


def _iter_repo_files(exclude_prefixes: tuple[str, ...] = ()) -> list[Path]:
    proc = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    candidates: list[Path] = []
    if proc.returncode == 0 and proc.stdout.strip():
        for rel in proc.stdout.splitlines():
            rel_str = rel.strip()
            if not rel_str:
                continue
            parts = Path(rel_str).parts
            if any(part in EXCLUDED_DIRS for part in parts) or Path(rel_str).name in EXCLUDED_FILES:
                continue
            if exclude_prefixes and rel_str.startswith(exclude_prefixes):
                continue
            p = ROOT / rel_str
            if p.is_file() and p.suffix.lower() not in BINARY_SUFFIXES:
                candidates.append(p)
        return sorted(candidates)

    for p in ROOT.rglob("*"):
        if not p.is_file() or p.suffix.lower() in BINARY_SUFFIXES:
            continue
        rel_path = p.relative_to(ROOT)
        rel_str = rel_path.as_posix()
        if any(part in EXCLUDED_DIRS for part in rel_path.parts) or p.name in EXCLUDED_FILES:
            continue
        if exclude_prefixes and rel_str.startswith(exclude_prefixes):
            continue
        candidates.append(p)
    return sorted(candidates)


def scan_files_for_disallowed_emails(files: list[Path]) -> list[str]:
    hits: list[str] = []
    for path in files:
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        rel = path.relative_to(ROOT).as_posix()
        for lineno, line in enumerate(text.splitlines(), start=1):
            for match in EMAIL_SCAN_RE.finditer(line):
                email = match.group(1)
                if not _is_allowed_email(email):
                    hits.append(f"{rel}:{lineno}: {email}")
    return hits


def test_parse_group_rows_headers_dedup_and_formatting() -> None:
    assert parse_group_rows(None) == []
    assert parse_group_rows([]) == []
    raw_rows = [
        ["Google Group Name", "Google Group Email"],
        ["Gemini App", "Gemini PA <Gemini-PA@alerts.test>, gemini-backup@alerts.test; gemini-pa@alerts.test"],
        ["", "orphan@alerts.test"],
        ["Missing Email", "   "],
        ["Short Row"],
        ["Invalid Only", "not-an-email, @bad"],
        ["Maps / Geo", "'maps-geo@alerts.test'."],
    ]
    parsed = parse_group_rows(raw_rows)
    assert parsed == [
        ("Gemini App", ["gemini-pa@alerts.test", "gemini-backup@alerts.test"]),
        ("Maps / Geo", ["maps-geo@alerts.test"]),
    ]
    assert norm_group_key("Maps / Geo (Global)") == "mapsgeoglobal"
    assert parse_email_list(["A <a@alerts.test>", "a@alerts.test, b@alerts.test"]) == [
        "a@alerts.test",
        "b@alerts.test",
    ]


def test_apply_brand_safety_groups_products_executives_ops_and_dynamic_rows() -> None:
    cfg = load_config()
    rows = [
        ("Default CC", ["cc-team@alerts.test"]),
        ("Default To", ["fallback-to@alerts.test"]),
        ("Brand Social Sender", ["brand-sender@alerts.test"]),
        ("Trust & Safety Urgent", ["tns-urgent@alerts.test"]),
        ("SLRR Leads", ["lead-a@alerts.test", "lead-b@alerts.test"]),
        ("Gemini App", ["gemini@alerts.test"]),
        ("Maps / Geo", ["maps@alerts.test"]),
        ("Gemini Notebook", ["notebooklm@alerts.test"]),
        ("Google Workspace", ["workspace@alerts.test"]),
        ("Executives", ["exec-comms@alerts.test"]),
        ("Civics", ["civics@alerts.test"]),
        ("Stop Leaks", ["stopleaks@alerts.test"]),
        ("France", ["france@alerts.test"]),
        ("UK", ["uk@alerts.test"]),
        ("Project Astra", ["astra@alerts.test", "ASTRA@alerts.test"]),
    ]
    apply_brand_safety_groups(cfg, rows)

    assert cfg.escalation.default_cc == ["cc-team@alerts.test"]
    assert cfg.escalation.default_to == ["fallback-to@alerts.test"]
    assert cfg.escalation.from_email == "brand-sender@alerts.test"
    assert cfg.agent.email == "brand-sender@alerts.test"
    assert cfg.burson_qa.speed_im_sender == "brand-sender@alerts.test"
    assert cfg.tns.urgent_alias == "tns-urgent@alerts.test"
    assert cfg.protocols.leadership.recipients == ["lead-a@alerts.test", "lead-b@alerts.test"]

    assert cfg.distribution.product("Gemini App").pa == ["gemini@alerts.test"]  # type: ignore[union-attr]
    assert cfg.distribution.product("Maps/Geo").pa == ["maps@alerts.test"]  # type: ignore[union-attr]
    assert cfg.distribution.product("NotebookLM").pa == ["notebooklm@alerts.test"]  # type: ignore[union-attr]
    assert cfg.distribution.product("Workspace").pa == ["workspace@alerts.test"]  # type: ignore[union-attr]

    # "Executives" populates both the Executives product row and the Executive Comms specialty group
    assert cfg.distribution.product("Executives").pa == ["exec-comms@alerts.test"]  # type: ignore[union-attr]
    assert cfg.distribution.group("exec_comms").recipients == ["exec-comms@alerts.test"]  # type: ignore[union-attr]
    assert cfg.distribution.group("civics").recipients == ["civics@alerts.test"]  # type: ignore[union-attr]
    assert cfg.distribution.group("stop_leaks").recipients == ["stopleaks@alerts.test"]  # type: ignore[union-attr]

    # Regional leads matched by exact region name and alias
    fr = next(r for r in cfg.distribution.regional_leads if r.region == "France")
    uk = next(r for r in cfg.distribution.regional_leads if r.region == "United Kingdom")
    assert fr.recipients == ["france@alerts.test"]
    assert uk.recipients == ["uk@alerts.test"]

    # Brand-new product row not in distribution.yaml is dynamically registered
    astra = cfg.distribution.product("Project Astra")
    assert astra is not None
    assert astra.group_name == "Project Astra"
    assert astra.pa == ["astra@alerts.test"]


def test_control_b30_testers_accepts_any_valid_domain_blocks_real_distros_and_caps_at_five() -> None:
    cfg = load_config()
    gemini = cfg.distribution.product("Gemini App")
    assert gemini is not None
    gemini.gup = ["gemini-gup@alerts.test"]
    gemini.execs = ["gemini-exec@alerts.test"]
    gemini.conditional = [
        ConditionalRecipients(label="2K+", min_engagement=2000, recipients=["gemini-2k@alerts.test"])
    ]

    rows = [
        ("Brand Social Sender", ["sender@alerts.test"]),
        ("Trust and Safety Urgent", ["tns-urgent@alerts.test"]),
        ("Gemini App", ["gemini-pa@alerts.test"]),
        ("Civics", ["civics@alerts.test"]),
        ("France", ["france@alerts.test"]),
    ]

    # Blank Control!B30 keeps stand_in == ""
    apply_brand_safety_groups(cfg, rows, raw_testers="   ")
    assert cfg.escalation.stand_in == ""

    # Testers at any other valid domain are accepted while real Brand safety groups addresses are refused.
    # The addresses are written out in full, at reserved domains, so the repository scan below sees them.
    testers = [
        "qa1@webmail.test",
        "qa2@corp.test",
        "qa3@agency.test",
        "qa4@partner.invalid",
        "qa5@sandbox.invalid",
        "qa6@extra.test",  # 6th valid tester -> dropped by TESTERS_MAX == 5 cap
    ]
    assert all(_is_allowed_email(t) for t in testers)
    mixed_testers = ", ".join(
        [
            "GEMINI-PA@alerts.test",  # blocked: product PA
            "gemini-gup@alerts.test",  # blocked: product gUP
            "gemini-exec@alerts.test",  # blocked: product execs
            "gemini-2k@alerts.test",  # blocked: product conditional
            "civics@alerts.test",  # blocked: specialty group
            "france@alerts.test",  # blocked: regional lead
            "sender@alerts.test",  # blocked: from_email
            "tns-urgent@alerts.test",  # blocked: tns urgent_alias
            *testers,
        ]
    )
    apply_brand_safety_groups(cfg, rows, raw_testers=mixed_testers)
    chosen = [x.strip() for x in cfg.escalation.stand_in.split(",") if x.strip()]
    assert len(chosen) == TESTERS_MAX == 5
    assert chosen == testers[:5]

    # Resetting B30 back to blank clears stand_in
    apply_brand_safety_groups(cfg, rows, raw_testers="")
    assert cfg.escalation.stand_in == ""

    # In prod env, raw_testers is ignored
    cfg.env = "prod"
    apply_brand_safety_groups(cfg, rows, raw_testers=testers[1])
    assert cfg.escalation.stand_in == ""


def test_tests_directory_contains_zero_disallowed_emails() -> None:
    test_files = [
        p
        for p in sorted((ROOT / "tests").rglob("*"))
        if p.is_file() and "__pycache__" not in p.parts and p.suffix.lower() not in BINARY_SUFFIXES
    ]
    hits = scan_files_for_disallowed_emails(test_files)
    assert hits == [], "Disallowed hardcoded emails in tests/:\n" + "\n".join(hits)


def test_zero_hardcoded_real_emails_in_tracked_files() -> None:
    files = _iter_repo_files()
    assert len(files) >= 50
    hits = scan_files_for_disallowed_emails(files)
    assert hits == [], "Disallowed hardcoded emails in repository:\n" + "\n".join(hits)
