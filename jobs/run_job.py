"""Cloud Run job entry point (triggered by Cloud Scheduler).

  python -m jobs.run_job followups     # every minute: SLA nudges, reminders, sent detection, digest, handover
  python -m jobs.run_job inhouse       # every 1-5 minutes: Path B ingestion
  python -m jobs.run_job handover      # on demand
  python -m jobs.run_job digest        # on demand (forces today's Burson digest)

Output is queued in the outbox (deliver="outbox"); the doorbell starts the
Studio Outbox flow that posts it.
"""

import argparse
import json
import logging
import sys

from triage_agent.context import build_context
from triage_agent.operations import handle

OPS = {
    "followups": ("run_followups", {}),
    "inhouse": ("ingest_inhouse", {}),
    "handover": ("generate_handover", {}),
    "digest": ("run_followups", {"steps": ["digest"]}),
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job", choices=sorted(OPS))
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    op, payload = OPS[args.job]
    ctx = build_context()
    if args.job == "digest":
        from triage_agent.followups import burson_digest

        burson_digest(ctx, force=True)
        print(json.dumps({"ok": True, "job": "digest"}))
        return 0
    resp = handle({"op": op, "payload": payload, "context": {"deliver": "outbox", "flow": "job", "invoked_by": f"job:{args.job}"}}, ctx)
    print(json.dumps({"ok": resp.ok, "op": op, "summary": resp.outputs.get("summary"), "error": resp.error,
                      "data": resp.data}, default=str))
    return 0 if resp.ok else 1


if __name__ == "__main__":
    sys.exit(main())
