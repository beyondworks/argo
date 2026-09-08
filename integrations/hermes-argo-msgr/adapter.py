"""Argo Messenger platform adapter for Hermes Agent (plugin path — zero core changes).

Argo Messenger is the platform; Hermes connects as a *bot*, the way it connects to Telegram:
  · ARGO_MSGR_URL       — bot API address (Supabase edge function …/functions/v1/msgr-bot)
  · ARGO_MSGR_BOT_TOKEN — bot token (shown once in Argo Messenger → Settings → External agents)
Wire (Telegram Bot API discipline, JSON): GET  {url}/bot{token}/getMe
                                          GET  {url}/bot{token}/getUpdates?offset=&timeout=   (long poll, offset = ack)
                                          POST {url}/bot{token}/sendMessage {chat_id, text, reply_to_message_id}
Who may instruct the bot, which channels it reads, and channel policies are all decided by the Argo server
(getUpdates only returns mentions / DMs / replies addressed to this bot; sendMessage re-checks the policy on
every reply). So inbound events are marked role_authorized — no per-user allow-list is needed here.
"""
import asyncio
import datetime
import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

from gateway.config import Platform
from gateway.platforms.base import BasePlatformAdapter, MessageEvent, MessageType, SendResult

logger = logging.getLogger(__name__)

_POLL_TIMEOUT_S = 20          # server caps at 25
_BACKOFF_MAX_S = 30
_MAX_LEN = 20000              # server body cap (msgr_messages.body)
# Gateway system notices (busy-ack ⚡/⏳/⏩, 💾, 📬 home-channel notice) go as plain posts — the server keeps ONE reply per source
# message, and a notice must not take the slot the real answer needs (observed: '⚡ Interrupting…' became the reply, answer went plain).
_SYSTEM_PREFIXES = ('⚡', '⏳', '⏩', '💾', '📬')


def _cfg(extra: Dict[str, Any], env: str, key: str, default: str = "") -> str:
    return (os.getenv(env) or str(extra.get(key) or default)).strip()


def _redact(s: str) -> str:
    return s.replace(os.getenv("ARGO_MSGR_BOT_TOKEN", "\x00"), "argo_bot_***")


class ArgoMsgrError(Exception):
    def __init__(self, status: int, description: str):
        super().__init__(f"{status}: {description}")
        self.status, self.description = status, description


def _call(base: str, token: str, method: str, params: Optional[Dict[str, Any]] = None, *, post: bool = False,
          timeout: float = 30.0) -> Any:
    """Blocking HTTP call (run via asyncio.to_thread). Returns `result`; raises ArgoMsgrError on {ok:false}."""
    url = f"{base.rstrip('/')}/bot{token}/{method}"
    data = None
    headers = {"Accept": "application/json"}
    if post:
        data = json.dumps(params or {}).encode("utf-8")
        headers["Content-Type"] = "application/json"
    elif params:
        url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if post else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode("utf-8") or "{}")
        except Exception:
            body = {"ok": False, "error_code": e.code, "description": str(e)}
    if not body.get("ok"):
        raise ArgoMsgrError(int(body.get("error_code") or 500), str(body.get("description") or "unknown"))
    return body.get("result")


class ArgoMsgrAdapter(BasePlatformAdapter):
    def __init__(self, config):
        super().__init__(config=config, platform=Platform("argo_msgr"))
        extra = getattr(config, "extra", {}) or {}
        self.base_url = _cfg(extra, "ARGO_MSGR_URL", "url")
        self.token = _cfg(extra, "ARGO_MSGR_BOT_TOKEN", "token")
        self.max_message_length = _MAX_LEN
        self._me: Dict[str, Any] = {}
        self._offset = 0
        self._running = False
        self._poll_task: Optional[asyncio.Task] = None
        self._chats: Dict[str, Dict[str, Any]] = {}      # chat_id → {name, kind}
        self._last_src: Dict[str, int] = {}              # chat_id → last inbound message_id (reply target)
        self._replied: set = set()                       # message ids already answered (server dedupes reply:<crew>:<src>)

    @property
    def name(self) -> str:
        return "Argo Messenger"

    async def _api(self, method: str, params: Optional[Dict[str, Any]] = None, *, post: bool = False, timeout: float = 30.0):
        return await asyncio.to_thread(_call, self.base_url, self.token, method, params, post=post, timeout=timeout)

    # ── lifecycle ────────────────────────────────────────────────────────────
    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not self.base_url or not self.token:
            self._set_fatal_error("config", "ARGO_MSGR_URL and ARGO_MSGR_BOT_TOKEN are required", retryable=False)
            return False
        try:
            self._me = await self._api("getMe") or {}
        except ArgoMsgrError as e:
            self._set_fatal_error("auth" if e.status == 401 else "connect", f"getMe failed: {e.description}", retryable=e.status != 401)
            return False
        except Exception as e:
            self._set_fatal_error("connect", f"getMe failed: {_redact(str(e))}", retryable=True)
            return False
        logger.info("Argo Messenger: connected as %s (%s) in org %s", self._me.get("first_name"), self._me.get("kind"),
                    (self._me.get("org") or {}).get("name"))
        self._running = True
        self._poll_task = asyncio.create_task(self._poll_loop())
        self._mark_connected()
        return True

    async def disconnect(self) -> None:
        self._running = False
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except (asyncio.CancelledError, Exception):
                pass
            self._poll_task = None
        self._mark_disconnected()

    async def _poll_loop(self) -> None:
        backoff = 1.0
        while self._running:
            try:
                updates = await self._api("getUpdates", {"offset": self._offset, "timeout": _POLL_TIMEOUT_S, "limit": 50},
                                          timeout=_POLL_TIMEOUT_S + 15) or []
                backoff = 1.0
                for up in updates:
                    self._offset = max(self._offset, int(up.get("update_id", 0)) + 1)   # ack (Telegram offset discipline)
                    try:
                        await self._dispatch(up.get("message") or {})
                    except Exception:
                        logger.exception("Argo Messenger: dispatch failed for update %s", up.get("update_id"))
            except asyncio.CancelledError:
                raise
            except ArgoMsgrError as e:
                if e.status == 401:   # token revoked/rotated — stop, do not hammer
                    logger.error("Argo Messenger: token rejected (%s) — rotate the token in Argo Messenger settings", e.description)
                    self._set_fatal_error("auth", e.description, retryable=False)
                    self._running = False
                    self._mark_disconnected()
                    return
                logger.warning("Argo Messenger: getUpdates %s — retry in %.0fs", e, backoff)
                await asyncio.sleep(backoff); backoff = min(backoff * 2, _BACKOFF_MAX_S)
            except Exception as e:
                logger.warning("Argo Messenger: poll error %s — retry in %.0fs", _redact(str(e)), backoff)
                await asyncio.sleep(backoff); backoff = min(backoff * 2, _BACKOFF_MAX_S)

    async def _dispatch(self, m: Dict[str, Any]) -> None:
        text = (m.get("text") or "").strip()
        chat = m.get("chat") or {}
        frm = m.get("from") or {}
        chat_id = str(chat.get("id") or "")
        if not chat_id or not text or not self._message_handler:
            return
        self._chats[chat_id] = {"name": chat.get("name") or chat_id, "kind": chat.get("kind") or "public"}
        mid = int(m.get("message_id") or 0)
        self._last_src[chat_id] = mid
        source = self.build_source(
            chat_id=chat_id, chat_name=chat.get("name") or chat_id,
            chat_type="dm" if chat.get("kind") == "dm" else "group",
            user_id=str(frm.get("id") or ""), user_name=frm.get("name") or "", message_id=str(mid) if mid else None,
            role_authorized=True)   # the Argo server already decided this author may address the bot
        await self.handle_message(MessageEvent(
            text=text, message_type=MessageType.TEXT, source=source, message_id=str(mid) if mid else None,
            user_id=str(frm.get("id") or ""), user_name=frm.get("name") or "",
            reply_to_message_id=str(m["reply_to"]) if m.get("reply_to") else None,
            timestamp=datetime.datetime.fromtimestamp(int(m.get("date") or 0)) if m.get("date") else datetime.datetime.now()))

    # ── outbound ─────────────────────────────────────────────────────────────
    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None,
                   metadata: Optional[Dict[str, Any]] = None) -> SendResult:
        if not self._running and not self._me:
            return SendResult(success=False, error="Not connected")
        # Answer as a reply to the triggering message (the server re-checks who may instruct the bot on every
        # reply and dedupes one reply per source message) — later chunks go as plain posts.
        src: Optional[int] = None
        try:
            src = int(reply_to) if reply_to else self._last_src.get(str(chat_id))
        except (TypeError, ValueError):
            src = None
        if src is not None and (src in self._replied or content.lstrip().startswith(_SYSTEM_PREFIXES)):
            src = None
        params: Dict[str, Any] = {"chat_id": str(chat_id), "text": content[:_MAX_LEN]}
        if src is not None:
            params["reply_to_message_id"] = src
        try:
            res = await self._api("sendMessage", params, post=True) or {}
        except ArgoMsgrError as e:
            logger.warning("Argo Messenger: sendMessage %s", e)
            return SendResult(success=False, error=e.description)
        except Exception as e:
            return SendResult(success=False, error=_redact(str(e)))
        if src is not None:
            self._replied.add(src)
        return SendResult(success=True, message_id=str(res.get("message_id") or ""))

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        return None   # Argo Messenger shows "connected · last seen" from getUpdates instead of a typing bubble

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        c = self._chats.get(str(chat_id)) or {}
        return {"name": c.get("name") or str(chat_id), "type": "dm" if c.get("kind") == "dm" else "group", "chat_id": str(chat_id)}


# ── plugin registration ───────────────────────────────────────────────────────

def check_requirements() -> bool:
    return bool(os.getenv("ARGO_MSGR_URL") and os.getenv("ARGO_MSGR_BOT_TOKEN"))


def validate_config(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    return bool(_cfg(extra, "ARGO_MSGR_URL", "url") and _cfg(extra, "ARGO_MSGR_BOT_TOKEN", "token"))


def _env_enablement() -> Optional[dict]:
    url, token = os.getenv("ARGO_MSGR_URL", "").strip(), os.getenv("ARGO_MSGR_BOT_TOKEN", "").strip()
    if not (url and token):
        return None
    seed: Dict[str, Any] = {"url": url, "token": token}
    home = os.getenv("ARGO_MSGR_HOME_CHANNEL", "").strip()
    if home:
        seed["home_channel"] = {"chat_id": home, "name": "Argo Messenger"}
    return seed


async def _standalone_send(pconfig, chat_id, message, *, thread_id=None, media_files=None, force_document=False):
    extra = getattr(pconfig, "extra", {}) or {}
    base, token = _cfg(extra, "ARGO_MSGR_URL", "url"), _cfg(extra, "ARGO_MSGR_BOT_TOKEN", "token")
    if not (base and token):
        return {"error": "ARGO_MSGR_URL and ARGO_MSGR_BOT_TOKEN must be configured"}
    try:
        res = await asyncio.to_thread(_call, base, token, "sendMessage", {"chat_id": str(chat_id), "text": str(message)[:_MAX_LEN]}, post=True)
        return {"success": True, "message_id": str((res or {}).get("message_id") or "")}
    except ArgoMsgrError as e:
        return {"error": e.description}
    except Exception as e:
        return {"error": _redact(str(e))}


def register(ctx):
    ctx.register_platform(
        name="argo_msgr",
        label="Argo Messenger",
        adapter_factory=ArgoMsgrAdapter,
        check_fn=check_requirements,
        validate_config=validate_config,
        required_env=["ARGO_MSGR_URL", "ARGO_MSGR_BOT_TOKEN"],
        install_hint="No extra packages needed (stdlib only)",
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="ARGO_MSGR_HOME_CHANNEL",
        standalone_sender_fn=_standalone_send,
        max_message_length=_MAX_LEN,
        emoji="⛵",
        pii_safe=False,
        allow_update_command=False,
        platform_hint=(
            "You are connected to a company's Argo Messenger as an external agent bot. Messages reach you only when "
            "someone mentions you, DMs you, or replies to your post; your answer is posted as a reply in that channel. "
            "Markdown is supported. Answer in the language the person used (usually Korean); keep it concise."))
