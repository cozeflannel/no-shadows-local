#!/usr/bin/env python3
"""Write what the deploy already knows into the Console's settings, so nobody types it twice.

Fills only settings that are still empty: the project and region, the Console and worker addresses, the Agent Runtime
resource, the push identity, the BigQuery dataset with its events table, and for agent alerts the BigQuery connection
and the salt's secret once infra/11_own_alerts.sh has made them. Anything already set in the Console is left alone.
The values land in the same settings store the Console edits, with a history entry and an audit entry, so they can
be changed there afterwards.

    source infra/.env && .venv/bin/python infra/10_seed_settings.py [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def read(path: Path) -> str:
    return path.read_text().strip() if path.exists() else ""


def service_url(service: str) -> str:
    out = subprocess.run(["gcloud", "run", "services", "describe", service, f"--project={env('PROJECT_ID')}", f"--region={env('REGION')}",
                          "--format=value(status.url)"], capture_output=True, text=True, check=False)
    return out.stdout.strip() if out.returncode == 0 else ""


def exists(*command: str) -> bool:
    return subprocess.run(list(command), capture_output=True, text=True, check=False).returncode == 0


def known() -> dict[str, dict[str, object]]:
    project, region, dataset = env("PROJECT_ID"), env("REGION"), env("DATASET")
    connection = f"{project}.{env('BQ_LOCATION').lower()}.{env('OWN_CONNECTION', 'slrr_vertex_conn')}"  # as BigQuery names it
    salt = env("OWN_SALT_SECRET", "slrr-author-hash-salt")
    console = service_url(env("CONSOLE_SERVICE"))
    worker = read(ROOT / ".local" / "worker_url.txt") or service_url(env("WORKER_SERVICE") or f"{env('CONSOLE_SERVICE')}-worker")
    resource = env("AGENT_RESOURCE") or read(ROOT / ".local" / "agent_resource.txt")
    return {
        "gcp": {"project": project, "region": region, "console_url": console, "agent_runtime_resource": resource},
        "pubsub": {"project": project, "worker_url": worker, "push_service_account": env("SCHEDULER_SA"), "push_audience": worker},
        "bigquery": {"project": project, "location": env("BQ_LOCATION"), "dataset": f"{project}.{dataset}" if dataset else "",
                     "tables": {"events": f"{project}.{dataset}.agent_events"} if dataset else {}},
        # Agent alerts & Campaigns: named only once they exist, so the settings never point at something that is not there.
        "campaigns": {
            "firestore_project": project,
            "firestore_database": env("CAMPAIGNS_FIRESTORE_DB", "slrr-social-alerts")
            if exists("gcloud", "firestore", "databases", "describe", f"--database={env('CAMPAIGNS_FIRESTORE_DB', 'slrr-social-alerts')}", f"--project={project}")
            else "",
        },
        "own_alerts": {"ai_connection": connection if exists("bq", "show", "--connection", connection) else "",
                       "hash_salt_secret": salt if exists("gcloud", "secrets", "describe", salt, f"--project={project}") else ""},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="show what would be written; write nothing")
    args = parser.parse_args()
    if not env("PROJECT_ID"):
        sys.exit("PROJECT_ID is not set: source infra/.env first.")
    os.environ.setdefault("TRIAGE_BACKEND", "gcp")
    os.environ.setdefault("TRIAGE_PROJECT_ID", env("PROJECT_ID"))
    os.environ.setdefault("GOOGLE_CLOUD_PROJECT", env("PROJECT_ID"))
    os.environ.setdefault("TRIAGE_FIRESTORE_DB", env("FIRESTORE_DB", "(default)"))
    os.environ.setdefault("TRIAGE_ENV", env("TRIAGE_ENV", "dev"))

    from triage_agent import audit
    from triage_agent.config import AgentConfig, deep_merge, load_default_dict
    from triage_agent.context import build_context

    ctx = build_context()
    current = ctx.config.platform.model_dump(mode="json")
    overrides = json.loads(json.dumps(ctx.store.get_config_overrides() or {}))
    platform = overrides.setdefault("platform", {})
    written: list[str] = []
    for part, values in known().items():
        for key, value in values.items():
            if not value:
                continue
            if isinstance(value, dict):  # a mapping: add the entries that are missing
                held = dict(current[part].get(key) or {})
                missing = {k: v for k, v in value.items() if v and not held.get(k)}
                if missing:
                    platform.setdefault(part, {})[key] = {**held, **missing}
                    written += [f"{part}.{key}.{k} = {v}" for k, v in missing.items()]
            elif not current[part].get(key):
                platform.setdefault(part, {})[key] = value
                written.append(f"{part}.{key} = {value}")
    if not written:
        print("Settings already hold everything the deploy knows. Nothing written.")
        return 0
    AgentConfig.model_validate(deep_merge(load_default_dict(), overrides))  # refuse to write settings that do not validate
    print("\n".join(("Would write:" if args.dry_run else "Writing:", *(f"  {w}" for w in written))))
    if args.dry_run:
        return 0
    actor = subprocess.run(["gcloud", "config", "get-value", "account"], capture_output=True, text=True, check=False).stdout.strip() or "deploy"
    ctx.store.save_config_overrides(overrides, actor=actor, note="Filled from the deploy")
    ctx.reload_config()
    audit.record(ctx, actor=actor, action="settings.seed", surface="system", target_type="setting", target_id="platform",
                 summary=f"The deploy filled {len(written)} empty setting(s)", detail={"written": written})
    print(f"Saved as {actor}. Change any of it in the Console: Settings.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
