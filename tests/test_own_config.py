"""Own alerts: its switches start OFF, its settings carry the specification's numbers and no operational value,
and the two tables only own alerts read are kept as data."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError

from triage_agent.config import FeatureFlags, OwnAlertsConfig, TempCheckSource, switch_title

ROOT = Path(__file__).resolve().parents[1]


def test_both_switches_start_off_and_have_plain_names(ctx):
    flags = ctx.config.platform.flags
    assert flags.own_alerts is False and flags.own_alerts_post is False
    assert switch_title("own_alerts") == "Raise its own alerts"
    assert switch_title("own_alerts_post") == "Post own alerts in Chat"
    for name in ("own_alerts", "own_alerts_post"):
        said = FeatureFlags.model_fields[name].description
        assert said.startswith("ON: ") and " OFF: " in said


def test_the_settings_hold_no_operational_value(ctx):
    own = ctx.config.platform.own_alerts
    assert own.sources == [] and own.brandwatch_queries == []
    assert (own.other_alerts_space, own.kof_sheet, own.ai_connection, own.post_target, own.hash_salt_secret) == ("", "", "", "", "")


def test_the_specifications_numbers_are_the_defaults():
    own = OwnAlertsConfig()
    assert own.interval_minutes == 2 and own.first_read_minutes == 15 and own.posts_per_read == 500
    assert own.snippet_chars == 500 and own.keep_days == 30
    assert (own.single_min_score, own.story_min_score, own.cos_threshold, own.min_vel_ratio) == (0.65, 0.65, 0.22, 1.5)
    assert (own.min_story_posts, own.cooldown_minutes, own.reviews_per_minute) == (3, 120, 25)
    assert (own.surge_min_minutes, own.surge_max_hours, own.surge_min_posts, own.surge_ratio) == (30, 4, 25, 3.0)
    assert own.embedding_endpoint == "gemini-embedding-001" and own.fast_endpoint == "gemini-4-hydrogen" and own.deep_model == "gemini-4-argon"
    assert own.severities == ["P0", "P1", "P2"] and own.escalation_paths == ["EXEC_SECURITY", "PR_COMMS", "LEGAL", "BRAND_SOCIAL"]
    assert own.default_severity == "P1" and own.default_path == "BRAND_SOCIAL"
    assert own.dlp_info_types == ["EMAIL_ADDRESS", "PHONE_NUMBER", "PERSON_NAME", "STREET_ADDRESS", "IP_ADDRESS", "CREDIT_CARD_NUMBER",
                                  "US_SOCIAL_SECURITY_NUMBER"]
    assert own.review_engine == "agent_runtime" and own.other_alerts_mandatory is True


def test_posts_and_the_vault_are_never_kept_past_thirty_days():
    with pytest.raises(ValidationError):
        OwnAlertsConfig(keep_days=31)
    assert OwnAlertsConfig(keep_days=7).keep_days == 7


def test_the_fallback_severity_and_path_must_be_ones_the_review_may_give():
    with pytest.raises(ValidationError, match="severities"):
        OwnAlertsConfig(default_severity="P9")
    with pytest.raises(ValidationError, match="escalation paths"):
        OwnAlertsConfig(default_path="NOBODY")


def test_the_two_tables_only_own_alerts_read_are_kept_as_data():
    data = yaml.safe_load((ROOT / "config" / "own_alerts.yaml").read_text())
    tables = [TempCheckSource.model_validate(t) for t in data["tables"]]
    assert [t.key for t in tables] == ["owned", "story"]
    assert [t.table for t in tables] == ["brand-social-central-data.reporting_data.sprinklr_outbound_reporting",
                                         "brand-social-central-data.DSD.DSD-story-selection"]
    for t in tables:
        assert t.enabled is False, "temp checks do not search these"
        assert t.location == "US" and "{table}" in t.read_sql and "text" in t.has
        for col in ("platform", "author", "text", "url", "posted", "followers", "eng", "sentiment", "language", "shares", "replies", "seen", "one"):
            assert f" AS {col}" in t.read_sql or f" {col}," in t.read_sql or t.read_sql.rstrip().endswith(col) or f"\n  {col}" in t.read_sql, col
    owned, story = tables
    assert "Outbound_Post_ID" in owned.read_sql and "GROUP BY Outbound_Post_ID" in owned.read_sql and "Is_External" in owned.read_sql
    assert "ingestion_time" in story.read_sql and "total_engagements = 2000" in story.read_sql
