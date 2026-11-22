"""The QA chatbot's sign-in to Google Chat: an admin starts it, the bot's own account approves it at Google.

The same sign-in client and return address as Gmail's are used, so nothing new has to be registered at Google. Only a
token for the account in Settings (the agent's account) is ever kept, and only when every permission was granted.
"""

from __future__ import annotations

import logging
from types import ModuleType
from typing import Any
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse

from triage_agent import audit, chatapi
from triage_agent.context import AgentContext

from . import gmail_oauth
from .auth import User, get_ctx, require_admin, require_viewer

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["chat sign-in"])
PURPOSE = "chat"


def status(ctx: AgentContext) -> dict[str, Any]:
    mod = gmail_oauth.gmail_module()
    ready = False
    if mod is not None:
        try:
            ready = bool(mod.load_oauth_client_config())
        except Exception:  # noqa: BLE001 - no sign-in client yet
            ready = False
    return {"signed_in": chatapi.signed_in(ctx), "email": ctx.config.agent.email, "client_ready": ready, "scopes": list(chatapi.SCOPES)}


@router.get("/chat-signin")
def get_status(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    return status(ctx)


@router.get("/chat-signin/connect")
def connect(request: Request, format: str | None = None, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> Any:
    bot = (ctx.config.agent.email or "").strip().lower()
    if not bot:
        raise HTTPException(422, {"error": "Enter the QA chatbot's account first (Integrations, Google Chat).", "code": "validation_error"})
    mod = gmail_oauth.gmail_module()
    if mod is None:
        raise gmail_oauth._unavailable()
    try:
        client_config = mod.load_oauth_client_config()
    except Exception as exc:  # noqa: BLE001 - missing setting, file or secret
        raise HTTPException(503, {"error": f"No Google sign-in client is set up yet ({exc}). Create one once: the steps are at the top of infra/08_gmail_oauth.sh.",
                                  "code": "signin_not_configured"}) from exc
    redirect_uri = gmail_oauth._redirect_uri(request)
    gmail_oauth._allow_local_http(redirect_uri)
    scopes = [*chatapi.SCOPES, *chatapi.IDENTITY_SCOPES]
    flow = mod.build_oauth_flow(client_config, redirect_uri, scopes=scopes)
    auth_url, state = flow.authorization_url(access_type="offline", prompt="consent", login_hint=bot)
    ctx.store.put_kv(f"{gmail_oauth.KV_PREFIX}{state}", {
        "purpose": PURPOSE, "email": user.email, "bot": bot, "scopes": scopes, "code_verifier": getattr(flow, "code_verifier", None),
        "redirect_uri": redirect_uri, "created_at": ctx.now().isoformat(),
    })
    if format == "json":
        return {"auth_url": auth_url, "scopes": scopes, "account": bot}
    return RedirectResponse(auth_url, status_code=302)


def _back(result: str, reason: str = "") -> RedirectResponse:
    query = {"signin": result, **({"reason": reason[:300]} if reason else {})}
    return RedirectResponse(f"/connections/chat?{urlencode(query)}", status_code=302)


def finish(ctx: AgentContext, mod: ModuleType, saved: dict[str, Any], state: str, code: str, user: User) -> RedirectResponse:
    """The second half of the sign-in, called from the shared return address once the state has been checked."""
    bot = str(saved.get("bot") or "").lower()
    scopes = list(saved.get("scopes") or [*chatapi.SCOPES, *chatapi.IDENTITY_SCOPES])
    try:
        client_config = mod.load_oauth_client_config()
        gmail_oauth._allow_local_http(saved["redirect_uri"])
        flow = mod.build_oauth_flow(client_config, saved["redirect_uri"], scopes=scopes, state=state)
        flow.fetch_token(code=code, code_verifier=saved.get("code_verifier"))
        creds = flow.credentials
        missing = gmail_oauth.missing_scopes(list(chatapi.SCOPES), gmail_oauth.granted_scopes(flow, creds))
        if missing:  # a box was unticked at Google: the bot could not do its work, so nothing is kept
            return _back("error", "Google did not allow the QA chatbot to " + ", ".join(chatapi.SCOPE_WORDS[s] for s in missing)
                         + ". Sign in again and leave every box ticked.")
        if not getattr(creds, "refresh_token", None):
            return _back("error", "Google did not return a lasting sign-in. Remove the app at myaccount.google.com/permissions and sign in again.")
        authorized = gmail_oauth._id_token_email(getattr(creds, "id_token", None))
        if not authorized:
            return _back("error", "Google did not say which account signed in. Try again.")
        if authorized != bot:
            return _back("error", f"That was {authorized}. Sign in as the QA chatbot's account, {bot}.")
        mod.store_credentials(mod.get_token_vault(), chatapi.vault_key(bot), creds)
    except Exception as exc:  # noqa: BLE001 - any failure at Google or the vault is shown to the person
        log.exception("the Chat sign-in did not finish")
        return _back("error", f"The sign-in did not finish: {exc}")
    audit.record(ctx, actor=user.email, action="connection.chat_signin", surface="console", target_type="connection", target_id="chat",
                 summary=f"The QA chatbot ({bot}) signed in to Google Chat")
    return _back("connected")


@router.delete("/chat-signin")
def sign_out(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    bot = (ctx.config.agent.email or "").strip().lower()
    mod = gmail_oauth.gmail_module()
    if bot and mod is not None:
        mod.get_token_vault().delete(chatapi.vault_key(bot))
        audit.record(ctx, actor=user.email, action="connection.chat_signout", surface="console", target_type="connection", target_id="chat",
                     summary=f"The QA chatbot ({bot}) was signed out of Google Chat")
    return status(ctx)
