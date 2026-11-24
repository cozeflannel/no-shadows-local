"""Usage tracking of the Console through Google Tag Manager: off until an admin names a container, and only a container id
is ever accepted (it goes into a script address in the browser).

Which pages are tracked, and what is sent for each, is the browser's part (console/frontend/src/lib/analytics.ts). The
container never runs in the Console's own page, where it would read the address (an alert's number, a search), the clicks
and the forms: it runs in a blank page of its own, served here.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from test_platform import ADMIN, IM, LEAD, client, iap  # noqa: F401 - fixtures
from triage_agent.config import AnalyticsConfig

FRONTEND = Path(__file__).resolve().parent.parent / "console" / "frontend"


def test_nothing_is_tracked_until_a_container_is_named(ctx, client):
    assert ctx.config.platform.analytics.gtm_container == "", "off in the code: a container is named in Settings, by an admin"
    assert client.get("/api/meta", headers=iap(IM)).json()["analytics"] == {"gtm_container": ""}
    part = next(p for p in client.get("/api/platform", headers=iap(ADMIN)).json()["parts"] if p["key"] == "analytics")
    assert part["label"] == "Usage tracking" and part["overridden"] is False


def test_an_admin_names_the_container_and_every_signed_in_person_gets_it(ctx, client):
    assert client.put("/api/platform/analytics", json={"value": {"gtm_container": "GTM-ABC1234"}}, headers=iap(LEAD)).status_code == 403
    saved = client.put("/api/platform/analytics", json={"value": {"gtm_container": "GTM-ABC1234"}}, headers=iap(ADMIN))
    assert saved.status_code == 200 and saved.json()["value"]["gtm_container"] == "GTM-ABC1234"
    assert client.get("/api/meta", headers=iap(IM)).json()["analytics"]["gtm_container"] == "GTM-ABC1234"
    cleared = client.put("/api/platform/analytics", json={"value": {"gtm_container": ""}}, headers=iap(ADMIN))
    assert cleared.status_code == 200
    assert client.get("/api/meta", headers=iap(IM)).json()["analytics"]["gtm_container"] == "", "blank turns it off again"


@pytest.mark.parametrize("value", [
    "gtm-abc1234",                                   # the wrong case
    "G-ABC1234", "UA-12345-1", "AW-123456789",       # other Google tags: this setting is a Tag Manager container
    "GTM-ABC1234&l=x",                               # more than the id
    "GTM-ABC1234\"></script><script>alert(1)</script>",
    "https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234",
    " GTM-ABC1234", "GTM-", "GTM-AB",
])
def test_only_a_container_id_is_accepted(ctx, client, value):
    with pytest.raises(ValidationError):
        AnalyticsConfig(gtm_container=value)
    bad = client.put("/api/platform/analytics", json={"value": {"gtm_container": value}}, headers=iap(ADMIN))
    assert bad.status_code == 422
    assert client.get("/api/meta", headers=iap(IM)).json()["analytics"]["gtm_container"] == "", "a refused value changes nothing"


def test_the_container_gets_a_blank_page_of_its_own(ctx, client):
    page = client.get("/api/usage-frame", headers=iap(IM))
    assert page.status_code == 200 and page.headers["content-type"].startswith("text/html")
    blank = page.text
    assert 'name="console-usage-frame"' in blank, "the mark the browser looks for before it loads a container into the page"
    assert "<body></body>" in blank, "nothing of the Console is in it for a tag to read"
    assert "<script" not in blank.lower() and "googletagmanager" not in blank, "no script of its own: the browser adds the container, and only when one is set"
    assert client.put("/api/platform/analytics", json={"value": {"gtm_container": "GTM-ABC1234"}}, headers=iap(ADMIN)).status_code == 200
    assert client.get("/api/usage-frame", headers=iap(IM)).text == blank, "the same page whatever the setting"
    assert client.get("/api/usage-frame", headers=iap("stranger@external.invalid")).status_code == 403, "a page of the Console: only for people who may open it"


def test_the_container_is_never_loaded_into_the_consoles_own_page():
    index = (FRONTEND / "index.html").read_text(encoding="utf-8")
    assert "googletagmanager" not in index and "dataLayer" not in index, "not in the page every person loads"
    loaders = sorted(p.name for p in (FRONTEND / "src").rglob("*.ts*") if "googletagmanager" in p.read_text(encoding="utf-8"))
    assert loaders == ["analytics.ts"], "one place loads the container"
    source = (FRONTEND / "src" / "lib" / "analytics.ts").read_text(encoding="utf-8")
    assert 'const FRAME = "/api/usage-frame"' in source and 'referrerPolicy = "no-referrer"' in source
    assert "document.head.appendChild" not in source, "the container's script goes into its own page, never the Console's"
