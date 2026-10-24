// 자동화 일정 v2(20261024100000) — 업무 창이 부르는 옛 이름(msgr_automations·msgr_automation_*)이 v2 어댑터를 거쳐 msgr2_* 표·RPC로 가고, 옛 모양으로 돌아온다.
// 업무 창은 셸의 클라이언트(v2 어댑터)를 받아 쓴다 — 원래 클라이언트를 직접 쓰면 v2에서 옛 표를 부른다(화면 확인 중 실제로 그랬다, 2026-10-24).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createV2Client, v2Route } from '../src/v2/source.mjs';

const DM = '7f000000-0000-4000-8000-000000000003', A = 'a0000000-0000-4000-8000-000000000001';
const DAILY = { kind: 'daily', time: '09:00', timezone: 'Asia/Seoul' };

test('어댑터: 자동화 목록·실행 기록은 v2 표로, 행은 옛 열 이름(channel_id·crew_id)으로 — 알림 대상 열은 v2에 없어 null', async () => {
  globalThis.window ??= {}; globalThis.location ??= { search: '' };
  const { supabase: fake } = await import('./v2-shell.supabase.mjs');
  const f = globalThis.window.__v2Fixture; const c = createV2Client(fake, { personalSpace: async () => f.ids.P });
  const before = f.calls.length;
  const r = await c.from('msgr_automations').select('id,channel_id,crew_id,created_by,title,prompt,schedule,enabled,next_run_at,last_run_at,last_status,notification_route_ids')
    .eq('channel_id', DM).is('deleted_at', null).order('created_at', { ascending: false }).order('id', { ascending: false }).range(0, 25);
  assert.equal(r.error, null);
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0].channel_id, DM); assert.equal(r.data[0].crew_id, A); assert.equal(r.data[0].notification_route_ids, null);
  const runs = await c.from('msgr_automation_runs').select('*').eq('automation_id', r.data[0].id).order('created_at', { ascending: false }).limit(20);
  assert.equal(runs.data.length, 3);
  assert.deepEqual(f.calls.slice(before).map((x) => x.table), ['msgr2_automations', 'msgr2_automation_runs'], '옛 표(msgr_automations)는 부르지 않는다');
});

test('어댑터: 저장·켜고 끄기·지금 실행·삭제·실행기 상태는 msgr2_automation_* RPC로(옛 인자 → p_*), v2_unsupported가 아니다', async () => {
  const { supabase: fake } = await import('./v2-shell.supabase.mjs');
  const f = globalThis.window.__v2Fixture; const c = createV2Client(fake, { personalSpace: async () => f.ids.P });
  for (const n of ['msgr_automation_save_with_notifications', 'msgr_automation_set_enabled', 'msgr_automation_run_now', 'msgr_automation_delete', 'msgr_automation_scheduler_status']) assert.equal(v2Route('rpc', n), 'map', n);
  const before = f.calls.length;
  const s = await c.rpc('msgr_automation_save_with_notifications', { automation: null, channel: DM, crew: A, title: '저녁 정리', prompt: '할 일만', schedule: DAILY, request_id: 'r1', notification_route_ids: ['x'] });
  assert.equal(s.error, null); assert.equal(s.data.channel_id, DM); assert.equal(s.data.crew_id, A); assert.deepEqual(s.data.notification_route_ids, [], '알림 대상은 v2에 없다 — 버린다');
  assert.equal((await c.rpc('msgr_automation_set_enabled', { automation: s.data.id, enabled: false })).data.enabled, false);
  assert.equal((await c.rpc('msgr_automation_run_now', { automation: s.data.id, request_id: 'q1' })).data.trigger, 'manual');
  assert.equal((await c.rpc('msgr_automation_scheduler_status')).data.server_active, true);
  assert.equal((await c.rpc('msgr_automation_delete', { automation: s.data.id })).data, true);
  assert.deepEqual(f.calls.slice(before).map((x) => x.rpc).filter(Boolean),
    ['msgr2_automation_save', 'msgr2_automation_set_enabled', 'msgr2_automation_run_now', 'msgr2_automation_scheduler_status', 'msgr2_automation_delete']);
  assert.equal((await c.rpc('msgr_automation_save_with_notifications', { automation: null, channel: DM, crew: 'nope', title: 't', prompt: 'p', schedule: DAILY })).error.message, 'msgr_automation_forbidden', '서버 거부는 원문 그대로(화면 문구는 work-panel errorText)');
});

test('업무 창: 셸의 클라이언트를 받아 쓰고, v2에서는 팀 업무 탭·루틴·알림 선택·옛 스레드 단추를 숨긴다', () => {
  const src = readFileSync(new URL('../src/work-panel.jsx', import.meta.url), 'utf8');
  assert.match(src, /const supabase = client \?\? rawSupabase;/);
  assert.match(src, /useRows\('msgr_automations', channel\.id, tab === 'automations', '', supabase\)/);
  assert.doesNotMatch(src, /^import \{ supabase \} from '\.\/supabase\.js';/m, '원래 클라이언트를 모듈 전체에서 직접 쓰지 않는다');
  assert.match(src, /useState\(v2 \? 'automations' : 'team'\)/);
  assert.match(src, /\{!v2 && <div className="work-tabs" role="tablist"/);
  assert.match(src, /const routines = v2 \? NO_ROUTINES : crewRoutines;/);
  assert.match(src, /\{v2 && <p className="work-note">\{t\('routine\.v2\.soon'\)\}<\/p>\}/);
  assert.match(src, /\{!v2 && <fieldset className="work-notification-routes">/);
  assert.match(src, /\{run\.message_id && !v2 && <button/);
  const i18n = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
  for (const k of ['automation.intro.v2', 'routine.v2.soon', 'automation.error.pro', 'automation.error.noWork', 'automation.error.expired', 'automation.error.dispatch', 'automation.error.stalled', 'automation.error.session'])
    assert.match(i18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
});
