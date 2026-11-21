"""Deploy (create or update) the triage agent on Agent Runtime.

Agent Runtime is the managed runtime of the Gemini Enterprise Agent Platform (formerly Vertex AI
Agent Engine). The agent is deployed from source files: no pickling and no staging bucket.

    source infra/.env
    .venv/bin/python infra/05_deploy_agent_engine.py --dry-run     # build + validate the source package only
    .venv/bin/python infra/05_deploy_agent_engine.py               # create (first time) or update (AGENT_RESOURCE set)
    .venv/bin/python infra/05_deploy_agent_engine.py --smoke       # call op=health exactly like the Studio add-on does

The resource name is written to .local/agent_resource.txt. Put it in infra/.env as AGENT_RESOURCE (later runs
update in place) and in the Studio add-on's Script Properties (studio-addon/README.md).

Needs google-cloud-aiplatform >= 2.x (the `agentplatform` client; see requirements.txt) and ADC with
roles/aiplatform.admin (or equivalent) + roles/iam.serviceAccountUser on the runtime service account.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tarfile
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD_DIR = ROOT / ".local" / "agent_build"
RESOURCE_FILE = ROOT / ".local" / "agent_resource.txt"
MAX_SOURCE_BYTES = 8 * 1024 * 1024  # Agent Runtime limit for source_packages
PYTHON_VERSION = "3.12"
ENTRYPOINT_MODULE = "triage_agent.agent_engine_app"
ENTRYPOINT_OBJECT = "root_agent"

QUERY_METHOD = {
    "name": "query",
    "api_mode": "",
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "description": "Operation name (docs/CONTRACTS.md §3), e.g. triage_message"},
            "payload": {"type": "object", "description": "Operation payload"},
            "context": {"type": "object", "description": "RequestContext: invoked_by, flow, run_id, deliver, targets"},
        },
        "required": ["op"],
    },
}


def env(name: str, default: str | None = None, *, required: bool = False) -> str:
    value = os.environ.get(name, default)
    if required and (not value or value == "REPLACE_ME"):
        sys.exit(f"{name} is not set: copy infra/00_env.example to infra/.env, edit it, and `source infra/.env`.")
    return value or ""


def runtime_env_vars() -> dict[str, str]:
    """Environment for the deployed agent. Never set GOOGLE_CLOUD_PROJECT/LOCATION (the runtime owns them)."""
    project = env("PROJECT_ID", required=True)
    return {
        "TRIAGE_BACKEND": "gcp",
        "TRIAGE_PROJECT_ID": project,
        "TRIAGE_ENV": env("TRIAGE_ENV", "dev"),
        "TRIAGE_FIRESTORE_DB": env("FIRESTORE_DB", "(default)"),
        "TRIAGE_BQ_TABLE": f"{project}.{env('DATASET', 'slrr_triage_agent')}.agent_events",
        "TRIAGE_LLM": "vertex",
        "TRIAGE_LLM_LOCATION": env("TRIAGE_LLM_LOCATION", "global"),
        "TRIAGE_GMAIL": env("TRIAGE_GMAIL", "google"),
        "TRIAGE_GMAIL_READ_SCOPE": env("TRIAGE_GMAIL_READ_SCOPE", "metadata"),
        "TRIAGE_TOKEN_VAULT": "secretmanager",
        "TRIAGE_STEALTH_BURSON": env("TRIAGE_STEALTH_BURSON", "true"),
    }


def flatten_requirements(path: Path, seen: set[Path] | None = None) -> list[str]:
    """Inline `-r other.txt` includes so the package carries one self-contained requirements.txt."""
    seen = seen or set()
    path = path.resolve()
    if path in seen:
        return []
    seen.add(path)
    lines: list[str] = []
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith(("-r ", "--requirement ")):
            lines += flatten_requirements(path.parent / line.split(None, 1)[1], seen)
        else:
            lines.append(line)
    return lines


def build_source_package() -> list[str]:
    """Copy the agent sources into .local/agent_build (no caches, tests or local data); return package paths."""
    if BUILD_DIR.exists():
        shutil.rmtree(BUILD_DIR)
    BUILD_DIR.mkdir(parents=True)
    ignore = shutil.ignore_patterns("__pycache__", "*.pyc", "*.db", ".DS_Store")
    shutil.copytree(ROOT / "triage_agent", BUILD_DIR / "triage_agent", ignore=ignore)
    shutil.copytree(ROOT / "config", BUILD_DIR / "config", ignore=ignore)
    (BUILD_DIR / "requirements.txt").write_text("\n".join(flatten_requirements(ROOT / "requirements-agent.txt")) + "\n")
    return ["triage_agent", "config", "requirements.txt"]


def package_size(paths: list[str]) -> int:
    buf = BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for p in paths:
            tar.add(BUILD_DIR / p, arcname=p)
    return buf.tell()


def check_entrypoint() -> None:
    """Import the entrypoint from the built package in a clean interpreter (catches missing files)."""
    code = (f"import {ENTRYPOINT_MODULE} as m; a = getattr(m, {ENTRYPOINT_OBJECT!r}); "
            "assert callable(getattr(a, 'query')); "
            "from triage_agent.config import load_config; c = load_config(); print('entrypoint ok, config', c.version)")
    result = subprocess.run([sys.executable, "-c", code], cwd=BUILD_DIR, capture_output=True, text=True,
                            env={**os.environ, "PYTHONPATH": str(BUILD_DIR), "TRIAGE_LLM": "fake"})
    if result.returncode != 0:
        sys.exit(f"Entrypoint check failed:\n{result.stderr[-3000:]}")
    print(result.stdout.strip())


def deploy_config(paths: list[str]) -> dict:
    sa = env("RUNTIME_SA", required=True)
    return {
        "display_name": env("AGENT_DISPLAY_NAME", "SLRR Triage Agent"),
        "description": "Triages Burson/Sonar alerts, drafts Social Alert emails, T&S pre-fills, conversation (docs/CONTRACTS.md).",
        "source_packages": paths,
        "entrypoint_module": ENTRYPOINT_MODULE,
        "entrypoint_object": ENTRYPOINT_OBJECT,
        "class_methods": [QUERY_METHOD],
        "requirements_file": "requirements.txt",
        "python_version": PYTHON_VERSION,
        "agent_framework": "custom",
        "env_vars": runtime_env_vars(),
        "service_account": sa,
        "labels": {"app": "slrr-triage-agent", "env": env("TRIAGE_ENV", "dev")},
        # Alerts must be triaged within seconds: keep one warm instance. Small, bursty traffic otherwise.
        "min_instances": int(env("AGENT_MIN_INSTANCES", "1")),
        "max_instances": int(env("AGENT_MAX_INSTANCES", "10")),
        "resource_limits": {"cpu": "2", "memory": "4Gi"},
        "container_concurrency": 5,
    }


def deploy(config: dict, resource: str | None) -> str:
    import agentplatform  # google-cloud-aiplatform >= 2.x

    client = agentplatform.Client(project=env("PROJECT_ID", required=True), location=env("REGION", "us-central1"))
    cwd = os.getcwd()
    os.chdir(BUILD_DIR)  # the SDK tars source_packages relative to the working directory
    try:
        if resource:
            print(f"Updating {resource} …")
            runtime = client.runtimes.update(name=resource, config=config)
        else:
            print("Creating a new Agent Runtime (takes a few minutes) …")
            runtime = client.runtimes.create(config=config)
    finally:
        os.chdir(cwd)
    name = runtime.api_resource.name
    RESOURCE_FILE.parent.mkdir(parents=True, exist_ok=True)
    RESOURCE_FILE.write_text(name + "\n")
    return name


def smoke(resource: str) -> None:
    """POST :query with class_method=query, op=health: the same call the Studio add-on makes."""
    import google.auth
    from google.auth.transport.requests import AuthorizedSession

    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    region = resource.split("/locations/")[1].split("/")[0]
    url = f"https://{region}-aiplatform.googleapis.com/v1/{resource}:query"
    body = {"class_method": "query", "input": {"op": "health", "payload": {}, "context": {"flow": "smoke"}}}
    resp = AuthorizedSession(creds).post(url, json=body, timeout=120)
    print(f"HTTP {resp.status_code}")
    try:
        data = resp.json()
    except ValueError:
        sys.exit(resp.text[:2000])
    print(json.dumps(data, indent=2)[:4000])
    output = data.get("output") or {}
    if resp.status_code != 200 or not output.get("ok"):
        sys.exit("Smoke test failed.")
    print("Smoke test passed: the agent answers :query like the Studio add-on expects.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="build and validate the source package; deploy nothing")
    parser.add_argument("--smoke", action="store_true", help="only call op=health on AGENT_RESOURCE")
    parser.add_argument("--resource", default=os.environ.get("AGENT_RESOURCE") or None,
                        help="existing resource to update (default: $AGENT_RESOURCE); omit to create")
    args = parser.parse_args()

    if args.smoke:
        resource = args.resource or (RESOURCE_FILE.read_text().strip() if RESOURCE_FILE.exists() else "")
        if not resource:
            sys.exit("No resource: set AGENT_RESOURCE or deploy first.")
        smoke(resource)
        return

    paths = build_source_package()
    size = package_size(paths)
    print(f"Source package: {', '.join(paths)} ({size / 1024:.0f} KiB compressed; limit {MAX_SOURCE_BYTES // 1024 // 1024} MiB)")
    if size > MAX_SOURCE_BYTES:
        sys.exit("Source package is over the Agent Runtime limit.")
    check_entrypoint()
    config = deploy_config(paths)
    shown = {k: v for k, v in config.items() if k != "class_methods"}
    print(json.dumps(shown, indent=2))
    if args.dry_run:
        print("Dry run: nothing deployed.")
        return
    name = deploy(config, args.resource)
    print(f"\nAgent Runtime: {name}\nSaved to {RESOURCE_FILE.relative_to(ROOT)}.")
    print("Next: add AGENT_RESOURCE to infra/.env, set it in the Studio add-on Script Properties, then run --smoke.")


if __name__ == "__main__":
    main()
