// 에이전트 패널(⌘J, 1단계). 대화 = 내 에이전트와의 1:1 방 안에서 패널이 보낸 첫 글(meta.source = office_panel, thread_root 없음)과 그 답글 묶음 — 게이트웨이 답도 reply_to·thread_root를 단다(msgr.mjs).
// 방 찾기·보내기 전 거절은 맡기기와 같은 crewRoom, 첨부 업로드·등록·빈 글 거두기는 메신저 composerTransport를 그대로 쓰고 글 쓰기만 바꿔 meta를 싣는다.
// 부하: 패널을 열 때 방 찾기 RPC 2~4건 + 글 1회(최근 150개) + 첨부 1회. 그 뒤로는 비공개 토픽 구독(폴링 없음) — 새 글·첨부 방송마다 그 한 줄만 읽는다. 진행 신호는 방송만(DB 0).
import { composerTransport } from '../../../../src/composer-delivery.mjs';
import { crewRoom } from './crew-assign.js';

export const PANEL_SOURCE = 'office_panel';
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

