"""The Console's owner: an admin whatever People says, named on the back end only (TRIAGE_OWNER_ADMIN).

Nobody can be locked out of the Console from the Console: not by taking their own admin role away by mistake, and not
by another admin. Without the variable nothing changes.
"""

from __future__ import annotations

from test_platform import ADMIN, IM, client, iap  # noqa: F401 - fixtures
from triage_agent.config import OWNER_ADMIN_ENV, Analyst, owner_admins
from triage_agent.converse import teach
from triage_agent.models import ProposalStatus

OWNER = "owner@ops.test"


def test_nobody_owns_the_console_unless_the_back_end_names_them(ctx, client):
    assert owner_admins() == []
    assert client.get("/api/me", headers=iap(OWNER)).json()["role"] == "none"
    assert OWNER not in ctx.config.admin_emails()
    people = client.get("/api/admin/overview", headers=iap(ADMIN)).json()["people"]
    assert people and all(p["locked"] is False for p in people)


def test_the_owner_is_an_admin_whatever_people_says(ctx, client, monkeypatch):
    monkeypatch.setenv(OWNER_ADMIN_ENV, f" {OWNER.upper()} , second.owner@ops.test,")
    assert owner_admins() == [OWNER, "second.owner@ops.test"], "trimmed, lower case, once each"
    me = client.get("/api/me", headers=iap(OWNER)).json()
    assert (me["role"], me["role_source"], me["is_admin"]) == ("admin", "owner", True), "not under People at all, and an admin"

    # What happened on the live Console: the owner's own record was set to User. They stay an admin.
    ctx.config.analysts.append(Analyst(name="Olive Owner", email=OWNER, role="analyst"))
    me = client.get("/api/me", headers=iap(OWNER)).json()
    assert (me["role"], me["role_source"], me["name"]) == ("admin", "owner", "Olive Owner")
    row = next(p for p in client.get("/api/admin/overview", headers=iap(ADMIN)).json()["people"] if p["email"] == OWNER)
    assert (row["role"], row["role_source"], row["locked"]) == ("admin", "owner", True), "People shows what is true, not the record"

    for who in (OWNER, ADMIN):  # neither the owner nor another admin can make the owner less than an admin, or remove them
        down = client.put(f"/api/admin/people/{OWNER}", json={"role": "user"}, headers=iap(who))
        assert down.status_code == 422 and "always an admin" in down.json()["error"]
        gone = client.delete(f"/api/admin/people/{OWNER}", headers=iap(who))
        assert gone.status_code == 422 and "always an admin" in gone.json()["error"]
    assert ctx.config.analyst(OWNER).role == "analyst", "a refused change changes nothing"

    kept = client.put(f"/api/admin/people/{OWNER}", json={"name": "Olive O.", "role": "admin"}, headers=iap(OWNER))
    assert kept.status_code == 200, "the owner passes the admin-only routes, and their name can still be edited"
    assert (kept.json()["person"]["name"], kept.json()["person"]["role"], kept.json()["person"]["locked"]) == ("Olive O.", "admin", True)


def test_the_owner_counts_as_an_admin_for_the_rest_of_the_back_end(ctx, client, monkeypatch):
    monkeypatch.setenv(OWNER_ADMIN_ENV, OWNER)
    assert OWNER in ctx.config.admin_emails() and OWNER in ctx.config.lead_emails()
    fact, _ = teach.propose_fact(ctx, "Owned posts are never suppressed", IM, source="test")
    teach.decide_fact(ctx, fact.fact_id, "approve", OWNER)  # a lead's or an admin's call: the owner's too
    assert ctx.store.get_fact(fact.fact_id).status == ProposalStatus.APPROVED

    # The only admin People names can step down, since the owner is still an admin; the owner can put them back.
    assert client.put(f"/api/admin/people/{ADMIN}", json={"role": "user"}, headers=iap(ADMIN)).status_code == 200
    assert client.get("/api/me", headers=iap(ADMIN)).json()["is_admin"] is False
    assert client.put(f"/api/admin/people/{ADMIN}", json={"role": "admin"}, headers=iap(OWNER)).status_code == 200
    assert client.get("/api/me", headers=iap(ADMIN)).json()["is_admin"] is True

    ctx.config.analysts.append(Analyst(name="Olive Owner", email=OWNER.upper(), role="admin"))
    assert [e.lower() for e in ctx.config.admin_emails()].count(OWNER) == 1, "listed as an admin too: counted once"
