// Browser-only fixture: no credentials or production client imported.
// 2026-09-27 — 분리 검수 M1(관리자 설정 "이용 중" team 플랜)·무료 기간 화면 3상태 스크린샷 검증용.
export const configured = true, customServer = false, SB_URL = 'http://fixture.invalid', SB_ANON = 'fixture';
const uid = 'user-me';
const now = Date.now();
const day = 86400000;
const orgs = [
  { id: 'org-trial', name: '무료 기간 중', ent: { plan: 'free', seats: null, ls_status: null, trial_ends_at: new Date(now + 20 * day).toISOString(), paid_until: null } },
  { id: 'org-ended', name: '무료 기간 종료', ent: { plan: 'free', seats: null, ls_status: null, trial_ends_at: new Date(now - 5 * day).toISOString(), paid_until: null } },
  { id: 'org-team', name: 'team 플랜', ent: { plan: 'team', seats: 5, ls_status: null, trial_ends_at: new Date(now - 5 * day).toISOString(), paid_until: null } },
];
const channel = (org) => ({ id: `${org.id}-general`, org_id: org.id, kind: 'public', name: 'general', topic: '', created_by: uid, archived_at: null, admin_user_ids: [], excluded_user_ids: [], excluded_crew_ids: [], crew_memory: true, personal_crews: true });
const state = window.__orgTrialFixture = { calls: [], tables: {
  msgr_org_members: orgs.map((o) => ({ user_id: uid, org_id: o.id, role: 'owner', display_name: 'Fixture Owner', expires_at: null, removed_at: null,
    msgr_orgs: { id: o.id, name: o.name, slug: o.id, owner_user_id: uid, service_user_id: null, node_seen_at: null, pending_owner_user_id: null, successor_user_id: null, auto_join_domain: null, auto_join_role: null, deleted_at: null, node_info: null } })),
  msgr_channels: orgs.map(channel),
  msgr_channel_members: orgs.map((o) => ({ channel_id: `${o.id}-general`, member_kind: 'user', member_id: uid })),
  msgr_crews: [],
  msgr_org_entitlements: orgs.map((o) => ({ org_id: o.id, ...o.ent })),
  msgr_org_policies: [],
  msgr_invites: [],
  msgr_audit_log: [],
} };
function result(call, action) { state.calls.push(structuredClone(call)); return { data: action(), error: null }; }
function query(table) {
  let cols = '*', one = false; const filters = [];
  const api = {
    select(c = '*') { cols = c; return api; },
    eq(k, v) { filters.push((r) => r[k] === v); return api; },
    is(k, v) { filters.push((r) => (r[k] ?? null) === v); return api; },
    in(k, vs) { filters.push((r) => vs.includes(r[k])); return api; },
    order() { return api; },
    limit() { return api; },
    maybeSingle() { one = true; return api; },
    single() { one = true; return api; },
    then(resolve, reject) {
      return Promise.resolve(result({ table, cols }, () => {
        const all = state.tables[table] ?? [];
        let rows = all.filter((r) => filters.every((f) => f(r)));
        if (table === 'msgr_org_members' && cols.includes('msgr_orgs')) rows = rows; // 이미 embed 형태로 시딩됨
        return structuredClone(one ? (rows[0] ?? null) : rows);
      })).then(resolve, reject);
    },
  };
  return api;
}
export const supabase = {
  from: query,
  auth: {
    getSession: async () => ({ data: { session: { user: { id: uid, email: 'fixture@example.invalid' }, access_token: 'fixture' } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  },
  rpc: async (name) => result({ rpc: name }, () => {
    if (name === 'msgr_joinable_orgs') return [];
    if (name === 'msgr_my_deleted_orgs') return [];
    if (name === 'msgr_is_report_operator') return false;
    return [];
  }),
  realtime: { setAuth: async () => {} },
  channel: (topic) => { const c = { on: () => c, subscribe: () => c, send: async () => {}, unsubscribe: async () => {} }; return c; },
  removeChannel: async () => 'ok',
  removeAllChannels: async () => {},
  storage: { from: () => ({ remove: async () => ({ data: [], error: null }) }) },
};
export async function q(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
