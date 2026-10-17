// 메신저 v2 어댑터(U6c-1b) — 기존 셸(App.jsx)이 옛 표(msgr_*)에 하던 조회를 v2 표(msgr2_*)로 바꿔 보내고, 받은 행을 옛 모양으로 돌려준다.
// 방향(유건 결정 2026-10-17 "기존 화면을 최대한 유지", 총괄 2026-10-18): 새 셸을 따로 키우지 않고 기존 셸을 그대로 쓰되 데이터 출처만 v2로 바꾼다.
// 플래그(v2/flag.mjs)가 꺼져 있으면 이 파일은 쓰이지 않는다 — App.jsx가 원래 클라이언트를 그대로 쓴다(기존 호출 코드는 한 줄도 옮기지 않음).
//
// 표마다 세 가지 중 하나다.
//   MAP   옛 표 → v2 표(열 이름·값 바꿈). 글·방·방 멤버·공간 멤버·첨부·반응·읽음·방 설정·에이전트.
//   KEEP  그대로 쓴다(설계 1-2절 — 사람 관계·기억·요금): 프로필·친구·친구 링크·차단·숨김·신고·회사 문서·일지·요금. 원래 클라이언트로 보낸다.
//   NONE  v2에 대응 표가 없다(설계 D16 범위 밖이거나 U6d 전). 요청 없이 빈 결과, 쓰기는 'v2_unsupported' 오류. 화면은 그 단추를 v2 모드에서 숨긴다.
// RPC도 같은 세 갈래다(RPCS). 실시간·보내기는 여기서 하지 않는다 — 연결 상태 기계(src/link/machine.mjs)가 맡는다(App.jsx v2 분기).

export const V2_UNSUPPORTED = 'v2_unsupported';

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
    'msgr_service_pause']),
  // 읽기 RPC가 none일 때 돌려줄 빈 값(배열이 아닌 것만)
  empty: { msgr_my_badge: 0, msgr_unread: [], msgr_my_ai_consent: null },
  write: new Set(['msgr_friend_request', 'msgr_friend_link_accept', 'msgr_report_message', 'msgr_create_channel', 'msgr_join_channel', 'msgr_crew_join',
    'msgr_crew_leave_channel', 'msgr_crew_join_decide', 'msgr_leave_dm', 'msgr_dm_personal', 'msgr_dm_personal_crew', 'msgr_dm_personal_group',
    'msgr_restore_org', 'msgr_join_by_domain', 'msgr_mute_crew', 'msgr_unmute_crew', 'msgr_set_member_profile', 'msgr_work_create', 'msgr_work_cancel',
    'msgr_work_resume', 'msgr_request_stop', 'msgr_bot_create', 'msgr_bot_rotate', 'msgr_bot_revoke', 'msgr_bot_rename', 'msgr_bot_set_role',
    'msgr_bot_set_mirror_all', 'msgr_crew_routine_edit', 'msgr_automation_set_enabled', 'msgr_automation_save_with_notifications',
    'msgr_automation_run_now', 'msgr_automation_delete', 'msgr_server_link_create', 'msgr_server_link_approve', 'msgr_report_resolve',
    'msgr_push_badge_resync']),
};

const unsupported = () => ({ data: null, error: { message: V2_UNSUPPORTED, code: V2_UNSUPPORTED }, status: 400, count: null });
const invert = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k]));

/** select 문자열 → 열 목록(최상위 쉼표, 공백 제거). 끼워 읽기(괄호)는 MAP 표에서 쓰지 않는다. */
export function splitCols(sel) {
  const s = String(sel ?? '*').trim();
  if (s.includes('(')) throw new Error('v2 source: embedded select is not mapped');
  return s.split(',').map((c) => c.trim()).filter(Boolean).map((c) => (c.includes(':') ? c.split(':')[0].trim() : c)); // 별칭(last_seen_at:msgr_crew_seen)은 앞 이름으로
}

function mapValue(spec, oldCol, v) {
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
    if (this.verb === 'select') q = q.select((v2Cols?.length ? v2Cols : ['id']).join(', '), this.selOpts);
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
    let rows = Array.isArray(r.data) ? r.data.map((x) => toLegacyRow(this.table, x, want)) : toLegacyRow(this.table, r.data, want);
    // 내 참여 방(옛 '참여한 채널' 조회 — member_kind user + member_id, 방 조건 없음): v2 open 방은 공간 멤버가 참여 단계 없이 읽는다 → 읽을 수 있는 open 방을 더한다(조회 1회)
    if (this.table === 'msgr_channel_members' && this.verb === 'select' && Array.isArray(rows) && !this.one) {
      const who = this.ops.find(([op, a]) => op === 'eq' && a[0] === 'member_id')?.[1][1];
      const userOnly = this.ops.some(([op, a]) => op === 'eq' && a[0] === 'member_kind' && a[1] === 'user');
      const roomScoped = this.ops.some(([, a]) => a[0] === 'channel_id');
      if (who && userOnly && !roomScoped) {
        const open = await raw.from('msgr2_rooms').select('id').eq('kind', 'open').is('archived_at', null);
        if (!open.error) { const have = new Set(rows.map((x) => x.channel_id)); for (const o of open.data ?? []) if (!have.has(o.id)) rows.push({ channel_id: o.id, member_kind: 'user', member_id: who }); }
      }
    }
    return { ...r, data: rows };
  }
}

function renameOr(spec, expr) {
  return String(expr).replace(/(^|,|\()([a-z_]+)\./g, (m, pre, c) => `${pre}${spec.cols?.[c] ?? c}.`);
}

/** 에이전트(옛 msgr_crews 모양). 조직 조건(org_id) = 그 팀 공간의 자리(seat), 자리의 allow·allow_users를 붙인다. */
class CrewBuilder extends Builder {
  async run() {
    if (this.verb !== 'select') return unsupported();
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
  const client = Object.create(raw);
  client.from = (table) => {
    if (table === 'msgr_crews') return new CrewBuilder(ctx, table);
    if (TABLES[table]) return new MapBuilder(ctx, table);
    if (KEEP.has(table) || String(table).startsWith('msgr2_') || !String(table).startsWith('msgr')) return raw.from(table); // v2 표를 직접 읽는 곳(v2/data.mjs 등)은 그대로
    return new NoneBuilder(ctx, table);
  };
  client.rpc = (name, args, o) => {
    if (RPCS.keep.has(name) || String(name).startsWith('msgr2_')) return raw.rpc(name, args, o);
    if (RPCS.write.has(name)) return Promise.resolve(unsupported());
    return Promise.resolve({ data: name in RPCS.empty ? RPCS.empty[name] : [], error: null, status: 200 });
  };
  client.forgetRooms = (space) => { if (space) roomCache.delete(space); else roomCache.clear(); }; // 방 목록이 바뀌면(새 방) 다시 묻는다
  client.v2 = true;
  return client;
}

/** 이 이름의 RPC·표가 v2 모드에서 실제로 서버에 가는가(시험·숨김 표용). */
export function v2Route(kind, name) {
  if (kind === 'table') return name === 'msgr_crews' || TABLES[name] ? 'map' : KEEP.has(name) || String(name).startsWith('msgr2_') || !String(name).startsWith('msgr') ? 'keep' : 'none';
  return RPCS.keep.has(name) || String(name).startsWith('msgr2_') ? 'keep' : RPCS.write.has(name) ? 'unsupported' : 'none';
}
