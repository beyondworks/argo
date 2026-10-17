// 메신저 v2 연결(U5)의 순수 규칙 — 재연결 간격, 서버 오류 → 약속 거부 코드, 최소 버전, 따라잡기 응답 정리.
// 설계 정본: 볼트 AI-Sessions/conversations/argo/2026-10-17-argo-messenger-redesign-design.md 4절(실시간)·5절(안전장치)·7절 경우 5·10·11·19.
// 약속 정본: packages/agent-link/contract/v1.mjs — 다시 보낼지는 REJECT_CODES[code].retry만 본다(rate_limited·internal만 참).
// 이 파일은 네트워크·시계·저장소를 모른다(시험에서 그대로 부른다). 화면 문자열은 없다 — 상태 코드만 낸다(문구는 U6 i18n).
import { REJECT_CODES, TOPICS } from '../../../../packages/agent-link/contract/v1.mjs';
import { cmpVersion } from '../../../../src/version-compare.mjs';
import { isNetworkFailure } from '../../../../src/net-errors.mjs';

/** 서버 이름의 자리 — U1·U2·U3가 정하는 RPC·표·토픽 이름은 여기 한 곳에서만 쓴다(맞출 때 이 표만 고친다). */
export const NAMES = Object.freeze({
  minVersionRpc: 'argo_min_app_version', // 20261013190000 — p_app = 'messenger'
  pauseRpc: 'msgr2_service_pause', // v2 중단 스위치 읽기(옛 msgr_service_pause와 같은 모양: 켜짐 {paused:true, since}, 꺼짐 null)
  registerRpc: 'msgr2_device_register', // 설계 5절(U3)
  catchUpRpc: 'msgr2_catch_up', // 설계 4절 — (since_id) → 방별 최근 200개 + 더 있음
  messages: 'msgr2_messages', // U1 — 사람 글은 표에 직접 insert(RLS), (room_id, client_msg_id) 유일
  attachments: 'msgr2_attachments', // U1(사람은 직접 넣지 못한다 — 아래 attachmentAddRpc)
  attachmentAddRpc: 'msgr2_attachment_add', // U2 — (p_message, p_index, p_name, p_mime, p_bytes) → { attachment_id, bucket, path, existing }. 이 path에만 올릴 수 있다(U2b Storage 정책)
  bucket: 'msgr', // 첨부 Storage 버킷(옛 경로 유지 — 설계 1-2)
  userTopic: TOPICS.user, // v2:u:<uid> — 옛 u: 토픽과 겹치지 않게(약속 v1 TOPICS, 검수 #1076)
  workTopic: TOPICS.work, // v2:wk:<work>
  spaceTopic: TOPICS.space, // v2:s:<space> — 사람이 많은 팀 open 방의 글은 이 토픽 한 번으로 온다(U2b)
  presenceTopic: (owner) => `pr:${owner}`,
});

/** u:<uid> 방송 event 이름(Realtime이 소문자로 비교한다). 서버(U2·U3)가 같은 이름으로 보낸다. 그 밖의 event는 화면에 그대로 넘긴다. */
export const USER_EVENTS = Object.freeze({
  message: 'msg', // 새 글 — payload.message(또는 payload 자체)가 글 행. 본문 4KB 초과면 body 없이 id만(그때만 1회 조회)
  pause: 'pause', // v2 중단 스위치 — { paused: boolean }
  deviceRevoked: 'device_revoked', // 기기 폐기 — { device_id } 또는 { all: true }(사용자 폐기 세대)
});

/** 상태 코드(화면은 U6이 이 값으로 그린다). */
export const STATES = Object.freeze({
  idle: 'idle', // 아직 start 전
  disconnected: 'disconnected', // 끊김(재연결 대기 또는 포기)
  connecting: 'connecting', // 최소 버전·중단 확인
  registering: 'registering', // msgr2_device_register
  subscribing: 'subscribing', // u:<uid> 가입
  catchingUp: 'catching_up', // msgr2_catch_up 1회
  ready: 'ready', // 정상 — 유휴 요청 0
  background: 'background', // 앱이 뒤로 감 — 소켓 닫힘, 요청 0
  paused: 'paused', // 서버 중단 스위치 — 조회·보내기 0
  updateRequired: 'update_required', // 최소 버전 미만 — 등록하지 않는다
  signedOut: 'signed_out', // 기기 폐기 — 소켓 닫힘, 요청 0
});
export const TERMINAL_STATES = Object.freeze([STATES.updateRequired, STATES.signedOut]);

export const RECONNECT = Object.freeze({ baseMs: 1000, maxMs: 60_000, maxAttempts: 8 });
export const SEND_RETRY = Object.freeze({ baseMs: 2000, maxMs: 30_000, maxAttempts: 5 });
export const REGISTER_EVERY_MS = 24 * 3600_000; // 오래 켜 둔 데스크톱: 하루 지났을 때만 다시 등록(서버 만료 30일, 서버도 1일 이상일 때만 쓴다)
export const CATCH_UP_PER_ROOM = 200;
export const SEEN_CAP = 5000; // 중복 거르기용으로 기억하는 글 id 수

/**
 * n번째(0부터) 재시도까지 기다릴 시간. 지수 증가 + 상한, 반쯤 흔들기(같은 순간에 끊긴 기기들이 한꺼번에 붙지 않게).
 * random()은 [0,1). 상한(maxMs)을 넘지 않는다.
 */
export function backoffDelay(n, { baseMs, maxMs } = RECONNECT, random = Math.random) {
  const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, n));
  return Math.min(maxMs, Math.round(raw * (0.5 + 0.5 * random())));
}

/** 이 버전이 최소 버전보다 낮은가. 최소 버전이 없거나 앱 버전을 모르면(0.0.0 포함) 거짓 — 비교할 수 없는데 막으면 최신 앱도 멈춘다(src/app-gate.mjs와 같은 판정). */
export function belowMin(version, min) {
  if (!min || typeof min !== 'string') return false;
  if (!version || cmpVersion(version, '0.0.0') === 0) return false;
  return cmpVersion(version, min) < 0;
}

// 약속 밖이지만 앱이 따로 다루는 서버 표지. 업데이트 요구는 등록 RPC의 거부(설계 D10), 기기 무효는 U1 자리 함수의 오류 이름이다.
const UPDATE_MARKS = ['app_version_unsupported', 'app_update_required', 'min_app_version'];
// U3 등록이 "다시 로그인"을 뜻하는 거부(…_msgr2_device.sql 124·161·182·183줄) — 재시도로 풀리지 않는다
const LOGIN_MARKS = ['device_login_required', 'msgr2_session_required', 'msgr2_device_kind_locked'];
const CONTRACT_CODES = Object.keys(REJECT_CODES).sort((a, b) => b.length - a.length);

/**
 * supabase-js 오류({ data, error, status } 또는 Storage 오류)를 거부 코드로 읽는다.
 * 반환: null(성공) | 'duplicate'(같은 client_msg_id·같은 파일이 이미 있음 = 성공) | 'update_required' | 'login_required' | 'invalid'(값 모양) | REJECT_CODES 키 | 'rejected'(모르는 거부 — 다시 보내지 않는다).
 */
export function rejectCodeOf(error, status, { storage = false } = {}) {
  if (!error) return null;
  const st = Number(status ?? error.status ?? error.statusCode ?? NaN);
  const text = [error.code, error.message, error.details, error.hint, error.error].filter((x) => x != null).join(' ');
  if (String(error.code) === '23505') return 'duplicate'; // (room_id, client_msg_id) 유일 — 같은 글이 이미 들어갔다
  // Storage는 같은 경로가 있으면 409. REST의 409는 외래 키 위반(23503)도 포함하므로 Storage일 때만 중복으로 읽는다
  if (storage && (st === 409 || /already exists|duplicate/i.test(String(error.message ?? '')))) return 'duplicate';
  if (UPDATE_MARKS.some((m) => text.includes(m))) return 'update_required';
  if (LOGIN_MARKS.some((m) => text.includes(m))) return 'login_required';
  if (text.includes('msgr2_device_invalid') && String(error.code) === '22023') return 'invalid'; // U3 등록의 값 모양 오류 — 기기 무효가 아니다
  for (const c of CONTRACT_CODES) if (text.includes(c)) return c;
  if (text.includes('msgr2_device_invalid')) return 'device_unknown'; // U1 자리 함수 — 폐기·만료·모름을 가르지 않는다. 다시 등록해 보고, 폐기면 등록이 device_revoked로 답한다
  if (st === 429) return 'rate_limited';
  if (st >= 500 || ['57014', '40001', '40P01', '53300', 'PGRST000', 'PGRST001'].includes(String(error.code))) return 'internal';
  if (st === 0 || isNetworkFailure(text) || error.name === 'StorageUnknownError') return 'internal'; // fetch 실패(오프라인·끊김) — postgrest-js는 status 0으로 돌려준다
  if (st === 413) return 'too_large';
  return 'rejected';
}

/** 다시 보낼 코드인가 — 약속의 retry 표시만 따른다(rate_limited·internal). */
export const retryable = (code) => REJECT_CODES[code]?.retry === true;

/** 기기 쪽 거부 — 폐기는 로그아웃, 모름·만료는 한 번 다시 등록해 본다. */
export const DEVICE_CODES = Object.freeze(['device_revoked', 'device_unknown', 'device_expired']);

/**
 * msgr2_catch_up 응답을 방별 묶음으로 정리한다.
 * 받는 모양: { rooms: [{ room_id, messages: [...], more }], paused? } 또는 글 행 배열(방마다 200개를 넘겨 주면 넘침 = 더 있음).
 * 반환: { rooms: [{ roomId, messages(id 오름차순, 최대 200), more }], paused: boolean, nextSince: number | null }.
 * nextSince(U2 next_since): 다음 따라잡기 기준. 서버가 "60초보다 오래된 글 중 최대 id"까지만 올린다 — 글 id 순서와 커밋 순서가 어긋나
 * 늦게 보이는 글을 빠뜨리지 않게. 최근 글은 다음 따라잡기에서 다시 오고 받는 쪽이 id로 거른다. 옛 서버(값 없음)면 null.
 */
export function normalizeCatchUp(data, perRoom = CATCH_UP_PER_ROOM) {
  const out = new Map();
  const put = (roomId, msgs, more) => {
    if (!roomId) return;
    const cur = out.get(roomId) || { roomId, messages: [], more: false };
    cur.messages.push(...msgs.filter((m) => m && m.id != null));
    cur.more = cur.more || !!more;
    out.set(roomId, cur);
  };
  if (Array.isArray(data)) {
    const by = new Map();
    for (const m of data) { if (!m?.room_id) continue; (by.get(m.room_id) || by.set(m.room_id, []).get(m.room_id)).push(m); }
    for (const [r, msgs] of by) put(r, msgs, false);
  } else if (data && Array.isArray(data.rooms)) {
    for (const r of data.rooms) put(r?.room_id ?? r?.roomId, Array.isArray(r?.messages) ? r.messages : [], r?.more);
  }
  const rooms = [...out.values()].map((r) => {
    const sorted = r.messages.sort((a, b) => Number(a.id) - Number(b.id));
    const over = sorted.length > perRoom;
    return { roomId: r.roomId, messages: over ? sorted.slice(-perRoom) : sorted, more: r.more || over };
  });
  const ns = data && !Array.isArray(data) && data.next_since != null ? Number(data.next_since) : NaN; // null은 값 없음(0으로 읽으면 기준이 처음으로 돌아간다)
  return { rooms, paused: !!(data && !Array.isArray(data) && data.paused), nextSince: Number.isSafeInteger(ns) && ns >= 0 ? ns : null };
}

/** 등록 응답에서 기기 id를 꺼낸다(uuid 문자열 또는 { device_id } / { id }). */
export const deviceIdOf = (data) => (typeof data === 'string' ? data : data?.device_id ?? data?.id ?? null);

/** 중단 표지 읽기 — msgr2_service_pause() 응답(null = 꺼짐) 또는 u: 방송 payload. */
export const pausedOf = (data) => !!(data && (data === true || data.paused === true));

/**
 * (옛) Storage 경로 — 클라이언트가 정하던 경로. v2 서버(U2b)는 msgr2_attachment_add가 돌려준 경로에만 쓰기를 허용하므로 보내기는 더 쓰지 않는다.
 * 옛 판 시험·도구가 부를 수 있어 남긴다.
 */
export function uploadPath(roomId, clientMsgId, index, name) {
  const safe = String(name || 'file').normalize('NFC').replace(/[\\/\u0000-\u001f]/g, '_').slice(-120) || 'file';
  return `${roomId}/${clientMsgId}/${index}-${safe}`;
}
