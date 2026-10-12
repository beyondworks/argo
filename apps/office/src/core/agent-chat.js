// 에이전트 패널(⌘J, 1단계). 대화 = 내 에이전트와의 1:1 방 안에서 패널이 보낸 첫 글(meta.source = office_panel, thread_root 없음)과 그 답글 묶음 — 게이트웨이 답도 reply_to·thread_root를 단다(msgr.mjs).
// 방 찾기·보내기 전 거절은 맡기기와 같은 crewRoom, 첨부 업로드·등록·빈 글 거두기는 메신저 composerTransport를 그대로 쓰고 글 쓰기만 바꿔 meta를 싣는다.
// 부하: 패널을 열 때 방 찾기 RPC 2~4건 + 글 1회(최근 150개) + 첨부 1회. 그 뒤로는 비공개 토픽 구독(폴링 없음) — 새 글·첨부 방송마다 그 한 줄만 읽는다. 진행 신호는 방송만(DB 0).
import { composerTransport } from '../../../../src/composer-delivery.mjs';
import { crewRoom } from './crew-assign.js';

export const PANEL_SOURCE = 'office_panel';
/** 패널 글 meta — 개인 1:1(조직 없는 방)로 가는 글은 보고 있는 오피스 조직(office_org)을 싣는다. 게이트웨이가 구성원인지 확인한 뒤에만 그 조직의 할 일·페이지·거래 도구를 싣는다(msgr.mjs panelOfficeOrg) */
export const panelMeta = (meta, { items = [], auto = false, personal = false, orgId = null } = {}) => ({
  ...meta, source: PANEL_SOURCE, office_items: items.map(({ kind, label }) => ({ kind, label })),
  ...(auto ? { office_auto: true } : {}), ...(personal && orgId ? { office_org: orgId } : {}),
});
const ROW = 'id, author_kind, author_user_id, crew_id, kind, body, meta, reply_to, thread_root, created_at, deleted_at';
const ATTACH = 'id, message_id, name, mime, bytes, storage_path';
export const RECENT_N = 150;
export const PROGRESS_STALE_MS = 9000; // 게이트웨이는 턴 중 4초 간격으로 progress를 보낸다 — 두 번 놓치면 끝난 것으로 본다

// 1:1 방의 첫 글은 서버가 thread_root를 자기 번호로 채운다(msgr_dm_message_guard) — 조직 방에서는 비어 있다
export const isRoot = (row) => row?.author_kind === 'user' && row.meta?.source === PANEL_SOURCE && !row.reply_to && (row.thread_root == null || row.thread_root === row.id) && !row.deleted_at;

export function shownBody(body, fence) {
  const s = String(body ?? '');
  const i = fence ? s.indexOf(`\n\n${fence}\n`) : -1;
  return (i >= 0 ? s.slice(0, i) : s).trim();
}
export const titleOf = (row, fence, max = 40) => {
  const line = shownBody(row?.body, fence).split('\n').find((l) => l.trim())?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

export function conversations(rows, fence) {
  const last = new Map();
  for (const r of rows) { const root = r.thread_root ?? r.id; if (!r.deleted_at && (last.get(root) ?? 0) < r.id) last.set(root, r.id); }
  return rows.filter(isRoot).map((r) => ({ id: r.id, title: titleOf(r, fence), at: r.created_at, last: last.get(r.id) ?? r.id, items: r.meta?.office_items ?? [] }))
    .sort((a, b) => b.last - a.last);
}
export const threadOf = (rows, root) => rows.filter((r) => !r.deleted_at && (r.id === root || r.thread_root === root)).sort((a, b) => a.id - b.id);

export function seeingItem(path, { mails = [], pages = [] } = {}, untitled = '') {
  const mail = /^\/me\/mail\/([^/?#]+)/.exec(path ?? '')?.[1];
  if (mail) { const m = mails.find((x) => x.id === decodeURIComponent(mail)); return m ? { kind: 'mail', id: m.id, label: m.subject || untitled } : null; }
  const page = /^\/(?:me|o\/[^/]+)\/p\/([^/?#]+)/.exec(path ?? '')?.[1];
  if (page) { const p = pages.find((x) => x.id === decodeURIComponent(page)); return p ? { kind: 'page', id: p.id, label: p.title || untitled } : null; }
  return null;
}

export const waiting = (progress, now) => !!progress && now - progress.at < PROGRESS_STALE_MS;

const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };

export function roomDb(sb, owner) {
  return {
    rpc: (fn, args) => must(sb.rpc(fn, args)),
    myChannels: () => must(sb.from('msgr_channel_members').select('channel_id, msgr_channels!inner(id, kind, org_id, archived_at)').eq('member_kind', 'user').eq('member_id', owner)),
    members: (ids) => must(sb.from('msgr_channel_members').select('channel_id, member_kind, member_id').in('channel_id', ids)),
  };
}
export const openRoom = (sb, owner, target, crewName) => crewRoom(roomDb(sb, owner), { owner, ...target, crewName });

export async function loadRoom(sb, channel) {
  const rows = await must(sb.from('msgr_messages').select(ROW).eq('channel_id', channel).is('deleted_at', null).order('id', { ascending: false }).limit(RECENT_N));
  return { rows: rows ?? [], files: rows?.length ? await loadFiles(sb, rows.map((r) => r.id)) : [] };
}
export const loadRow = async (sb, id) => (await must(sb.from('msgr_messages').select(ROW).eq('id', id).maybeSingle())) ?? null;
export const loadSince = async (sb, channel, afterId) => (await must(sb.from('msgr_messages').select(ROW).eq('channel_id', channel).gt('id', afterId).is('deleted_at', null).order('id', { ascending: true }).limit(RECENT_N))) ?? [];
export const loadFiles = async (sb, ids) => (await must(sb.from('msgr_attachments').select(ATTACH).in('message_id', ids))) ?? [];
const signed = new Map();
export async function fileUrl(sb, path) {
  const hit = signed.get(path);
  if (hit && hit.until > Date.now()) return hit.url;
  const url = (await must(sb.storage.from('msgr').createSignedUrl(path, 600)))?.signedUrl;
  if (url) signed.set(path, { url, until: Date.now() + 540_000 });
  return url;
}
export const stopTurn = (sb, crew, source) => must(sb.rpc('msgr_request_stop', { p_crew: crew, p_source: source }));

/** 방 소식 구독 — 개인 방 글·첨부·진행은 dm:<방>, 조직 1:1의 글·첨부는 u:<나>로 온다(20260918184500·20260930160000). 반환: 끊기 */
// 같은 토픽의 채널을 이 패널만 쓴다는 전제 — sb.channel은 같은 토픽이면 기존 채널을 돌려줘 끊을 때 함께 끊긴다(오피스에 다른 dm:·u: 구독 없음)
export async function listen(sb, { channel, uid, personal }, on) {
  await sb.realtime.setAuth();
  const mine = (fn) => ({ payload }) => { if (payload?.channel_id === channel) fn(payload); };
  const subs = [sb.channel(`dm:${channel}`, { config: { private: true } })
    .on('broadcast', { event: 'message' }, mine(on.message)).on('broadcast', { event: 'attach' }, mine(on.attach)).on('broadcast', { event: 'progress' }, mine(on.progress)).subscribe((s) => on.status?.(s))];
  if (!personal) subs.push(sb.channel(`u:${uid}`, { config: { private: true } }).on('broadcast', { event: 'message' }, mine(on.message)).on('broadcast', { event: 'attach' }, mine(on.attach)).subscribe((s) => on.status?.(s)));
  return () => { for (const s of subs) sb.removeChannel(s).catch?.(() => {}); };
}

/** 메신저 전송 통로에 meta를 싣는 글 쓰기만 바꿔 끼운다. prepare(job) → { body, meta, replyTo } — 보낼 때 한 번(다시 보내기는 같은 글 번호를 쓴다) */
export function panelTransport(sb, { orgId, channel, uid, personal }, prepare) {
  const base = composerTransport(sb, { orgId, chId: channel, uid, personal });
  return {
    ...base,
    async message(job) {
      job.prepared ??= await prepare(job); // 다시 보내기는 처음 고른 대화·자료로(그사이 새 대화를 열어도 섞이지 않게)
      const { body, meta, replyTo } = job.prepared;
      // 1:1 방은 thread_root를 비우면 서버가 자기 번호로 채워 대화가 끊긴다(msgr_dm_message_guard가 reply_to로 채우는 규칙보다 먼저 돈다) — 이어 쓰는 글은 첫 글 번호를 직접 싣는다
      const { data, error } = await sb.from('msgr_messages').insert({ channel_id: channel, author_kind: 'user', author_user_id: uid, body, meta, client_msg_id: job.clientId, ...(replyTo ? { reply_to: replyTo, thread_root: replyTo } : {}) }).select('id').single();
      if (!error) return data.id;
      const found = await sb.from('msgr_messages').select('id').eq('channel_id', channel).eq('author_user_id', uid).eq('client_msg_id', job.clientId).maybeSingle();
      if (!found.error && found.data) return found.data.id;
      throw Object.assign(new Error(error.message), { code: error.code });
    },
  };
}


/* ── 쓰기 확인 카드(2단계 PR1) — 게이트웨이가 패널 턴의 오피스 쓰기를 실행하지 않고 답 글 meta.office_proposals로 올린다(src/gateway/office-proposals.mjs).
   [실행]은 같은 대화에 확인 글(meta.office_confirm)을 넣고, 게이트웨이가 그 답 글의 제안을 다시 읽어 인자 그대로 실행한 뒤 답에 meta.office_result를 단다.
   취소는 이 기기에만 남긴다(서버 쓰기 없음). */
export const proposalsOf = (row) => (row?.author_kind === 'crew' && Array.isArray(row.meta?.office_proposals)
  ? row.meta.office_proposals.filter((p) => p && /^p[1-9]$/.test(p.pid) && typeof p.summary === 'string') : []);

/** 카드 상태 — 'done'(처리기가 돌았다 — 성공·거절은 답 글이 알린다) | 'failed'(오류·제안을 못 찾음) | 'unknown'(실행 중 끊겨 모름) | 'sent'(확인 글을 보냈다) | 'open'.
    결과 표지의 status가 없으면(이 표지를 처음 단 게이트웨이) 'done'으로 본다. thread = 이 대화의 글 */
export function proposalState(thread, replyId, pid) {
  const same = (c) => c && Number(c.reply) === replyId && c.pid === pid;
  const res = thread.find((r) => r.author_kind === 'crew' && same(r.meta?.office_result))?.meta.office_result;
  if (res) return res.status === 'error' || res.status === 'not_found' ? 'failed' : res.status === 'unknown' ? 'unknown' : 'done';
  if (thread.some((r) => r.author_kind === 'user' && same(r.meta?.office_confirm))) return 'sent';
  return 'open';
}

/** 카드 '자세히' — 실행될 인자를 칸 이름과 값 한 줄씩(action 제외). 값은 글자로, 길면 자른다. 무엇이 바뀌는지 보고 누르게(검수 M2) */
export function proposalFields(p, max = 300) {
  const a = p?.args && typeof p.args === 'object' ? p.args : {};
  const text = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  return Object.entries(a).filter(([k, v]) => k !== 'action' && v != null && v !== '')
    .map(([k, v]) => { const s = text(v); return { key: k, tool: p.tool, value: s.length > max ? `${s.slice(0, max)}…` : s }; });
}
/** 칸 이름 사전 키 — 도구마다 뜻이 다른 칸(메일 account = 메일 계정, 거래 account = 계좌)은 도구 키가 먼저 */
export function fieldLabelKey(f, has) {
  const own = `agent.field.${f.tool}.${f.key}`;
  return has(own) ? own : `agent.field.${f.key}`;
}

/** 확인 글 쓰기 — 같은 카드를 두 번 눌러도 한 건(client_msg_id 고정, 이미 있으면 그 글 번호) */
export async function sendConfirm(sb, { channel, uid, root, replyId, pid, body }) {
  const clientId = `oc:${replyId}:${pid}`;
  const row = { channel_id: channel, author_kind: 'user', author_user_id: uid, body, client_msg_id: clientId,
    meta: { source: PANEL_SOURCE, office_confirm: { reply: replyId, pid } }, reply_to: root, thread_root: root };
  const { data, error } = await sb.from('msgr_messages').insert(row).select('id').single();
  if (!error) return data.id;
  const found = await sb.from('msgr_messages').select('id').eq('channel_id', channel).eq('author_user_id', uid).eq('client_msg_id', clientId).maybeSingle();
  if (!found.error && found.data) return found.data.id;
  throw Object.assign(new Error(error.message), { code: error.code });
}

/* ── 단계 보기(2단계 PR2) — 진행 중에는 progress 방송의 steps, 끝난 뒤에는 답 글 meta.office_steps {n, steps}(src/gateway/office-steps.mjs).
   단계 = { stage, detail }. stage는 게이트웨이의 안정 코드(turn-status TOOL_STAGE) — 모르는 값은 'work'로 본다. */
export const STEP_STAGES = ['memory', 'write', 'shell', 'web', 'delegate', 'approval', 'tool', 'work'];
const cleanSteps = (list) => (Array.isArray(list) ? list.filter((x) => x && typeof x === 'object').slice(-40).map((x) => ({ stage: STEP_STAGES.includes(x.stage) ? x.stage : 'work', detail: String(x.detail ?? '').slice(0, 120) })) : []);
export const liveSteps = (payload) => cleanSteps(payload?.steps);
export function keptSteps(row) {
  const o = row?.author_kind === 'crew' ? row.meta?.office_steps : null;
  if (!o || typeof o !== 'object') return null;
  const steps = cleanSteps(o.steps);
  const n = Number.isSafeInteger(o.n) && o.n > 0 ? o.n : steps.length;
  return steps.length ? { n, steps } : null;
}

/* ── 직무별 배분(2단계 PR3) — 답 글의 단계 요약에서 '동료에게 맡김' 단계의 대상을 모으고, '다른 에이전트에게 맡기기'는 같은 대화에 맡길 동료 이름을 실은 글을 넣는다 ── */
/** 실제로 맡은 동료 — 게이트웨이가 위임에 성공한 동료의 이름·직무만 meta.office_delegates로 싣는다(실패한 위임·slug는 보이지 않게, 검수 M5) */
export function delegatedTo(row) {
  const list = row?.author_kind === 'crew' && Array.isArray(row.meta?.office_delegates) ? row.meta.office_delegates : [];
  const seen = new Set();
  return list.filter((d) => d && typeof d.name === 'string' && d.name.trim()).map((d) => ({ name: d.name.trim().slice(0, 40), role: typeof d.role === 'string' ? d.role.trim().slice(0, 40) : '' }))
    .filter((d) => !seen.has(d.name) && seen.add(d.name));
}

/** 맡길 동료를 고른 글 — 같은 대화 뿌리에 붙인다. 반환: 글 번호 */
export async function sendRoute(sb, { channel, uid, root, name, body, clientId }) {
  const row = { channel_id: channel, author_kind: 'user', author_user_id: uid, body, client_msg_id: clientId,
    meta: { source: PANEL_SOURCE, office_route: name }, reply_to: root, thread_root: root };
  const { data, error } = await sb.from('msgr_messages').insert(row).select('id').single();
  if (!error) return data.id;
  const found = await sb.from('msgr_messages').select('id').eq('channel_id', channel).eq('author_user_id', uid).eq('client_msg_id', clientId).maybeSingle(); // 같은 요청·같은 동료를 두 번 골라도 한 건
  if (!found.error && found.data) return found.data.id;
  throw Object.assign(new Error(error.message), { code: error.code });
}
