"""What went wrong in a run, a review or a source's read, in plain words for the Agent alerts page.

The runs keep Google's own words (kv own:state, own:review, each source's entry): they are what an admin sends on to
whoever looks after the Console. The page shows what happened and what to do instead; the raw words stay under
Technical details, for admins only (console/backend/routes_own.py).

Each answer is {kind, title, message, action, link, technical}: kind is one of KINDS, link is {to, label} or {}.
"""

from __future__ import annotations

import re

KINDS = ("setup", "sources", "missing", "permission", "model", "quota", "timeout", "unavailable", "query", "other")
TECHNICAL_CHARS = 2000
SETTINGS = {"to": "/settings/own_alerts", "label": "Settings, Agent alerts"}
SWITCHES = {"to": "/settings/flags", "label": "Settings, Switches"}
BIGQUERY = {"to": "/connections/bigquery", "label": "Integrations, BigQuery"}
BIGQUERY_SETTINGS = {"to": "/settings/bigquery", "label": "Settings, BigQuery"}
HEADS = {"run": "The last run did not finish", "review": "The last review did not finish", "source": "This source could not be read"}

# Sentences the agent writes itself when something is not set up: already plain, so they are shown as they are.
_SETUP = re.compile(r"(\bSet the |The salt secret|Share the KOF sheet|tables in BigQuery are not created yet|is not a Chat space|"
                    r"is not one of the agent's spaces|\(Settings, )", re.I)
# ...unless Google's own answer is inside one: then that answer decides.
_GOOGLE = re.compile(r"\b[45]\d\d\b|denied|exceeded|timed out|unavailable", re.I)
_PREFIXES = re.compile(r"^(?:BigQuery could not finish the run|A review failed and will be tried again|BigQuery did not take the decisions|"
                       r"The queue could not be closed and will be closed next minute|Could not read)\s*:\s*", re.I)
_MISSING = re.compile(r"\bNot found: (Table|Model|Routine|Dataset|Connection) ([\w.:$-]+)", re.I)
_TABLE = re.compile(r"Access Denied: (?:Table|Dataset) ([\w.:$-]+)", re.I)
_JOBS = re.compile(r"bigquery\.jobs\.create permission in project ([\w-]+)", re.I)
_PERMISSION = re.compile(r"\b(403|Access Denied|PERMISSION_DENIED|Permission denied|does not have [\w.]+ permission|"
                         r"permission [^\n]{0,60} denied|not authori[sz]ed|caller does not have permission)", re.I)
_MODEL = re.compile(r"(Publisher model|/models/[\w.@-]+)[^\n]{0,240}(not found|NOT_FOUND|does not have access)|"
                    r"\bmodel\b[^\n]{0,80}\b(is not found|was not found|does not exist|is not supported)", re.I)
_QUOTA = re.compile(r"\b(429|quota|quotaExceeded|rateLimitExceeded|RESOURCE_EXHAUSTED|Exceeded rate limits|too many (?:concurrent|requests))", re.I)
_TIMEOUT = re.compile(r"\b(timed? ?out|timeout|DEADLINE_EXCEEDED|deadline[^\n]{0,40}exceeded|took too long|504)\b", re.I)
_UNAVAILABLE = re.compile(r"\b(500|502|503|backendError|internalError|UNAVAILABLE|Service Unavailable|Bad Gateway|Internal error|"
                          r"Connection (?:aborted|reset|refused)|temporarily unavailable)\b", re.I)
_QUERY = re.compile(r"\b(400|invalidQuery|Syntax error|Query error|Correlated subquer\w*|Unrecognized name|No matching signature|"
                    r"is not supported|Invalid (?:value|table|query|argument))\b", re.I)


def _doing(what: str) -> str:
    return {"review": "the review", "source": "this source's read"}.get(what, "the agent's check")


def _clean(raw: str) -> str:
    """The error without the lead-in the run or the review put before Google's words."""
    text = str(raw or "").strip()
    while True:
        cut = _PREFIXES.sub("", text, count=1)
        if cut == text:
            return text
        text = cut


def _name(found: str) -> str:
    """project:dataset.table or project.dataset.table, said as dataset.table."""
    parts = [p for p in re.split(r"[:.]", found.strip("`.: ")) if p]
    return ".".join(parts[-2:]) if len(parts) >= 2 else found


def _setup_link(body: str) -> dict:
    if "Settings, Switches" in body:
        return SWITCHES
    if "Settings, BigQuery" in body:
        return BIGQUERY_SETTINGS
    return SETTINGS


def _permission(body: str, doing: str) -> dict:
    table, jobs = _TABLE.search(body), _JOBS.search(body)
    if table:
        return {"message": f"The Console's Google Cloud account is not allowed to read {_name(table.group(1))}.",
                "action": "Ask that table's owners, or an admin of its Google Cloud project, to let the Console's account read it. The "
                          "statement to send them, with the account's name, is under Integrations, BigQuery. Nothing is lost: the agent "
                          "tries again on its own.", "link": BIGQUERY}
    if jobs:
        return {"message": f"The Console's Google Cloud account is not allowed to run queries in the project {jobs.group(1)}.",
                "action": "An admin of that Google Cloud project can give the Console's account the BigQuery Job User role."}
    if re.search(r"connection", body, re.I):
        return {"message": "BigQuery is not allowed to call Gemini through the connection agent alerts uses.",
                "action": "An admin of the Google Cloud project can give that connection's account the Vertex AI User role (running "
                          "infra/11_own_alerts.sh again does it)."}
    if re.search(r"aiplatform|vertex", body, re.I):
        return {"message": "The Console's Google Cloud account is not allowed to use Gemini on Vertex AI.",
                "action": "An admin of the Google Cloud project can give the Console's account the Vertex AI User role."}
    if re.search(r"secret", body, re.I):
        return {"message": "The Console's Google Cloud account cannot read the secret agent alerts needs.",
                "action": "An admin can give the Console's account the Secret Manager Secret Accessor role on that secret (Settings, Secrets)."}
    return {"message": f"Google Cloud refused the Console's account, so {doing} stopped.",
            "action": "Tell an admin and include the technical details: they name what the account needs."}


def explain(raw: str, what: str = "run") -> dict:
    """What happened and what to do, for one error a run (`run`), a review (`review`) or a source's read (`source`)
    recorded. {} when nothing went wrong."""
    text = str(raw or "").strip()
    if not text:
        return {}
    doing, body = _doing(what), _clean(text)
    out = {"kind": "other", "title": HEADS.get(what, "Something went wrong"), "message": "", "action": "", "link": {},
           "technical": text[:TECHNICAL_CHARS]}
    missing = _MISSING.search(body)
    if re.match(r"^Could not read\s*:", text, re.I):  # the run read the other sources: each one that failed says why itself
        out.update(kind="sources", title="Some sources could not be read",
                   message=f"The agent could not read {body}. The other sources were read as usual.",
                   action="Open the Sources tab to see what each one needs.")
    elif _SETUP.search(body) and not _GOOGLE.search(body):
        out.update(kind="setup", title="Agent alerts is not fully set up yet", message=body[:600],
                   action="An admin can fix this; the next run picks it up.", link=_setup_link(body))
    elif missing:
        out.update(kind="missing", title="Something agent alerts needs in BigQuery is missing",
                   message=f"BigQuery says the {missing.group(1).lower()} {_name(missing.group(2))} is not there, so {doing} stopped.",
                   action="An admin can make it again: with \"Change BigQuery from here\" on under Settings, Switches, the next run "
                          "creates whatever is missing. Press Run now afterwards.", link=SWITCHES)
    elif _PERMISSION.search(body):
        out.update(kind="permission", title="The Console's Google Cloud account was refused", **_permission(body, doing))
    elif _MODEL.search(body):
        out.update(kind="model", title="The Gemini model it is set to use is not available",
                   message=f"Vertex AI says the Gemini model agent alerts is set to use is not available to this project, so {doing} stopped.",
                   action="An admin can choose another model under Settings, Agent alerts. The list there shows the models this project can use.",
                   link=SETTINGS)
    elif _QUOTA.search(body):
        out.update(kind="quota", title="Google Cloud asked the agent to slow down",
                   message=f"A Google Cloud usage limit was reached, so {doing} stopped early. Nothing is lost: what was read waits for the next run.",
                   action="Wait a few minutes. The agent tries again on its own, or press Run now later.")
    elif _TIMEOUT.search(body):
        out.update(kind="timeout", title="It took too long", message=f"{doing[0].upper()}{doing[1:]} took too long and was stopped. Nothing is lost.",
                   action="Wait a few minutes and press Run now. If it keeps happening, tell an admin.")
    elif _UNAVAILABLE.search(body):
        out.update(kind="unavailable", title="Google Cloud did not answer", message=f"Google Cloud had a short problem, so {doing} stopped. Nothing is lost.",
                   action="This usually clears up by itself. The agent tries again on its own; you can also press Run now in a few minutes.")
    elif _QUERY.search(body):
        message = {"review": "The review could not run because of a problem in its query.",
                   "source": "This source could not be read because of a problem in the query that reads it."}.get(
                       what, "The agent's check could not run because of a problem in its query.")
        out.update(kind="query", message=message, action="Press Run now to try again; if it keeps failing, tell an admin.")
    else:
        out.update(message=f"Something went wrong and {doing} stopped.",
                   action="Press Run now to try again. If it keeps failing, tell an admin and include the technical details.")
    return out


def for_viewer(problem: dict, admin: bool) -> dict:
    """The answer as the person asking may see it: the technical details are for admins only."""
    if not problem or admin:
        return problem
    return {k: v for k, v in problem.items() if k != "technical"}
