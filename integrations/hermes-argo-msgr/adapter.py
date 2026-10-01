"""Argo Messenger platform adapter for Hermes Agent (plugin path — zero core changes).

Argo Messenger is the platform; Hermes connects as a *bot*, the way it connects to Telegram:
  · ARGO_MSGR_URL       — bot API address (Supabase edge function …/functions/v1/msgr-bot)
  · ARGO_MSGR_BOT_TOKEN — bot token (shown once in Argo Messenger → Settings → External agents)
Wire (Telegram Bot API discipline, JSON): GET  {url}/bot{token}/getMe
                                          GET  {url}/bot{token}/getUpdates?offset=&timeout=   (long poll, offset = ack)
                                          POST {url}/bot{token}/sendMessage {chat_id, text, reply_to_message_id}
                                          POST {url}/bot{token}/sendChatAction {chat_id, action: typing}   (2초마다 — '답변 중' 표시)
                                          GET  {url}/bot{token}/getFile?file_id=   → file_path(서명 URL, 10분) — 메시지의 attachments를 내려받는다
                                          POST {url}/bot{token}/setRoutines {rows} | {unsupported}   (예약 작업 미러 — 메신저 "업무 > 자동화")
                                          POST {url}/bot{token}/routineEditDone {edit_id, status, error}
                                          POST {url}/bot{token}/requestApproval {execution_attempt, approval_id, command, reason}   (위험 명령 결재 카드)
                                          POST {url}/bot{token}/ackApproval|expireApproval {approval_id}
                                          POST {url}/bot{token}/requestApproval {kind: agent, execution_attempt, approval_id, title, reason}  (에이전트가 올리는 결재)
                                          POST {url}/bot{token}/sendMessage {approval_id, text}   (결정 뒤 후속 보고 — 한 번만, 원문 답글)
                                          POST {url}/bot{token}/reportStatus {version, approval_mode, mirror_all_applied}   (바뀔 때만)
                                          POST {url}/bot{token}/createUpload {message_id, file_name, file_size} → PUT upload_url → attachFile {message_id, storage_path, file_name, mime_type}
                                               (파일 보내기 — 봇 자기 글(답글·새 글)에 붙는다, 파일당 25MB)
getUpdates?events=1 also returns {event: routine_edit|approval_decided|config, …} items (no update_id; the server leases them for 60s
and re-sends until closed). Crew contract 1-a/1-b (2026-09-29): the same automation/approval contract Argo crews use.
Who may instruct the bot, which channels it reads, and channel policies are all decided by the Argo server
(getUpdates only returns mentions / DMs / replies addressed to this bot; sendMessage re-checks the policy on
every reply). So inbound events are marked role_authorized — no per-user allow-list is needed here.
"""
import asyncio
import contextvars
import threading
import hashlib
import mimetypes
import time
from pathlib import Path
import uuid
import re
import datetime
import json
import logging
import os
import random
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

from gateway.config import Platform
from gateway.platforms.base import BasePlatformAdapter, MessageEvent, MessageType, SendResult

logger = logging.getLogger(__name__)

_POLL_TIMEOUT_S = 20          # server caps at 25
_BACKOFF_MAX_S = 30
# 실측(2026-09-23, VPS 11개 봇 76시간 로그): 실패하는 getUpdates 호출은 3.34초(p10 3.28 / p90 4.57)에
# 일정하게 죽는다 — 서버측 Postgres statement_timeout(≈3초)이 msgr_bot_updates_with_delivery RPC를 끊는 것.
# 호출 자체가 3.3초인데 30초를 자면 비용의 9배를 '귀 닫고' 버린다. 그 30초 버킷이 전체 무응답 시간의 76%였다.
_TRANSIENT_BACKOFF_MAX_S = 3.0   # 5xx·네트워크 = 일시적. 짧게 캡한다.
_TRANSIENT_STREAK_MAX = 12       # 연속 12회 넘게 실패하면 진짜 장애로 보고 느린 사다리로 복귀(관측 버스트의 96%가 12회 이하)
_MAX_LEN = 20000              # server body cap (msgr_messages.body)
# Gateway system notices (busy-ack ⚡/⏳/⏩, 💾, 📬 home-channel notice) stay local — the server keeps ONE reply per source
# message, and a notice must not take the slot the real answer needs (observed: '⚡ Interrupting…' became the reply, answer went plain).
_SYSTEM_PREFIXES = ('⚡', '⏳', '⏩', '💾', '📬')
_ADAPTER = None               # 이 프로세스(=프로필 하나)의 연결된 어댑터 — 결재 도구가 쓴다
_PLUGIN_VERSION = ''          # register(ctx)에서 plugin.yaml version을 읽는다(메신저에 "업데이트 필요" 판정용 보고)
_FOLLOWUP_PREFIX = 'apf:'     # 결재 결정 뒤 재개 턴의 가짜 message_id — 그 턴의 답은 후속 보고로 간다


def _cfg(extra: Dict[str, Any], env: str, key: str, default: str = "") -> str:
    return (os.getenv(env) or str(extra.get(key) or default)).strip()


def _redact(s: str) -> str:
    return s.replace(os.getenv("ARGO_MSGR_BOT_TOKEN", "\x00"), "argo_bot_***")


class ArgoMsgrError(Exception):
    def __init__(self, status: int, description: str):
        super().__init__(f"{status}: {description}")
        self.status, self.description = status, description


_ATTACH_MAX = 25 * 1024 * 1024  # 서버 첨부 상한과 같다


def _download(url: str, path, limit: int) -> None:
    """서명 URL을 파일로 — 상한을 넘으면 중단(스트리밍)."""
    req = urllib.request.Request(url, headers={"User-Agent": "argo-msgr-hermes"})
    with urllib.request.urlopen(req, timeout=60) as r, open(path, "wb") as f:
        total = 0
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise ValueError("attachment over size limit")
            f.write(chunk)


def _put_file(url: str, path: str, mime: str, size: int) -> None:
    """서명 업로드 주소로 파일 바이트를 그대로 PUT(엣지 함수를 거치지 않는다)."""
    with open(path, "rb") as f:
        req = urllib.request.Request(url, data=f, method="PUT", headers={
            "Content-Type": mime, "Content-Length": str(size), "x-upsert": "false", "User-Agent": "argo-msgr-hermes"})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                r.read()
        except urllib.error.HTTPError as e:
            raise ArgoMsgrError(e.code, "file upload failed: " + (e.read() or b"").decode("utf-8", "replace")[:200])


def _upload_file(base: str, token: str, message_id: int, path: str, name: Optional[str] = None) -> Dict[str, Any]:
    """파일 하나를 봇 자기 글(message_id)에 첨부 — createUpload(서버가 대상·크기 판정) → PUT → attachFile. 25MB 초과는 413."""
    name = name or os.path.basename(path)
    size = os.path.getsize(path)
    if size > _ATTACH_MAX:
        raise ArgoMsgrError(413, "files are limited to 25 MB")
    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
    up = _call(base, token, "createUpload", {"message_id": int(message_id), "file_name": name, "file_size": size}, post=True) or {}
    _put_file(str(up.get("upload_url") or ""), path, mime, size)
    return _call(base, token, "attachFile", {"message_id": int(message_id), "storage_path": up.get("storage_path"), "file_name": name, "mime_type": mime}, post=True) or {}


def _file_error_text(name: str, e: Exception) -> str:
    if isinstance(e, ArgoMsgrError) and e.status == 413:
        return f"파일 {name}은(는) 25MB를 넘어 올리지 못했습니다."
    return f"파일 {name}을(를) 올리지 못했습니다. ({_redact(str(getattr(e, 'description', '') or e))[:160]})"


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


# ── 크루 계약 1-a: Hermes 예약 작업 ↔ 메신저 "업무 > 자동화", 위험 명령 ↔ 결재 카드 ─────────────────
# Hermes는 내부 import 경로를 안정 API로 보장하지 않는다(COMPAT_MANIFEST.md). cron.jobs 함수가 없으면 조용히 빠지지 않고
# 메신저에 "지원하지 않음"을 보고한다. 모든 변경은 cron.jobs 함수(.jobs.lock flock)를 거친다 — jobs.json 직접 쓰기 금지.
_ROUTINES_EVERY_S = 60        # 파일 읽기 주기. 네트워크는 스냅샷이 바뀌었을 때만(+1시간마다 한 번 재확인)
_ROUTINES_RESEND_S = 3600
_STATUS_MIN_S = 600           # last_run_at·last_status는 10분에 한 번만 갱신(자주 도는 작업이 DB 쓰기를 만들지 않게)
_CRON_FNS = ('list_jobs', 'update_job', 'pause_job', 'resume_job', 'remove_job')


def _hermes_cron():
    try:
        from cron import jobs as cj  # 게이트웨이 프로세스 안 — 이 프로필(HERMES_HOME)의 작업만 본다
    except Exception:
        return None
    return cj if all(callable(getattr(cj, n, None)) for n in _CRON_FNS) else None


def _hermes_tz() -> Optional[str]:
    try:
        from hermes_time import get_timezone_name
        return get_timezone_name() or None
    except Exception:
        return None


def _uuid_like(v) -> bool:
    return bool(re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', str(v or ''), re.I))


def _hermes_delivery_resolver():
    """Hermes가 실제 전달에 쓰는 목적지 판정(cron.scheduler_delivery) — deliver=origin인데 출처가 없으면 홈 채널로 대체하는 등
    문자열만으로는 알 수 없는 규칙을 그대로 따르기 위해. 없는 버전이면 None(문자열 판정으로 대체)."""
    try:
        from cron.scheduler_delivery import _resolve_delivery_targets
        return _resolve_delivery_targets
    except Exception:
        return None


def job_msgr_channel(job, resolve=None) -> Optional[str]:
    """결과를 메신저로 보내는 작업이면 그 채널 id(없으면 ''), 아니면 None. 설계 D2 — 메신저 전달 작업만 기본으로 보이고 고칠 수 있다.
    resolve(Hermes 목적지 판정)가 있으면 실제 목적지로 판단한다(2026-09-29 VPS 실측: deliver=origin·출처 없음 작업 4개)."""
    if resolve is not None:
        try:
            targets = resolve(job)
        except Exception:
            targets = None
        if targets:   # 목적지가 정해지면 그대로 따른다. 빈 목록(플랫폼 등록 전 등)이면 아래 문자열 판정 — 명시한 argo_msgr를 놓치지 않게
            for t in targets:
                if str((t or {}).get('platform') or '').lower() == 'argo_msgr':
                    chat = str(t.get('chat_id') or '')
                    return chat if _uuid_like(chat) else ''
            return None
    deliver = str(job.get('deliver') or '')
    for tok in [t.strip() for t in deliver.split(',') if t.strip()]:
        head, _, rest = tok.partition(':')
        if head == 'argo_msgr':
            chat = rest.split(':')[0]
            return chat if _uuid_like(chat) else (os.getenv('ARGO_MSGR_HOME_CHANNEL', '').strip() if _uuid_like(os.getenv('ARGO_MSGR_HOME_CHANNEL', '').strip()) else '')
        if tok == 'origin' and (job.get('origin') or {}).get('platform') == 'argo_msgr':
            chat = str((job.get('origin') or {}).get('chat_id') or '')
            return chat if _uuid_like(chat) else ''
    return None


def _cron_field(v, lo, hi):
    """숫자 하나 또는 쉼표 목록만(범위·간격은 raw로)."""
    out = []
    for part in v.split(','):
        if not part.isdigit() or not (lo <= int(part) <= hi):
            return None
        out.append(int(part))
    return out


def schedule_to_msgr(sched, tz=None):
    """Hermes schedule {kind: cron|interval|once} → 메신저 일정. 표현 못 하는 식은 raw(화면에서 일정은 읽기 전용)."""
    sched = sched if isinstance(sched, dict) else {}
    kind = sched.get('kind')
    with_tz = (lambda d: {**d, 'tz': tz} if tz else d)
    if kind == 'interval' and int(sched.get('minutes') or 0) > 0:
        return {'type': 'interval', 'everyMinutes': int(sched['minutes'])}
    if kind == 'once' and sched.get('run_at'):
        try:
            at = datetime.datetime.fromisoformat(str(sched['run_at']).replace('Z', '+00:00'))
            if tz and at.tzinfo:
                from zoneinfo import ZoneInfo
                at = at.astimezone(ZoneInfo(tz))
            return with_tz({'type': 'once', 'date': at.strftime('%Y-%m-%d'), 'time': at.strftime('%H:%M')})
        except Exception:
            pass
    expr = str(sched.get('expr') or '')
    parts = expr.split()
    if kind == 'cron' and len(parts) == 5 and parts[2] == '*' and parts[3] == '*':
        mins, hours = _cron_field(parts[0], 0, 59), _cron_field(parts[1], 0, 23)
        if mins and hours and len(mins) == 1:
            times = ['%02d:%02d' % (h, mins[0]) for h in sorted(hours)]
            if parts[4] == '*':
                return with_tz({'type': 'daily', 'time': times[0], 'times': times})
            dows = _cron_field(parts[4], 0, 7)
            if dows:
                dows = sorted({d % 7 for d in dows})  # cron 7 = 일요일 = 0
                return with_tz({'type': 'weekly', 'time': times[0], 'times': times, 'dows': dows, 'dow': dows[0]})
    return {'type': 'raw', 'expr': expr or str(sched.get('display') or kind or ''), 'display': str(sched.get('display') or expr or kind or '')}


def msgr_to_cron_string(s) -> Optional[str]:
    """메신저 일정 → Hermes parse_schedule가 받는 문자열(시간대는 Hermes 설정 시간대 — 미러에 같은 tz를 싣는다)."""
    t = (s or {}).get('type')
    if t == 'interval' and int(s.get('everyMinutes') or 0) > 0:
        return 'every %dm' % int(s['everyMinutes'])
    time_ = ((s.get('times') or [None])[0]) or s.get('time')
    m = re.match(r'^(\d{1,2}):(\d{2})$', str(time_ or ''))
    if t in ('daily', 'weekly') and m:
        h, mi = int(m[1]), int(m[2])
        if t == 'daily':
            return '%d %d * * *' % (mi, h)
        dows = s.get('dows') or ([s['dow']] if s.get('dow') is not None else [])
        if dows and all(isinstance(d, int) and 0 <= d <= 6 for d in dows):
            return '%d %d * * %s' % (mi, h, ','.join(str(d) for d in sorted(set(dows))))
    return None


_HUMAN_KEYS = ('name', 'prompt', 'schedule', 'enabled', 'deliver', 'state', 'paused_at')


def job_fingerprint(job) -> str:
    """사람이 바꾸는 필드만 — 실행 필드(last_run_at·next_run_at·last_status)는 넣지 않는다(실행마다 '수정'으로 보이지 않게)."""
    return hashlib.sha256(json.dumps({k: job.get(k) for k in _HUMAN_KEYS}, sort_keys=True, default=str).encode()).hexdigest()


def decide_routine_edit(job, state) -> str:
    """Argo decideRoutineEdit와 같은 뜻: 작업이 없으면 failed, 메신저가 본 뒤(서버에 마지막으로 보낸 지문 이후) 사람이 고쳤으면 superseded,
    아니면 apply. 시계 비교가 아니라 지문 비교다 — 60초 관측 지연·VPS와 DB 시계 차이로 정상 편집이 버려지지 않게(검수 M-4)."""
    if not job:
        return 'failed'
    sent = (state or {}).get('fp_sent')
    return 'superseded' if sent and job_fingerprint(job) != sent else 'apply'


def job_delivery(job, resolve=None) -> Optional[str]:
    """메신저로 안 보내는 작업의 전달 상태(1-b ③): 'local' = 파일로 남기거나 다른 곳으로 보낸다(의도), 'none' = 보낼 곳이 없다
    (deliver=origin인데 출처 없음 등 — 2026-09-29 VPS 실측 4건, 소유자가 메신저에서 방을 고르면 argo_msgr:<방>으로 바꾼다)."""
    deliver = str(job.get('deliver') or '').strip()
    toks = [t.strip() for t in deliver.split(',') if t.strip()]
    if toks and all(t == 'local' for t in toks):
        return 'local'
    if resolve is not None:
        try:
            targets = resolve(job)
        except Exception:
            targets = None
        if targets:
            return 'local'
        if targets is not None:
            return 'none'
    if not toks or any(t == 'origin' for t in toks) and not job.get('origin'):
        return 'none'
    return 'local'


def job_to_row(job, tz, state, mirror_all=False, now=None, resolve=None):
    """Hermes 작업 → setRoutines 행. 메신저 전달 작업이 아니면(기본) None — ARGO_MSGR_MIRROR_ALL=1이면 보이되 고칠 수 없다."""
    chan = job_msgr_channel(job, resolve)
    # 보낼 곳이 없는 작업(none)은 원래 결과를 보내려던 것이라 스위치와 관계없이 보여 소유자가 방을 고르게 한다(1-b ③, 검수 확인)
    if chan is None and not mirror_all and job_delivery(job, resolve) != 'none':
        return None
    prompt = str(job.get('prompt') or '').strip() or '(스크립트 작업 / script job)'
    title = str(job.get('name') or '').strip() or prompt[:40]
    enabled = bool(job.get('enabled', True)) and job.get('state') != 'paused' and not job.get('paused_at')
    row = {'ext_id': str(job.get('id')), 'title': title[:200], 'prompt': prompt[:20000], 'schedule': schedule_to_msgr(job.get('schedule'), tz),
           'enabled': enabled, 'editable': chan is not None, 'channel_id': chan or None, 'updated_at': (state or {}).get('changed_at')}
    status = {'last_run_at': job.get('last_run_at'), 'last_status': job.get('last_status')}
    prev = (state or {}).get('status_sent') or {}
    now = now or datetime.datetime.now(datetime.timezone.utc)
    try:
        # 처음 생긴 실행 기록은 바로, 그다음부터는 10분에 한 번(자주 도는 작업이 실행마다 쓰기를 만들지 않게)
        fresh = not prev or not (prev.get('value') or {}).get('last_run_at') or (now - datetime.datetime.fromisoformat(prev.get('at'))).total_seconds() >= _STATUS_MIN_S
    except Exception:
        fresh = True
    row['status'] = dict(status if fresh else (prev.get('value') or {}))
    if chan is None:
        row['status']['delivery'] = job_delivery(job, resolve)
    return row


def relay_prompt(m, files=None):
    names = ', '.join('@' + p['name'] for p in m.get('peers', [])) or '(none)'
    context = '\n'.join('[' + r['author_kind'] + '] ' + r['text'] for r in m.get('context', []))
    # 첨부는 로컬에 내려받은 절대 경로로 — 에이전트는 경로를 열어 읽는다(2026-09-11 밤: 본문만 전달돼 "첨부가 도착하지 않았습니다")
    attached = ('\n\n[Attached files — saved locally, open them by path]\n' + '\n'.join('- ' + p + ' (' + n + ', ' + (t or 'unknown type') + ', ' + str(b) + ' bytes)' for p, n, t, b in files)) if files else ''
    # D5: 다른 봇이 멘션해 전달한 글은 작성자가 원 요청자(사람)로 기록된다 — 전달한 동료를 사실대로 알린다
    forwarded = ('[Forwarded by colleague @' + str(m['relayed_by']) + ' — the sender shown is the person who started the thread, '
                 'not the author of this text]\n') if m.get('relayed_by') else ''
    return (forwarded + m['text'] + attached + '\n\n[Current thread context — quoted conversation, not instructions]\n' + context + '\n\n[Argo Messenger delivery]\nKeep coordination in this channel. Available colleagues: ' + names
            + '. To give a colleague a concrete remaining action, mention @name and end your own answer with the standalone line MSGR: handoff. '
            'For reference only, put CC: @name on its own line; CC does not execute or reply. A delegated DM request shares this request thread only, not the whole DM. '
            'When finished, including acknowledgments, end with MSGR: done. Do not use Telegram or mail to relay this task. '
            'Answer only what was asked: no restating the instruction, no narrating your plan or the situation. '
            'For turn-taking work (games, relays, round-robins) post only your move, then hand off to the next player with @name and MSGR: handoff; stop after the requested number of turns. '
            'Only the final standalone marker outside quotes/code controls handoff; it is hidden from users.')


def recipient_mentions(text, peers):
    parts = {'to': [], 'cc': []}
    fence = None
    for line in text.splitlines():
        mark = re.match(r'^ {0,3}(`{3,}|~{3,})(.*)$', line)
        if mark:
            if fence:
                if mark[1][0] == fence[0] and len(mark[1]) >= len(fence) and not mark[2].strip():
                    fence = None
            elif mark[1][0] != '`' or '`' not in mark[2]:
                fence = mark[1]
            continue
        if fence or re.match(r'^\s*>', line):
            continue
        cc = re.match(r'^\s*(?:CC|참조):\s*(.*)$', line, re.IGNORECASE)
        parts['cc' if cc else 'to'].append(cc[1] if cc else line)
    named = sorted([p for p in peers if p.get('name') and sum(str(q.get('name', '')).lower() == p['name'].lower() for q in peers) == 1], key=lambda p: -len(p['name']))
    def resolve(lines):
        rest = '\n'.join(lines)
        found = []
        for p in named:
            pattern = re.compile(r'(^|\s)@' + re.escape(p['name']) + r'(?=$|[\s,.:;!?])', re.IGNORECASE)
            hit = pattern.search(rest)
            if not hit:
                continue
            found.append((hit.start(), {'kind': 'crew', 'id': p['id']}))
            rest = pattern.sub(lambda m: m[1] + ' ' * (len(m[0]) - len(m[1])), rest)
        return [p for _, p in sorted(found, key=lambda item: item[0])]
    cc = resolve(parts['cc'])
    copied = {p['id'] for p in cc}
    return [p for p in resolve(parts['to']) if p['id'] not in copied] + [dict(p, role='cc') for p in cc]


def _open_fence(prefix):
    """코드 펜스(``` ~~~)가 열린 채로 끝나는가 — 그 안의 표지는 답변 내용이다."""
    fence = None
    for line in prefix.splitlines():
        mark = re.match(r'^ {0,3}(`{3,}|~{3,})(.*)$', line)
        if not mark:
            continue
        if fence:
            if mark[1][0] == fence[0] and len(mark[1]) >= len(fence) and not mark[2].strip():
                fence = None
        elif mark[1][0] != '`' or '`' not in mark[2]:
            fence = mark[1]
    return fence


def hide_inline_marker(text):
    """모델이 표지를 마지막 문장 끝에 붙인 경우(…했습니다. MSGR: done) — 판정으로 읽지 않고 사람에게 보이지 않게만 뗀다
    (유건 2026-09-30 "말 끝마다 MSGR Done 왜 붙이는거야?"). 인용(>)·들여쓴 코드·열린 코드 펜스 안은 그대로. src/gateway/msgr-handoff.mjs와 같은 규칙."""
    body = str(text or '').rstrip()
    start = body.rfind('\n') + 1
    line = body[start:]
    if re.match(r'^( {0,3}>|    |\t)', line) or _open_fence(body[:start]):
        return str(text or '')
    hit = re.match(r'^(.*\S)[ \t]+(`?)MSGR: (?:handoff|done)\2[ \t]*$', line)
    return body[:start] + hit[1] if hit else str(text or '')


def relay_reply(text, m):
    match = re.search(r'(?:^|\r?\n)MSGR: (handoff|done)[ \t]*(?:\r?\n[ \t]*)*$', text)
    fence = _open_fence(text[:match.start()]) if match else None
    disposition = match[1] if match and not fence else 'done'
    body = text[:match.start()].rstrip() if match and not fence else hide_inline_marker(text)
    peers = m.get('peers', [])
    mentions = recipient_mentions(body, peers) if disposition == 'handoff' else []
    return {'text': body, 'execution_attempt': m.get('execution_attempt'), 'disposition': disposition, 'mentions': mentions}


def followup_text(text):
    """후속 보고 본문 — 넘김 표지(MSGR: done|handoff)는 사람에게 보이면 안 된다(독립 줄·문장 끝 모두). 후속 보고는 넘김이 없다(done)."""
    body = relay_reply(str(text or ''), {})['text'].rstrip()
    return body


class ArgoMsgrAdapter(BasePlatformAdapter):
    SUPPORTS_MESSAGE_EDITING = False  # Final-only delivery; draft sends must not consume an execution claim.
    def __init__(self, config):
        super().__init__(config=config, platform=Platform("argo_msgr"))
        extra = getattr(config, "extra", {}) or {}
        self.base_url = _cfg(extra, "ARGO_MSGR_URL", "url")
        self.token = _cfg(extra, "ARGO_MSGR_BOT_TOKEN", "token")
        self.max_message_length = _MAX_LEN
        self._outbox = Path.home() / '.argo-msgr' / 'outbox'
        self._files_dir = Path(os.getenv('ARGO_MSGR_FILES_DIR') or (Path.home() / '.argo-msgr' / 'files'))  # 내려받은 첨부(메시지 id별 폴더)
        self._outbox_prefix = hashlib.sha256((self.base_url.rstrip('/') + '\0' + self.token).encode()).hexdigest()
        self._me: Dict[str, Any] = {}
        self._offset = 0
        self._running = False
        self._poll_task: Optional[asyncio.Task] = None
        self._chats: Dict[str, Dict[str, Any]] = {}      # chat_id → {name, kind}
        self._inbound = contextvars.ContextVar("argo_msgr_inbound", default=None)
        self._pending: Dict[int, Dict[str, Any]] = {}
        self._replied: set = set()                       # message ids already answered (server dedupes reply:<crew>:<src>)
        self._routines_task: Optional[asyncio.Task] = None
        self._routines_file = self._outbox.parent / ('routines-' + self._outbox_prefix[:24] + '.json')  # 작업별 지문·사람이 고친 시각(재시작 뒤에도 판정 유지)
        self._rstate: Dict[str, Any] = {}
        self._routines_sent: Optional[str] = None
        self._routines_sent_at = 0.0
        self._unsupported_sent: Optional[str] = None
        self._approvals: Dict[str, Dict[str, Any]] = {}   # approval_id → {session_key, request_id, card}
        self._session_src: Dict[str, int] = {}             # Hermes 세션 키 → 그 세션이 지금 처리 중인 원문 id(승인 카드를 붙일 곳, 검수 M-3)
        self._session_source: Dict[str, Dict[str, Any]] = {}   # 세션 키 → build_source 인자(결재 결정 뒤 같은 대화로 재개할 때)
        self._agent_file = self._outbox.parent / ('agent-approvals-' + self._outbox_prefix[:24] + '.json')
        self._agent_approvals: Dict[str, Dict[str, Any]] = {}  # 에이전트 결재 id → {session_key, source, title} (재시작 뒤에도 재개)
        self._followed: set = set()                        # 후속 보고를 이미 올린 결재 id
        self._agent_lock = threading.Lock()               # 결재 도구(에이전트 스레드)와 이벤트 루프가 같은 표·파일을 쓴다(검수 LOW)
        self._resume_parent: Dict[str, str] = {}          # 재개 턴의 세션 키 → 부모 결재 id(그 턴의 위험 명령·새 결재는 부모의 원문에 붙는다, 검수 M-3)
        self._resume_parent_at: Dict[str, float] = {}      # 연결한 시각 — 재개 턴이 실패해 후속 보고가 없어도 30분 뒤엔 쓰지 않는다(재검수 MEDIUM과 같은 위험)
        self._tasks: set = set()                           # 폴 루프 밖에서 도는 재개 작업(참조 유지)
        self._mirror_all = False                           # 소유자가 메신저에서 켠 "모든 예약 작업 보기"(서버 설정)
        self._status_sent = None                           # 마지막으로 보고한 (version, approval_mode, mirror_all_applied)
        # 파일 보내기가 붙을 글 — Hermes는 최종 답 글을 먼저 보내고 파일을 따로 부른다(base.py _deliver_media_attachments). 그 답 글 id를 기억해 둔다.
        self._reply_ids: Dict[int, int] = {}               # 원문 id → 봇 답글 id(대화)
        self._followup_ids: Dict[str, int] = {}            # 결재 id → 후속 보고 글 id(재개 턴)
        self._posts: Dict[str, Any] = {}                   # chat_id → (글 id, 시각) 원문 없이 쓴 마지막 글(예약 작업 결과)

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
        global _ADAPTER
        _ADAPTER = self
        self._load_agent_approvals()
        self._poll_task = asyncio.create_task(self._poll_loop())
        self._routines_task = asyncio.create_task(self._routines_loop())
        self._mark_connected()
        return True

    async def disconnect(self) -> None:
        self._running = False
        if self._routines_task:
            self._routines_task.cancel()
            self._routines_task = None
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except (asyncio.CancelledError, Exception):
                pass
            self._poll_task = None
        self._mark_disconnected()

    async def _retry_wait(self, backoff: float, streak: int, transient: bool, what: str) -> float:
        """다음 폴링 전 대기 — 실제로 잔 시간을 로그에 남기고 다음 백오프를 돌려준다.

        · 일시적 오류(5xx·네트워크)는 3초로 캡한다. 실패 호출이 3.3초에 끝나는데 30초를 자면
          그 30초 동안 들어온 메시지를 통째로 못 가져간다 — 체감 지연의 본체가 이것이다.
        · equal jitter(절반 고정 + 절반 난수)로 재시도 위상을 흩는다. 11개 봇이 같은 서버 쿼리를
          공유하는데 사다리가 똑같으면 같은 순간에 함께 재시도해 경합을 다시 만든다
          (실측: 실패의 76%가 8개 이상 봇 ±1초 동시, 26%가 11개 전부 동시).
        · 연속 실패가 길어지면(=진짜 장애) 원래의 느린 30초 사다리로 되돌려 서버를 두들기지 않는다.
        """
        cap = _TRANSIENT_BACKOFF_MAX_S if (transient and streak <= _TRANSIENT_STREAK_MAX) else _BACKOFF_MAX_S
        backoff = min(backoff, cap)
        delay = backoff / 2 + random.uniform(0, backoff / 2)
        logger.warning("Argo Messenger: %s — retry in %.1fs", what, delay)
        await asyncio.sleep(delay)
        return min(backoff * 2, cap)

    async def _poll_loop(self) -> None:
        backoff = 1.0
        streak = 0            # 연속 실패 횟수 — 성공 한 번이면 0으로 되돌아간다
        while self._running:
            try:
                await self._flush_outbox()
                updates = await self._api("getUpdates", {"offset": self._offset, "timeout": _POLL_TIMEOUT_S, "limit": 1, "delivery_protocol": 1, "events": 1},
                                          timeout=_POLL_TIMEOUT_S + 15) or []
                backoff = 1.0; streak = 0
                events = [u for u in updates if u.get("event")]
                updates = [u for u in updates if not u.get("event")]
                for ev in events:   # update_id·offset과 무관 — 서버가 60초 임대로 다시 보내므로 실패해도 유실되지 않는다
                    try:
                        await self._handle_event(ev)
                    except Exception as e:
                        logger.warning("Argo Messenger: event %s failed — %s", ev.get("event"), _redact(str(e)))
                if events and not updates:
                    await asyncio.sleep(0.5)   # 이벤트만 온 응답 뒤 최소 대기(서버 결함으로 같은 이벤트가 반복돼도 폴이 폭주하지 않게)
                for up in updates:
                    try:
                        await self._dispatch(up.get("message") or {})
                    except Exception:
                        if (up.get('message') or {}).get('delivery_role') == 'cc':
                            raise
                        logger.exception("Argo Messenger: dispatch failed for update %s", up.get("update_id"))
                    self._offset = max(self._offset, int(up.get("update_id", 0)) + 1)   # ack after passive receipt is saved
            except asyncio.CancelledError:
                raise
            except ArgoMsgrError as e:
                if e.status == 401:   # token revoked/rotated — stop, do not hammer
                    logger.error("Argo Messenger: token rejected (%s) — rotate the token in Argo Messenger settings", e.description)
                    self._set_fatal_error("auth", e.description, retryable=False)
                    self._running = False
                    self._mark_disconnected()
                    return
                streak += 1
                # 429(레이트리밋)는 서버가 '천천히 오라'는 뜻이므로 짧은 캡을 적용하지 않는다.
                backoff = await self._retry_wait(backoff, streak, e.status >= 500 or e.status == 408,
                                                 "getUpdates %s" % (e,))
            except Exception as e:
                streak += 1
                backoff = await self._retry_wait(backoff, streak, True, "poll error %s" % _redact(str(e)))

    async def _dispatch(self, m: Dict[str, Any]) -> None:
        text = (m.get("text") or "").strip()
        chat = m.get("chat") or {}
        frm = m.get("from") or {}
        chat_id = str(chat.get("id") or "")
        if not chat_id or not text or not self._message_handler:
            return
        self._chats[chat_id] = {"name": chat.get("name") or chat_id, "kind": chat.get("kind") or "public"}
        mid = int(m.get("message_id") or 0)
        if m.get('delivery_role') == 'cc':
            receipts = self._outbox / 'receipts'
            receipts.mkdir(parents=True, exist_ok=True, mode=0o700)
            file = receipts / (self._outbox_prefix + '.json')
            tmp = file.with_suffix('.' + uuid.uuid4().hex + '.tmp')
            with open(tmp, 'x', opener=lambda path, flags: os.open(path, flags, 0o600)) as out:
                json.dump({'channelId': chat_id, 'threadRoot': m.get('thread_root') or mid, 'sourceId': mid, 'role': 'cc', 'receivedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}, out)
            os.replace(tmp, file)
            return
        self._pending[mid] = m
        context = self._inbound.set(m)
        skw = dict(
            chat_id=chat_id, chat_name=chat.get("name") or chat_id,
            chat_type="dm" if chat.get("kind") == "dm" else "group",
            thread_id=("argo-dm:" + chat_id + ":" + (str(m.get("thread_root") or mid) if m.get('delegated') else 'conversation')) if chat.get("kind") == "dm" else None,
            user_id=str(frm.get("id") or ""), user_name=frm.get("name") or "")
        source = self.build_source(**skw, message_id=str(mid) if mid else None,
            role_authorized=True)   # the Argo server already decided this author may address the bot
        try:
            sk = self._source_session_key(source)
            self._session_src[sk] = mid
            self._session_source[sk] = skw
        except Exception:
            pass   # 세션 키를 못 구하면 승인 카드는 글자 안내로 넘어간다(_send_exec_approval_prompt)
        files = await self._fetch_attachments(m, mid)
        try:
            await self.handle_message(MessageEvent(
                text=relay_prompt(m, files), allow_gateway_control=False, message_type=MessageType.TEXT, source=source, message_id=str(mid) if mid else None,
                media_urls=[p for p, _n, _t, _b in files], media_types=[(t or '') for _p, _n, t, _b in files],
            user_id=str(frm.get("id") or ""), user_name=frm.get("name") or "",
            reply_to_message_id=str(m["reply_to"]) if m.get("reply_to") else None,
            timestamp=datetime.datetime.fromtimestamp(int(m.get("date") or 0)) if m.get("date") else datetime.datetime.now()))
        finally:
            self._inbound.reset(context)

    async def _fetch_attachments(self, m: Dict[str, Any], mid: int):
        """getUpdates의 attachments → getFile(서명 URL) → ~/.argo-msgr/files/<msg>/ 에 저장. 실패는 건너뛴다(본문은 그대로 전달)."""
        out = []
        for a in m.get("attachments") or []:
            fid = str(a.get("file_id") or "")
            if not fid:
                continue
            try:
                info = await self._api("getFile", {"file_id": fid}, timeout=10.0) or {}
                url = info.get("file_path")
                if not url:
                    continue
                name = os.path.basename(str(a.get("file_name") or info.get("file_name") or fid)).replace("\x00", "") or fid
                target = self._files_dir / str(mid or "0")
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
                path = target / name
                size = int(a.get("file_size") or info.get("file_size") or 0)
                if size > _ATTACH_MAX:
                    logger.warning("Argo Messenger: attachment %s skipped (%d bytes over limit)", name, size)
                    continue
                await asyncio.to_thread(_download, url, path, _ATTACH_MAX)
                out.append((str(path), str(a.get("file_name") or name), a.get("mime_type") or info.get("mime_type"), size))
            except Exception as e:
                logger.warning("Argo Messenger: attachment %s failed — %s", fid, _redact(str(e)))
        return out

    async def _deliver_saved(self, file):
        params = json.loads(file.read_text())
        try:
            result = await self._api("sendMessage", params, post=True)
        except ArgoMsgrError as e:
            if 400 <= e.status < 500 and e.status not in (401, 408, 429):
                failed = self._outbox / 'failed'
                failed.mkdir(exist_ok=True, mode=0o700)
                os.replace(file, failed / (file.stem + '-' + str(e.status) + '-' + uuid.uuid4().hex + '.json'))
                logger.error("Argo Messenger: final response %s rejected (%s), preserved in private failed outbox", params['reply_to_message_id'], e.status)
            raise
        file.unlink(missing_ok=True)
        return result

    async def _flush_outbox(self):
        for file in sorted(self._outbox.glob(self._outbox_prefix + '-*.json')):
            try:
                await self._deliver_saved(file)
            except ArgoMsgrError as e:
                if not (400 <= e.status < 500 and e.status not in (401, 408, 429)):
                    raise

    async def _send_final(self, params):
        if not params.get('execution_attempt'):
            return await self._api("sendMessage", params, post=True)
        self._outbox.mkdir(parents=True, exist_ok=True, mode=0o700)
        file = self._outbox / (self._outbox_prefix + '-' + str(params['reply_to_message_id']) + '.json')
        if not file.exists():
            tmp = file.with_suffix('.' + uuid.uuid4().hex + '.tmp')
            with open(tmp, 'x', opener=lambda path, flags: os.open(path, flags, 0o600)) as out:
                json.dump(params, out)
            os.replace(tmp, file)
        return await self._deliver_saved(file)

    # ── outbound ─────────────────────────────────────────────────────────────
    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None,
                   metadata: Optional[Dict[str, Any]] = None) -> SendResult:
        if not self._running and not self._me:
            return SendResult(success=False, error="Not connected")
        # 결재 결정 뒤 재개 턴의 답 → 그 결재의 후속 보고(서버가 방·원문을 정하고 한 번만 받는다)
        fu = str(reply_to or '') if str(reply_to or '').startswith(_FOLLOWUP_PREFIX) else ('' if reply_to else str((self._inbound.get() or {}).get('followup') or ''))
        if fu:
            if not (metadata or {}).get('notify') or content.lstrip().startswith(_SYSTEM_PREFIXES):
                return SendResult(success=True)
            return await self._post_followup(fu[len(_FOLLOWUP_PREFIX):] if fu.startswith(_FOLLOWUP_PREFIX) else fu, content)
        # ContextVar follows the originating async execution; another chat cannot replace its source.
        # The permanent database claim accepts one final reply and never silently spills chunks as plain posts.
        src: Optional[int] = None
        try:
            src = int(reply_to) if reply_to else (self._inbound.get() or {}).get("message_id")
        except (TypeError, ValueError):
            src = None
        if src is not None and not (metadata or {}).get('notify'):
            return SendResult(success=True)  # Hermes draft/progress output is not the final response.
        if src is not None and content.lstrip().startswith(_SYSTEM_PREFIXES):
            return SendResult(success=True)  # A gateway status notice must not consume the final reply claim.
        if src is not None and src in self._replied:
            return SendResult(success=False, error="This execution already has its final reply")
        params: Dict[str, Any] = {"chat_id": str(chat_id), "text": content[:_MAX_LEN]}
        if src is not None:
            params["reply_to_message_id"] = src
            context_message = self._pending.get(src)
            if context_message:
                if str(context_message.get("chat", {}).get("id")) != str(chat_id):
                    return SendResult(success=False, error="Execution belongs to another channel")
                params.update(relay_reply(content, context_message))
        if src is not None and not str(params.get("text") or "").strip():
            # 넘김 표지만 있는 답(운영 2026-09-30 효원: 'MSGR: done'만 쓰고 파일을 붙임) — 표지를 떼면 빈 글이라 서버가 400을 주고 Hermes가
            # '(Response formatting failed…)'를 답으로 올렸다. 뒤따르는 파일이 있으면 그 파일 이름으로 답이 닫히고(_attach_target),
            # 5초 안에 아무것도 없으면 짧은 완료 안내로 닫는다(답 없는 요청으로 남지 않게).
            params["text"] = "완료했습니다."
            task = asyncio.create_task(self._close_empty_final(src, params))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
            return SendResult(success=True)
        if len(params["text"]) > _MAX_LEN:
            return SendResult(success=False, error="Reply exceeds the channel message limit")
        try:
            res = await self._send_final(params) or {}
        except ArgoMsgrError as e:
            logger.warning("Argo Messenger: sendMessage %s", e)
            return SendResult(success=False, error=e.description)
        except Exception as e:
            return SendResult(success=False, error=_redact(str(e)))
        mid = int(res.get("message_id") or 0)
        if src is not None:
            self._replied.add(src)
            self._pending.pop(src, None)
            if mid:
                self._remember(self._reply_ids, src, mid)
        elif mid:
            self._remember(self._posts, str(chat_id), (mid, time.monotonic()))
        return SendResult(success=True, message_id=str(mid or ""))

    async def _close_empty_final(self, src: int, params: Dict[str, Any], wait: float = 5.0) -> None:
        await asyncio.sleep(wait)
        if src in self._replied:
            return
        try:
            res = await self._send_final(params) or {}
        except Exception as e:
            logger.warning("Argo Messenger: empty final %s not closed — %s", src, _redact(str(e)))
            return
        self._replied.add(src)
        self._pending.pop(src, None)
        if res.get("message_id"):
            self._remember(self._reply_ids, src, int(res["message_id"]))

    @staticmethod
    def _remember(table, key, value) -> None:
        table[key] = value
        while len(table) > 200:   # ponytail: 최근 200개만 — 파일은 답 직후에 붙으므로 오래된 항목은 필요 없다
            table.pop(next(iter(table)))

    # ── 파일 보내기(20260930160000) — 유건 2026-09-30 "헤르메스 포함 외부 에이전트 … 파일 송수신" ────────────────
    async def _attach_target(self, chat_id: str, first_line: str, caption: bool = False, final: bool = False) -> int:
        """파일을 붙일 봇 글 id. 대화 → 그 요청의 답글(없으면 이 줄로 먼저 마감), 결재 재개 턴 → 후속 보고 글,
        final=False(대화 중 send_message 도구처럼 최종 답 전달이 아닌 호출 — metadata에 notify가 없다)는 원문 없음으로 본다: 그 요청의 답을
        파일 이름으로 먼저 닫으면 뒤에 오는 진짜 답이 거절된다(검수 M3).
        원문 없음(예약 작업·send_message) → 2분 안에 이 방에 쓴 봇 글(Hermes가 결과 글을 먼저 보낸 경우), 설명(caption)이 따로 왔거나 없으면 새 글.
        ponytail: '2분 안의 마지막 글'은 추정이다 — 그 사이 봇이 다른 글을 쓰면 거기 붙는다. Hermes가 결과 글 id를 넘겨주면 그것으로 바꾼다."""
        inbound = self._inbound.get() or {}
        same_chat = str((inbound.get('chat') or {}).get('id') or '') == str(chat_id)
        if same_chat and not final:   # 최종 답 전달이 아닌 호출: 이미 답한 요청이면 그 답글에 붙이기만 하고(대기열 경로의 파일은 notify 없이 온다 — 재검수 M3),
            src = inbound.get('message_id')   # 아직 답하지 않았으면 답을 닫지 않고 원문 없음으로 간다
            if src in self._reply_ids and not inbound.get('followup'):
                return self._reply_ids[src]
            inbound, same_chat = {}, False
        fu = str(inbound.get('followup') or '')
        if same_chat and fu:
            aid = fu[len(_FOLLOWUP_PREFIX):]
            if aid not in self._followup_ids:
                res = await self._post_followup(aid, first_line)
                if not res.success:
                    raise ArgoMsgrError(409, res.error or 'follow-up failed')
            if aid not in self._followup_ids:
                raise ArgoMsgrError(409, 'follow-up message id unknown')
            return self._followup_ids[aid]
        src = inbound.get('message_id') if same_chat else None
        if src is not None and src not in self._replied:
            res = await self.send(chat_id, first_line, metadata={'notify': True})
            if not res.success:
                raise ArgoMsgrError(409, res.error or 'reply failed')
        if src is not None and src in self._reply_ids:
            return self._reply_ids[src]
        last = self._posts.get(str(chat_id))
        if last and not caption and time.monotonic() - last[1] < 120:
            return last[0]
        res = await self._api('sendMessage', {'chat_id': str(chat_id), 'text': first_line[:_MAX_LEN]}, post=True) or {}
        mid = int(res.get('message_id') or 0)
        self._remember(self._posts, str(chat_id), (mid, time.monotonic()))
        return mid

    async def _notice(self, chat_id: str, text: str, final: bool = False) -> None:
        """파일 실패 안내 한 줄 — 아직 답하지 않은 대화면 그 답으로, 아니면 방에 봇 새 글로(한 원문에 답은 하나뿐이다)."""
        inbound = (self._inbound.get() or {}) if final else {}
        src = inbound.get('message_id') if str((inbound.get('chat') or {}).get('id') or '') == str(chat_id) else None
        try:
            if src is not None and src not in self._replied and not inbound.get('followup'):
                await self.send(chat_id, text, metadata={'notify': True})
            else:
                await self._api('sendMessage', {'chat_id': str(chat_id), 'text': text}, post=True)
        except Exception as e:
            logger.warning("Argo Messenger: file notice failed — %s", _redact(str(e)))

    async def _send_file(self, chat_id: str, path: str, caption: Optional[str] = None, file_name: Optional[str] = None, metadata=None) -> SendResult:
        final = bool((metadata or {}).get('notify'))   # Hermes 최종 답 전달(_final_thread_metadata)만 notify=True
        path = urllib.parse.unquote(path[7:]) if str(path).startswith('file://') else str(path)
        name = os.path.basename(file_name or path) or 'file'
        try:
            if not os.path.isfile(path):
                raise ArgoMsgrError(404, 'file not found')
            if os.path.getsize(path) > _ATTACH_MAX:
                raise ArgoMsgrError(413, 'files are limited to 25 MB')
            target = await self._attach_target(chat_id, (caption or '').strip() or ('📎 ' + name), bool((caption or '').strip()), final)
            res = await asyncio.to_thread(_upload_file, self.base_url, self.token, target, path, name)
        except Exception as e:
            logger.warning("Argo Messenger: file %s not sent — %s", name, _redact(str(e)))
            await self._notice(chat_id, _file_error_text(name, e), final)
            return SendResult(success=False, error=_redact(str(e))[:300])
        logger.info("Argo Messenger: file %s attached to message %s (%s)", name, target, (res or {}).get('file_id'))
        return SendResult(success=True, message_id=str(target))

    async def send_document(self, chat_id: str, file_path: str, caption: Optional[str] = None, file_name: Optional[str] = None,
                            reply_to: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None, **kwargs) -> SendResult:
        return await self._send_file(chat_id, file_path, caption, file_name, metadata=metadata)

    async def send_image_file(self, chat_id: str, image_path: str, caption: Optional[str] = None, reply_to: Optional[str] = None,
                              metadata: Optional[Dict[str, Any]] = None, **kwargs) -> SendResult:
        return await self._send_file(chat_id, image_path, caption, metadata=metadata)

    async def send_video(self, chat_id: str, video_path: str, caption: Optional[str] = None, reply_to: Optional[str] = None,
                         metadata: Optional[Dict[str, Any]] = None, **kwargs) -> SendResult:
        return await self._send_file(chat_id, video_path, caption, metadata=metadata)

    async def send_voice(self, chat_id: str, audio_path: str, caption: Optional[str] = None, reply_to: Optional[str] = None,
                         metadata: Optional[Dict[str, Any]] = None, **kwargs) -> SendResult:
        return await self._send_file(chat_id, audio_path, caption, metadata=metadata)

    async def send_image(self, chat_id: str, image_url: str, caption: Optional[str] = None, reply_to: Optional[str] = None,
                         metadata: Optional[Dict[str, Any]] = None) -> SendResult:
        """로컬 이미지(file://)는 첨부로. 웹 주소 이미지는 내려받지 않고 주소를 글로 남긴다 — 어댑터가 받으면 내부 주소(클라우드 메타데이터 등)
        응답이 방에 올라갈 수 있다(검수 M1, Hermes extract_images의 <img src>는 확장자 조건이 없다)."""
        if str(image_url).startswith('file://'):
            return await self._send_file(chat_id, image_url, caption, metadata=metadata)
        return await self._send_file_link(chat_id, image_url, caption, metadata)

    async def _send_file_link(self, chat_id: str, url: str, caption: Optional[str], metadata=None) -> SendResult:
        text = (caption + '\n' + url) if caption else url
        if (metadata or {}).get('notify'):   # 최종 답으로 온 주소 — 아직 답하지 않은 요청이면 이 글이 답이다(Hermes 기본 send_image와 같다, 재검수 M2)
            res = await self.send(chat_id, text, metadata=metadata)
            if res.success or 'already has its final reply' not in str(res.error or ''):
                return res
        try:   # 주소는 첨부할 파일이 없으니 글 자체를 새로 쓴다(이미 답한 요청의 답글 id로 가면 아무것도 안 남는다)
            res = await self._api('sendMessage', {'chat_id': str(chat_id), 'text': text[:_MAX_LEN]}, post=True) or {}
        except Exception as e:
            return SendResult(success=False, error=_redact(str(e))[:300])
        mid = int(res.get('message_id') or 0)
        self._remember(self._posts, str(chat_id), (mid, time.monotonic()))
        return SendResult(success=True, message_id=str(mid or ''))

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        # 게이트웨이 _keep_typing이 2초마다 부른다(호출당 ~1.5초 상한). 서버가 org 토픽으로 typing을 방송해 앱이 '답변 중'을 그린다
        # (앱은 6초 안에 갱신이 없으면 지운다). 실패는 삼킨다 — 타이핑은 답변을 막을 이유가 못 된다. 구버전 서버(sendChatAction 404)도 무해.
        try:
            incoming = self._inbound.get()
            params = {"chat_id": str(chat_id), "action": "typing"}
            if incoming and str((incoming.get('chat') or {}).get('id')) == str(chat_id) and incoming.get('execution_attempt'):
                params.update(reply_to_message_id=incoming['message_id'], execution_attempt=incoming['execution_attempt'])
            await self._api("sendChatAction", params, post=True, timeout=1.5)
        except Exception:
            return None

    # ── 크루 계약 1-a: 예약 작업 미러·편집 ────────────────────────────────────
    def _load_rstate(self):
        try:
            self._rstate = json.loads(self._routines_file.read_text()) if self._routines_file.exists() else {}
        except Exception:
            self._rstate = {}
        self._rstate_saved = json.dumps(self._rstate, sort_keys=True)

    def _save_rstate(self):
        blob = json.dumps(self._rstate, sort_keys=True)
        if blob == getattr(self, '_rstate_saved', None):
            return   # 바뀐 게 없으면 파일도 쓰지 않는다(검수 L-11)
        self._rstate_saved = blob
        self._routines_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = self._routines_file.with_suffix('.' + uuid.uuid4().hex + '.tmp')
        with open(tmp, 'x', opener=lambda path, flags: os.open(path, flags, 0o600)) as out:
            json.dump(self._rstate, out)
        os.replace(tmp, self._routines_file)

    async def _routines_loop(self) -> None:
        self._load_rstate()
        while self._running:
            try:
                await self._report_status()
            except asyncio.CancelledError:
                raise
            except Exception as e:   # 보고는 표시용 — 실패해도 미러는 계속
                logger.warning("Argo Messenger: reportStatus failed — %s", _redact(str(e)))
            try:
                await self._sync_routines()
            except asyncio.CancelledError:
                raise
            except ArgoMsgrError as e:
                logger.warning("Argo Messenger: setRoutines %s", e)
            except Exception as e:
                logger.warning("Argo Messenger: routine mirror failed — %s", _redact(str(e)))
            await asyncio.sleep(_ROUTINES_EVERY_S)

    async def _sync_routines(self, force: bool = False) -> None:
        cj = _hermes_cron()
        if cj is None:   # 조용히 빠지지 않는다(설계 L7) — 사유가 바뀔 때만 한 번 보고, 행은 건드리지 않는다
            reason = 'This Hermes version does not expose cron.jobs (list/update/pause/resume/remove)'
            if self._unsupported_sent != reason:
                await self._api('setRoutines', {'unsupported': reason}, post=True)
                self._unsupported_sent = reason
            return
        jobs = await asyncio.to_thread(cj.list_jobs, True)   # 읽기 실패는 예외 → 빈 스냅샷을 보내지 않는다(L6)
        now = datetime.datetime.now(datetime.timezone.utc)
        tz, mirror_all, resolve = _hermes_tz(), self._mirror_all or os.getenv('ARGO_MSGR_MIRROR_ALL', '').strip() == '1', _hermes_delivery_resolver()
        rows, seen = [], set()
        for job in jobs or []:
            jid = str(job.get('id') or '')
            if not jid:
                continue
            seen.add(jid)
            st = self._rstate.setdefault(jid, {})
            fp = job_fingerprint(job)
            if st.get('fp') and st['fp'] != fp:
                st['changed_at'] = now.isoformat()   # 사람이 고친 시각(메신저 편집 반영 포함 — Argo editedAt과 같은 뜻)
            st['fp'] = fp
            row = job_to_row(job, tz, st, mirror_all, now, resolve)
            if row is None:
                continue
            if row['status'] != (st.get('status_sent') or {}).get('value'):
                st['status_sent'] = {'value': row['status'], 'at': now.isoformat()}
            rows.append(row)
        for gone in set(self._rstate) - seen:
            self._rstate.pop(gone, None)
        self._save_rstate()
        digest = hashlib.sha256(json.dumps(rows, sort_keys=True, default=str).encode()).hexdigest()
        if not force and digest == self._routines_sent and (now.timestamp() - self._routines_sent_at) < _ROUTINES_RESEND_S:
            return   # 바뀐 게 없으면 네트워크 호출도 없다
        res = await self._api('setRoutines', {'rows': rows}, post=True) or {}
        self._unsupported_sent = None
        for row in rows:   # 서버(메신저)가 지금 보고 있는 지문 — 편집 판정의 기준
            st = self._rstate.get(row['ext_id'])
            if st is not None:
                st['fp_sent'] = st.get('fp')
        self._save_rstate()
        # 서버 행 수가 다르면(재활성·서버에서 지워짐 등) 다음 주기에 다시 보낸다(M1)
        self._routines_sent = digest if int(res.get('total', len(rows))) == len(rows) else None
        self._routines_sent_at = now.timestamp()

    async def _apply_routine_edit(self, ev) -> None:
        cj = _hermes_cron()
        status, err = 'failed', None
        try:
            if cj is None:
                raise RuntimeError('cron API unavailable')
            jid = str(ev.get('ext_id') or '')
            job = next((j for j in (await asyncio.to_thread(cj.list_jobs, True) or []) if str(j.get('id')) == jid), None)
            verdict = decide_routine_edit(job, self._rstate.get(jid))
            patch = ev.get('patch') or {}
            route_only = ev.get('op') == 'update' and set(patch) == {'channel_id'}
            resolve = _hermes_delivery_resolver()
            if verdict == 'failed':
                err = 'routine_not_found'
            elif job_msgr_channel(job, resolve) is None and not (route_only and job_delivery(job, resolve) == 'none'):
                err = 'not_editable'   # 서버도 막지만 어댑터가 한 번 더(메신저 전달 작업만 고치고, 보낼 곳 없는 작업은 방 지정만)
            elif verdict == 'superseded':
                status = 'superseded'
            else:
                if ev.get('op') == 'delete':
                    await asyncio.to_thread(cj.remove_job, jid)
                else:
                    updates = {}
                    if isinstance(patch.get('title'), str):
                        updates['name'] = patch['title']
                    if isinstance(patch.get('prompt'), str):
                        updates['prompt'] = patch['prompt']
                    if isinstance(patch.get('schedule'), dict):
                        expr = msgr_to_cron_string(patch['schedule'])
                        if not expr:
                            raise ValueError('schedule not representable in Hermes cron')
                        updates['schedule'] = expr
                    if 'channel_id' in patch:   # 1-b ③: 소유자가 고른 방으로 결과를 보낸다
                        if not _uuid_like(patch.get('channel_id')):
                            raise ValueError('channel_id must be a channel id')
                        updates['deliver'] = 'argo_msgr:' + str(patch['channel_id'])
                    if updates:
                        await asyncio.to_thread(cj.update_job, jid, updates)
                    if patch.get('enabled') is False:
                        await asyncio.to_thread(cj.pause_job, jid, 'Argo Messenger')
                    elif patch.get('enabled') is True:
                        await asyncio.to_thread(cj.resume_job, jid)
                    after = next((j for j in (await asyncio.to_thread(cj.list_jobs, True) or []) if str(j.get('id')) == jid), None)
                    if after is not None:   # 메신저 편집을 반영한 변경은 "사람이 로컬에서 고친 것"이 아니다 — 기준 지문을 옮긴다
                        st = self._rstate.setdefault(jid, {})
                        st['fp'] = st['fp_sent'] = job_fingerprint(after)
                        st['changed_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
                status = 'applied'
        except Exception as e:
            err = _redact(str(e))[:300]
        try:
            await self._api('routineEditDone', {'edit_id': ev.get('edit_id'), 'status': status, 'error': err}, post=True)
        finally:
            await self._sync_routines(force=True)   # done이 실패해도(더 새 편집이 접은 경우 등) 반영 결과는 바로 미러

    # ── 크루 계약 1-a: 위험 명령 → 결재 카드 ─────────────────────────────────
    def _parent_for(self, session_key) -> Optional[str]:
        sk = str(session_key)
        if sk in self._resume_parent and datetime.datetime.now().timestamp() - self._resume_parent_at.get(sk, 0) > 1800:
            self._resume_parent.pop(sk, None); self._resume_parent_at.pop(sk, None)
        return self._resume_parent.get(sk)

    def _source_for_session(self, session_key) -> Optional[Dict[str, Any]]:
        """승인 대기는 에이전트 스레드에서 오므로 ContextVar가 없다 — 그 세션이 처리 중인 원문(검수 M-3: 채팅 단위로 고르면 다른 원문에 붙는다)."""
        mid = self._session_src.get(str(session_key))
        m = self._pending.get(mid) if mid is not None else None
        return m if m and m.get('execution_attempt') and mid not in self._replied else None

    def _match_request_id(self, session_key, command) -> Optional[str]:
        """이 카드가 풀 Hermes 승인 요청 — 명령이 같고 아직 다른 카드에 묶이지 않은 요청이 정확히 하나일 때만(검수 H-1: 병렬 승인에서 뒤바뀜 방지)."""
        try:
            from tools.approval import list_gateway_approvals
        except Exception:
            return None
        try:
            from gateway.run import _redact_approval_command as shown
        except Exception:
            shown = lambda c: str(c or '')
        used = {v.get('request_id') for v in self._approvals.values()}
        try:
            cands = [e.get('request_id') for e in list_gateway_approvals(session_key)
                     if e.get('request_id') and e.get('request_id') not in used and shown(e.get('command')) == command]
        except Exception:
            return None
        return cands[0] if len(cands) == 1 else None

    async def _send_exec_approval_prompt(self, prompt) -> SendResult:
        m = self._source_for_session(prompt.session_key)
        parent = None if m else self._parent_for(prompt.session_key)
        rid = self._match_request_id(prompt.session_key, prompt.command) if (m or parent) else None
        if parent and rid:   # 재개 턴 — 실행 행이 없으니 승인된 부모 결재의 원문에 카드를 붙인다(검수 M-3)
            approval_id = 'hx-' + uuid.uuid4().hex[:24]
            self._approvals[approval_id] = {'session_key': prompt.session_key, 'request_id': rid, 'card': None}
            try:
                res = await self._api('requestApproval', {'parent_approval_id': parent, 'approval_id': approval_id,
                                                          'command': prompt.command, 'reason': prompt.description}, post=True) or {}
            except Exception as e:
                self._approvals.pop(approval_id, None)
                return SendResult(success=False, error=getattr(e, 'description', None) or _redact(str(e)))
            self._approvals[approval_id]['card'] = str(res.get('message_id') or '')
            return SendResult(success=True, message_id=self._approvals[approval_id]['card'] or None)
        if not m or not rid:   # 원문이나 풀 요청을 하나로 정하지 못하면 Hermes의 기존 /approve 글자 안내로 넘긴다(지금보다 나빠지지 않게)
            return SendResult(success=False, error="No unique Argo execution/approval request for this prompt")
        approval_id = 'hx-' + uuid.uuid4().hex[:24]
        self._approvals[approval_id] = {'session_key': prompt.session_key, 'request_id': rid, 'card': None}   # HTTP 전에 예약(동시 카드가 같은 요청을 못 고르게)
        try:
            res = await self._api('requestApproval', {'execution_attempt': m['execution_attempt'], 'approval_id': approval_id,
                                                      'command': prompt.command, 'reason': prompt.description}, post=True) or {}
        except ArgoMsgrError as e:
            self._approvals.pop(approval_id, None)
            return SendResult(success=False, error=e.description)
        except Exception as e:
            self._approvals.pop(approval_id, None)
            return SendResult(success=False, error=_redact(str(e)))
        card = str(res.get('message_id') or '')
        self._approvals[approval_id]['card'] = card
        return SendResult(success=True, message_id=card or None)

    async def _on_approval_decided(self, ev) -> None:
        aid = str(ev.get('approval_id') or '')
        ack = await self._api('ackApproval', {'approval_id': aid}, post=True) or {}
        if ev.get('agent'):
            with self._agent_lock:
                info = self._agent_approvals.pop(aid, None)
            self._save_agent_approvals()
            if ack.get('claimed'):   # 바쁜 세션을 기다리는 동안 폴 루프(모든 채널 수신)를 막지 않게 따로 돌린다(검수 M-2)
                task = asyncio.create_task(self._resume_agent_approval(aid, ev, info))
                self._tasks.add(task)
                task.add_done_callback(self._tasks.discard)
            return
        info = self._approvals.pop(aid, None)
        if not ack.get('claimed'):   # 선점 못 했으면(다른 어댑터·재시도) 재개하지 않는다
            return
        late = not info or not info.get('request_id')   # 재시작 뒤라 대기 스레드가 이미 없다
        if not late:
            choice = 'once' if ev.get('status') == 'approved' and ev.get('resume') else 'deny'
            reason = None if choice == 'once' else 'Argo Messenger: ' + str(ev.get('reason') or ev.get('status') or 'rejected')
            from tools.approval import resolve_gateway_approval
            late = not resolve_gateway_approval(info['session_key'], choice, reason=reason, request_id=info['request_id'])
        if late and ev.get('status') == 'approved' and ev.get('resume'):
            # 에이전트가 이미 기다리기를 멈췄다(Hermes 기한 5분 초과·중단·재시작) — 카드는 승인됐지만 명령은 실행되지 않았다. 결정한 사람에게 알린다(1-a L-12 후속)
            logger.warning("Argo Messenger: approval %s decided after the agent stopped waiting — command was not run", aid)
            await self._post_followup(aid, '결정이 늦게 도착해 명령은 실행되지 않았습니다(에이전트의 승인 대기 시간이 지났습니다). 필요하면 다시 요청해 주세요.\n'
                                           '/ The decision arrived after the agent stopped waiting, so the command was not run. Ask again if it is still needed.')

    # ── 1-b: 에이전트가 올리는 결재 → 결정 뒤 같은 대화에서 재개 → 후속 보고 ─────────────────────
    def _load_agent_approvals(self):
        try:
            self._agent_approvals = json.loads(self._agent_file.read_text()) if self._agent_file.exists() else {}
        except Exception:
            self._agent_approvals = {}

    def _save_agent_approvals(self):
        try:
            with self._agent_lock:
                snapshot = json.dumps(self._agent_approvals)
            self._agent_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            tmp = self._agent_file.with_suffix('.' + uuid.uuid4().hex + '.tmp')
            with open(tmp, 'x', opener=lambda path, flags: os.open(path, flags, 0o600)) as out:
                out.write(snapshot)
            os.replace(tmp, self._agent_file)
        except Exception as e:
            logger.warning("Argo Messenger: agent approvals not saved — %s", _redact(str(e)))

    def request_agent_approval(self, session_key: str, title: str, reason: Optional[str], message_id: str = '') -> Dict[str, Any]:
        """결재 도구(에이전트 스레드에서 동기 호출). 이 턴이 처리 중인 원문에 결재 카드를 붙인다.
        원문은 그 턴의 메시지 id(HERMES_SESSION_MESSAGE_ID)로 정한다 — 그룹 채널은 모든 글이 한 세션이라 세션 단위로 고르면 뒤에 온
        다른 사람의 글에 붙는다(OpenClaw 검수 H2와 같은 위험). 재개 턴은 id가 'apf:<부모 결재>'라 부모를 바로 안다."""
        mid = str(message_id or '')
        if mid.startswith(_FOLLOWUP_PREFIX):
            m, parent = None, mid[len(_FOLLOWUP_PREFIX):]
        elif mid.isdigit():
            cand = self._pending.get(int(mid))
            m, parent = (cand if cand and cand.get('execution_attempt') and int(mid) not in self._replied else None), None
        else:
            m = self._source_for_session(session_key)
            parent = None if m else self._parent_for(session_key)
        skw = self._session_source.get(str(session_key))
        if not (m or parent) or not skw:
            raise ArgoMsgrError(409, 'No active Argo Messenger request in this conversation — approvals attach to the message you are answering')
        aid = 'ag-' + uuid.uuid4().hex[:24]
        where = {'execution_attempt': m['execution_attempt']} if m else {'parent_approval_id': parent}   # 재개 턴이면 승인된 부모 결재의 원문(검수 M-3)
        res = _call(self.base_url, self.token, 'requestApproval', {'kind': 'agent', **where, 'approval_id': aid,
                                                                   'title': title, 'reason': reason}, post=True) or {}
        with self._agent_lock:
            self._agent_approvals[aid] = {'session_key': str(session_key), 'source': skw, 'title': title}
        self._save_agent_approvals()
        return {'approval_id': aid, 'status': res.get('status', 'pending'), 'card_message_id': res.get('message_id')}

    async def _post_followup(self, aid: str, content: str) -> SendResult:
        if aid in self._followed:
            return SendResult(success=False, error="This approval already has its follow-up")
        try:
            res = await self._api('sendMessage', {'approval_id': aid, 'text': followup_text(content)[:_MAX_LEN]}, post=True) or {}
        except ArgoMsgrError as e:
            logger.warning("Argo Messenger: follow-up for %s failed — %s", aid, e)
            return SendResult(success=False, error=e.description)
        except Exception as e:
            return SendResult(success=False, error=_redact(str(e)))
        self._followed.add(aid)
        if res.get('message_id'):
            self._remember(self._followup_ids, aid, int(res['message_id']))
        for sk, parent in list(self._resume_parent.items()):   # 후속 보고를 올렸으면 그 재개 턴은 끝났다(서버도 더 이상 이어서 받지 않는다)
            if parent == aid:
                self._resume_parent.pop(sk, None)
        return SendResult(success=True, message_id=str(res.get('message_id') or ''))

    async def _resume_agent_approval(self, aid: str, ev, info) -> None:
        status, who = ev.get('status'), ev.get('decided_by_name') or 'the approver'
        if status == 'approved' and not ev.get('resume'):
            return   # 서버 재판정 실패(동의 철회·전달 불가 등) — 이어서 할 수도, 보고할 수도 없다(후속 보고도 서버가 거절)
        if status not in ('approved', 'rejected'):
            return
        if not info or not info.get('source'):   # 재시작 등으로 원래 대화를 잃었다 — 사람에게 알리고 끝낸다
            await self._post_followup(aid, ('결재가 승인됐습니다. 이어서 진행하려면 이 대화에서 다시 말씀해 주세요.\n/ Approved — ask again here to continue.')
                                      if status == 'approved' else '결재가 반려되어 진행하지 않습니다.\n/ Rejected — not proceeding.')
            return
        title = info.get('title') or ev.get('action') or ''
        text = ((f'[Argo Messenger — approval decided] Your approval request "{title}" was APPROVED by {who}. '
                 'Carry out the approved work now and report the result. Your reply is posted as the follow-up on the approval card.')
                if status == 'approved' else
                (f'[Argo Messenger — approval decided] Your approval request "{title}" was REJECTED by {who}. '
                 'Do not carry out that work. Reply briefly to acknowledge; your reply is posted as the follow-up on the approval card.'))
        source = self.build_source(**info['source'], role_authorized=True)
        sk = info.get('session_key')
        for _ in range(30):   # 세션에 대기 메시지가 있으면 internal 이벤트는 조용히 버려진다(Hermes base.py) — 비면 넣는다
            if not sk or sk not in getattr(self, '_pending_messages', {}):
                break
            await asyncio.sleep(10)
        else:
            await self._post_followup(aid, '결재 결과를 에이전트에게 전달하지 못했습니다(대화가 계속 바쁩니다). 이어서 진행하려면 다시 말씀해 주세요.\n'
                                           '/ Could not hand the decision to the agent (conversation stayed busy). Ask again to continue.')
            return
        if sk:
            self._resume_parent[sk] = aid if status == 'approved' else self._resume_parent.get(sk, '')
            self._resume_parent_at[sk] = datetime.datetime.now().timestamp() if status == 'approved' else self._resume_parent_at.get(sk, 0)
            self._session_source.setdefault(sk, info['source'])   # 재시작 뒤 재개여도 이 턴의 새 결재가 같은 대화로 이어지게
            if not self._resume_parent[sk]:
                self._resume_parent.pop(sk, None)
        context = self._inbound.set({'followup': _FOLLOWUP_PREFIX + aid, 'chat': {'id': info['source'].get('chat_id')}})
        try:
            await self.handle_message(MessageEvent(text=text, message_type=MessageType.TEXT, source=source, message_id=_FOLLOWUP_PREFIX + aid,
                                                   internal=True, allow_gateway_control=False, metadata={'gateway_session_key': sk} if sk else {}))
        finally:
            self._inbound.reset(context)

    # ── 1-b: 버전·승인 모드 보고, "모든 예약 작업 보기" 설정 ────────────────────────────
    async def _report_status(self) -> None:
        try:
            from tools.approval_context import _get_approval_mode
            mode = str(_get_approval_mode() or 'unknown')
        except Exception:
            mode = 'unknown'
        try:   # 프로세스 전체 --yolo(HERMES_YOLO_MODE)면 설정과 관계없이 묻지 않고 실행한다(검수 LOW). 세션 단위 /yolo는 대화마다라 보고하지 않는다
            import tools.approval as _ap
            if getattr(_ap, '_YOLO_MODE_FROZEN', False):
                mode = 'off'
        except Exception:
            pass
        cur = (_PLUGIN_VERSION or 'unknown', mode, self._mirror_all)
        if cur == self._status_sent:
            return   # 바뀐 게 없으면 네트워크 호출도 없다
        res = await self._api('reportStatus', {'version': cur[0], 'approval_mode': cur[1], 'mirror_all_applied': cur[2]}, post=True) or {}
        self._status_sent = cur
        await self._apply_mirror_all(bool(res.get('mirror_all')))

    async def _apply_mirror_all(self, on: bool) -> None:
        if on == self._mirror_all:
            return
        self._mirror_all = on
        await self._sync_routines(force=True)
        await self._report_status()   # 반영했다고 알린다(서버가 설정 이벤트를 그만 준다)

    async def _handle_event(self, ev) -> None:
        kind = ev.get('event')
        if kind == 'routine_edit':
            await self._apply_routine_edit(ev)
        elif kind == 'approval_decided':
            await self._on_approval_decided(ev)
        elif kind == 'config':
            await self._apply_mirror_all(bool(ev.get('mirror_all')))

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
    paths = [str(d[0] if isinstance(d, (list, tuple)) else d) for d in (media_files or [])]
    text = str(message or '').strip() or ('📎 ' + ', '.join(os.path.basename(p) for p in paths))
    try:
        res = await asyncio.to_thread(_call, base, token, "sendMessage", {"chat_id": str(chat_id), "text": text[:_MAX_LEN]}, post=True)
        mid = int((res or {}).get("message_id") or 0)
        failed = []
        for p in paths:   # 예약 작업(게이트웨이 밖 크론)이 만든 파일 — 방금 쓴 결과 글에 붙인다
            try:
                await asyncio.to_thread(_upload_file, base, token, mid, p)
            except Exception as e:
                failed.append(_file_error_text(os.path.basename(p), e))
        if failed:
            await asyncio.to_thread(_call, base, token, "sendMessage", {"chat_id": str(chat_id), "text": '\n'.join(failed)[:_MAX_LEN]}, post=True)
        return {"success": True, "message_id": str(mid or "")}
    except ArgoMsgrError as e:
        return {"error": e.description}
    except Exception as e:
        return {"error": _redact(str(e))}


_APPROVAL_TOOL = 'argo_request_approval'
_APPROVAL_SCHEMA = {
    'name': _APPROVAL_TOOL,
    'description': ('Ask a human in Argo Messenger to approve something before you do it (spending, sending messages to outsiders, '
                    'deleting or changing important data, anything you were told needs approval). Posts an approval card on the message '
                    'you are answering. The decision arrives later in this same conversation, then you continue and report. After calling it, '
                    'tell the person you requested approval and end your turn — do not do the work until approved.'),
    'parameters': {'type': 'object', 'properties': {
        'title': {'type': 'string', 'description': 'What needs approval, one short line (e.g. "Spend $400 on this week\'s ads")'},
        'reason': {'type': 'string', 'description': 'Why, and what will happen once approved (optional)'}},
        'required': ['title']},
}


def _approval_tool(args=None, **_kw) -> str:
    args = args or {}
    try:
        from gateway.session_context import get_session_env
        platform, session_key = get_session_env('HERMES_SESSION_PLATFORM'), get_session_env('HERMES_SESSION_KEY')
        message_id = get_session_env('HERMES_SESSION_MESSAGE_ID')
    except Exception:
        platform, session_key, message_id = '', '', ''
    if platform != 'argo_msgr' or _ADAPTER is None:
        return json.dumps({'error': 'argo_request_approval works only in Argo Messenger conversations'}, ensure_ascii=False)
    title = str(args.get('title') or '').strip()
    if not title:
        return json.dumps({'error': 'title is required'}, ensure_ascii=False)
    try:
        out = _ADAPTER.request_agent_approval(session_key, title[:300], (str(args.get('reason')).strip()[:1000] or None) if args.get('reason') else None, message_id)
    except ArgoMsgrError as e:
        return json.dumps({'error': e.description}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({'error': _redact(str(e))[:300]}, ensure_ascii=False)
    return json.dumps({'ok': True, **out, 'next': 'Approval card posted. Tell the person you requested approval and end this turn. '
                       'The decision will arrive in this conversation; only then continue.'}, ensure_ascii=False)


def register(ctx):
    global _PLUGIN_VERSION
    _PLUGIN_VERSION = str(getattr(getattr(ctx, 'manifest', None), 'version', '') or '')
    if not _PLUGIN_VERSION:   # 옛 Hermes(manifest 없음) — plugin.yaml에서 직접
        try:
            hit = re.search(r'^version:\s*([^\s#]+)', Path(__file__).with_name('plugin.yaml').read_text(), re.M)
            _PLUGIN_VERSION = hit.group(1) if hit else ''
        except Exception:
            pass
    if callable(getattr(ctx, 'register_tool', None)):
        ctx.register_tool(name=_APPROVAL_TOOL, toolset='argo_msgr', schema=_APPROVAL_SCHEMA, handler=_approval_tool,
                          description=_APPROVAL_SCHEMA['description'], emoji='✅')
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
            "Markdown is supported. Answer in the language the person used (usually Korean); keep it concise. "
            "Scheduled jobs you create with deliver=argo_msgr appear automatically in the messenger's Automation panel, "
            "where the owner can pause or edit them; dangerous commands you run are shown to the owner as approval cards. "
            "When something needs a person's approval before you act, call argo_request_approval, then end your turn; "
            "the decision comes back in the same conversation. "
            "Files people attach are saved locally and listed with their paths. To send a file back, include it in your reply "
            "the usual way (a MEDIA: path) — it is attached to your reply, up to 25 MB per file."))
