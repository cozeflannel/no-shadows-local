"""Gmail connection for Incident Managers and the Triage Agent account (docs/CONTRACTS.md §7, §17).

OAuth web flow (google-auth-oauthlib) with offline access:
  * Incident Managers / analysts: IM_SCOPES (gmail.compose + gmail.metadata) for Social Alert drafts.
  * The Triage Agent account (config.agent.email): AGENT_SCOPES (gmail.send) for the email
    doorbell, plus the OpenID email scope so the callback can check which account was authorized
    (gmail.send alone can't read the Gmail profile).
Credentials go to the TokenVault from triage_agent.escalation.gmail (local file in dev, Secret
Manager in prod); they are never stored in the Store. That module is owned by workstream A2 and
imported lazily, so the Console still runs (and answers 503 here) in builds without it.
Google lets users untick individual scopes: if any requested Gmail scope wasn't granted, the token
is dropped and the Console asks the user to connect again (`?gmail=error&reason=missing_scopes`).
"""

from __future__ import annotations

import base64
import importlib
import json
import logging
import os
from datetime import datetime
from types import ModuleType
from typing import Any
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse

from triage_agent.context import AgentContext

from .auth import User, current_user, get_ctx

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["gmail"])

GMAIL_MODULE = "triage_agent.escalation.gmail"
STATE_TTL_S = 15 * 60
KV_PREFIX = "gmail_oauth:"
FALLBACK_SCOPES = (
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.metadata",
)
FALLBACK_AGENT_SCOPES = ("https://www.googleapis.com/auth/gmail.send",)
# Identity only: lets the callback read the authorized account from the ID token.
IDENTITY_SCOPES = ("openid", "https://www.googleapis.com/auth/userinfo.email")
# Ignored when checking granted scopes (Google returns the identity scopes under several names).
IDENTITY_ALIASES = frozenset({"openid", "email", "profile", "https://www.googleapis.com/auth/userinfo.email",
                              "https://www.googleapis.com/auth/userinfo.profile"})

# Google may return fewer scopes than requested (granular consent) or list them in another order;
# the callback compares them itself instead of letting oauthlib raise.
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")


def gmail_module() -> ModuleType | None:
    try:
        return importlib.import_module(GMAIL_MODULE)
    except ModuleNotFoundError as exc:
        if exc.name in (GMAIL_MODULE, GMAIL_MODULE.rsplit(".", 1)[0]):
            return None
        raise


def _unavailable() -> HTTPException:
    return HTTPException(503, {
        "error": "Gmail integration isn't available in this build yet (triage_agent.escalation.gmail is missing).",
        "code": "gmail_unavailable",
    })


def _token_vault(mod: ModuleType) -> Any:
    factory = getattr(mod, "get_token_vault", None)
    if factory is None:
        raise _unavailable()
    return factory()


def mailbox_kind(ctx: AgentContext, email: str) -> str:
    """"agent" for the Triage Agent account (config.agent.email), else "im"."""
    agent = (ctx.config.agent.email or "").strip().lower()
    return "agent" if agent and email.strip().lower() == agent else "im"


def _scopes(mod: ModuleType, mailbox: str = "im") -> list[str]:
    if mailbox == "agent":
        scopes = list(getattr(mod, "AGENT_SCOPES", FALLBACK_AGENT_SCOPES))
        return scopes + [s for s in IDENTITY_SCOPES if s not in scopes]
    return list(getattr(mod, "IM_SCOPES", FALLBACK_SCOPES))


def _scope_set(value: Any) -> set[str] | None:
    """Scopes as a set, from a list or a space-separated string (None when unknown)."""
    if value is None:
        return None
    try:
        items = value.split() if isinstance(value, str) else [str(v) for v in value]
    except TypeError:
        return None
    return {s.strip() for s in items if s.strip()}


def granted_scopes(flow: Any, creds: Any) -> set[str] | None:
    """Scopes the user actually granted: credentials.granted_scopes, else the token response's `scope`."""
    granted = _scope_set(getattr(creds, "granted_scopes", None))
    if granted is None:
        token = getattr(getattr(flow, "oauth2session", None), "token", None)
        granted = _scope_set(token.get("scope")) if isinstance(token, dict) else None
    return granted


def missing_scopes(requested: list[str], granted: set[str] | None) -> list[str]:
    """Requested scopes the user unticked on Google's consent screen (identity scopes don't count).

    No `scope` in the token response means the requested scopes were granted (RFC 6749 §5.1).
    """
    if granted is None:
        return []
    return [s for s in requested if s not in IDENTITY_ALIASES and s not in granted]


def scope_name(scope: str) -> str:
    """Short name for a scope URL: .../auth/gmail.compose -> compose."""
    tail = scope.rstrip("/").rsplit("/", 1)[-1]
    return tail.split("gmail.", 1)[1] if tail.startswith("gmail.") else ("full" if tail == "mail.google.com" else tail)


def _may_connect(user: User, mailbox: str) -> bool:
    """IMs/analysts connect their own mailbox; the agent account may connect its own (it has no Console role)."""
    return mailbox == "agent" or user.has("analyst")


def _redirect_uri(request: Request) -> str:
    base = os.environ.get("TRIAGE_CONSOLE_BASE_URL", "").strip().rstrip("/")
    if base:
        return f"{base}/api/gmail/callback"
    return str(request.url_for("gmail_callback"))


def _allow_local_http(redirect_uri: str) -> None:
    """oauthlib refuses http:// redirect URIs; allow them only for localhost development."""
    if redirect_uri.startswith(("http://localhost", "http://127.0.0.1")):
        os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"


def _back_to_console(status: str, reason: str | None = None, **extra: str) -> RedirectResponse:
    query = {"gmail": status, **({"reason": reason[:300]} if reason else {}), **{k: v for k, v in extra.items() if v}}
    return RedirectResponse(f"/?{urlencode(query)}", status_code=302)


def _is_connected(ctx: AgentContext, mod: ModuleType, email: str) -> bool:
    gateway = ctx.gmail
    if gateway is not None and hasattr(gateway, "is_connected"):
        try:
            return bool(gateway.is_connected(email))
        except Exception:  # noqa: BLE001
            log.warning("gmail is_connected failed", exc_info=True)
            return False
    try:
        info = _token_vault(mod).get(email)
    except Exception:  # noqa: BLE001
        return False
    return bool(info and info.get("refresh_token"))


def _stale_scopes(mod: ModuleType, email: str, requested: list[str]) -> list[str]:
    """Requested scopes the stored token lacks (it was granted before IM_SCOPES / AGENT_SCOPES changed)."""
    try:
        info = _token_vault(mod).get(email)
    except Exception:  # noqa: BLE001 - vault unavailable: nothing to compare
        return []
    stored = _scope_set((info or {}).get("scopes")) if info else None
    return missing_scopes(requested, stored)


@router.get("/gmail/status")
def gmail_status(ctx: AgentContext = Depends(get_ctx), user: User = Depends(current_user)) -> dict[str, Any]:
    mod = gmail_module()
    mode = (os.environ.get("TRIAGE_GMAIL") or "fake").strip().lower()
    oauth_configured = bool(os.environ.get("TRIAGE_OAUTH_CLIENT"))
    mailbox = mailbox_kind(ctx, user.email)
    if mod is None:
        return {"available": False, "connected": False, "email": user.email, "mode": mode, "mailbox": mailbox,
                "oauth_configured": oauth_configured, "can_connect": False,
                "message": "Gmail integration isn't available in this build yet."}
    requested = _scopes(mod, mailbox)
    connected = _is_connected(ctx, mod, user.email)
    stale = _stale_scopes(mod, user.email, requested) if connected and mode != "fake" else []
    if mode == "fake":
        message = "Simulated Gmail (TRIAGE_GMAIL=fake): drafts stay in memory."
    elif ctx.gmail is None:
        message = "Gmail drafting is turned off (TRIAGE_GMAIL)."
    elif stale:
        message = "The agent now needs a Gmail permission you haven't granted yet: connect again."
    elif mailbox == "agent":
        message = ("The email doorbell sends from this mailbox (gmail.send only)." if connected
                   else "Connect the agent mailbox once so the email doorbell can send (gmail.send only).")
    elif connected:
        message = "Drafts are created in your Gmail from the Brand Social alias."
    else:
        message = "Connect Gmail so URGENT alerts get a Social Alert draft in your mailbox."
    return {
        "available": True,
        "connected": connected,
        "email": user.email,
        "mode": mode,
        "mailbox": mailbox,
        # Gmail permissions requested for this mailbox (short names; the IM read scope is TRIAGE_GMAIL_READ_SCOPE)
        "scopes": [scope_name(s) for s in requested if s not in IDENTITY_ALIASES],
        # granted before the requested scopes changed (e.g. metadata -> readonly): reconnect to add them
        "needs_reconnect": bool(stale),
        "missing_scopes": [scope_name(s) for s in stale],
        "oauth_configured": oauth_configured,
        "can_connect": oauth_configured and _may_connect(user, mailbox),
        "message": message,
    }


@router.get("/gmail/connect")
def gmail_connect(
    request: Request,
    format: str | None = None,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(current_user),
) -> Any:
    mailbox = mailbox_kind(ctx, user.email)
    if not _may_connect(user, mailbox):
        raise HTTPException(403, {
            "error": f"Connecting Gmail needs an analyst / IM role (you are signed in as {user.email}, role: {user.role}).",
            "code": "forbidden",
            "required_role": "analyst",
        })
    mod = gmail_module()
    if mod is None:
        raise _unavailable()
    try:
        client_config = mod.load_oauth_client_config()
    except Exception as exc:  # noqa: BLE001 - missing env var, file or secret
        raise HTTPException(503, {"error": f"The Gmail OAuth client isn't configured: {exc}", "code": "gmail_not_configured"}) from exc
    redirect_uri = _redirect_uri(request)
    _allow_local_http(redirect_uri)
    scopes = _scopes(mod, mailbox)
    flow = mod.build_oauth_flow(client_config, redirect_uri, scopes=scopes)
    auth_url, state = flow.authorization_url(access_type="offline", prompt="consent", login_hint=user.email)
    ctx.store.put_kv(f"{KV_PREFIX}{state}", {
        "email": user.email,
        "mailbox": mailbox,
        "scopes": scopes,
        "code_verifier": getattr(flow, "code_verifier", None),
        "redirect_uri": redirect_uri,
        "created_at": ctx.now().isoformat(),
    })
    if format == "json":
        return {"auth_url": auth_url, "mailbox": mailbox, "scopes": scopes}
    return RedirectResponse(auth_url, status_code=302)


def _profile_email(creds: Any) -> str | None:
    """Mailbox the user actually authorized (gmail.metadata allows users.getProfile)."""
    from google.auth.transport.requests import AuthorizedSession

    resp = AuthorizedSession(creds).get("https://gmail.googleapis.com/gmail/v1/users/me/profile", timeout=10)
    resp.raise_for_status()
    return str(resp.json().get("emailAddress") or "").lower() or None


def _id_token_email(id_token: Any) -> str | None:
    """Verified email claim of the ID token returned with the access token.

    The token comes straight from Google's token endpoint over TLS in this same request, so its
    signature doesn't need checking (OpenID Connect Core §3.1.3.7).
    """
    if not isinstance(id_token, str) or id_token.count(".") != 2:
        return None
    try:
        payload = id_token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (ValueError, TypeError):
        return None
    if not isinstance(claims, dict) or claims.get("email_verified") is False:
        return None
    return str(claims.get("email") or "").lower() or None


def _authorized_email(creds: Any) -> str | None:
    """Account the user authorized: the ID token's email (agent mailbox) or the Gmail profile (IMs)."""
    return _id_token_email(getattr(creds, "id_token", None)) or _profile_email(creds)


@router.get("/gmail/callback", name="gmail_callback")
def gmail_callback(
    request: Request,
    state: str | None = None,
    code: str | None = None,
    error: str | None = None,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(current_user),
) -> RedirectResponse:
    if error:
        return _back_to_console("error", f"Google returned: {error}")
    mod = gmail_module()
    if mod is None:
        return _back_to_console("error", "Gmail integration isn't available in this build yet")
    key = f"{KV_PREFIX}{state}" if state else None
    saved = ctx.store.get_kv(key) if key else None
    if not saved or saved.get("used") or not code:
        return _back_to_console("error", "This sign-in link expired. Click Connect Gmail again.")
    if saved.get("email") != user.email:
        return _back_to_console("error", "The sign-in was started by a different Console user.")
    try:
        started = datetime.fromisoformat(saved["created_at"])
        if (ctx.now() - started).total_seconds() > STATE_TTL_S:
            return _back_to_console("error", "This sign-in link expired. Click Connect Gmail again.")
    except (KeyError, ValueError):
        return _back_to_console("error", "Invalid sign-in state. Click Connect Gmail again.")
    ctx.store.put_kv(key, {"used": True, "email": user.email, "used_at": ctx.now().isoformat()})  # type: ignore[arg-type]
    mailbox = saved.get("mailbox") or mailbox_kind(ctx, user.email)
    scopes = saved.get("scopes") or _scopes(mod, mailbox)
    try:
        client_config = mod.load_oauth_client_config()
        _allow_local_http(saved["redirect_uri"])
        flow = mod.build_oauth_flow(client_config, saved["redirect_uri"], scopes=scopes, state=state)
        flow.fetch_token(code=code, code_verifier=saved.get("code_verifier"))
        creds = flow.credentials
        missing = missing_scopes(list(scopes), granted_scopes(flow, creds))
        if missing:  # unticked on Google's consent screen: the token can't do the job, so don't keep it
            log.warning("gmail oauth for %s is missing scopes %s; token not stored", user.email, missing)
            return _back_to_console("error", "missing_scopes", missing=",".join(scope_name(s) for s in missing), mailbox=mailbox)
        if not getattr(creds, "refresh_token", None):
            return _back_to_console("error", "Google didn't return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.")
        authorized = _authorized_email(creds)
        if authorized and authorized != user.email:
            return _back_to_console("error", f"You authorized {authorized}, but you're signed in to the Console as {user.email}.")
        mod.store_credentials(_token_vault(mod), user.email, creds)
    except Exception as exc:  # noqa: BLE001 - surface any OAuth / vault failure to the user
        log.exception("gmail oauth callback failed for %s", user.email)
        return _back_to_console("error", f"Couldn't connect Gmail: {exc}")
    return _back_to_console("connected_agent" if mailbox == "agent" else "connected")


@router.delete("/gmail")
def gmail_disconnect(ctx: AgentContext = Depends(get_ctx), user: User = Depends(current_user)) -> dict[str, Any]:
    mod = gmail_module()
    if mod is None:
        raise _unavailable()
    try:
        _token_vault(mod).delete(user.email)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, {"error": f"Couldn't remove the stored Gmail token: {exc}", "code": "gmail_vault_error"}) from exc
    if ctx.gmail is not None and hasattr(ctx.gmail, "disconnect"):
        try:
            ctx.gmail.disconnect(user.email)  # FakeGmail (dev)
        except Exception:  # noqa: BLE001
            pass
    return gmail_status(ctx, user)
