// 메신저 A+ '사람' 탭 화면 판단(2026-10-20 유건: 사람 채팅까지 넣고 한 번에 공개) — 순수 모듈(React·Supabase 없음, test/aplus-people.test.mjs가 잠근다).
// 사람 = 팀 공간 · 채널 · 사람 1:1 · 초대 보내기/받기 · 멤버 목록 + 첨부(사람 글·에이전트 글). 사람 채팅도 Pro 전용이고 최종 판정은 서버 거부 코드다.
// 서버 계약(2026-10-20 'Argo M2 - 워커'): 무료인 내가 쓰면 msgr2_pro_required(초대 수락 포함 — 초대는 남아 Pro가 된 뒤 다시 수락),
// 무료인 상대를 바로 넣으면(1:1 열기·방에 넣기) msgr2_member_not_pro, 상한은 msgr2_limit + details, 서버 스위치가 꺼져 있으면 msgr2_lite_only.
// 첫 글 첨부는 기계가 files_expected + msgr2_message_ready로 맞춘다(link/machine.mjs). 옮겨 온 방 표지는 서버에 없다(방 id = 옛 채널 id인 일반 방).
import { attachmentProblem, ATTACH_LIMITS } from '../link/policy.mjs';
import { notOpenYet } from './model.mjs';

export const NAME_MAX = 60;
export { ATTACH_LIMITS };

const ERR = ['msgr2_pro_required', 'msgr2_member_not_pro', 'msgr2_lite_only', 'msgr2_invite_not_found', 'msgr2_invite_rejoin_direct_only', 'msgr2_dm_blocked', 'invalid_attachment'];
/** 사람 탭 서버 거부 → 사전 키(people.err.*) | null. 메시지 안에 코드가 들어 있어도 찾는다(PostgREST message = 예외 이름). */
export const LIMIT_DETAILS = Object.freeze(['space_members', 'room_members', 'user_messages', 'room_messages', 'invites_day']); // 서버 msgr2_limit(22023)의 details — 다시 보내지 않는 거부
export function peopleErrorKey(e) {
  const detail = typeof e === 'object' ? (e?.details ?? e?.detail ?? null) : null;
  const text = typeof e === 'string' ? e : `${e?.code ?? ''} ${e?.message ?? ''}`;
  if (/\bmsgr2_limit\b/.test(text) || (e?.code === 'rejected' && detail)) return `people.limit.${LIMIT_DETAILS.includes(detail) ? detail : 'other'}`;
  const hit = ERR.find((c) => new RegExp(`\\b${c}\\b`).test(text));
  return hit ? `people.err.${hit}` : null;
}

/** 사람 탭을 읽다 난 오류 → 탭 상태. 'pro'(Pro 안내 — 서버 판정이 최종) | 'closed'(서버가 아직 안 엶 — 오류 아님) | 'error'(다시 시도). */
export function peopleGate(e) {
  const text = `${e?.code ?? ''} ${e?.message ?? ''} ${typeof e === 'string' ? e : ''}`;
  if (/\bmsgr2_pro_required\b/.test(text)) return 'pro';
  if (/\bmsgr2_lite_only\b/.test(text) || notOpenYet(e)) return 'closed';
  return 'error';
}

/** 공간·채널 이름 입력 문제 → 'empty' | 'long' | null. */
export function nameProblem(name) {
  const s = String(name ?? '').trim();
  if (!s) return 'empty';
  if ([...s].length > NAME_MAX) return 'long';
  return null;
}

const collator = new Intl.Collator('ko');
/**
 * 공간의 방 → 화면 줄. rooms: msgr2_rooms 행(+ 가짜 원본의 legacy·last·unread), members: 방 멤버 행, names: userId → 이름.
 * 반환 { channels, dms }. 채널 = open·private, 사람 1:1 = direct(상대 사람이 있는 방 — 에이전트 1:1은 '1:1' 탭이 맡는다).
 */
export function roomRows({ rooms = [], members = [], uid, names = {} } = {}) {
  const byRoom = new Map();
  for (const m of members) { if (m.removed_at) continue; if (!byRoom.has(m.room_id)) byRoom.set(m.room_id, []); byRoom.get(m.room_id).push(m); }
  const channels = []; const dms = [];
  for (const r of rooms) {
    if (!r || r.meeting) continue;
    const mem = byRoom.get(r.id) ?? [];
    const base = { id: r.id, legacy: !!r.legacy, readOnly: !!(r.archived_at || r.read_only), last: r.last ?? '', unread: r.unread ?? 0, at: Date.parse(r.last_at ?? r.created_at ?? '') || 0 };
    if (r.kind === 'direct') {
      const other = mem.find((m) => m.member_kind === 'user' && m.member_id !== uid);
      if (!other) continue; // 사람 상대가 없는 direct = 에이전트 1:1(1:1 탭)
      dms.push({ ...base, kind: 'dm', userId: other.member_id, name: names[other.member_id] || '?' });
    } else {
      channels.push({ ...base, kind: 'channel', name: r.name || '?', private: r.kind === 'private', count: mem.filter((m) => m.member_kind === 'user').length });
    }
  }
  channels.sort((a, b) => collator.compare(a.name, b.name));
  dms.sort((a, b) => (b.at - a.at) || collator.compare(a.name, b.name));
  return { channels, dms };
}

const ROLE_ORDER = { owner: 0, admin: 1, member: 2, guest: 3 };
/** 공간 멤버 → 목록 줄. people: [{ user_id, name, role, removed_at, expires_at, plan? }], agents: 그 공간에서 보이는 에이전트. 나는 맨 위, 그다음 역할·이름순. */
export function memberRows({ people = [], agents = [], uid, now = Date.now() } = {}) {
  const humans = people
    .filter((p) => p && !p.removed_at && !(p.expires_at && Date.parse(p.expires_at) <= now))
    .map((p) => ({ id: p.user_id, kind: 'user', name: p.name || '?', role: ROLE_ORDER[p.role] != null ? p.role : 'member', me: p.user_id === uid }))
    .sort((a, b) => (Number(b.me) - Number(a.me)) || (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || collator.compare(a.name, b.name));
  const bots = agents.filter((a) => a && a.status !== 'retired')
    .map((a) => ({ id: a.id, kind: 'agent', name: a.display_name || a.slug || '?', role: 'agent', mine: a.owner_user_id === uid, paused: a.status === 'paused' }))
    .sort((a, b) => collator.compare(a.name, b.name));
  return { humans, agents: bots };
}

/** 초대·관리 권한: 팀 공간의 owner·admin만 초대를 만든다(서버 msgr2_invite_create와 같은 기준). 채널 만들기는 손님을 뺀 멤버. */
export const canInvite = (space) => !!space && !space.personal && ['owner', 'admin'].includes(space.role);
export const canCreateRoom = (space) => !!space && !space.personal && ['owner', 'admin', 'member'].includes(space.role);

// ── 첨부 ──
/** 고른 파일(File·Blob 모양) → 기계가 받는 모양 { name, mime, bytes, data }. */
export const toUpload = (f) => ({ name: String(f?.name || 'file'), mime: f?.type || null, bytes: Number(f?.size) || 0, data: f });

/** 보낼 파일 목록에 더하기 — 같은 이름·크기는 한 번만, 한도를 넘으면 더하지 않고 문제를 돌려준다(보내기 전에 막는다 — 기계 attachmentProblem과 같은 기준). */
export function addFiles(current = [], picked = []) {
  const key = (f) => `${f.name}:${f.bytes}`;
  const have = new Set(current.map(key));
  const next = [...current]; for (const f of picked) { if (have.has(key(f))) continue; have.add(key(f)); next.push(f); }
  if (next.length > ATTACH_LIMITS.maxFiles) return { files: current, problem: 'tooMany' };
  if (next.some((f) => f.bytes > ATTACH_LIMITS.maxBytes)) return { files: current, problem: 'tooBig' };
  if (attachmentProblem(next)) return { files: current, problem: 'bad' };
  return { files: next, problem: null };
}

/** 보내기 단추를 켤까: 읽기 전용·막힘이 아니고 본문이나 첨부가 있으면. 첨부만 보낸 글도 된다. */
export const canSend = ({ body = '', files = [], blocked = false, sending = false } = {}) => !blocked && !sending && (String(body).trim().length > 0 || files.length > 0);


/** 바이트 → 짧은 크기 문구(언어와 무관한 단위). */
export function formatBytes(n) {
  const b = Math.max(0, Number(n) || 0);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 102.4) / 10} KB`;
  if (b < 1024 * 1024 * 1024) return `${Math.round(b / 104857.6) / 10} MB`;
  return `${Math.round(b / 107374182.4) / 10} GB`;
}

/** 파일 종류 → 아이콘 이름(icons.jsx). 이미지는 미리보기를 그린다. */
export function fileIcon({ mime = '', name = '' } = {}) {
  const m = String(mime || '').toLowerCase(); const ext = String(name || '').toLowerCase().split('.').pop();
  if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(ext)) return 'image';
  if (m === 'application/pdf' || ext === 'pdf') return 'fpdf';
  if (m.startsWith('video/') || ['mp4', 'mov', 'webm'].includes(ext)) return 'fvideo';
  if (m.startsWith('audio/') || ['mp3', 'm4a', 'wav'].includes(ext)) return 'faudio';
  if (['xlsx', 'xls', 'csv', 'numbers'].includes(ext)) return 'fsheet';
  if (['pptx', 'ppt', 'key'].includes(ext)) return 'fslide';
  if (['zip', 'gz', 'tgz', '7z', 'rar'].includes(ext)) return 'fzip';
  if (['js', 'mjs', 'ts', 'py', 'json', 'sh', 'sql', 'rs'].includes(ext)) return 'fcode';
  if (m.startsWith('text/') || ['txt', 'md'].includes(ext)) return 'ftext';
  return 'ffile';
}
export const isImage = (a) => fileIcon(a) === 'image';

/** 첨부 행(msgr2_attachments 또는 기계 'attachments' 사건) → 글 id별 묶음. 같은 첨부 id는 한 번만. */
export function attachmentsByMessage(rows = []) {
  const out = new Map(); const seen = new Set();
  for (const a of rows) {
    const mid = Number(a?.message_id); if (!Number.isSafeInteger(mid)) continue;
    const k = a.id ?? `${mid}:${a.storage_path ?? a.path ?? a.name}`; if (seen.has(k)) continue; seen.add(k);
    if (!out.has(mid)) out.set(mid, []);
    out.get(mid).push({ id: a.id ?? k, name: a.name || 'file', mime: a.mime || '', bytes: Number(a.bytes) || 0, path: a.storage_path ?? a.path ?? null, url: a.url ?? null });
  }
  return out;
}

// ── 이관된 옛 대화 ──
/** 옛 메신저에서 옮겨 온 방인가: 방 표지(legacy) 또는 옮겨 온 글 표지(meta.legacy_author·meta.legacy). */
export const legacyRoom = (room, msgs = []) => !!room?.legacy || msgs.some((m) => m?.legacy || m?.meta?.legacy_author || m?.meta?.legacy);

// ── 읽음 표시(폭주 방지 — 2026-10-20 유건 "폭주 안되게 막는 게 제일 중요해") ──
/**
 * 방 하나의 '마지막으로 읽은 글' 보내기. 화면에 보인 가장 큰 글 id가 커질 때만, 마지막으로 본 뒤 delayMs 조용하면 1회(글이 계속 와도 maxWaitMs마다 1회까지).
 * 글마다 보내지 않는다(글 100개가 한꺼번에 와도 1회). 서버 msgr2_mark_read도 값이 커질 때만 쓴다. 실패는 다시 보내지 않는다(다음에 더 큰 값이 보일 때 함께).
 * send(id) → Promise, timers = { set(fn, ms) → h, clear(h), now() }. 반환 { see(id), flush(), dispose() }.
 */
export function createReadMarker({ send, delayMs = 3000, maxWaitMs = 30_000, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h), now: () => Date.now() } } = {}) {
  let sent = 0; let want = 0; let timer = null; let firstAt = 0; let dead = false;
  const fire = () => { timer = null; firstAt = 0; if (dead || want <= sent) return; sent = want; Promise.resolve().then(() => send(want)).catch(() => {}); };
  return {
    see(id) {
      const n = Number(id); if (dead || !Number.isSafeInteger(n) || n <= Math.max(sent, want)) return;
      want = n;
      if (!firstAt) firstAt = timers.now();
      if (timer != null) timers.clear(timer);
      const wait = Math.min(delayMs, Math.max(0, firstAt + maxWaitMs - timers.now()));
      timer = timers.set(fire, wait);
    },
    flush() { if (timer != null) { timers.clear(timer); fire(); } },
    dispose() { this.flush(); dead = true; },
  };
}
