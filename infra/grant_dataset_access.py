#!/usr/bin/env python3
"""Adds a service account to BigQuery datasets' access lists (additive; existing entries are kept as they are).

Used by infra/09_slrr_signals.sh because dataset-level IAM bindings (bq add-iam-policy-binding) need allowlisting.
  python3 infra/grant_dataset_access.py <service-account-email> READER project:dataset [project:dataset ...]
  python3 infra/grant_dataset_access.py <service-account-email> WRITER project:dataset
Prints one line per dataset: granted, already there, or why it couldn't (e.g. the dataset belongs to someone else).
"""

from __future__ import annotations

import sys

from google.cloud import bigquery


def main(argv: list[str]) -> int:
    if len(argv) < 4 or argv[2] not in ("READER", "WRITER"):
        print(__doc__)  # noqa: T201
        return 2
    member, role, datasets = argv[1], argv[2], argv[3:]
    failed = 0
    for ref in datasets:
        project, dataset = ref.split(":", 1)
        try:
            client = bigquery.Client(project=project)
            ds = client.get_dataset(f"{project}.{dataset}")
            entries = list(ds.access_entries)
            if any(e.entity_type == "userByEmail" and str(e.entity_id).lower() == member.lower() and e.role in (role, "OWNER", "WRITER" if role == "READER" else role)
                   for e in entries):
                print(f"  {role} on {ref}: already there")  # noqa: T201
                continue
            entries.append(bigquery.AccessEntry(role=role, entity_type="userByEmail", entity_id=member))
            ds.access_entries = entries
            client.update_dataset(ds, ["access_entries"])  # the dataset's etag guards against a concurrent change
            print(f"  {role} on {ref}: granted")  # noqa: T201
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"  !! {role} on {ref}: couldn't ({str(e)[:160]}); its owner can add {member} as {role}")  # noqa: T201
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
