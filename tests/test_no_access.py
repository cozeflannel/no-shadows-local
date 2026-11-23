"""Telling "this account has no access to that table yet" apart from every other failure.

A table whose owners have not let the Console read it yet is waiting, not broken: it is skipped and nothing fails over
it. Every other refusal (quota, billing, an organisation's policy, a wrong column, a missing table) is a failure a
person has to look at. The wordings below are BigQuery's own.
"""

from __future__ import annotations

import pytest

from triage_agent import bq_admin

WAITING = [
    "403 Access Denied: Table bsip-s-bsip-gg-26-2cf3:google_bg.sonar_raw: User does not have permission to query table "
    "bsip-s-bsip-gg-26-2cf3:google_bg.sonar_raw, or perhaps it does not exist.",
    "403 GET https://bigquery.googleapis.com/bigquery/v2/projects/p/datasets/d/tables/t?prettyPrint=false: Access Denied: Table p:d.t: "
    "Permission bigquery.tables.get denied on table p:d.t (or it may not exist).",
    "403 Access Denied: Table p:d.t: User does not have bigquery.tables.getData permission for table p:d.t.",
    "403 Access Denied: Dataset p:d: Permission bigquery.tables.list denied on dataset p:d (or it may not exist).",
    "403 access denied: table p:d.t: user does not have permission to query table p:d.t",
]

FAILING = [
    "403 Access Denied: Project p: User does not have bigquery.jobs.create permission in project p.",
    "403 Access Denied: BigQuery BigQuery: Permission denied while getting Drive credentials.",
    "403 Access Denied: Connection p.us.c: User does not have bigquery.connections.use permission.",
    "403 Quota exceeded: Your project exceeded quota for free query bytes scanned.",
    "403 VPC Service Controls: Request is prohibited by organization's policy.",
    "403 Billing has not been enabled for this project.",
    "403 Access Denied: the table can't be read",
    "404 Not found: Table p:d.t was not found in location US",
    "400 Unrecognized name: video_title at [1:40]",
    "BigQuery refused access",
    "",
]


@pytest.mark.parametrize("said", WAITING)
def test_a_table_this_account_may_not_read_yet_is_waiting(said):
    assert bq_admin.no_access(RuntimeError(said)) is True


@pytest.mark.parametrize("said", FAILING)
def test_every_other_refusal_is_a_failure(said):
    assert bq_admin.no_access(RuntimeError(said)) is False
