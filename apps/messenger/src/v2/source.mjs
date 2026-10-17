// 메신저 v2 어댑터(U6c-1b) — 기존 셸(App.jsx)이 옛 표(msgr_*)에 하던 조회를 v2 표(msgr2_*)로 바꿔 보내고, 받은 행을 옛 모양으로 돌려준다.
// 방향(유건 결정 2026-10-17 "기존 화면을 최대한 유지", 총괄 2026-10-18): 새 셸을 따로 키우지 않고 기존 셸을 그대로 쓰되 데이터 출처만 v2로 바꾼다.
// 플래그(v2/flag.mjs)가 꺼져 있으면 이 파일은 쓰이지 않는다 — App.jsx가 원래 클라이언트를 그대로 쓴다(기존 호출 코드는 한 줄도 옮기지 않음).
//
// 표마다 세 가지 중 하나다.
//   MAP   옛 표 → v2 표(열 이름·값 바꿈). 글·방·방 멤버·공간 멤버·첨부·반응·읽음·방 설정·에이전트.
//   KEEP  그대로 쓴다(설계 1-2절 — 사람 관계·기억·요금): 프로필·친구·친구 링크·차단·숨김·신고·회사 문서·일지·요금. 원래 클라이언트로 보낸다.
//   NONE  v2에 대응 표가 없다(설계 D16 범위 밖). 요청 없이 빈 결과, 쓰기는 'v2_unsupported' 오류. 화면은 그 단추를 v2 모드에서 숨긴다.
// 직접 쓰기가 막힌 표(읽음·방 멤버)·초대·조직 만들기는 U6d RPC로 보낸다(WRITES·InviteBuilder·OrgBuilder, U6c-2b).
// RPC는 네 갈래다: 그대로(RPCS.keep·msgr2_*), U6d로 번역(legacy-rpc.mjs LEGACY_RPCS), 쓰기 없음(RPCS.write → v2_unsupported), 그 밖의 읽기는 빈 값. 실시간·보내기는 여기서 하지 않는다 — 연결 상태 기계(src/link/machine.mjs)가 맡는다(App.jsx v2 분기).

import { LEGACY_RPCS, legacyInvite, inviteArgs } from './legacy-rpc.mjs';

export const V2_UNSUPPORTED = 'v2_unsupported';
/** v2 첨부 버킷(storage_path 앞 칸). */
export const V2_BUCKET = 'msgr';

// 옛 열 → v2 열. 값 바꿈은 옛 값 → v2 값(되돌릴 때는 거꾸로).
const ROOM_KIND = { public: 'open', private: 'private', dm: 'direct' };
const MEMBER_KIND = { user: 'user', crew: 'agent' };
const AUTHOR_KIND = { user: 'user', crew: 'agent', system: 'system' };
const MSG_KIND = { text: 'text', system: 'system', approval_card: 'card', card: 'card' };

const TABLES = {
  msgr_messages: {
    to: 'msgr2_messages', cols: { channel_id: 'room_id', crew_id: 'author_agent_id' },
    have: ['id', 'room_id', 'topic_id', 'author_kind', 'author_user_id', 'author_agent_id', 'kind', 'body', 'meta', 'mentions', 'reply_to', 'client_msg_id', 'work_id', 'created_at', 'edited_at', 'deleted_at'],
    values: { author_kind: AUTHOR_KIND, kind: MSG_KIND },
    spaceVia: 'room_id', // 옛 org_id 조건은 그 공간의 방 id 목록으로 바꾼다(방 조회 1회)
  },
  msgr_attachments: { to: 'msgr2_attachments', have: ['id', 'message_id', 'room_id', 'storage_path', 'name', 'mime', 'bytes', 'created_at'] },
  msgr_reactions: { to: 'msgr2_reactions', have: ['message_id', 'user_id', 'emoji', 'created_at'] },
  msgr_reads: { to: 'msgr2_reads', cols: { channel_id: 'room_id' }, have: ['room_id', 'user_id', 'last_read_id', 'updated_at'] },
  msgr_channel_prefs: { to: 'msgr2_prefs', cols: { channel_id: 'room_id' }, have: ['room_id', 'user_id', 'muted', 'pinned', 'updated_at'] },
  msgr_channels: {
    to: 'msgr2_rooms', cols: { org_id: 'space_id', crew_memory: 'memory', personal_crews: 'agent_policy' },
    have: ['id', 'space_id', 'kind', 'pair_key', 'name', 'memory', 'agent_policy', 'created_by', 'created_at', 'archived_at'],
    values: { kind: ROOM_KIND, agent_policy: { approval: 'approval', allowed: 'allowed', blocked: 'blocked', open: 'allowed', owner: 'approval' } },
    defaults: { topic: null, admin_user_ids: [], excluded_user_ids: [], excluded_crew_ids: [] },
  },
  msgr_channel_members: {
    to: 'msgr2_room_members', cols: { channel_id: 'room_id' }, have: ['room_id', 'member_kind', 'member_id', 'added_by', 'added_at', 'removed_at'],
    values: { member_kind: MEMBER_KIND }, live: 'removed_at', // 빠진 멤버는 옛 표처럼 행이 없는 것으로 본다
  },
  msgr_org_members: {
    to: 'msgr2_space_members', cols: { org_id: 'space_id' }, have: ['space_id', 'user_id', 'role', 'display_name', 'joined_at', 'removed_at', 'expires_at'],
  },
};

// 그대로 쓰는 표(설계 1-2절). 옛 앱과 같은 표·같은 정책.
const KEEP = new Set(['msgr_profiles', 'msgr_friends', 'msgr_friend_links', 'msgr_user_blocks', 'msgr_user_hides', 'msgr_reports',
  'msgr_org_docs', 'msgr_journal_entries', 'msgr_org_entitlements', 'entitlements']);

// RPC: keep = 원래대로, none = 요청 없이 빈 결과(쓰는 RPC는 오류). 목록에 없는 RPC도 none이다(옛 방·조직 자료를 섞지 않는다).
const RPCS = {
  keep: new Set(['msgr_people_names', 'msgr_avatars', 'msgr_my_friends', 'msgr_my_hidden_users', 'msgr_hide_user', 'msgr_unhide_user',
    'msgr_my_blocked', 'msgr_friend_remove', 'msgr_friend_unblock', 'msgr_friend_decide', 'msgr_friend_link_mine', 'msgr_friend_link_revoke',
    'msgr_find_user', 'my_plan', 'msgr_my_ai_consent', 'msgr_set_ai_consent', 'msgr_chief_docs', 'msgr_doc_links_for', 'msgr_delete_me',
    'msgr_service_pause', 'msgr_friend_request', 'msgr_friend_link_accept']), // 친구 요청·링크 수락: 옛 중단 장치가 v2 앱 기기의 msgr_friends 쓰기만 통과시킨다(U6d)
  // 읽기 RPC가 none일 때 돌려줄 빈 값(배열이 아닌 것만)
  empty: { msgr_my_badge: 0, msgr_my_ai_consent: null },
  write: new Set(['msgr_crew_join_decide', // 방·1:1·신고·초대·안 읽음·찾기는 U6d RPC로 바꿔 보낸다(legacy-rpc.mjs LEGACY_RPCS)
    'msgr_restore_org', 'msgr_join_by_domain', 'msgr_mute_crew', 'msgr_unmute_crew', 'msgr_set_member_profile', 'msgr_work_create', 'msgr_work_cancel',
    'msgr_work_resume', 'msgr_request_stop', 'msgr_bot_create', 'msgr_bot_rotate', 'msgr_bot_revoke', 'msgr_bot_rename', 'msgr_bot_set_role',
    'msgr_bot_set_mirror_all', 'msgr_crew_routine_edit', 'msgr_automation_set_enabled', 'msgr_automation_save_with_notifications',
    'msgr_automation_run_now', 'msgr_automation_delete', 'msgr_server_link_create', 'msgr_server_link_approve', 'msgr_report_resolve',
    'msgr_push_badge_resync']),
};

/** 등록을 기다리다 실패하면(시간 상한·다시 붙기 그만둠 — runtime.mjs) 요청 없이 오류 결과로 끝낸다(조회가 끝없이 걸리지 않게, #1086 검수 1). */
const notReady = (e) => ({ data: null, error: { message: e?.code ?? e?.message ?? 'v2_not_registered', code: e?.code ?? 'v2_not_registered' }, status: 0, count: null });
async function waitReady(ctx) { try { await ctx.ready(); return null; } catch (e) { return notReady(e); } }
const unsupported = () => ({ data: null, error: { message: V2_UNSUPPORTED, code: V2_UNSUPPORTED }, status: 400, count: null });
const invert = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k]));

/** select 문자열 → 최상위 항목(쉼표, 괄호 안은 나누지 않음). */
function topItems(sel) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of String(sel ?? '*')) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}
/** 끼워 읽기 항목 'msgr_channels(name, kind)'·'msgr_channels!inner(id, …)' → { table, inner, cols }. 아니면 null. */
export function parseEmbed(item) {
  const m = /^([a-z_]+)(!inner)?\((.*)\)$/s.exec(item);
  return m ? { table: m[1], inner: !!m[2], cols: m[3].split(',').map((c) => c.trim()).filter(Boolean) } : null;
}
/** select 문자열 → 열 목록(최상위 쉼표, 공백 제거). 끼워 읽기는 방(msgr_channels)만 바꾼다(EMBEDS) — 그 밖의 끼워 읽기는 던진다. */
export function splitCols(sel) {
  return topItems(sel).filter((c) => { const e = parseEmbed(c); if (!e) return true; if (!EMBEDS[e.table]) throw new Error('v2 source: embedded select is not mapped'); return false; })
    .map((c) => (c.includes(':') ? c.split(':')[0].trim() : c)); // 별칭(last_seen_at:msgr_crew_seen)은 앞 이름으로
}
const embedsOf = (sel) => topItems(sel).map(parseEmbed).filter(Boolean);
// 끼워 읽기: 옛 이름 → v2 표(외래 키 room_id → msgr2_rooms). 결과 열 이름은 옛 이름 그대로(별칭), 행은 옛 모양으로 되돌린다.
const EMBEDS = { msgr_channels: 'msgr2_rooms' };

function mapValue(spec, oldCol, v) {
  if (spec.to === 'msgr2_attachments' && oldCol === 'storage_path') { // 옛 객체 이름 → v2 '버킷/객체'(조건·쓰기)
    if (Array.isArray(v)) return v.map((x) => mapValue(spec, oldCol, x));
    return typeof v === 'string' && !v.startsWith(`${V2_BUCKET}/`) ? `${V2_BUCKET}/${v}` : v;
  }
  const m = spec.values?.[oldCol];
  if (!m) return v;
  if (Array.isArray(v)) return v.map((x) => mapValue(spec, oldCol, x));
  return v in m ? m[v] : v;
}

/** v2 행 → 옛 모양. 옛 열 이름으로 되돌리고, v2에 없는 열은 기본값(null)으로, 값도 되돌린다. */
export function toLegacyRow(table, row, want) {
  const spec = TABLES[table];
  if (!spec || !row) return row;
  const back = invert(spec.cols ?? {});
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const old = back[k] ?? k;
    const vm = spec.values?.[old];
    out[old] = vm ? (invert(vm)[v] ?? v) : v;
  }
  if (table === 'msgr_messages') {
    if ('author_kind' in out && out.author_kind === 'agent') out.author_kind = 'crew';
    if ('kind' in out && out.kind === 'card') out.kind = 'approval_card';
    if ('mentions' in out) out.mentions = Array.isArray(out.mentions) ? out.mentions.map((id) => ({ kind: 'crew', id })) : [];
    out._v2 = true; // 시스템 글(meta.code)을 사전 문구로 그리는 표지(App.jsx)
  }
  if (table === 'msgr_channels' && out.kind === 'direct') out.kind = 'dm';
  // 첨부 경로: v2 storage_path는 '버킷/객체'('msgr/<공간>/<방>/…' — U1·U2·U8). 옛 화면은 버킷 안의 객체 이름을 쓴다(media-io.js storage.from('msgr').createSignedUrl(이름),
  // 방 지우기 정리 storage.from('msgr').remove(이름들)). 'msgr/'만 뗀다 — 다른 버킷은 옛 화면이 열 수 없으므로 그대로 두어 서명이 실패하게 한다(조용히 다른 파일을 열지 않게).
  if (table === 'msgr_attachments' && typeof out.storage_path === 'string' && out.storage_path.startsWith(`${V2_BUCKET}/`)) out.storage_path = out.storage_path.slice(V2_BUCKET.length + 1);
  for (const c of want ?? []) if (c !== '*' && !(c in out)) out[c] = spec.defaults && c in spec.defaults ? spec.defaults[c] : null;
  return out;
}

/** 옛 행(쓰기) → v2 행. v2에 없는 열은 버린다. */
export function toV2Row(table, row) {
  const spec = TABLES[table];
  const out = {};
  for (const [k, v] of Object.entries(row ?? {})) {
    const col = spec.cols?.[k] ?? k;
    if (!spec.have.includes(col)) continue;
    out[col] = mapValue(spec, k, v);
  }
  if (table === 'msgr_messages' && Array.isArray(row?.mentions)) out.mentions = [...new Set(row.mentions.filter((m) => m?.kind === 'crew' && m.id).map((m) => m.id))].slice(0, 20);
  return out;
}

const NONE_RESULT = (single) => ({ data: single ? null : [], error: null, status: 200, count: 0 });

/** 요청을 모아 두었다가 then에서 한 번 보낸다(supabase-js 빌더와 같은 사슬 모양). */
class Builder {
  constructor(ctx, table) { this.ctx = ctx; this.table = table; this.ops = []; this.verb = 'select'; this.cols = ['*']; this.selOpts = undefined; this.one = null; this.payload = null; this.writeSelect = null; }
  select(cols = '*', opts) { if (this.verb === 'select') { this.cols = cols; this.selOpts = opts; } else this.writeSelect = cols; return this; }
  insert(row, opts) { this.verb = 'insert'; this.payload = row; this.writeOpts = opts; return this; }
  upsert(row, opts) { this.verb = 'upsert'; this.payload = row; this.writeOpts = opts; return this; }
  update(row) { this.verb = 'update'; this.payload = row; return this; }
  delete() { this.verb = 'delete'; return this; }
  maybeSingle() { this.one = 'maybe'; return this; }
  single() { this.one = 'one'; return this; }
  then(res, rej) { return this.run().then(res, rej); }
  catch(rej) { return this.run().catch(rej); }
}
for (const op of ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'contains', 'or', 'not', 'order', 'limit', 'range', 'filter', 'match']) {
  Builder.prototype[op] = function chain(...args) { this.ops.push([op, args]); return this; };
}

class NoneBuilder extends Builder {
  async run() { return this.verb === 'select' ? NONE_RESULT(this.one) : unsupported(); }
}

class MapBuilder extends Builder {
  async run() {
    const nr = await waitReady(this.ctx); if (nr) return nr; // v2 표의 RLS는 등록된 기기 세션만 읽게 한다(U3) — 첫 실행의 등록 전 읽기가 빈 결과로 굳지 않게(#1085 검수 2)
    const spec = TABLES[this.table]; const raw = this.ctx.raw;
    const want = this.verb === 'select' ? (this.cols === '*' ? ['*'] : splitCols(this.cols)) : (this.writeSelect ? splitCols(this.writeSelect) : null);
    const col = (c) => spec.cols?.[c] ?? c;
    const known = (c) => spec.have.includes(col(c));
    // 옛 org_id 조건(글) → 그 공간의 방 id 목록
    let roomFilter = null;
    for (const [op, args] of this.ops) {
      if (op === 'eq' && args[0] === 'org_id' && spec.spaceVia) roomFilter = await this.ctx.roomsOf(args[1]);
      else if (op === 'is' && args[0] === 'org_id' && args[1] === null && spec.spaceVia) roomFilter = await this.ctx.roomsOf(await this.ctx.personalSpace());
    }
    const nothing = () => (this.verb === 'select' ? NONE_RESULT(this.one) : unsupported());
    if (roomFilter && !roomFilter.length) return nothing();
    // 요청을 만들기 전에 결과가 없는 조건을 거른다(요청 0)
    for (const [op, args] of this.ops) {
      const [c, v] = args;
      if (op === 'contains' && c === 'mentions') {
        const ids = JSON.parse(typeof v === 'string' ? v : JSON.stringify(v)).filter((m) => m?.kind === 'crew');
        if (!ids.length) return NONE_RESULT(this.one); // 사람 멘션은 v2에 없다
      } else if ((op === 'eq' || op === 'in') && !(c === 'org_id' && spec.spaceVia) && typeof c === 'string' && !known(c)) return nothing(); // v2에 없는 열의 같음·포함
    }
    let q = raw.from(spec.to);
    const v2Cols = want ? [...new Set(want.filter((c) => c === '*' || known(c)).map((c) => (c === '*' ? '*' : col(c))))] : null;
    const embeds = this.verb === 'select' ? embedsOf(this.cols) : [];
    const embedSel = embeds.map((e) => { const rs = TABLES[e.table]; const cs = [...new Set(e.cols.map((c) => rs.cols?.[c] ?? c).filter((c) => rs.have.includes(c)))]; return `${e.table}:${EMBEDS[e.table]}${e.inner ? '!inner' : ''}(${(cs.length ? cs : ['id']).join(', ')})`; });
    if (this.verb === 'select') q = q.select([...(v2Cols?.length ? v2Cols : ['id']), ...embedSel].join(', '), this.selOpts);
    else if (this.verb === 'insert') q = q.insert(Array.isArray(this.payload) ? this.payload.map((r) => toV2Row(this.table, r)) : toV2Row(this.table, this.payload), this.writeOpts);
    else if (this.verb === 'upsert') {
      const conflict = this.writeOpts?.onConflict ? this.writeOpts.onConflict.split(',').map((c) => col(c.trim())).join(',') : this.table === 'msgr_channel_prefs' ? 'room_id,user_id' : undefined; // 충돌 기준 열도 v2 이름으로
      q = q.upsert(Array.isArray(this.payload) ? this.payload.map((r) => toV2Row(this.table, r)) : toV2Row(this.table, this.payload), { ...this.writeOpts, ...(conflict ? { onConflict: conflict } : {}) });
    }
    else if (this.verb === 'update') q = q.update(toV2Row(this.table, this.payload));
    else q = q.delete();
    if (this.verb !== 'select' && this.writeSelect) q = q.select((v2Cols?.length ? v2Cols : ['id']).join(', '));
    if (roomFilter) q = q.in(spec.spaceVia, roomFilter);
    if (spec.live && this.verb === 'select') q = q.is(spec.live, null);
    for (const [op, args] of this.ops) {
      const [c, ...rest] = args;
      if ((op === 'eq' || op === 'is') && c === 'org_id' && spec.spaceVia) continue; // 위에서 방 목록으로 바꿨다
      if (op === 'order') { if (known(c)) q = q.order(col(c), ...rest); continue; }
      if (op === 'limit' || op === 'range') { q = q[op](...args); continue; }
      if (op === 'or') { q = q.or(renameOr(spec, c)); continue; }
      if (op === 'contains' && c === 'mentions') { // 옛 [{kind,id}] → v2 uuid[](에이전트만)
        q = q.contains('mentions', JSON.parse(typeof rest[0] === 'string' ? rest[0] : JSON.stringify(rest[0])).filter((m) => m?.kind === 'crew').map((m) => m.id)); continue;
      }
      if (!known(c)) continue; // v2에 없는 열의 그 밖 조건(is null 등)은 조건 없음과 같다(같음·포함은 위에서 걸렀다)
      q = q[op](col(c), op === 'in' ? rest[0].map((v) => mapValue(spec, c, v)) : mapValue(spec, c, rest[0]), ...rest.slice(1));
    }
    if (this.one === 'maybe') q = q.maybeSingle(); else if (this.one === 'one') q = q.single();
    const r = await q;
    if (r?.error || r?.data == null) return r;
    const back = (x) => { const o = toLegacyRow(this.table, x, want); for (const e of embeds) if (o && e.table in o) o[e.table] = o[e.table] ? toLegacyRow(e.table, o[e.table], e.cols) : null; return o; }; // 끼워 읽은 방도 옛 모양(org_id·dm)
    let rows = Array.isArray(r.data) ? r.data.map(back) : back(r.data);
    // 내 참여 방은 멤버 행 그대로다(U6c-2b): open 방도 참여(msgr2_room_join)해야 목록·안 읽음(msgr2_unread)에 든다 — 참여 전 open 방은 옛 앱처럼 미리보기·둘러보기로 보인다
    return { ...r, data: rows };
  }
}

const rowsOf = (payload) => (Array.isArray(payload) ? payload : payload ? [payload] : []);
const eqOf = (ops, col) => ops.find(([op, a]) => op === 'eq' && a[0] === col)?.[1][1];
const okRows = (b, data) => ({ data: b.one ? (data[0] ?? null) : b.writeSelect || b.verb === 'select' ? data : null, error: null, status: 200, count: data.length });
async function meOf(raw) { const { data } = await Promise.resolve(raw.auth?.getSession?.()).catch(() => ({ data: null })) ?? {}; return data?.session?.user?.id ?? null; }

/**
 * 직접 쓰기가 막힌 v2 표(읽음·방 멤버 — U6d가 쓰기 권한을 거뒀다)와 RPC가 더 맞는 쓰기(방 설정)는 그 RPC로 보낸다(U6c-2b). 읽기는 MapBuilder 그대로.
 *   msgr_reads 쓰기          → msgr2_mark_read(값이 커질 때만 서버가 쓴다)
 *   msgr_channel_prefs 쓰기  → msgr2_room_pref_set(음소거·고정만 — 순서 열 pin_pos·sort_pos는 v2에 없어 요청 없이 버린다)
 *   msgr_channel_members 넣기 → msgr2_room_members_add, 빼기 → 나면 msgr2_room_leave, 남·에이전트면 msgr2_room_member_remove
 */
const WRITES = {
  msgr_reads: { async upsert(b) { for (const r of rowsOf(b.payload)) { const x = await b.ctx.rpc('msgr2_mark_read', { p_room: r.channel_id, p_last_id: r.last_read_id }); if (x.error) return x; } return okRows(b, []); } },
  msgr_channel_prefs: { async upsert(b) {
    for (const r of rowsOf(b.payload)) {
      if (!('muted' in r) && !('pinned' in r)) continue;
      const x = await b.ctx.rpc('msgr2_room_pref_set', { p_room: r.channel_id, p_muted: 'muted' in r ? !!r.muted : null, p_pinned: 'pinned' in r ? !!r.pinned : null });
      if (x.error) return x;
    }
    return okRows(b, []);
  } },
  msgr_channel_members: {
    async upsert(b) {
      const by = new Map(); for (const r of rowsOf(b.payload)) { const g = by.get(r.channel_id) ?? { users: [], agents: [] }; (r.member_kind === 'crew' ? g.agents : g.users).push(r.member_id); by.set(r.channel_id, g); }
      for (const [room, g] of by) { const x = await b.ctx.rpc('msgr2_room_members_add', { p_room: room, p_users: g.users, p_agents: g.agents }); if (x.error) return x; }
      return okRows(b, rowsOf(b.payload).map((r) => ({ member_id: r.member_id })));
    },
    async delete(b) {
      const room = eqOf(b.ops, 'channel_id'); const kind = eqOf(b.ops, 'member_kind'); const id = eqOf(b.ops, 'member_id');
      if (!room || !kind || !id) return unsupported(); // 여러 행을 한 번에 지우는 옛 쓰기는 v2에 없다
      const x = kind === 'user' && id === await meOf(b.ctx.raw) ? await b.ctx.rpc('msgr2_room_leave', { p_room: room })
        : await b.ctx.rpc('msgr2_room_member_remove', { p_room: room, p_kind: kind === 'crew' ? 'agent' : 'user', p_member: id });
      if (x.error) return x;
      return okRows(b, x.data ? [{ member_id: id }] : []);
    },
  },
};
WRITES.msgr_reads.insert = WRITES.msgr_reads.upsert; WRITES.msgr_channel_prefs.insert = WRITES.msgr_channel_prefs.upsert; WRITES.msgr_channel_members.insert = WRITES.msgr_channel_members.upsert;

class WriteMapBuilder extends MapBuilder {
  async run() {
    const w = WRITES[this.table]?.[this.verb];
    if (!w) return super.run();
    const nr = await waitReady(this.ctx); if (nr) return nr;
    return w(this);
  }
}

/** 초대(옛 msgr_invites — v2는 msgr2_space_invites, 쓰기·목록은 RPC만). 넣기 → msgr2_invite_create, 목록 → msgr2_invites_list(그 공간), 지우기 → msgr2_invite_revoke(소프트 취소). */
class InviteBuilder extends Builder {
  async run() {
    const nr = await waitReady(this.ctx); if (nr) return nr;
    const c = this.ctx;
    if (this.verb === 'insert') {
      const row = rowsOf(this.payload)[0];
      if (!row || row.for_node) return unsupported(); // 노드 코드는 v2에 없다
      const r = await c.rpc('msgr2_invite_create', inviteArgs(row));
      if (r.error) return r;
      if (!r.data?.invite_id) return { data: null, error: { message: 'msgr2_invite_unavailable' }, status: 400 };
      c.inviteSpace.set(r.data.invite_id, row.org_id);
      return okRows(this, [{ id: r.data.invite_id, code: r.data.code, expires_at: r.data.expires_at ?? null }]);
    }
    const id = eqOf(this.ops, 'id');
    if (this.verb === 'delete') {
      if (!id) return unsupported();
      const r = await c.rpc('msgr2_invite_revoke', { p_invite: id });
      return r.error ? r : okRows(this, r.data ? [{ id }] : []);
    }
    if (this.verb !== 'select') return unsupported();
    const space = eqOf(this.ops, 'org_id') ?? (id ? c.inviteSpace.get(id) : null);
    if (!space) return NONE_RESULT(this.one);
    const l = await c.rpc('msgr2_invites_list', { p_space: space });
    if (l.error) return l;
    for (const i of l.data ?? []) c.inviteSpace.set(i.id, space);
    let rows = (l.data ?? []).map(legacyInvite);
    for (const [op, [col, v]] of this.ops) {
      if (op === 'eq' && col !== 'org_id') rows = rows.filter((x) => x[col] === v);
      else if (op === 'is') rows = rows.filter((x) => (x[col] ?? null) === v);
    }
    const ord = this.ops.find(([op]) => op === 'order'); if (ord) { const [col, o] = ord[1]; const dir = o?.ascending === false ? -1 : 1; rows.sort((a, b) => (a[col] < b[col] ? -dir : a[col] > b[col] ? dir : 0)); }
    const lim = this.ops.find(([op]) => op === 'limit'); if (lim) rows = rows.slice(0, lim[1][0]);
    return okRows(this, rows);
  }
}

/** 조직 만들기(옛 msgr_orgs 넣기) → msgr2_space_create. 주소(slug)는 v2 규칙에 맞을 때만 넘긴다. 그 밖의 msgr_orgs 쓰기는 v2에 없다. */
class OrgBuilder extends NoneBuilder {
  async run() {
    if (this.verb !== 'insert') return super.run();
    const nr = await waitReady(this.ctx); if (nr) return nr;
    const row = rowsOf(this.payload)[0] ?? {};
    const slug = /^[a-z0-9][a-z0-9-]{1,39}$/.test(row.slug ?? '') ? row.slug : null;
    const r = await this.ctx.rpc('msgr2_space_create', { p_name: row.name ?? '', p_slug: slug });
    return r.error ? r : okRows(this, [{ id: r.data }]);
  }
}

function renameOr(spec, expr) {
  return String(expr).replace(/(^|,|\()([a-z_]+)\./g, (m, pre, c) => `${pre}${spec.cols?.[c] ?? c}.`);
}

/** 에이전트(옛 msgr_crews 모양). 조직 조건(org_id) = 그 팀 공간의 자리(seat), 자리의 allow·allow_users를 붙인다. */
class CrewBuilder extends Builder {
  async run() {
    if (this.verb !== 'select') return unsupported();
    const nr = await waitReady(this.ctx); if (nr) return nr;
    const raw = this.ctx.raw;
    const want = this.cols === '*' ? ['*'] : splitCols(this.cols);
    let space = null; let ids = null; let owner = null; let statuses = null;
    for (const [op, args] of this.ops) {
      if (op === 'eq' && args[0] === 'org_id') space = args[1];
      else if (op === 'eq' && args[0] === 'id') ids = [args[1]];
      else if (op === 'in' && args[0] === 'id') ids = args[1];
      else if (op === 'eq' && args[0] === 'owner_user_id') owner = args[1];
      else if (op === 'in' && args[0] === 'status') statuses = args[1];
      else if (op === 'eq' && args[0] === 'status') statuses = [args[1]];
    }
    let seats = null;
    if (space) {
      const s = await raw.from('msgr2_agent_seats').select('agent_id, allow, allow_users').eq('space_id', space).is('removed_at', null);
      if (s.error) return s;
      seats = new Map((s.data ?? []).map((x) => [x.agent_id, x]));
      ids = ids ? ids.filter((id) => seats.has(id)) : [...seats.keys()];
      if (!ids.length && !statuses?.includes('available')) return NONE_RESULT(this.one);
    }
    let list = [];
    if (!ids || ids.length) { // 자리가 하나도 없으면 자리 있는 에이전트 조회는 하지 않는다(아래 '파견 전'만)
      let q = raw.from('msgr2_agents').select('id, owner_user_id, slug, display_name, role_text, face, hosting, status, created_at');
      if (ids) q = q.in('id', ids);
      if (owner) q = q.eq('owner_user_id', owner);
      const seatedStatuses = statuses?.filter((x) => x !== 'available') ?? null; // 자리 있는 에이전트의 상태 조건('available'은 아래 '파견 전'이 따로)
      if (seatedStatuses) q = q.in('status', seatedStatuses.length ? seatedStatuses : ['active']);
      else q = q.neq('status', 'retired');
      const r = await q;
      if (r.error) return r;
      list = r.data ?? [];
    }
    // 옛 status 'available'(내 크루, 이 조직에 파견 전) = 이 팀 공간에 자리가 없는 내 에이전트(U6c-1b ③ — 사이드바 '내 에이전트'의 파견 단추)
    if (space && statuses?.includes('available')) {
      const { data: sess } = await raw.auth.getSession().catch(() => ({ data: null }));
      const me = sess?.session?.user?.id;
      if (me) {
        const mine = await raw.from('msgr2_agents').select('id, owner_user_id, slug, display_name, role_text, face, hosting, status, created_at').eq('owner_user_id', me).eq('status', 'active');
        if (!mine.error) list = list.concat((mine.data ?? []).filter((a) => !seats.has(a.id)).map((a) => ({ ...a, status: 'available' })));
      }
    }
    let rows = list.map((a) => {
      const seat = seats?.get(a.id);
      const row = { ...a, org_id: space, allow: seat?.allow ?? 'all', allow_users: seat?.allow_users ?? [], last_seen_at: null, folder: null, avatar_url: null, bio: null, _v2: true }; // 접속은 v2:pr:(Presence)로 본다 — 행 시각이 없다
      for (const c of want) if (c !== '*' && !(c in row)) row[c] = null;
      return row;
    });
    if (this.one) rows = rows[0] ?? null;
    return { data: rows, error: null, status: 200 };
  }
}

/**
 * 원래 클라이언트를 감싼 v2 클라이언트. from·rpc만 바꾸고 나머지(auth·storage·functions·realtime·channel)는 원래 것을 그대로 쓴다.
 * opts.personalSpace() — 내 개인 공간 id(옛 org_id null 조건에 쓴다). opts.roomsOf(space) — 그 공간의 방 id 목록(옛 org_id 조건에 쓴다).
 */
export function createV2Client(raw, opts = {}) {
  const roomCache = new Map();
  const ctx = {
    raw,
    ready: opts.ready ?? (async () => {}),
    personalSpace: opts.personalSpace ?? (async () => null),
    roomsOf: opts.roomsOf ?? (async (space) => {
      if (!space) return [];
      if (!roomCache.has(space)) {
        roomCache.set(space, Promise.resolve(raw.from('msgr2_rooms').select('id').eq('space_id', space).is('archived_at', null))
          .then((r) => (r.error ? (roomCache.delete(space), []) : (r.data ?? []).map((x) => x.id))));
      }
      return roomCache.get(space);
    }),
  };
  ctx.rpc = (name, args, o) => waitReady(ctx).then((nr) => nr ?? raw.rpc(name, args, o)); // v2 RPC는 기기 등록 뒤에
  ctx.inviteSpace = new Map(); // 초대 id → 공간(목록·만들기에서 기억 — 공간 없이 id만으로 읽거나 바꾸는 옛 호출용)
  const legacy = { call: (n, a) => ctx.rpc(n, a), personal: () => ctx.personalSpace(), roomsOf: (sp) => ctx.roomsOf(sp), forget: (sp) => { if (sp) roomCache.delete(sp); }, inviteSpace: ctx.inviteSpace };
  const client = Object.create(raw);
  client.from = (table) => {
    if (table === 'msgr_crews') return new CrewBuilder(ctx, table);
    if (table === 'msgr_invites') return new InviteBuilder(ctx, table);
    if (table === 'msgr_orgs') return new OrgBuilder(ctx, table);
    if (WRITES[table]) return new WriteMapBuilder(ctx, table);
    if (TABLES[table]) return new MapBuilder(ctx, table);
    if (KEEP.has(table) || String(table).startsWith('msgr2_') || !String(table).startsWith('msgr')) return raw.from(table); // v2 표를 직접 읽는 곳(v2/data.mjs 등)은 그대로
    return new NoneBuilder(ctx, table);
  };
  client.rpc = (name, args, o) => {
    if (String(name).startsWith('msgr2_')) return ctx.rpc(name, args, o);
    if (LEGACY_RPCS[name]) return Promise.resolve(LEGACY_RPCS[name](legacy, args ?? {})).catch((e) => ({ data: null, error: { message: String(e?.message ?? e) }, status: 0 }));
    if (RPCS.keep.has(name)) return raw.rpc(name, args, o);
    if (RPCS.write.has(name)) return Promise.resolve(unsupported());
    return Promise.resolve({ data: name in RPCS.empty ? RPCS.empty[name] : [], error: null, status: 200 });
  };
  client.forgetRooms = (space) => { if (space) roomCache.delete(space); else roomCache.clear(); }; // 방 목록이 바뀌면(새 방) 다시 묻는다
  client.v2 = true;
  return client;
}

/** 이 이름의 RPC·표가 v2 모드에서 실제로 서버에 가는가(시험·숨김 표용). */
export function v2Route(kind, name) {
  if (kind === 'table') return name === 'msgr_crews' || name === 'msgr_invites' || TABLES[name] ? 'map' : KEEP.has(name) || String(name).startsWith('msgr2_') || !String(name).startsWith('msgr') ? 'keep' : 'none';
  return RPCS.keep.has(name) || String(name).startsWith('msgr2_') ? 'keep' : LEGACY_RPCS[name] ? 'map' : RPCS.write.has(name) ? 'unsupported' : 'none';
}
