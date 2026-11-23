"""Agent alerts on Google Cloud: what the deploy scripts create and what they leave alone.

The scripts cannot reach Google Cloud from here. These checks parse them, run infra/11_own_alerts.sh and the Python
that decides which settings the deploy fills against stand-ins for gcloud, bq and curl, and read the rest.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
INFRA = ROOT / "infra"


# gcloud, bq and curl as infra/11_own_alerts.sh meets them. What exists on the project is in state.json; every call is
# written to calls.jsonl. A call the script was never meant to make stops it.
CLOUD = r'''
import json, os, sys
from pathlib import Path

home = Path(os.environ["FAKE_CLOUD"])
state = json.loads((home / "state.json").read_text())
tool, args = sys.argv[1], sys.argv[2:]
piped = sys.stdin.read() if "--data-file=-" in args else ""
with (home / "calls.jsonl").open("a") as log:
    log.write(json.dumps({"tool": tool, "args": args}) + "\n")


def save():
    (home / "state.json").write_text(json.dumps(state))


def flag(name):
    return next((a.split("=", 1)[1] for a in args if a.startswith(name + "=")), "")


if tool == "gcloud" and args[:2] == ["auth", "print-access-token"]:
    print("token-1")
elif tool == "gcloud" and args[:2] == ["secrets", "describe"]:
    sys.exit(0 if args[2] in state["secrets"] else 1)
elif tool == "gcloud" and args[:2] == ["secrets", "create"]:
    state["secrets"][args[2]] = piped
    save()
elif tool == "gcloud" and args[:2] == ["projects", "add-iam-policy-binding"]:
    state["project_roles"].append([args[2], flag("--member"), flag("--role")])
    save()
elif tool == "bq" and args[0] == "show" and "--connection" in args:
    account = state["connections"].get(args[-1])
    if account is None:
        sys.exit(1)
    print(json.dumps({"name": args[-1], "cloudResource": {"serviceAccountId": account}}) if "--format=json" in args else args[-1])
elif tool == "bq" and args[0] == "mk" and "--connection" in args and flag("--connection_type") == "CLOUD_RESOURCE":
    state["connections"][f"{flag('--project_id')}.{flag('--location').lower()}.{args[-1]}"] = "connection@bq.test"
    save()
elif tool == "curl":
    url = next(a for a in args if a.startswith("https://"))
    method, body = args[args.index("-X") + 1], json.loads(args[args.index("-d") + 1])
    if "Authorization: Bearer token-1" not in args:
        sys.exit("curl was not given the deployer's token")
    if url.endswith(":getIamPolicy") and method == "POST":
        if state["refuse"] == "policy":
            sys.exit(22)
        state["policy_of"] = url.rsplit(":", 1)[0]
        save()
        print(json.dumps(state["policy"]))
    elif url.endswith(":setIamPolicy") and method == "POST":
        state["policy"] = body["policy"]
        save()
        print(json.dumps(body["policy"]))
    elif url.endswith("/cacheConfig") and method == "PATCH":
        if state["refuse"] == "cache":
            sys.exit(22)
        state["cache"] = {"url": url, **body}
        save()
        print("{}")
    else:
        sys.exit(f"curl was asked for something this stand-in does not know: {method} {url}")
else:
    sys.exit(f"{tool} was asked for something this stand-in does not know: {args}")
'''
RUNTIME = "serviceAccount:runtime@proj.test"
ADMIN = "roles/bigquery.connectionAdmin"


def script(name: str) -> str:
    return (INFRA / name).read_text(encoding="utf-8")


class Deployer:
    """infra/11_own_alerts.sh run from a copy of infra/, with the example env file as its env file."""

    def __init__(self, home: Path):
        self.home, self.infra, self.bin = home, home / "infra", home / "bin"
        self.infra.mkdir()
        self.bin.mkdir()
        for name in ("11_own_alerts.sh", "_lib.sh"):
            shutil.copy(INFRA / name, self.infra / name)
        env = re.sub(r"^export PROJECT_ID=.*$", 'export PROJECT_ID="proj"', script("00_env.example"), flags=re.M)
        (self.infra / ".env").write_text(env + '\nexport RUNTIME_SA="runtime@proj.test"\n', encoding="utf-8")
        (self.bin / "cloud.py").write_text(CLOUD, encoding="utf-8")
        for tool in ("gcloud", "bq", "curl"):
            stand_in = self.bin / tool
            stand_in.write_text(f'#!/usr/bin/env bash\nexec "{sys.executable}" "{self.bin / "cloud.py"}" {tool} "$@"\n', encoding="utf-8")
            stand_in.chmod(0o755)
        self.exists()

    def exists(self, **what) -> None:
        """What the project already holds before the next run."""
        held = {"connections": {}, "secrets": {}, "project_roles": [], "policy": {"etag": "ACAB"}, "refuse": "", **what}
        (self.home / "state.json").write_text(json.dumps(held), encoding="utf-8")

    def run(self, *options: str):
        """One run: (how it ended, what the project holds afterwards, what was asked of gcloud, bq and curl)."""
        (self.home / "calls.jsonl").write_text("", encoding="utf-8")
        env = {**os.environ, "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}", "FAKE_CLOUD": str(self.home)}
        done = subprocess.run(["bash", str(self.infra / "11_own_alerts.sh"), *options], env=env, capture_output=True, text=True, check=False)
        calls = [json.loads(line) for line in (self.home / "calls.jsonl").read_text(encoding="utf-8").splitlines()]
        return done, json.loads((self.home / "state.json").read_text(encoding="utf-8")), calls


@pytest.fixture
def deployer(tmp_path):
    return Deployer(tmp_path)


def seeder():
    spec = importlib.util.spec_from_file_location("seed_settings", INFRA / "10_seed_settings.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def cloud(monkeypatch):
    """gcloud and bq as the seeder meets them: `there` holds what exists."""
    there: set[str] = set()
    asked: list[list[str]] = []

    def run(command, **_):
        asked.append(list(command))
        found = any(name in command for name in there)
        return subprocess.CompletedProcess(command, 0 if found else 1, stdout="", stderr="")

    for name, value in {"PROJECT_ID": "proj", "REGION": "us-central1", "DATASET": "slrr_triage_agent", "BQ_LOCATION": "US",
                        "CONSOLE_SERVICE": "slrr-triage-console"}.items():
        monkeypatch.setenv(name, value)
    for name in ("OWN_CONNECTION", "OWN_SALT_SECRET", "AGENT_RESOURCE", "WORKER_SERVICE"):
        monkeypatch.delenv(name, raising=False)
    module = seeder()
    monkeypatch.setattr(module.subprocess, "run", run)
    return module, there, asked


def test_every_infra_script_parses():
    for path in sorted(INFRA.glob("*.sh")):
        done = subprocess.run(["bash", "-n", str(path)], capture_output=True, text=True, check=False)
        assert done.returncode == 0, f"{path.name}: {done.stderr}"


def test_apps_script_is_never_enabled():
    for path in sorted(INFRA.glob("*")):
        if path.is_file():
            assert "script.googleapis.com" not in path.read_text(encoding="utf-8", errors="ignore"), path.name


def test_the_apis_and_the_role_agent_alerts_needs_are_set_by_the_deploy():
    apis = script("01_enable_apis.sh")
    assert "dlp.googleapis.com" in apis and "bigqueryconnection.googleapis.com" in apis and "sheets.googleapis.com" in apis
    assert "roles/dlp.user" in script("02_service_accounts.sh")


def test_the_deploy_makes_the_connection_and_the_salt_before_it_fills_the_settings():
    deploy = script("deploy.sh")
    assert deploy.index("11_own_alerts.sh\"") < deploy.index("10_seed_settings.py")
    assert deploy.index("04_bigquery.sh") < deploy.index("11_own_alerts.sh\""), "the connection goes where the dataset is"
    assert '"${INFRA}/11_own_alerts.sh"\n' in deploy, "the deploy passes it no option, so Vertex AI's cache is turned off as the specification says"


def test_a_first_run_makes_the_connection_lets_both_accounts_use_it_makes_the_salt_and_turns_the_cache_off(deployer):
    done, held, calls = deployer.run()
    assert done.returncode == 0, done.stderr
    assert held["connections"] == {"proj.us.slrr_vertex_conn": "connection@bq.test"}, "named the way BigQuery names it: the location in lower case"
    assert held["project_roles"] == [["proj", "serviceAccount:connection@bq.test", "roles/aiplatform.user"]], "the connection's own account may call Vertex AI"
    assert held["policy_of"] == "https://bigqueryconnection.googleapis.com/v1/projects/proj/locations/us/connections/slrr_vertex_conn"
    assert held["policy"] == {"etag": "ACAB", "bindings": [{"role": ADMIN, "members": [RUNTIME]}]}, "the runtime account, on this one connection"
    assert re.fullmatch(r"[0-9a-f]{64}", held["secrets"]["slrr-author-hash-salt"]), "32 random bytes, and no line break after them"
    assert held["cache"] == {"url": "https://us-central1-aiplatform.googleapis.com/v1/projects/proj/cacheConfig",
                             "name": "projects/proj/cacheConfig", "disableCache": True}
    left = done.stdout[done.stdout.index("Left for a person"):]
    assert "1. Share the KOF sheet (Viewer) with runtime@proj.test" in left, "the account to share the KOF sheet with is named"
    assert "3." not in left, "nothing else is left"
    assert "Vertex AI's cache is off" in done.stdout and done.stderr == ""


def test_a_second_run_makes_nothing_twice_and_keeps_who_else_may_use_the_connection(deployer):
    others = [{"role": ADMIN, "members": ["user:lead@ops.test"]}, {"role": "roles/bigquery.connectionUser", "members": ["group:analysts@ops.test"]}]
    deployer.exists(connections={"proj.us.slrr_vertex_conn": "connection@bq.test"}, secrets={"slrr-author-hash-salt": "kept"},
                    policy={"etag": "BwYx", "bindings": others})
    done, held, calls = deployer.run()
    assert done.returncode == 0, done.stderr
    assert not [c for c in calls if c["tool"] == "bq" and c["args"][0] == "mk"], "the connection is not made again"
    assert not [c for c in calls if c["args"][:2] == ["secrets", "create"]]
    assert held["secrets"] == {"slrr-author-hash-salt": "kept"}, "a new salt would change every author's hash"
    kept = {"etag": "BwYx", "bindings": [{"role": ADMIN, "members": ["user:lead@ops.test", RUNTIME]}, others[1]]}
    assert held["policy"] == kept
    deployer.exists(**{k: held[k] for k in ("connections", "secrets", "policy")})
    assert deployer.run()[1]["policy"] == kept, "the runtime account is not listed twice"


def test_keep_cache_leaves_the_projects_cache_setting_alone(deployer):
    done, held, calls = deployer.run("--keep-cache")
    assert done.returncode == 0, done.stderr
    assert "cache" not in held and not [c for c in calls if any("cacheConfig" in a for a in c["args"])]
    assert held["connections"] and held["secrets"], "the rest is still done"


def test_a_refused_cache_change_is_said_and_the_rest_is_still_done(deployer):
    deployer.exists(refuse="cache")
    done, held, _ = deployer.run()
    assert done.returncode == 0, "the deploy goes on: the Console and the jobs are still deployed"
    assert "roles/aiplatform.admin" in done.stderr and "cache" not in held
    assert held["connections"] and held["secrets"] and held["policy"].get("bindings")
    left = done.stdout[done.stdout.index("Left for a person"):]
    assert "cache" in left and "11_own_alerts.sh" in left, "what is left names the cache and how to try again"


def test_a_refused_grant_on_the_connection_names_the_command_that_gives_it(deployer):
    deployer.exists(refuse="policy")
    done, held, _ = deployer.run()
    assert done.returncode == 0
    assert "gcloud projects add-iam-policy-binding proj --member=serviceAccount:runtime@proj.test --role=roles/bigquery.connectionAdmin" in done.stderr
    assert "bindings" not in held["policy"] and held["secrets"], "the salt is still made"
    left = done.stdout[done.stdout.index("Left for a person"):]
    assert "3. Let the runtime account use the connection: gcloud projects add-iam-policy-binding proj" in left


def test_an_option_it_does_not_know_stops_it_before_anything_is_asked(deployer):
    done, held, calls = deployer.run("--no-such-option")
    assert done.returncode == 2 and calls == [] and not held["connections"]


def test_the_in_house_job_is_given_the_time_a_run_holds_its_lock():
    from triage_agent.ownalerts import cycle

    assert f"deploy_job slrr-inhouse inhouse {cycle.LOCK_S}s" in script("06_jobs.sh")


def test_the_deploy_fills_the_connection_and_the_salts_secret_once_they_exist(cloud):
    module, there, asked = cloud
    assert module.known()["own_alerts"] == {"ai_connection": "", "hash_salt_secret": ""}, "nothing is named before it exists"
    there.update({"proj.us.slrr_vertex_conn", "slrr-author-hash-salt"})
    assert module.known()["own_alerts"] == {"ai_connection": "proj.us.slrr_vertex_conn", "hash_salt_secret": "slrr-author-hash-salt"}
    assert ["bq", "show", "--connection", "proj.us.slrr_vertex_conn"] in asked
    assert ["gcloud", "secrets", "describe", "slrr-author-hash-salt", "--project=proj"] in asked


def test_the_names_in_the_env_file_are_the_ones_filled(cloud, monkeypatch):
    module, there, _ = cloud
    monkeypatch.setenv("OWN_CONNECTION", "team_conn")
    monkeypatch.setenv("OWN_SALT_SECRET", "team-salt")
    there.update({"proj.us.team_conn", "team-salt"})
    assert module.known()["own_alerts"] == {"ai_connection": "proj.us.team_conn", "hash_salt_secret": "team-salt"}


def test_the_deploy_writes_the_connection_and_the_salt_into_empty_settings_and_leaves_a_set_one_alone(cloud, monkeypatch, tmp_path):
    from triage_agent.config import load_config
    from triage_agent.store import SqliteStore

    module, there, _ = cloud
    db = str(tmp_path / "settings.db")
    for name, value in {"TRIAGE_BACKEND": "local", "TRIAGE_LOCAL_DB": db, "TRIAGE_LLM": "fake", "TRIAGE_PROJECT_ID": "proj",
                        "GOOGLE_CLOUD_PROJECT": "proj", "TRIAGE_FIRESTORE_DB": "(default)", "TRIAGE_ENV": "dev"}.items():
        monkeypatch.setenv(name, value)  # the seeder sets what is missing: set here, so each is put back afterwards
    monkeypatch.setattr(sys, "argv", ["10_seed_settings.py"])
    SqliteStore(db).save_config_overrides({"platform": {"own_alerts": {"hash_salt_secret": "the-team-chose-this"}}}, actor="admin@ops.test", note="set in the Console")
    there.update({"proj.us.slrr_vertex_conn", "slrr-author-hash-salt"})

    assert module.main() == 0
    own = load_config(SqliteStore(db)).platform.own_alerts
    assert own.ai_connection == "proj.us.slrr_vertex_conn", "the empty setting is filled, and the settings still validate"
    assert own.hash_salt_secret == "the-team-chose-this", "a setting someone filled is not changed"
