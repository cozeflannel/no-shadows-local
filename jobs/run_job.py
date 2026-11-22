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
}
JOBS = sorted([*OPS, "digest"])  # digest is not an operation: it calls burson_digest(force=True), see main()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job", choices=JOBS)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    ctx = build_context()
    if args.job == "digest":
        from triage_agent.followups import burson_digest

        queued = burson_digest(ctx, force=True)  # 0 when burson_feedback.post_digest_to_burson_space is off
        print(json.dumps({"ok": True, "job": "digest", "queued": queued}))
        return 0
    op, payload = OPS[args.job]
    resp = handle({"op": op, "payload": payload, "context": {"deliver": "outbox", "flow": "job", "invoked_by": f"job:{args.job}"}}, ctx)
    # run_followups keeps going when a step raises and lists those steps: the job must not look green.
    ok = resp.ok and not (resp.data or {}).get("failed_steps")
    print(json.dumps({"ok": ok, "op": op, "summary": resp.outputs.get("summary"), "error": resp.error,
                      "data": resp.data}, default=str))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
