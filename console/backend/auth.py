"""Console authentication and roles (docs/CONTRACTS.md §17).

Identity:
  * Behind IAP: `X-Goog-Authenticated-User-Email` (the `accounts.google.com:` prefix is
    stripped). If TRIAGE_IAP_AUDIENCE is set, the signed `X-Goog-IAP-JWT-Assertion` is
    verified instead (recommended in production: headers can't be spoofed around IAP).
  * With TRIAGE_BACKEND=gcp, or anywhere on Cloud Run (K_SERVICE is set there), the plain
    email header is **not** trusted unless TRIAGE_IAP_AUDIENCE is set (fail closed: without
    the signed assertion the header is just a string any caller can send).
  * Locally (no IAP header): TRIAGE_DEV_USER (default dev@local.invalid). With
    TRIAGE_BACKEND=gcp or on Cloud Run the dev fallback only applies when TRIAGE_DEV_USER is
    set explicitly.

Roles:
  * `config.analysts` -> admin | lead | analyst | im (an IM ranks as an analyst)
  * people in roster("slrr_im") -> analyst (Incident Managers)
  * any other @google.com user -> viewer (read-only)
  * anyone else -> none (no access)
"""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

from fastapi import Depends, HTTPException, Request

from triage_agent.context import ROSTER_IM, AgentContext
from triage_agent.oncall.roster import person_by_email

IAP_EMAIL_HEADER = "X-Goog-Authenticated-User-Email"
IAP_JWT_HEADER = "X-Goog-IAP-JWT-Assertion"
IAP_CERTS_URL = "https://www.gstatic.com/iap/verify/public_key"
DEFAULT_DEV_USER = "dev@local.invalid"

# `im` is the config label for Incident Managers (config.Analyst.role); it carries analyst rights.
ROLE_RANK = {"none": 0, "viewer": 1, "analyst": 2, "im": 2, "lead": 3, "admin": 4}


@dataclass(frozen=True)
class User:
    email: str
    role: str  # admin | lead | analyst | viewer | none
    name: str | None = None
    role_source: str = "none"  # config | roster | domain | none
    via: str = "dev"  # iap | iap_jwt | dev

    def has(self, role: str) -> bool:
        return ROLE_RANK.get(self.role, 0) >= ROLE_RANK[role]

    def as_dict(self) -> dict[str, Any]:
        return {
            "email": self.email,
            "name": self.name,
            "role": self.role,
            "role_source": self.role_source,
            "via": self.via,
            "can_view": self.has("viewer"),
            "can_act": self.has("analyst"),
            "is_lead": self.has("lead"),
            "is_admin": self.has("admin"),
        }


# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------

_JWT_CACHE: dict[str, dict[str, Any]] = {}
_JWT_LOCK = threading.Lock()


def _verify_iap_jwt(token: str, audience: str) -> dict[str, Any]:
    """Verify IAP's signed header (ES256, Google IAP certs); cached until the token expires."""
    now = time.time()
    with _JWT_LOCK:
        cached = _JWT_CACHE.get(token)
        if cached and cached.get("exp", 0) > now + 10:
            return cached
    from google.auth.transport import requests as ga_requests
    from google.oauth2 import id_token

    claims = id_token.verify_token(token, ga_requests.Request(), audience=audience, certs_url=IAP_CERTS_URL)
    with _JWT_LOCK:
        if len(_JWT_CACHE) > 500:
            for key in [k for k, v in _JWT_CACHE.items() if v.get("exp", 0) <= now]:
                _JWT_CACHE.pop(key, None)
        _JWT_CACHE[token] = claims
    return claims


def request_identity(request: Request) -> tuple[str | None, str]:
    """(email, via) for the request; email None = unauthenticated."""
    audience = os.environ.get("TRIAGE_IAP_AUDIENCE", "").strip()
    if audience:
        token = request.headers.get(IAP_JWT_HEADER)
        if not token:
            return None, "iap_jwt"
        try:
            claims = _verify_iap_jwt(token, audience)
        except Exception as exc:  # noqa: BLE001 - any verification failure is a 401
            raise HTTPException(401, {"error": f"Invalid IAP assertion: {exc}", "code": "unauthenticated"}) from exc
        email = str(claims.get("email") or "").strip().lower()
        return (email or None), "iap_jwt"
    # A deployed service: the gcp backend, or any Cloud Run service (it sets K_SERVICE), so a deploy that forgot
    # TRIAGE_BACKEND=gcp still can't be told who is calling by a header anyone can send
    gcp = os.environ.get("TRIAGE_BACKEND", "local") == "gcp" or bool(os.environ.get("K_SERVICE", "").strip())
    raw = request.headers.get(IAP_EMAIL_HEADER)
    if raw:
        if gcp:  # without the signed assertion this header is just a string any caller can send
            raise HTTPException(
                401,
                {"error": "Unsigned IAP identity refused: set TRIAGE_IAP_AUDIENCE so the signed assertion is verified",
                 "code": "unauthenticated"},
            )
        email = raw.split(":", 1)[-1].strip().lower()
        return (email or None), "iap"
    dev = os.environ.get("TRIAGE_DEV_USER", "").strip()
    if gcp and not dev:
        return None, "none"
    return (dev or DEFAULT_DEV_USER).lower(), "dev"


def resolve_role(ctx: AgentContext, email: str) -> tuple[str, str | None, str]:
    """(role, display name, role source) for an email."""
    analyst = ctx.config.analyst(email)
    if analyst:
        return analyst.role, analyst.name, "config"
    try:
        person = person_by_email(ctx.roster(ROSTER_IM), email)
    except Exception:  # noqa: BLE001 - roster unavailable: fall through to domain rules
        person = None
    if person:
        return "analyst", person.name, "roster"
    if email.endswith("@google.com"):
        return "viewer", None, "domain"
    return "none", None, "none"


# ---------------------------------------------------------------------------
# FastAPI dependencies
# ---------------------------------------------------------------------------


def get_ctx(request: Request) -> AgentContext:
    return request.app.state.console.fresh()


def current_user(request: Request, ctx: AgentContext = Depends(get_ctx)) -> User:
    email, via = request_identity(request)
    if not email:
        raise HTTPException(401, {"error": "Not signed in (no IAP identity on the request)", "code": "unauthenticated"})
    role, name, source = resolve_role(ctx, email)
    return User(email=email, role=role, name=name, role_source=source, via=via)


def require(role: str) -> Callable[..., User]:
    labels = {"viewer": "Console access", "analyst": "an analyst / IM role", "lead": "a lead role", "admin": "an admin role"}

    def dependency(user: User = Depends(current_user)) -> User:
        if not user.has(role):
            raise HTTPException(
                403,
                {
                    "error": f"This action needs {labels.get(role, role)} (you are signed in as {user.email}, role: {user.role}).",
                    "code": "forbidden",
                    "required_role": role,
                },
            )
        return user

    return dependency


require_viewer = require("viewer")
require_analyst = require("analyst")
require_lead = require("lead")
require_admin = require("admin")
