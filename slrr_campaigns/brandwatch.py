"""Queued, rate-limited Brandwatch Consumer Research API client."""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlencode

import httpx

from .auth import BRANDWATCH_BASE_URL, BrandwatchTokenProvider
from .config import CampaignsConfig
from .logging_utils import log_event
from .models import (
    CachedQuerySummary,
    CreateQueryPayload,
    CustomAlertPayload,
    LocationFilterPayload,
)
from .store import CampaignStore

logger = logging.getLogger(__name__)


class BrandwatchApiError(RuntimeError):
    """Raised when a Brandwatch API request fails after retries."""

    def __init__(self, message: str, *, status_code: int, endpoint: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.endpoint = endpoint


def parse_rate_limit_headers(headers: Mapping[str, str]) -> tuple[int | None, int | None]:
    """Parse x-rate-limit and x-rate-limit-used headers case-insensitively."""
    lower = {k.lower(): v for k, v in headers.items()}
    raw_limit = lower.get("x-rate-limit")
    raw_used = lower.get("x-rate-limit-used")
    limit = int(raw_limit) if raw_limit and raw_limit.strip().isdigit() else None
    used = int(raw_used) if raw_used and raw_used.strip().isdigit() else None
    return limit, used


def format_bw_timestamp(iso_ts: str) -> str:
    """Format an ISO timestamp into Brandwatch's YYYY-MM-DDTHH:MM:SS.000+0000 UTC string."""
    cleaned = iso_ts.strip()
    if cleaned.endswith("Z"):
        base = cleaned[:-1]
        if "." not in base:
            base = f"{base}.000"
        else:
            head, frac = base.split(".", 1)
            base = f"{head}.{frac[:3].ljust(3, '0')}"
        return f"{base}+0000"
    if len(cleaned) == 10 and cleaned[4] == "-" and cleaned[7] == "-":
        return cleaned
    return cleaned


def _encode_query_params(params: list[tuple[str, str | int | bool]]) -> str:
    """URL-encode query parameters ensuring '+' in timestamps becomes '%2B'."""
    normalized: list[tuple[str, str]] = []
    for key, val in params:
        if isinstance(val, bool):
            normalized.append((key, "true" if val else "false"))
        else:
            normalized.append((key, str(val)))
    return urlencode(normalized, doseq=True)


class BrandwatchClient:
    """Client-wide queued Brandwatch API client enforcing <= 50% client rate-limit usage."""

    def __init__(
        self,
        cfg: CampaignsConfig,
        store: CampaignStore,
        tokens: BrandwatchTokenProvider,
        *,
        timeout_s: float = 40.0,
    ) -> None:
        self._cfg = cfg
        self._store = store
        self._tokens = tokens
        self._timeout_s = timeout_s
        self.call_count = 0
        self.last_rate_limit: int | None = None
        self.last_rate_used: int | None = None

    def _acquire_queue_and_slot(self) -> None:
        """Linearize Brandwatch requests across workers and wait for the 50% rate-limit window."""
        owner = f"bw-{uuid.uuid4().hex[:12]}"
        while True:
            if not self._store.acquire_lease("bw_queue", "global", owner, ttl_s=45.0):
                time.sleep(0.5)
                continue
            try:
                wait_s = self._store.reserve_brandwatch_slot()
            finally:
                self._store.release_lease("bw_queue", "global", owner)
            if wait_s <= 0.0:
                return
            sleep_for = min(wait_s, 30.0)
            log_event(logger, logging.INFO, "brandwatch_rate_limit_wait", wait_seconds=round(sleep_for, 2))
            time.sleep(sleep_for)

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: list[tuple[str, str | int | bool]] | None = None,
        json_body: dict[str, Any] | None = None,
    ) -> Any:
        query_str = _encode_query_params(params) if params else ""
        url = f"{BRANDWATCH_BASE_URL}{path}" + (f"?{query_str}" if query_str else "")
        retried_401 = False

        while True:
            self._acquire_queue_and_slot()
            token = self._tokens.get_token()
            headers = {
                "Authorization": f"bearer {token}",
                "Accept": "application/json",
            }
            if json_body is not None:
                headers["Content-Type"] = "application/json"

            self.call_count += 1
            try:
                with httpx.Client(timeout=self._timeout_s) as client:
                    resp = client.request(method, url, headers=headers, json=json_body)
            except httpx.HTTPError as exc:
                log_event(
                    logger,
                    logging.ERROR,
                    "brandwatch_network_error",
                    method=method,
                    path=path,
                    error_type=type(exc).__name__,
                )
                raise BrandwatchApiError(
                    f"Brandwatch network failure on {method} {path}: {exc}",
                    status_code=0,
                    endpoint=path,
                ) from exc

            rl_limit, rl_used = parse_rate_limit_headers(resp.headers)
            if rl_limit is not None:
                self.last_rate_limit = rl_limit
            if rl_used is not None:
                self.last_rate_used = rl_used

            if resp.status_code == 429:
                retry_hdr = resp.headers.get("retry-after", "").strip()
                retry_s = float(retry_hdr) if retry_hdr.isdigit() else 60.0
                self._store.update_brandwatch_rate_headers(
                    client_limit=rl_limit,
                    client_used=rl_used,
                    retry_after_seconds=retry_s,
                )
                log_event(
                    logger,
                    logging.WARNING,
                    "brandwatch_429_backoff",
                    path=path,
                    retry_seconds=retry_s,
                )
                time.sleep(min(retry_s, 65.0))
                continue

            self._store.update_brandwatch_rate_headers(client_limit=rl_limit, client_used=rl_used)

            if resp.status_code == 401 and not retried_401:
                retried_401 = True
                self._tokens.refresh_on_unauthorized()
                continue

            if resp.status_code >= 400:
                detail = resp.text[:400]
                log_event(
                    logger,
                    logging.ERROR,
                    "brandwatch_http_error",
                    method=method,
                    path=path,
                    status_code=resp.status_code,
                    detail=detail,
                )
                raise BrandwatchApiError(
                    f"Brandwatch {method} {path} returned HTTP {resp.status_code}: {detail}",
                    status_code=resp.status_code,
                    endpoint=path,
                )

            if not resp.text.strip():
                return {}
            return resp.json()

    def get_me(self) -> dict[str, Any]:
        """GET /me: return the authenticated API user metadata."""
        data = self._request("GET", "/me")
        return data if isinstance(data, dict) else {}

    def get_client(self) -> dict[str, Any]:
        """GET /client: return client pricing model and rate-limit tags."""
        data = self._request("GET", "/client")
        return data if isinstance(data, dict) else {}

    def list_projects(self, *, force_refresh: bool = False) -> list[dict[str, Any]]:
        """GET /projects: list accessible Brandwatch projects, cached for 24 hours."""
        if not force_refresh:
            cached = self._store.get_bw_cache("projects")
            if isinstance(cached, list):
                return [p for p in cached if isinstance(p, dict)]

        results: list[dict[str, Any]] = []
        page = 0
        while True:
            resp = self._request("GET", "/projects", params=[("pageSize", 100), ("page", page)])
            batch = resp.get("results") if isinstance(resp, dict) else None
            if not isinstance(batch, list) or not batch:
                break
            results.extend(p for p in batch if isinstance(p, dict))
            total = int(resp.get("resultsTotal") or len(results))
            if len(results) >= total or len(batch) < 100:
                break
            page += 1
        self._store.set_bw_cache("projects", results)
        return results

    def accessible_project_map(self, *, force_refresh: bool = False) -> dict[int, str]:
        """Map project_id -> project_name across accessible and configured Brandwatch projects."""
        projects = self.list_projects(force_refresh=force_refresh)
        mapping: dict[int, str] = {}
        for item in projects:
            pid = item.get("id")
            if isinstance(pid, int):
                mapping[pid] = str(item.get("name") or f"Project {pid}")
        for configured_id in self._cfg.brandwatch_project_ids:
            mapping.setdefault(configured_id, f"Project {configured_id}")
        return mapping

    def get_cached_queries(self, *, force_refresh: bool = False) -> list[CachedQuerySummary]:
        """List and cache queries (with booleanQuery, contentSources, languages) across projects."""
        if not force_refresh:
            cached = self._store.get_bw_cache("queries")
            if isinstance(cached, list):
                return [CachedQuerySummary.model_validate(item) for item in cached]

        proj_map = self.accessible_project_map(force_refresh=force_refresh)
        all_queries: list[CachedQuerySummary] = []
        for pid, pname in sorted(proj_map.items()):
            page = 0
            while True:
                resp = self._request(
                    "GET",
                    f"/projects/{pid}/queries",
                    params=[("pageSize", 100), ("page", page)],
                )
                batch = resp.get("results") if isinstance(resp, dict) else None
                if not isinstance(batch, list) or not batch:
                    break
                for q in batch:
                    if not isinstance(q, dict) or not isinstance(q.get("id"), int):
                        continue
                    all_queries.append(
                        CachedQuerySummary(
                            project_id=pid,
                            project_name=pname,
                            query_id=int(q["id"]),
                            name=str(q.get("name") or ""),
                            boolean_query=str(q.get("booleanQuery") or ""),
                            content_sources=[str(s) for s in (q.get("contentSources") or [])],
                            languages=[str(lang) for lang in (q.get("languages") or [])],
                        ),
                    )
                total = int(resp.get("resultsTotal") or len(batch))
                if (page + 1) * 100 >= total or len(batch) < 100:
                    break
                page += 1

        self._store.set_bw_cache("queries", [q.model_dump() for q in all_queries])
        return all_queries

    def get_metrics(self, *, force_refresh: bool = False) -> list[dict[str, Any]]:
        """GET /metrics: return accepted content source / pageType definitions, cached 24h."""
        if not force_refresh:
            cached = self._store.get_bw_cache("metrics")
            if isinstance(cached, list):
                return [m for m in cached if isinstance(m, dict)]
        data = self._request("GET", "/metrics")
        items: list[dict[str, Any]] = []
        if isinstance(data, list):
            items = [m for m in data if isinstance(m, dict)]
        elif isinstance(data, dict) and isinstance(data.get("results"), list):
            items = [m for m in data["results"] if isinstance(m, dict)]
        self._store.set_bw_cache("metrics", items)
        return items

    def get_filters(self, *, force_refresh: bool = False) -> dict[str, Any]:
        """GET /filters: return available Brandwatch filter definitions, cached 24h."""
        if not force_refresh:
            cached = self._store.get_bw_cache("filters")
            if isinstance(cached, dict):
                return cached
        data = self._request("GET", "/filters")
        payload = data if isinstance(data, dict) else {"items": data}
        self._store.set_bw_cache("filters", payload)
        return payload

    def get_exclusion_snippets(
        self,
        *,
        language: str = "en",
        force_refresh: bool = False,
    ) -> list[dict[str, Any]]:
        """GET /exclusionsnippets?language=en: list preset exclusion snippet IDs and names."""
        cache_key = f"exclusion_snippets_{language}"
        if not force_refresh:
            cached = self._store.get_bw_cache(cache_key)
            if isinstance(cached, list):
                return [s for s in cached if isinstance(s, dict)]
        data = self._request("GET", "/exclusionsnippets", params=[("language", language)])
        items: list[dict[str, Any]] = []
        if isinstance(data, list):
            items = [s for s in data if isinstance(s, dict)]
        elif isinstance(data, dict) and isinstance(data.get("results"), list):
            items = [s for s in data["results"] if isinstance(s, dict)]
        self._store.set_bw_cache(cache_key, items)
        return items

    def resolve_exclusion_snippet_ids(self, names: list[str]) -> list[int]:
        """Map human-readable exclusion snippet names from Settings to Brandwatch numeric IDs."""
        if not names:
            return []
        snippets = self.get_exclusion_snippets(language="en")
        wanted = {n.strip().lower() for n in names if n.strip()}
        matched: list[int] = []
        for item in snippets:
            sid = item.get("id")
            sname = str(item.get("name") or item.get("displayName") or "").strip().lower()
            if isinstance(sid, int) and sname in wanted:
                matched.append(sid)
        return sorted(set(matched))

    def refresh_daily_caches(self) -> dict[str, int]:
        """Refresh the 24h caches for projects, queries, filters, metrics, and exclusion snippets."""
        projects = self.list_projects(force_refresh=True)
        queries = self.get_cached_queries(force_refresh=True)
        filters = self.get_filters(force_refresh=True)
        metrics = self.get_metrics(force_refresh=True)
        snippets = self.get_exclusion_snippets(language="en", force_refresh=True)
        return {
            "projects": len(projects),
            "queries": len(queries),
            "filters": len(filters),
            "metrics": len(metrics),
            "exclusion_snippets": len(snippets),
        }

    def validate_query(
        self,
        *,
        boolean_query: str,
        languages: list[str] | None = None,
        location_filter: LocationFilterPayload | None = None,
    ) -> dict[str, Any]:
        """POST /query-validation: validate a boolean query without creating anything."""
        body: dict[str, Any] = {
            "booleanQuery": boolean_query,
            "languages": list(languages) if languages is not None else ["en"],
        }
        if location_filter and (location_filter.includedLocations or location_filter.excludedLocations):
            body["locationFilter"] = location_filter.to_api_dict()
        data = self._request("POST", "/query-validation", json_body=body)
        return data if isinstance(data, dict) else {}

    def find_query_by_exact_name(self, project_id: int, name: str) -> dict[str, Any] | None:
        """Check GET /projects/{id}/queries/summary for an existing query with the exact unique name."""
        page = 0
        target = name.strip()
        while True:
            resp = self._request(
                "GET",
                f"/projects/{project_id}/queries/summary",
                params=[("pageSize", 100), ("page", page)],
            )
            batch = resp.get("results") if isinstance(resp, dict) else None
            if not isinstance(batch, list) or not batch:
                return None
            for item in batch:
                if isinstance(item, dict) and str(item.get("name") or "").strip() == target:
                    return item
            total = int(resp.get("resultsTotal") or len(batch))
            if (page + 1) * 100 >= total or len(batch) < 100:
                return None
            page += 1

    def create_query(self, project_id: int, payload: CreateQueryPayload) -> dict[str, Any]:
        """Idempotently create a locked Brandwatch query with explicit startDate."""
        existing = self.find_query_by_exact_name(project_id, payload.name)
        if existing is not None:
            return existing
        created = self._request(
            "POST",
            f"/projects/{project_id}/queries",
            json_body=payload.to_api_dict(),
        )
        # Invalidate cached query list so the newly created query is immediately visible.
        self.get_cached_queries(force_refresh=True)
        return created if isinstance(created, dict) else {}

    def delete_query(self, project_id: int, query_id: int) -> None:
        """DELETE /projects/{projectId}/queries/{queryId}."""
        self._request("DELETE", f"/projects/{project_id}/queries/{query_id}")

    def list_alerts(
        self,
        project_id: int,
        *,
        search: str | None = None,
        enabled: bool | None = None,
        page_size: int = 50,
        page: int = 0,
    ) -> list[dict[str, Any]]:
        """GET /projects/{projectId}/alerts with mandatory pageSize and page parameters."""
        params: list[tuple[str, str | int | bool]] = [
            ("pageSize", page_size),
            ("page", page),
        ]
        if search is not None and search.strip():
            params.append(("search", search.strip()))
        if enabled is not None:
            params.append(("enabled", enabled))
        resp = self._request("GET", f"/projects/{project_id}/alerts", params=params)
        if isinstance(resp, dict) and isinstance(resp.get("results"), list):
            return [a for a in resp["results"] if isinstance(a, dict)]
        if isinstance(resp, list):
            return [a for a in resp if isinstance(a, dict)]
        return []

    def find_alert_by_name(
        self,
        alert_name: str,
        *,
        project_id: int | None = None,
        max_projects: int | None = None,
    ) -> tuple[int, dict[str, Any]] | None:
        """Search priority Brandwatch projects first for a Custom Alert matching alert_name."""
        target = alert_name.strip().lower()
        if project_id is not None:
            proj_ids = [project_id]
        else:
            seen_pids: set[int] = set()
            proj_ids = []
            for pid in self._cfg.brandwatch_project_ids:
                if pid not in seen_pids:
                    seen_pids.add(pid)
                    proj_ids.append(pid)
            for pid in sorted(self.accessible_project_map().keys()):
                if pid not in seen_pids:
                    seen_pids.add(pid)
                    proj_ids.append(pid)
            if max_projects is not None and max_projects > 0:
                proj_ids = proj_ids[:max_projects]
        for pid in proj_ids:
            matches = self.list_alerts(pid, search=alert_name.strip(), page_size=50, page=0)
            for item in matches:
                if str(item.get("name") or "").strip().lower() == target:
                    return pid, item
            for item in matches:
                if target in str(item.get("name") or "").strip().lower():
                    return pid, item
        return None

    def get_alert(self, project_id: int, alert_id: int) -> dict[str, Any]:
        """GET /projects/{projectId}/alerts/{alertId}."""
        data = self._request("GET", f"/projects/{project_id}/alerts/{alert_id}")
        return data if isinstance(data, dict) else {}

    def create_alert(self, project_id: int, payload: CustomAlertPayload) -> dict[str, Any]:
        """Idempotently create a Custom Alert by checking its unique name first."""
        existing = self.list_alerts(project_id, search=payload.name, page_size=50, page=0)
        for item in existing:
            if str(item.get("name") or "").strip() == payload.name and isinstance(item.get("id"), int):
                return self.get_alert(project_id, int(item["id"]))
        created = self._request(
            "POST",
            f"/projects/{project_id}/alerts",
            json_body=payload.to_api_dict(),
        )
        return created if isinstance(created, dict) else {}

    def update_alert(self, project_id: int, alert_id: int, payload: CustomAlertPayload) -> dict[str, Any]:
        """PUT /projects/{projectId}/alerts/{alertId} with every required non-deprecated field."""
        updated = self._request(
            "PUT",
            f"/projects/{project_id}/alerts/{alert_id}",
            json_body=payload.to_api_dict(),
        )
        return updated if isinstance(updated, dict) else {}

    def set_alert_paused(self, project_id: int, alert_id: int, *, paused: bool) -> dict[str, Any]:
        """Pause or resume an alert via GET then PUT, verifying polarity with enabled=true listing."""
        current = self.get_alert(project_id, alert_id)
        desired_enabled = not paused
        raw_filt = current.get("filter")
        filt_raw: dict[str, Any] = raw_filt if isinstance(raw_filt, dict) else {}
        payload = CustomAlertPayload.model_validate(
            {
                "name": str(current.get("name") or ""),
                "queryIds": [int(q) for q in (current.get("queryIds") or [])],
                "frequency": int(current.get("frequency") or 5),
                "alertTypes": list(current.get("alertTypes") or ["scheduled"]),
                "mentionsPerAlert": int(current.get("mentionsPerAlert") or 50),
                "recipients": [
                    str(r.get("emailAddress") if isinstance(r, dict) else r)
                    for r in (current.get("recipients") or [])
                ],
                "filter": {
                    k: filt_raw[k] for k in ("pageType", "threadEntryType", "sentiment") if filt_raw.get(k)
                },
                "enabled": desired_enabled,
            },
        )
        updated = self.update_alert(project_id, alert_id, payload)
        # Verify against GET /projects/{id}/alerts?enabled=true in case the API flips enabled polarity.
        active_list = self.list_alerts(
            project_id,
            search=payload.name,
            enabled=True,
            page_size=50,
            page=0,
        )
        in_active = any(int(a.get("id") or 0) == alert_id for a in active_list)
        if (paused and in_active) or ((not paused) and (not in_active)):
            flipped = payload.model_copy(update={"enabled": not desired_enabled})
            updated = self.update_alert(project_id, alert_id, flipped)
        return updated

    def delete_alert(self, project_id: int, alert_id: int) -> None:
        """DELETE /projects/{projectId}/alerts/{alertId}."""
        self._request("DELETE", f"/projects/{project_id}/alerts/{alert_id}")

    @staticmethod
    def _build_data_params(
        *,
        query_ids: list[int],
        start_date: str,
        end_date: str,
        extra_filter: dict[str, Any] | None = None,
    ) -> list[tuple[str, str | int | bool]]:
        params: list[tuple[str, str | int | bool]] = []
        for qid in query_ids:
            params.append(("queryId", qid))
        params.append(("startDate", format_bw_timestamp(start_date)))
        params.append(("endDate", format_bw_timestamp(end_date)))
        if extra_filter:
            for key in ("pageType", "threadEntryType", "sentiment"):
                val = extra_filter.get(key)
                if isinstance(val, list):
                    for item in val:
                        params.append((key, str(item)))
                elif isinstance(val, str) and val:
                    params.append((key, val))
        return params

    def get_mentions_count(
        self,
        project_id: int,
        *,
        query_ids: list[int],
        start_date: str,
        end_date: str,
        extra_filter: dict[str, Any] | None = None,
    ) -> int:
        """GET /projects/{id}/data/mentions/count."""
        params = self._build_data_params(
            query_ids=query_ids,
            start_date=start_date,
            end_date=end_date,
            extra_filter=extra_filter,
        )
        data = self._request("GET", f"/projects/{project_id}/data/mentions/count", params=params)
        if isinstance(data, dict):
            return int(data.get("mentionsCount") or 0)
        return 0

    def get_volume_sentiment_by_hour(
        self,
        project_id: int,
        *,
        query_ids: list[int],
        start_date: str,
        end_date: str,
        extra_filter: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """GET /projects/{id}/data/volume/sentiment/hours: both hourly volume and sentiment split."""
        params = self._build_data_params(
            query_ids=query_ids,
            start_date=start_date,
            end_date=end_date,
            extra_filter=extra_filter,
        )
        data = self._request(
            "GET",
            f"/projects/{project_id}/data/volume/sentiment/hours",
            params=params,
        )
        if isinstance(data, dict) and isinstance(data.get("results"), list):
            return [r for r in data["results"] if isinstance(r, dict)]
        return []

    def get_topics(
        self,
        project_id: int,
        *,
        query_ids: list[int],
        start_date: str,
        end_date: str,
        extra_filter: dict[str, Any] | None = None,
        limit: int = 15,
    ) -> list[dict[str, Any]]:
        """GET /projects/{id}/data/topics."""
        params = self._build_data_params(
            query_ids=query_ids,
            start_date=start_date,
            end_date=end_date,
            extra_filter=extra_filter,
        )
        params.extend(
            [
                ("extract", "phrases"),
                ("extract", "entities"),
                ("metrics", "percentageVolume,sentiment,trending"),
                ("limit", limit),
            ],
        )
        data = self._request("GET", f"/projects/{project_id}/data/topics", params=params)
        if isinstance(data, dict) and isinstance(data.get("topics"), list):
            return [t for t in data["topics"] if isinstance(t, dict)]
        return []

    def get_top_authors(
        self,
        project_id: int,
        *,
        query_ids: list[int],
        start_date: str,
        end_date: str,
        extra_filter: dict[str, Any] | None = None,
        limit: int = 15,
    ) -> list[dict[str, Any]]:
        """GET /projects/{id}/data/volume/topauthors/queries."""
        params = self._build_data_params(
            query_ids=query_ids,
            start_date=start_date,
            end_date=end_date,
            extra_filter=extra_filter,
        )
        params.append(("limit", limit))
        data = self._request(
            "GET",
            f"/projects/{project_id}/data/volume/topauthors/queries",
            params=params,
        )
        if isinstance(data, dict) and isinstance(data.get("results"), list):
            return [a for a in data["results"] if isinstance(a, dict)]
        return []

    def get_top_mentions(
        self,
        project_id: int,
        *,
        query_ids: list[int],
        start_date: str,
        end_date: str,
        extra_filter: dict[str, Any] | None = None,
        page_size: int = 50,
    ) -> list[dict[str, Any]]:
        """GET /projects/{id}/data/mentions ordered by impact descending."""
        params = self._build_data_params(
            query_ids=query_ids,
            start_date=start_date,
            end_date=end_date,
            extra_filter=extra_filter,
        )
        params.extend(
            [
                ("orderBy", "impact"),
                ("orderDirection", "desc"),
                ("pageSize", page_size),
                ("page", 0),
            ],
        )
        data = self._request("GET", f"/projects/{project_id}/data/mentions", params=params)
        if isinstance(data, dict) and isinstance(data.get("results"), list):
            return [m for m in data["results"] if isinstance(m, dict)]
        return []

    def list_slrr_cmp_resources(
        self,
        *,
        extra_project_ids: set[int] | None = None,
    ) -> tuple[list[tuple[int, dict[str, Any]]], list[tuple[int, dict[str, Any]]]]:
        """Return all (project_id, alert) and (project_id, query) items prefixed with SLRR-CMP-."""
        proj_map = self.accessible_project_map()
        accessible = set(proj_map.keys())
        target_pids = sorted(
            (set(self._cfg.brandwatch_project_ids) | (extra_project_ids or set())) & accessible
        )
        if not target_pids:
            target_pids = sorted(accessible)

        found_alerts: list[tuple[int, dict[str, Any]]] = []
        found_queries: list[tuple[int, dict[str, Any]]] = []
        seen_queries: set[tuple[int, int]] = set()

        for pid in target_pids:
            page = 0
            while True:
                alerts = self.list_alerts(pid, search="SLRR-CMP-", page_size=50, page=page)
                for a in alerts:
                    if str(a.get("name") or "").startswith("SLRR-CMP-"):
                        found_alerts.append((pid, a))
                if len(alerts) < 50:
                    break
                page += 1

            qpage = 0
            while True:
                qresp = self._request(
                    "GET",
                    f"/projects/{pid}/queries/summary",
                    params=[("pageSize", 100), ("page", qpage)],
                )
                qbatch = qresp.get("results") if isinstance(qresp, dict) else None
                if not isinstance(qbatch, list) or not qbatch:
                    break
                for q in qbatch:
                    if isinstance(q, dict) and str(q.get("name") or "").startswith("SLRR-CMP-"):
                        qid = q.get("id")
                        if isinstance(qid, int):
                            seen_queries.add((pid, qid))
                        found_queries.append((pid, q))
                total = int(qresp.get("resultsTotal") or len(qbatch))
                if (qpage + 1) * 100 >= total or len(qbatch) < 100:
                    break
                qpage += 1

        for cq in self.get_cached_queries():
            if cq.name.startswith("SLRR-CMP-") and (cq.project_id, cq.query_id) not in seen_queries:
                seen_queries.add((cq.project_id, cq.query_id))
                found_queries.append((cq.project_id, {"id": cq.query_id, "name": cq.name}))

        return found_alerts, found_queries
