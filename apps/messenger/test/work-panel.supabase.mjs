// Authenticated browser fixture only. No real client, credentials, or network backend.
import { supabase as base } from './dm-lifecycle.supabase.mjs';
export { configured, customServer, SB_URL, SB_ANON, q } from './dm-lifecycle.supabase.mjs';
const state = window.__workFixture = Object.assign(window.__dmFixture, { unavailable: false, workCalls: [], hold: null, fail: null, missingNotifications: false });
Object.assign(state.tables, { msgr_work_runs: [], msgr_automations: [], msgr_automation_runs: [], msgr_notification_deliveries: [], msgr_crew_routines: [], msgr_crew_routine_edits: [] });
state.tables.msgr_channels.forEach(channel => { channel.personal_crews = 'allowed'; });
state.tables.msgr_crews.forEach(crew => { crew.work_protocol = 1; });
const now = () => new Date().toISOString();
// 업무 > 자동화 1단계 — 채널(crew-new · general)과 1:1(crew-existing)에 각각 Argo 루틴 시드 + 반영 대기 편집 1건(WORK_FILTER=routine)
state.tables.msgr_crew_routines.push(
  { id: 'routine-1', crew_id: 'crew-new', title: 'Fixture morning brief', prompt: 'Summarize overnight updates.', schedule: { type: 'daily', time: '09:00', times: ['09:00'], tz: 'Asia/Seoul' }, enabled: true, channel_id: 'general', updated_at: now() },
  { id: 'routine-2', crew_id: 'crew-existing', title: 'Fixture weekly digest', prompt: 'Compile this week’s notes.', schedule: { type: 'weekly', time: '18:00', times: ['18:00'], dows: [1, 3, 5], tz: 'Asia/Seoul' }, enabled: true, channel_id: null, updated_at: now() },
);
state.tables.msgr_crew_routine_edits.push({ id: 'edit-1', routine_id: 'routine-2', status: 'pending', op: 'update', patch: { title: 'Fixture weekly digest (edited)' }, created_at: now() });
let nextId = 500;
async function response(name, args, action) {
  state.workCalls.push({ name, args: structuredClone(args) });
  if (state.hold === name) { state.hold = null; await new Promise(resolve => { state.release = () => { state.release = null; resolve(); }; }); }
  if (state.unavailable) return { data: null, error: { code: 'PGRST205', message: 'Could not find the table in the schema cache' } };
  if (state.fail === name) { state.fail = null; return { data: null, error: { message: 'Fixture network failure' } }; }
  try { return { data: structuredClone(action()), error: null }; }
  catch (error) { return { data: null, error: { message: error.message } }; }
}
const originalFrom = base.from, originalRpc = base.rpc;
base.from = (table) => {
  if (!['msgr_work_runs', 'msgr_automations', 'msgr_automation_runs', 'msgr_notification_deliveries', 'msgr_messages', 'msgr_crew_routines', 'msgr_crew_routine_edits'].includes(table)) return originalFrom(table);
  let count = Infinity, offset = 0, orderKey, ascending = true, single = false, columns;
  const filters = [], api = {
    select(value) { columns = value; return api; }, eq(key, value) { filters.push(row => row[key] === value); return api; },
    neq(key, value) { filters.push(row => row[key] !== value); return api; },
    is(key, value) { filters.push(row => (row[key] ?? null) === value); return api; },
    in(key, values) { filters.push(row => values.includes(row[key])); return api; },
    contains(key, values) { filters.push(row => values.every(value => (row[key] ?? []).includes(value))); return api; },
    gt(key, value) { filters.push(row => row[key] > value); return api; }, lt(key, value) { filters.push(row => row[key] < value); return api; },
    or(value) { const options = value.split(',').map(part => { const [key, op, ...rest] = part.split('.'); return { key, op, value: rest.join('.') }; }); filters.push(row => options.some(option => option.op === 'eq' && String(row[option.key]) === option.value)); return api; },
    order(key, options = {}) { orderKey = key; ascending = options.ascending ?? true; return api; }, limit(value) { count = value; return api; },
    range(start, end) { offset = start; count = end - start + 1; return api; },
    maybeSingle() { single = true; return api; }, single() { single = true; return api; },
    then(resolve, reject) { if (state.missingNotifications && columns?.includes('notification_route_ids')) return Promise.resolve({data:null,error:{code:'42703',message:'column notification_route_ids does not exist'}}).then(resolve,reject); return response(table, {}, () => { let rows = state.tables[table].filter(row => filters.every(filter => filter(row))); if (orderKey) rows.sort((a, b) => (a[orderKey] < b[orderKey] ? -1 : a[orderKey] > b[orderKey] ? 1 : 0) * (ascending ? 1 : -1)); rows = rows.slice(offset, offset + count); return single ? rows[0] ?? null : rows; }).then(resolve, reject); },
  };
  return api;
};
base.rpc = (name, args = {}) => {
  if (name === 'msgr_unread' && state.unreadRows) return Promise.resolve({ data: structuredClone(state.unreadRows), error: null }); // 하네스 시드(state.unreadRows)가 있을 때만 — 안읽음 필터 양성 검사용
  if (name === 'msgr_dm_latest') { // 폰 DM 탭 최근순 재료 — 채널당 마지막 글(실서버 RPC와 같은 모양: channel_id·last_id·last_at)
    const dmIds = new Set((state.tables.msgr_channels ?? []).filter((c) => c.kind === 'dm' && c.org_id === args.org && !c.archived_at).map((c) => c.id));
    const latest = new Map(); for (const m of state.tables.msgr_messages) if (dmIds.has(m.channel_id) && !m.deleted_at && (!latest.has(m.channel_id) || latest.get(m.channel_id).id < m.id)) latest.set(m.channel_id, m);
    return Promise.resolve({ data: [...latest.entries()].map(([channel_id, m]) => ({ channel_id, last_id: m.id, last_at: m.created_at })), error: null });
  }
  if (!name.startsWith('msgr_work_') && !name.startsWith('msgr_automation_') && !name.startsWith('msgr_notification_') && !name.startsWith('msgr_crew_routine')) return originalRpc(name, args);
  if (state.missingNotifications && /msgr_notification_|save_with_notifications/.test(name)) return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
  return response(name, args, () => {
    if (name === 'msgr_notification_routes_list') return [{id:'route-telegram',kind:'telegram',ws_id:'fixture-company',label:'Fixture Telegram',ready:true},{id:'route-slack',kind:'slack',ws_id:'fixture-company',label:'Fixture Slack',ready:false}];
    if (name === 'msgr_work_create') {
      const prior = state.tables.msgr_work_runs.find(row => row.request_id === args.p_request); if (prior) return prior;
      const row = { id: `work-${nextId++}`, request_id: args.p_request, channel_id: args.p_channel, goal: args.p_goal, completion_criteria: args.p_completion, lead_crew_id: args.p_lead || 'crew-new', created_by: 'user-me', status: 'planning', created_at: now(), root_message_id: nextId++ };
      state.tables.msgr_work_runs.push(row);
      state.tables.msgr_messages.push({ id: row.root_message_id, channel_id: row.channel_id, body: row.goal, author_kind: 'user', created_at: now(), deleted_at: null }, { id: nextId++, channel_id: row.channel_id, body: 'Fixture team discussion', author_kind: 'crew', crew_id: 'crew-new', reply_to: row.root_message_id, thread_root: row.root_message_id, created_at: now(), deleted_at: null });
      return row;
    }
    if (name === 'msgr_work_cancel' || name === 'msgr_work_resume') { const row = state.tables.msgr_work_runs.find(row => row.id === args.p_run); row.status = name.endsWith('cancel') ? 'cancelled' : 'planning'; return row; }
    if (name === 'msgr_automation_save' || name === 'msgr_automation_save_with_notifications') {
      let row = state.tables.msgr_automations.find(row => row.id === args.automation);
      if (!row) { row = { id: `automation-${nextId++}`, created_by: 'user-me', created_at: now(), enabled: true, deleted_at: null }; state.tables.msgr_automations.push(row); }
      Object.assign(row, { channel_id: args.channel, crew_id: args.crew, title: args.title, prompt: args.prompt, schedule: args.schedule, notification_route_ids: args.notification_route_ids ?? [], next_run_at: now() }); return row;
    }
    if (name === 'msgr_automation_set_enabled') { const row = state.tables.msgr_automations.find(row => row.id === args.automation); row.enabled = args.enabled; return row; }
    if (name === 'msgr_automation_delete') { state.tables.msgr_automations.find(row => row.id === args.automation).deleted_at = now(); return true; }
    if (name === 'msgr_automation_run_now') { const row = { id: `run-${nextId++}`, automation_id: args.automation, trigger: 'manual', status: 'queued', notification_route_ids: state.tables.msgr_automations.find(row => row.id === args.automation)?.notification_route_ids ?? [], created_at: now() }; state.tables.msgr_automation_runs.push(row); return row; }
    if (name === 'msgr_automation_scheduler_status') return { server_active: true, last_seen_at: now() };
    if (name === 'msgr_crew_routine_edit') {
      state.tables.msgr_crew_routine_edits.filter(row => row.routine_id === args.p_routine && row.status === 'pending').forEach(row => { row.status = 'superseded'; });
      const row = { id: `edit-${nextId++}`, routine_id: args.p_routine, status: 'pending', op: args.p_op, patch: args.p_patch ?? {}, created_at: now() };
      state.tables.msgr_crew_routine_edits.push(row); return row;
    }
    throw new Error(`Unexpected fixture RPC: ${name}`);
  });
};
export const supabase = base;
