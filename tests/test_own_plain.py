"""Agent alerts: what went wrong, in plain words. The Agent alerts page shows what happened and what to do; Google's
own words are kept, folded away, for admins only.

The errors below are the ones the runs keep (kv own:state, own:review, each source), several of them word for word as
BigQuery and Vertex AI gave them on the live project.
"""

from __future__ import annotations

from own_helpers import HOME, set_up
from test_platform import ADMIN, LEAD, VIEWER, _llm, client, iap  # noqa: F401 - fixtures
from triage_agent.ownalerts import cycle, plain, review, schema

# What the live run and review kept on 23 November 2026 (the project, the job ids and the links cut short).
RUN_400 = ("BigQuery could not finish the run: 400 GET https://bigquery.googleapis.com/bigquery/v2/projects/p/queries/0f5e?maxResults=10000"
           "&formatOptions.useInt64Timestamp=True&location=US&prettyPrint=false: Query error: Correlated subqueries that reference other tables "
           "are not supported un")
REVIEW_400 = ("400 Correlated subqueries that reference other tables are not supported unless they can be de-correlated, such as by transforming "
              "them into an efficient JOIN.; reason: invalidQuery, location: query, message: Correlated subqueries that reference other tables are "
              "not supported unless they can be de-correlated, such as by transforming them into an efficient JOIN.\n\nLocation: US\nJob ID: e14b")
PLAIN_WORDS = ("400", "invalidQuery", "Correlated", "googleapis", "Job ID", "subquer")


def test_the_live_query_errors_say_what_happened_and_what_to_do():
    run = plain.explain(RUN_400, "run")
    assert run["kind"] == "query" and run["title"] == "The last run did not finish"
    assert run["message"] == "The agent's check could not run because of a problem in its query."
    assert run["action"] == "Press Run now to try again; if it keeps failing, tell an admin."
    assert run["technical"] == RUN_400, "Google's own words are kept for an admin"
    reviewed = plain.explain(REVIEW_400, "review")
    assert reviewed["kind"] == "query" and reviewed["title"] == "The last review did not finish"
    assert reviewed["message"] == "The review could not run because of a problem in its query."
    for said in (run, reviewed):
        assert not [w for w in PLAIN_WORDS if w in said["title"] + said["message"] + said["action"]], "no code and no BigQuery words on the page"


def test_a_refusal_says_which_account_cannot_read_what_and_who_can_fix_it():
    table = plain.explain("403 Access Denied: Table other:google_bg.sonar_raw: User does not have permission to query table "
                          "other:google_bg.sonar_raw, or perhaps it does not exist.", "source")
    assert table["kind"] == "permission" and table["message"] == "The Console's Google Cloud account is not allowed to read google_bg.sonar_raw."
    assert "table's owners" in table["action"] and table["link"] == {"to": "/connections/bigquery", "label": "Integrations, BigQuery"}
    jobs = plain.explain("BigQuery could not finish the run: 403 Access Denied: Project p: User does not have bigquery.jobs.create permission in project p.")
    assert jobs["message"] == "The Console's Google Cloud account is not allowed to run queries in the project p." and "BigQuery Job User" in jobs["action"]
    connection = plain.explain("BigQuery could not finish the run: 400 Permission denied while using the connection p.us.slrr_vertex_conn")
    assert connection["kind"] == "permission" and "connection" in connection["message"] and "Vertex AI User" in connection["action"]
    vertex = plain.explain("A review failed and will be tried again: Gemini call failed (gemini-4-argon @ global): 403 PERMISSION_DENIED. "
                           "Permission 'aiplatform.endpoints.predict' denied", "review")
    assert vertex["message"] == "The Console's Google Cloud account is not allowed to use Gemini on Vertex AI."
    salt = plain.explain("The salt secret could not be read: 403 Permission 'secretmanager.versions.access' denied for resource")
    assert salt["kind"] == "permission" and "Secret Accessor" in salt["action"], "Google's refusal decides, not the agent's lead-in"


def test_busy_slow_and_unavailable_say_nothing_is_lost_and_to_wait():
    quota = plain.explain("A review failed and will be tried again: Gemini call failed (gemini-4-argon @ global): 429 RESOURCE_EXHAUSTED.", "review")
    assert quota["kind"] == "quota" and "Nothing is lost" in quota["message"] and quota["action"].startswith("Wait a few minutes")
    slow = plain.explain("BigQuery could not finish the run: Deadline of 600.0s exceeded while calling target function")
    assert slow["kind"] == "timeout" and slow["message"] == "The agent's check took too long and was stopped. Nothing is lost."
    down = plain.explain("BigQuery could not finish the run: 503 Service Unavailable: backendError")
    assert down["kind"] == "unavailable" and "clears up by itself" in down["action"]


def test_a_model_the_project_cannot_use_points_to_the_settings_list():
    said = plain.explain("A review failed and will be tried again: Gemini call failed (gemini-9-zinc @ global): 404 NOT_FOUND. Publisher model "
                         "`projects/p/locations/global/publishers/google/models/gemini-9-zinc` was not found or your project does not have access to it.", "review")
    assert said["kind"] == "model" and said["link"] == {"to": "/settings/own_alerts", "label": "Settings, Agent alerts"}
    assert "list there shows the models this project can use" in said["action"]


def test_what_is_not_set_up_is_said_as_the_agent_wrote_it_with_where_to_set_it():
    salt = plain.explain("Set the secret that holds the salt an author's handle is hashed with (Settings, Agent alerts). Nothing is read without it.")
    assert salt["kind"] == "setup" and salt["message"].startswith("Set the secret") and salt["link"]["to"] == "/settings/own_alerts"
    created = plain.explain(cycle.NOT_CREATED)
    assert created["kind"] == "setup" and created["link"] == {"to": "/settings/flags", "label": "Settings, Switches"}
    dataset = plain.explain("Set the agent's dataset first (Settings, BigQuery, Dataset).")
    assert dataset["link"] == {"to": "/settings/bigquery", "label": "Settings, BigQuery"}
    missing = plain.explain("BigQuery could not finish the run: 404 Not found: Model p:slrr_triage_agent.gemini4_fast_decisions was not found in location US")
    assert missing["kind"] == "missing" and "slrr_triage_agent.gemini4_fast_decisions" in missing["message"]
    sources = plain.explain("Could not read: Sonar, Sprinklr comments")
    assert sources["kind"] == "sources" and sources["message"] == "The agent could not read Sonar, Sprinklr comments. The other sources were read as usual."


def test_anything_else_still_says_what_to_do_and_nothing_at_all_is_nothing():
    other = plain.explain("ZeroDivisionError: division by zero", "review")
    assert other["kind"] == "other" and other["title"] == "The last review did not finish" and "Run now" in other["action"]
    assert plain.explain("") == {} and plain.explain("   ") == {}
    assert plain.for_viewer(other, admin=False) == {k: v for k, v in other.items() if k != "technical"} and plain.for_viewer(other, admin=True) == other


def test_the_page_gives_plain_words_to_everyone_and_googles_words_to_admins_only(ctx, client, monkeypatch):
    gw, _ = set_up(ctx, monkeypatch)
    ctx.config.platform.flags.bigquery_admin = True
    schema.provision(ctx)
    ctx.store.put_kv(cycle.STATE, {"last": ctx.now().isoformat(), "error": RUN_400, "result": {}})
    ctx.store.put_kv(review.STATE, {"last": ctx.now().isoformat(), "error": REVIEW_400, "result": {}})
    seen = client.get("/api/own", headers=iap(VIEWER)).json()["state"]
    assert seen["problem"]["message"] == "The agent's check could not run because of a problem in its query." and "technical" not in seen["problem"]
    assert seen["error"] == seen["problem"]["message"], "no raw error reaches someone who is not an admin"
    assert seen["review"]["problem"]["title"] == "The last review did not finish" and seen["review"]["error"] == seen["review"]["problem"]["message"]
    assert seen["made_before"] is True
    admin = client.get("/api/own", headers=iap(ADMIN)).json()["state"]
    assert admin["error"] == RUN_400 and admin["problem"]["technical"] == RUN_400 and admin["review"]["problem"]["technical"] == REVIEW_400


def test_a_run_by_hand_that_fails_answers_in_plain_words(ctx, client, monkeypatch):
    gw, _ = set_up(ctx, monkeypatch)
    ctx.config.platform.flags.bigquery_admin = True
    schema.provision(ctx)
    gw.fail = f"CALL `{HOME}.{schema.PROCEDURE}`"
    out = client.post("/api/own/run", headers=iap(LEAD)).json()
    assert out["ok"] is False and out["problem"]["kind"] == "permission" and "technical" not in out["problem"]
    assert "403" not in out["run"]["error"], "a lead is told what happened, not Google's words"
    admin = client.post("/api/own/run", headers=iap(ADMIN)).json()
    assert "403 Access Denied" in admin["problem"]["technical"]
