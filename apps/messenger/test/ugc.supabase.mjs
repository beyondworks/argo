// UGC 신고·차단 브라우저 픽스처(App Store 1.2, 2026-09-21) — work-panel 가짜 백엔드 위에 동료·에이전트 글과 신고·차단 RPC 흉내를 얹는다.
// 서버 규칙(자기 글 거부·차단 목록·신고 목록)의 실검증은 test/msgr-ugc-report-pg.test.mjs — 여기서는 화면 흐름만 본다.
import { supabase as base } from './work-panel.supabase.mjs';
export { configured, customServer, SB_URL, SB_ANON, q } from './work-panel.supabase.mjs';
const state = window.__workFixture;
const t = state.tables, now = new Date().toISOString();
t.msgr_messages.push(
  { id: 201, channel_id: 'general', author_kind: 'user', author_user_id: 'user-other', kind: 'text', body: 'Colleague message to report', created_at: now, deleted_at: null, mentions: [] },
  { id: 202, channel_id: 'general', author_kind: 'crew', crew_id: 'crew-new', kind: 'text', body: 'Agent answer', created_at: now, deleted_at: null, mentions: [] },
  { id: 203, channel_id: 'general', author_kind: 'user', author_user_id: 'user-me', kind: 'text', body: 'My own message', created_at: now, deleted_at: null, mentions: [] },
  { id: 205, channel_id: 'general', author_kind: 'user', author_user_id: 'user-other', kind: 'text', body: 'Colleague mentions you', created_at: now, deleted_at: null, mentions: [{ kind: 'user', id: 'user-me' }] },
  { id: 204, channel_id: 'general', author_kind: 'user', author_user_id: 'user-me', kind: 'text', body: 'Replying to colleague', reply_to: 201, created_at: now, deleted_at: null, mentions: [] },
);
// msgr_messages 조회 보강 — 공용 가짜는 contains(JSON 문자열)·ilike를 몰라 알림함 멘션·검색이 늘 빈다. 이 픽스처에서만 둘을 처리한다(org_id 조건은 한 조직이라 통과)
const originalFrom = base.from;
base.from = (table) => {
  if (table !== 'msgr_messages') return originalFrom(table);
  const filters = []; let lim = Infinity, orderKey = 'id', asc = true;
  const api = {
    select() { return api; }, order(k, o = {}) { orderKey = k; asc = o.ascending ?? true; return api; }, limit(n) { lim = n; return api; },
    eq(k, v) { if (k !== 'org_id') filters.push((r) => r[k] === v); return api; }, neq(k, v) { filters.push((r) => r[k] !== v); return api; },
    is(k, v) { filters.push((r) => (r[k] ?? null) === v); return api; }, in(k, vs) { filters.push((r) => vs.includes(r[k])); return api; },
    lt(k, v) { filters.push((r) => r[k] < v); return api; }, gt(k, v) { filters.push((r) => r[k] > v); return api; },
    or() { return api; }, maybeSingle() { lim = 1; return api; }, single() { lim = 1; return api; }, range(a, b) { lim = b - a + 1; return api; },
    contains(k, v) { const want = typeof v === 'string' ? JSON.parse(v) : v; filters.push((r) => want.every((w) => (r[k] ?? []).some((x) => JSON.stringify(x) === JSON.stringify(w)))); return api; },
    ilike(k, pat) { const needle = pat.replace(/%/g, '').toLowerCase(); filters.push((r) => String(r[k] ?? '').toLowerCase().includes(needle)); return api; },
    then(res, rej) { const rows = t.msgr_messages.filter((r) => filters.every((f) => f(r))).sort((a, b) => (a[orderKey] > b[orderKey] ? 1 : -1) * (asc ? 1 : -1)).slice(0, lim); return Promise.resolve({ data: structuredClone(rows), error: null }).then(res, rej); },
  };
  return api;
};
const ugc = state.ugc = { reports: [], blocked: [], calls: [] };
const ok = (data) => Promise.resolve({ data: structuredClone(data), error: null });
const original = base.rpc;
base.rpc = (name, args = {}) => {
  if (!/^msgr_(report|reports_list|my_blocked|friend_remove|friend_unblock|is_report_operator)/.test(name)) return original(name, args);
  ugc.calls.push({ name, args: structuredClone(args) });
  if (name === 'msgr_report_message') {
    const m = t.msgr_messages.find((x) => x.id === args.msg);
    if (m.author_user_id === 'user-me') return Promise.resolve({ data: null, error: { message: 'msgr_report_own' } });
    const r = { id: `report-${ugc.reports.length + 1}`, message_id: m.id, channel_id: m.channel_id, org_id: m.org_id, reporter_user_id: 'user-me', author_user_id: m.author_user_id ?? null, reason: args.reason, status: 'open', created_at: now, message_body: m.body, message_created_at: m.created_at };
    ugc.reports.push(r); return ok(r.id);
  }
  if (name === 'msgr_is_report_operator') return ok(!!state.ugcOperator);
  if (name === 'msgr_reports_list') return ok(ugc.reports);
  if (name === 'msgr_report_resolve') { ugc.reports.find((r) => r.id === args.report).status = 'resolved'; return ok(null); }
  if (name === 'msgr_my_blocked') return ok(ugc.blocked);
  if (name === 'msgr_friend_remove' && args.block) { if (!ugc.blocked.some((b) => b.user_id === args.other)) ugc.blocked.push({ user_id: args.other, handle: 'colleague', display_name: 'Fixture Colleague', created_at: now }); return ok(null); }
  if (name === 'msgr_friend_unblock') { ugc.blocked = ugc.blocked.filter((b) => b.user_id !== args.other); return ok(null); }
  return ok(null);
};
export const supabase = base;
