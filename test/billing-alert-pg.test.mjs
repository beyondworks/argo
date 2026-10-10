// 결제 미연결 알림·하루 대사 호출(20261010170000_billing_unmatched_alert_reconcile.sql) — 실제 Postgres에서 트리거·함수를 실행한다.
// pg_net이 없는 임시 DB라 net.http_post는 호출을 표에 적는 가짜다(실제 발송 없음). ARGO_PG_TEST_URL 미설정이면 skip — `bash scripts/billing-pg-drill.sh test/billing-alert-pg.test.mjs`.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
import { billingAlertable } from '../supabase/functions/msgr-push/core.js';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh로 실행';
const migDir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
const OP = '11111111-1111-4111-8111-111111111111';

function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const calls = () => Number(sql('select count(*) from net.calls'));
let seq = 9_000_000;
const ins = (over = {}) => {
  const r = { event_name: 'subscription_created', reason: 'no-user', ls_subscription_id: String(seq++), ls_customer_id: '1', user_email: 'pay@example.com', ...over };
  return sql(`insert into public.billing_unmatched(event_name, reason, ls_subscription_id, ls_customer_id, user_email)
    values ('${r.event_name}', '${r.reason}', '${r.ls_subscription_id}', '${r.ls_customer_id}', '${r.user_email}') returning id`);
};

before(() => {
  if (!DB) return;
  sql(`create schema if not exists auth; create schema if not exists net; create schema if not exists extensions;
    do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if; end $$;
    create table if not exists auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, created_at timestamptz default now());
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('argo.uid', true), '')::uuid $$;
    grant usage on schema public to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;`);
  // 가짜 pg_net — 주소·머리글·본문을 적는다
  sql(`create table if not exists net.calls (url text, headers jsonb, body jsonb, at timestamptz default now());
    create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
      language plpgsql as $$ begin insert into net.calls(url, headers, body) values (url, headers, body); return 1; end $$;`);
  for (const f of readdirSync(migDir).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
    psqlRaw(['-v', 'ON_ERROR_STOP=0', '-f', `${migDir}${f}`]); // 무관한 마이그레이션 실패(스토리지 정책 등)는 넘어간다 — 필요한 표·함수는 아래에서 확인
  }
  assert.equal(sql(`select count(*) from pg_trigger where tgname = 'billing_unmatched_notify'`), '1', '알림 트리거가 적용됐다');
  assert.equal(sql(`select count(*) from pg_proc where proname in ('msgr_push_headers', 'ls_reconcile_kick', 'billing_unmatched_alertable')`), '3');
  sql(`insert into auth.users(id, email) values ('${OP}', 'op@x.test') on conflict do nothing;
    insert into public.msgr_report_operators(user_id) values ('${OP}') on conflict do nothing;
    insert into public.msgr_settings(key, value) values ('push_url', 'https://push.test/msgr-push'), ('push_secret', 'push-sec')
      on conflict (key) do update set value = excluded.value;
    truncate net.calls;`);
});

test('실결제 미연결 행이 새로 생기면 운영자 푸시를 한 번 부른다(push_url·공유 비밀·행 번호만)', { skip }, () => {
  sql('truncate net.calls');
  const id = ins({ reason: 'no-user', ls_subscription_id: '2595064' });
  assert.equal(calls(), 1);
  assert.equal(sql('select url from net.calls'), 'https://push.test/msgr-push');
  assert.equal(sql(`select headers->>'Authorization' from net.calls`), 'Bearer push-sec');
  assert.equal(sql('select body::text from net.calls'), `{"billing_unmatched_id": ${id}}`, '본문에 이메일·구독 번호를 싣지 않는다 — msgr-push가 행을 다시 읽는다');
  // 같은 이벤트 재전송(같은 구독·사유) = 충돌로 무시 → 알림 없음. 행 갱신도 알림 없음
  sql(`insert into public.billing_unmatched(event_name, reason, ls_subscription_id) values ('subscription_updated', 'no-user', '2595064')
    on conflict (ls_subscription_id, reason) do nothing`);
  sql(`update public.billing_unmatched set event_name = 'subscription_updated', user_email = 'x@y.z' where id = ${id}`);
  assert.equal(calls(), 1, '재전송·갱신은 알림을 다시 만들지 않는다');
  for (const reason of ['duplicate-attribution', 'email-account-has-subscription', 'reconcile-ls-pro-not-linked', 'reconcile-pro-not-in-ls']) ins({ reason });
  assert.equal(calls(), 5, '연결 실패·대사 불일치 사유는 전부 알린다');
});

test('시험 결제·probe·숫자 아닌 구독·처리된 행·다른 사유는 알리지 않는다', { skip }, () => {
  sql('truncate net.calls');
  ins({ reason: 'test-mode' });
  ins({ reason: 'other-product:5' });
  ins({ reason: 'unknown-status' });
  ins({ ls_subscription_id: 'probe-1' });
  ins({ ls_subscription_id: '' });
  ins({ event_name: 'probe' });
  ins({ event_name: 'test_ping' });
  sql(`insert into public.billing_unmatched(event_name, reason, ls_subscription_id, resolved_at) values ('subscription_created', 'no-user', '${seq++}', now())`);
  assert.equal(calls(), 0);
});

test('대상 규칙 — SQL billing_unmatched_alertable과 msgr-push billingAlertable이 같은 답을 낸다', { skip }, () => {
  const rows = [
    {}, { reason: 'test-mode' }, { reason: 'duplicate-attribution' }, { reason: 'reconcile-pro-not-in-ls' }, { reason: 'other-product:1' },
    { ls_subscription_id: 'abc' }, { ls_subscription_id: '' }, { ls_subscription_id: '12a' }, { event_name: 'PROBE' }, { event_name: 'reconcile-daily' },
    { event_name: 'subscription_test' }, { resolved_at: '2026-10-10T00:00:00Z' },
  ];
  for (const over of rows) {
    const r = { event_name: 'subscription_created', reason: 'no-user', ls_subscription_id: '123', resolved_at: null, ...over };
    // 열 이름으로 행을 만든다 — 다른 PR(#933)이 열을 더해 순서가 바뀌어도 그대로 돈다
    const q = `select public.billing_unmatched_alertable(jsonb_populate_record(null::public.billing_unmatched, '${JSON.stringify({ id: 1, ...r })}'::jsonb))`;
    assert.equal(sql(q) === 't', billingAlertable(r), JSON.stringify(over));
  }
});

test('운영자가 없거나 push_url이 없으면 부르지 않는다(기록은 남는다)', { skip }, () => {
  sql('truncate net.calls');
  sql(`delete from public.msgr_report_operators`);
  const a = ins();
  sql(`insert into public.msgr_report_operators(user_id) values ('${OP}')`);
  sql(`delete from public.msgr_settings where key = 'push_url'`);
  const b = ins();
  sql(`insert into public.msgr_settings(key, value) values ('push_url', 'https://push.test/msgr-push')`);
  assert.equal(calls(), 0);
  assert.equal(sql(`select count(*) from public.billing_unmatched where id in (${a}, ${b})`), '2', '알림이 못 가도 미연결 기록은 남는다');
});

test('ls_reconcile_kick — 주소·비밀이 둘 다 있을 때만 대사 엣지를 부른다, 일반 사용자는 실행 못 한다', { skip }, () => {
  sql('truncate net.calls');
  sql('select public.ls_reconcile_kick()');
  sql(`insert into public.msgr_settings(key, value) values ('ls_reconcile_url', 'https://edge.test/ls-reconcile')`);
  sql('select public.ls_reconcile_kick()');
  assert.equal(calls(), 0, '비밀이 없으면 부르지 않는다');
  sql(`insert into public.msgr_settings(key, value) values ('ls_reconcile_secret', 'rec-sec')`);
  sql('select public.ls_reconcile_kick()');
  assert.equal(calls(), 1);
  assert.equal(sql('select url from net.calls'), 'https://edge.test/ls-reconcile');
  assert.equal(sql(`select headers->>'Authorization' from net.calls`), 'Bearer rec-sec');
  for (const fn of ['ls_reconcile_kick()', 'billing_unmatched_notify()']) {
    assert.equal(sql(`select has_function_privilege('authenticated', 'public.${fn}', 'execute')`), 'f', fn);
    assert.equal(sql(`select has_function_privilege('anon', 'public.${fn}', 'execute')`), 'f', fn);
  }
  // msgr_settings(비밀이 사는 곳)는 일반 사용자가 못 읽는다
  const r = psqlRaw(['-A', '-t', '-c', `set role authenticated; select value from public.msgr_settings where key = 'ls_reconcile_secret'`]);
  assert.ok(r.status !== 0 || r.stdout.trim() === '', '사용자 역할로 대사 비밀을 읽을 수 없다');
});

test('PR #933 열(test_mode)이 생겨도 같은 트리거로 시험 결제를 거른다', { skip }, () => {
  sql('alter table public.billing_unmatched add column if not exists test_mode boolean not null default false');
  sql('truncate net.calls');
  sql(`insert into public.billing_unmatched(event_name, reason, ls_subscription_id, test_mode) values ('subscription_created', 'no-user', '${seq++}', true)`);
  assert.equal(calls(), 0, 'test_mode=true는 알리지 않는다');
  sql(`insert into public.billing_unmatched(event_name, reason, ls_subscription_id, test_mode) values ('subscription_created', 'no-user', '${seq++}', false)`);
  assert.equal(calls(), 1);
});

test('한 시간에 20행이 넘으면 푸시는 건너뛴다(행은 남는다) — 마지막에 돈다', { skip }, () => {
  const before = Number(sql(`select count(*) from public.billing_unmatched where created_at > now() - interval '1 hour'`));
  sql('truncate net.calls');
  const n = Math.max(0, 25 - before);
  for (let i = 0; i < n; i++) ins();
  const total = Number(sql(`select count(*) from public.billing_unmatched where created_at > now() - interval '1 hour'`));
  assert.ok(total >= 25);
  assert.equal(calls(), Math.max(0, 20 - before), '20행까지만 알린다');
});
