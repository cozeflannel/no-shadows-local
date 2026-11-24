"""Shared pytest fixtures (offline: SQLite in tmp dir, FakeLLM, fixed clock).

Workstreams add their own fixtures in separate files; keep this file small.
"""

from datetime import UTC, datetime, timedelta

import pytest

from triage_agent.brand_safety_groups import apply_brand_safety_groups
from triage_agent.config import (
    AgentConfig,
    Analyst,
    ChannelOwnerEntry,
    Stakeholder,
    load_config,
)
from triage_agent.context import AgentContext
from triage_agent.events import SqliteEventLogger
from triage_agent.llm import FakeLLM
from triage_agent.models import (
    ChatMessage,
    ChatUser,
    Person,
    Roster,
    RotationSlot,
    Weekday,
)
from triage_agent.outbox import NoopDoorbell
from triage_agent.store import SqliteStore

# Monday 2026-10-12 18:00 UTC = 2:00 pm ET:
#   IM roster (slrr_im)  -> im1 ("AMER late", 12:00-18:00 ET)
#   Burson roster        -> burson1 (Mon-Wed 08:00-18:00 ET)
FIXED_NOW = datetime(2026, 10, 12, 18, 0, tzinfo=UTC)

BURSON_SPACE = {
    "space_id": "spaces/AAQAaa_0I9g",
    "space_name": "[S-F] Burson Automated Alerts V3",
}

ALL_DAYS: list[Weekday] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

# Synthetic Brand safety groups rows (RFC 2606 .test domain; GCPA and GSOC remain empty placeholders).
TEST_BSG_ROWS: list[tuple[str, list[str]]] = [
    # Operational / system slots
    ("Default CC", ["default-cc@alerts.test"]),
    ("Brand Social Sender", ["sender@alerts.test"]),
    ("Trust & Safety Urgent", ["tns-urgent@alerts.test"]),
    ("Leadership", ["lead1@alerts.test", "lead2@alerts.test"]),
    # Product Area distros
    ("Ads / Merchant Center", ["ads@alerts.test"]),
    ("AI Mode", ["ai-mode@alerts.test"]),
    ("AI Overviews", ["aio@alerts.test"]),
    ("Android", ["android@alerts.test"]),
    ("Antigravity", ["antigravity@alerts.test"]),
    ("Assistant / Home", ["assistant-home@alerts.test"]),
    ("Brand", ["brand@alerts.test"]),
    ("Executives", ["exec-comms@alerts.test"]),
    ("Calendar", ["calendar@alerts.test"]),
    ("Chrome", ["chrome@alerts.test"]),
    ("Chromebook", ["chromebook@alerts.test"]),
    ("Googlebook", ["googlebook@alerts.test"]),
    ("Chromecast", ["chromecast@alerts.test"]),
    ("Cloud", ["cloud@alerts.test"]),
    ("Cloud x Gemini", ["cloud-gemini@alerts.test"]),
    ("Data Centers", ["data-centers@alerts.test"]),
    ("DeepMind", ["deepmind@alerts.test"]),
    ("Devs Products", ["devs@alerts.test"]),
    ("Doodles", ["doodles@alerts.test"]),
    ("Easter Eggs & Delights", ["delights@alerts.test"]),
    ("Google for Education", ["education@alerts.test"]),
    ("Fitbit", ["fitbit@alerts.test"]),
    ("Google One (G1)", ["g1@alerts.test"]),
    ("Gemini App", ["gemini-app@alerts.test"]),
    ("Gemini Model", ["gemini-model@alerts.test"]),
    ("Nano Banana", ["nano-banana@alerts.test"]),
    ("GFiber", ["gfiber@alerts.test"]),
    ("Glass", ["glass@alerts.test"]),
    ("Google Health", ["health@alerts.test"]),
    ("Google News", ["news@alerts.test"]),
    ("Google Research", ["research@alerts.test"]),
    ("Grow with Google", ["grow@alerts.test"]),
    ("Intrinsic.ai", ["intrinsic@alerts.test"]),
    ("Isomorphic Labs", ["isomorphic@alerts.test"]),
    ("Jigsaw", ["jigsaw@alerts.test"]),
    ("Kaggle", ["kaggle@alerts.test"]),
    ("Labs", ["labs@alerts.test"]),
    ("Lyria", ["lyria@alerts.test"]),
    ("Lens", ["lens@alerts.test"]),
    ("Maps / Geo", ["maps-geo@alerts.test"]),
    ("Gemini Notebook", ["notebooklm@alerts.test"]),
    ("Google Pay", ["pay@alerts.test"]),
    ("Photos", ["photos@alerts.test"]),
    ("Pixel", ["pixel@alerts.test"]),
    ("Play Store", ["play-store@alerts.test"]),
    ("Reviews", ["reviews@alerts.test"]),
    ("Search", ["search@alerts.test"]),
    ("Search Images", ["search-images@alerts.test"]),
    ("Search Knowledge Panel", ["knowledge-panel@alerts.test"]),
    ("Shopping", ["shopping@alerts.test"]),
    ("Translate", ["translate@alerts.test"]),
    ("Trends", ["trends@alerts.test"]),
    ("Veo", ["veo@alerts.test"]),
    ("Waymo", ["waymo@alerts.test"]),
    ("Waze", ["waze@alerts.test"]),
    ("Wing", ["wing@alerts.test"]),
    ("Workspace", ["workspace@alerts.test"]),
    ("Willow", ["willow@alerts.test"]),
    ("YouTube", ["youtube@alerts.test"]),
    # Non-product specialty groups (GCPA & GSOC intentionally omitted -> placeholder [])
    ("Civics", ["civics@alerts.test"]),
    ("Executive Comms", ["exec-comms@alerts.test"]),
    ("Stop Leaks", ["stopleaks@alerts.test"]),
    ("People Comms", ["people-comms@alerts.test"]),
    ("LSS / Exec Security", ["lss@alerts.test"]),
    ("Influencer Team", ["influencer@alerts.test"]),
    # Regional leads
    ("France", ["france@alerts.test"]),
    ("EMEA", ["emea@alerts.test"]),
]

# Canonical sample matching the template in config/default_config.yaml.
# HIGH_ENGAGEMENT track (2,450 >= 2K), P1 tag, not sensitive, not a KOF, NEW issue -> PASS.
GOOD_ALERT = """🚨 Burson Automated Alert
Alert Name: [HIGH ENGAGEMENT] [NEW] Gemini App \u2013 Users report fabricated citations in research answers
Issue Name: Gemini fabricates academic citations
Issue Status: NEW
Engagement Level: HIGH
Total Engagement: 2450
Likes: 2000
Comments: 300
Shares: 150
Product: Gemini App
Social Network: X
Exposure Tag: Product - Factual inaccuracies (not dangerous/offensive)
Priority: P1
KOF: No
T&S: No
Author: @techwatcher
Followers: 152,300
Post Date: 2026-10-12T13:05:00Z
Location: US
View Post: https://x.com/techwatcher/status/1845123456789012345
Summary: User claims Gemini fabricated three academic sources in a research answer; the thread is gaining traction with journalists.
Post Content: Asked Gemini for sources on microplastics research and it invented three papers that don't exist. Be careful using it for anything serious."""  # noqa: E501


def seed_test_config(cfg: AgentConfig) -> AgentConfig:
    """Populate synthetic RFC 2606 `.test` email fixtures onto a loaded `AgentConfig`."""
    apply_brand_safety_groups(cfg, TEST_BSG_ROWS)

    for rl in cfg.distribution.regional_leads:
        if rl.region in ("Japan", "Asia Pacific") and not rl.reputational_risk_recipients:
            rl.reputational_risk_recipients = ["apac-rep@alerts.test"]

    if not cfg.distribution.channel_owners:
        cfg.distribution.channel_owners = [
            ChannelOwnerEntry(
                account_url="https://www.instagram.com/madebygoogle",
                handle="@madebygoogle",
                owners=["pixel-owner@alerts.test"],
                region="US",
                account_name="Made by Google",
                platform="Instagram",
                team_brand="Pixel",
            ),
            ChannelOwnerEntry(
                account_url="https://x.com/google",
                handle="@Google",
                owners=["brand-owner@alerts.test"],
                region="US",
                account_name="Google",
                platform="X",
                team_brand="Brand",
            ),
        ]

    gemini_prod = cfg.distribution.product("Gemini App")
    if gemini_prod and not gemini_prod.execs:
        gemini_prod.execs = ["gemini-execs@alerts.test"]

    jon_act = cfg.action("escalated_jon")
    if jon_act and not jon_act.recipients:
        jon_act.recipients = ["lead1@alerts.test"]

    cfg.agent.email = "triage-agent@runner.test"

    if not cfg.analysts:
        cfg.analysts = [
            Analyst(name="Alex Admin", email="admin@ops.test", role="admin"),
            Analyst(name="Lee Lead", email="lead@ops.test", role="lead"),
            Analyst(name="Sam Shift", email="im1@ops.test", role="im"),
            Analyst(name="Taylor Triage", email="im2@ops.test", role="analyst"),
        ]

    if not cfg.seed_rosters:
        cfg.seed_rosters = {
            "slrr_im": Roster(
                people=[
                    Person(id="im1", name="Sam Shift", email="im1@ops.test", org="ops"),
                    Person(id="im2", name="Taylor Triage", email="im2@ops.test", org="ops"),
                    Person(id="im3", name="Morgan Night", email="im3@ops.test", org="ops"),
                    Person(id="im4", name="Robin Early", email="im4@ops.test", org="ops"),
                ],
                rotation=[
                    RotationSlot(person_id="im4", days=ALL_DAYS, start="00:00", end="06:00"),
                    RotationSlot(person_id="im2", days=ALL_DAYS, start="06:00", end="12:00"),
                    RotationSlot(person_id="im1", days=ALL_DAYS, start="12:00", end="18:00"),
                    RotationSlot(person_id="im3", days=ALL_DAYS, start="18:00", end="00:00"),
                ],
                backup_person_id="im2",
                fallback=Person(
                    id="im_lead", name="SLRR Leads", email="lead@ops.test", org="ops"
                ),
            ),
            "burson": Roster(
                people=[
                    Person(
                        id="burson1",
                        name="Casey Brooks",
                        email="burson1@agency.test",
                        org="burson",
                    ),
                    Person(
                        id="burson2",
                        name="Jordan Patel",
                        email="burson2@agency.test",
                        org="burson",
                    ),
                ],
                rotation=[
                    RotationSlot(
                        person_id="burson1",
                        days=["mon", "tue", "wed"],
                        start="08:00",
                        end="18:00",
                    ),
                    RotationSlot(
                        person_id="burson2",
                        days=["thu", "fri"],
                        start="08:00",
                        end="18:00",
                    ),
                ],
                backup_person_id="burson2",
                fallback=Person(
                    id="burson_lead",
                    name="Riley Morgan",
                    email="burson-lead@agency.test",
                    org="burson",
                ),
            ),
        }

    for s in cfg.stakeholders:
        if s.id == "slrr_leads" and not s.contacts:
            s.contacts = ["lead@ops.test"]
        elif s.id == "tns_watchdog" and not s.contacts:
            s.contacts = ["watchdog@ops.test"]
    if not any(s.id == "doodle" for s in cfg.stakeholders):
        cfg.stakeholders.append(
            Stakeholder(
                id="doodle",
                team="Doodle Team",
                topics=["Doodle", "Doodles"],
                contacts=["doodle1@ops.test", "doodle2@ops.test"],
                autonomy="answer_only",
            )
        )

    return cfg


class SeededAgentContext(AgentContext):
    """AgentContext test subclass that re-applies synthetic sheet/roster fixtures after config reloads."""

    def reload_config(self) -> None:
        super().reload_config()
        seed_test_config(self.config)
        self._config_version = None


class Clock:
    """Mutable fixed clock: ctx.now() returns clock.now; advance with clock.advance(minutes=...)."""

    def __init__(self, start: datetime = FIXED_NOW):
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **kwargs) -> datetime:
        self.now = self.now + timedelta(**kwargs)
        return self.now


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def fake_llm() -> FakeLLM:
    return FakeLLM(default_json=None, default_text="I don't know.")


@pytest.fixture(autouse=True)
def _no_owner_from_the_shell(monkeypatch):
    """The Console's owner comes from the environment (TRIAGE_OWNER_ADMIN): a test names one itself, and never inherits
    one from the shell it runs in."""
    monkeypatch.delenv("TRIAGE_OWNER_ADMIN", raising=False)


@pytest.fixture
def ctx(tmp_path, fake_llm, clock) -> AgentContext:
    db = tmp_path / "triage.db"
    store = SqliteStore(db)
    cfg = seed_test_config(load_config(store))
    cfg.burson_feedback.silent_in_burson_space = False
    cfg.burson_feedback.post_digest_to_burson_space = True
    cfg.sonar_lookup.enabled = False
    cfg.inhouse.enabled = False
    return SeededAgentContext(
        config=cfg,
        store=store,
        events=SqliteEventLogger(db),
        llm=fake_llm,
        now=clock,
        doorbell=NoopDoorbell(),
    )


def make_message(
    text: str,
    *,
    sender_name: str = "Zapier",
    sender_email: str | None = None,
    sender_type: str = "BOT",
    space_id: str | None = BURSON_SPACE["space_id"],
    space_name: str = BURSON_SPACE["space_name"],
    message_id: str | None = None,
    thread_id: str | None = None,
    conversation_type: str = "SPACE",
    create_time: datetime | None = None,
) -> dict:
    """Payload-ready dict for a normalized ChatMessage (defaults: Zapier post in the Burson space)."""
    msg = ChatMessage(
        message_id=message_id or f"msg-{abs(hash((text, sender_name, space_name))) % 10**10}",
        text=text,
        sender=ChatUser(name=sender_name, email=sender_email, type=sender_type),  # type: ignore[arg-type]
        space_id=space_id,
        space_name=space_name,
        thread_id=thread_id,
        conversation_type=conversation_type,  # type: ignore[arg-type]
        create_time=create_time or FIXED_NOW,
    )
    return msg.model_dump(mode="json")
