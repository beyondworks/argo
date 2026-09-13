// Real PostgreSQL automation authorization, scheduling and execution regressions. Isolated DB via billing-pg-drill.sh.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { // 고정 uuid — 값은 전부 이 파일의 상수(주입 표면 없음)
  owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222',
  member: '33333333-3333-4333-8333-333333333333', guest: '44444444-4444-4444-8444-444444444444',
  svc: '77777777-7777-4777-8777-777777777777',
};

function psqlRaw(args) { return spawnSync('psql', [DB, '-X', '-v', 'ON_ERROR_STOP=1', '-q', ...args], { encoding: 'utf8' }); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();                 // 슈퍼유저(RLS 우회) — 시드·관찰 전용. BEFORE 트리거는 슈퍼유저에도 돈다
const sqlRaw = (q) => psqlRaw(['-A', '-t', '-c', q]);
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';        // set_config 출력 뒤 마지막 결과 줄
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, label); };

let ORG, OTHER_ORG, CREW, OTHER_CREW, CH;
before(() => {
  if (!DB) return;
  psql(['-c', `
    do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end $$;
    grant usage on schema public to anon, authenticated, service_role;
    create schema if not exists auth;
    grant usage on schema auth to anon, authenticated, service_role;
    create table if not exists auth.users (id uuid primary key, created_at timestamptz not null default now(), email text);
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('argo.uid', true), '')::uuid $$;
    create schema if not exists storage;
    create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
    create table if not exists storage.buckets (id text primary key, name text, public boolean not null default false);
    create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated; grant select, insert, delete on storage.objects to authenticated;
    create schema if not exists realtime;
    create table if not exists realtime.messages (id bigint generated always as identity primary key, topic text, extension text, payload jsonb);
    create table if not exists realtime.sent (id bigint generated always as identity primary key, payload jsonb, event text, topic text, private boolean);
    create or replace function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
      language sql as $$ insert into realtime.sent (payload, event, topic, private) values (payload, event, topic, private) $$;
    alter table realtime.messages enable row level security;
    grant select, insert on realtime.messages to authenticated;
    grant usage on schema realtime to authenticated;
  `]);
  // 배포될 마이그레이션을 라이브와 같은 순서로 그대로 적용(제외 목록 열은 20260911150000이 만든다)
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql',
    '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql',
    '20260903120000_msgr.sql', '20260907120000_msgr_crew_inventory.sql', '20260908120000_msgr_bots.sql', '20260908140000_msgr_crew_autodispatch.sql',
    '20260909000000_msgr_bot_external_id.sql', '20260909001000_msgr_crew_folder.sql', '20260909002000_msgr_profiles_friends.sql', '20260909003000_msgr_message_meta.sql',
    '20260909004000_msgr_p0_reads_reactions_prefs.sql', '20260909005000_msgr_avatars.sql', '20260909120000_msgr_execution_claims.sql', '20260909230000_msgr_bot_execution.sql',
    '20260911150000_msgr_channel_manage.sql', '20260911230000_msgr_channel_scope_enforce.sql', '20260912135036_msgr_target_favorites_dm_leave.sql', '20260913010000_msgr_work_runs.sql', '20260913110000_msgr_automations.sql']) psql(['-f', mig(f)]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  OTHER_ORG = last(asUser(U.guest, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Other', 'other', '${U.guest}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const uid of [U.admin, U.member]) {
    const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.owner}') returning code`));
    assert.equal(last(asUser(uid, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  CREW = last(asUser(U.owner, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.owner}', 'lean', 'mine', 'Mine') returning id`));
  OTHER_CREW = last(asUser(U.member, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.member}', 'lean', 'theirs', 'Theirs') returning id`));
  CH = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}','public','Automation tests','[]')`));
  sql(`update public.msgr_crews set status = 'active', allow = 'all' where org_id = '${ORG}'`);
});
const create = (user=U.owner, schedule={kind:'daily',timezone:'Asia/Seoul',time:'09:00'}) => JSON.parse(last(asUser(user,`select public.msgr_automation_save(null,'${CH}','${CREW}','Daily brief','Summarize our channel','${JSON.stringify(schedule)}')`)));
const rpc = (user,q) => { const v=last(asUser(user,`select ${q}`)); return v==='t'?true:v==='f'?false:JSON.parse(v); };
const due = (id) => sql(`update public.msgr_automations set next_run_at = now()-interval '1 minute' where id='${id}'`);
const run = id => rpc(U.owner,`public.msgr_automation_run_now('${id}')`);
const cloud = () => JSON.parse(sql('select public.msgr_automation_dispatch_cloud()'));
const next = (s, at) => sql(`select public.msgr_automation_next('${JSON.stringify(s)}','${at}') at time zone 'UTC'`);

test('strict timezone schedules skip DST gaps and choose one repeated time', {skip}, () => {
  assert.equal(next({kind:'daily',timezone:'Asia/Seoul',time:'09:00'},'2026-09-13T00:00:00Z'),'2026-09-14 00:00:00');
  assert.equal(next({kind:'weekly',timezone:'UTC',time:'09:00',weekdays:[1]},'2026-09-13T10:00:00Z'),'2026-09-14 09:00:00');
  assert.equal(next({kind:'daily',timezone:'America/New_York',time:'02:30'},'2026-03-08T00:00:00Z'),'2026-03-09 06:30:00');
  assert.equal(next({kind:'daily',timezone:'America/New_York',time:'01:30'},'2026-11-01T00:00:00Z'),'2026-11-01 06:30:00');
  assert.equal(next({kind:'daily',timezone:'America/New_York',time:'01:30'},'2026-11-01T06:30:00Z'),'2026-11-02 06:30:00');
  for(const s of [{kind:'daily',timezone:'Invalid/Zone',time:'09:00'},{kind:'weekly',timezone:'UTC',time:'12:00',weekdays:[0]},{kind:'interval',timezone:'UTC',minutes:0}]) fails(sqlRaw(`select public.msgr_automation_next('${JSON.stringify(s)}',now())`),/invalid_schedule/,'invalid schedule');
});
test('authenticated CRUD is creator-only, authorized and no direct table mutation', {skip},()=>{
  const a=create();
  assert.equal(a.created_by,U.owner);
  fails(asUserRaw(U.guest,`select public.msgr_automation_save(null,'${CH}','${CREW}','x','y','{"kind":"interval","timezone":"UTC","minutes":10}')`),/forbidden/,'foreign actor');
  fails(asUserRaw(U.member,`select public.msgr_automation_set_enabled('${a.id}',false)`),/forbidden/,'other creator');
  fails(asUserRaw(U.member,`update public.msgr_automations set created_by='${U.member}'`),/permission denied/,'direct mutation');
  rpc(U.owner,`public.msgr_automation_save('${a.id}','${CH}','${CREW}','Renamed','New prompt','{"kind":"interval","timezone":"UTC","minutes":10}')`);
  assert.equal(sql(`select title from public.msgr_automations where id='${a.id}'`),'Renamed');
  rpc(U.owner,`public.msgr_automation_delete('${a.id}')`);
});
test('due dispatch writes one authorized command, retries coalesce and manual run uses same channel pipeline', {skip},()=>{
  const a=create();due(a.id);
  const first=rpc(U.owner,"public.msgr_automation_dispatch_due('lean')");
  assert.equal(first.length,1);assert.equal(first[0].status,'queued');
  assert.deepEqual(rpc(U.owner,"public.msgr_automation_dispatch_due('lean')"),[]);
  const m=JSON.parse(sql(`select row_to_json(m) from public.msgr_messages m where id=${first[0].message_id}`));
  assert.equal(m.author_user_id,U.owner);assert.equal(m.channel_id,CH);assert.equal(m.meta.automation_id,a.id);assert.deepEqual(m.mentions,[{kind:'crew',id:CREW}]);
  const manual=run(a.id);assert.equal(manual.status,'queued');
  rpc(U.owner,`public.msgr_automation_delete('${a.id}')`);
});
test('paused/deleted automations cannot dispatch, offline missed slots coalesce without burst', {skip},()=>{
  const a=create(U.owner,{kind:'interval',timezone:'UTC',minutes:5});
  rpc(U.owner,`public.msgr_automation_set_enabled('${a.id}',false)`);due(a.id);assert.deepEqual(cloud(),[]);
  rpc(U.owner,`public.msgr_automation_set_enabled('${a.id}',true)`);
  sql(`update public.msgr_automations set next_run_at=now()-interval '20 days' where id='${a.id}'`);
  assert.equal(cloud().length,1);assert.deepEqual(cloud(),[]);
  assert.equal(sql(`select next_run_at > now() from public.msgr_automations where id='${a.id}'`),'t');
  rpc(U.owner,`public.msgr_automation_delete('${a.id}')`);due(a.id);assert.deepEqual(cloud(),[]);
});
test('revoked creator permission blocks future commands and disables schedule', {skip},()=>{
  const a=create(U.member);due(a.id);
  sql(`update public.msgr_org_members set removed_at=now() where org_id='${ORG}' and user_id='${U.member}'`);
  const result=cloud();assert.equal(result.length,1);assert.equal(result[0].status,'blocked');assert.equal(result[0].message_id,null);
  assert.equal(sql(`select enabled from public.msgr_automations where id='${a.id}'`),'f');
  fails(asUserRaw(U.member,`select public.msgr_automation_run_now('${a.id}')`),/forbidden/,'revoked creator');
  rpc(U.member,`public.msgr_automation_delete('${a.id}')`);
  sql(`update public.msgr_org_members set removed_at=null where org_id='${ORG}' and user_id='${U.member}'`);
});
test('cloud route is privileged and reports observed scheduler heartbeat', {skip},()=>{
  fails(asUserRaw(U.owner,'select public.msgr_automation_dispatch_cloud()'),/permission denied/,'cloud bypass');
  fails(asUserRaw(U.owner,"select public.msgr_automation_dispatch_internal(null,true)"),/permission denied/,'private helper bypass');
  assert.equal(rpc(U.owner,'public.msgr_automation_scheduler_status()').server_active,true);
});
test('queued means queued; running/completion follows actual execution record with correct target', {skip},()=>{
  const a=create();const r=run(a.id);
  const attempt='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  rpc(U.owner,`public.msgr_execution_claim('lean','${CREW}',${r.message_id},'${CH}','${attempt}')`);
  assert.equal(sql(`select status from public.msgr_automation_runs where id='${r.id}'`),'running');
  const reply={channel_id:CH,crew_id:CREW,author_kind:'crew',kind:'text',client_msg_id:`reply:${CREW}:${r.message_id}`,reply_to:r.message_id,thread_root:r.message_id,body:'Scheduled result'};
  rpc(U.owner,`public.msgr_execution_finish('lean','${CREW}',${r.message_id},'${CH}','${attempt}','${JSON.stringify(reply)}')`);
  assert.equal(sql(`select status from public.msgr_automation_runs where id='${r.id}'`),'completed');
  rpc(U.owner,`public.msgr_automation_delete('${a.id}')`);
});
const concurrentSql = query => new Promise((resolve,reject)=>{
  const p=spawn('psql',[DB,'-X','-v','ON_ERROR_STOP=1','-A','-t','-q','-c',query]);
  let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);
  p.on('error',reject);p.on('exit',code=>code?reject(new Error(err)):resolve(out.trim()));
});
test('simultaneous cloud/resident workers claim one slot and lost-response manual retries reuse request id', {skip},async()=>{
  const a=create();due(a.id);
  const results=await Promise.all([
    concurrentSql('select public.msgr_automation_dispatch_cloud()'),
    concurrentSql(`set role authenticated; select set_config('argo.uid','${U.owner}',false);select public.msgr_automation_dispatch_due('lean')`)
  ]);
  assert.equal(results.map(v=>JSON.parse(last(v)).length).reduce((a,b)=>a+b),1);
  assert.equal(sql(`select count(*) from public.msgr_automation_runs where automation_id='${a.id}'`),'1');
  const key='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const r1=rpc(U.owner,`public.msgr_automation_run_now('${a.id}','${key}')`);
  const r2=rpc(U.owner,`public.msgr_automation_run_now('${a.id}','${key}')`);
  assert.equal(r1.message_id,r2.message_id);
  assert.equal(sql(`select count(*) from public.msgr_automation_runs where automation_id='${a.id}' and trigger='manual'`),'1');
  rpc(U.owner,`public.msgr_automation_delete('${a.id}')`);
});
test('failed execution reply is not displayed as successful automation completion', {skip},()=>{
  const a=create();const r=run(a.id);const attempt='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  rpc(U.owner,`public.msgr_execution_claim('lean','${CREW}',${r.message_id},'${CH}','${attempt}')`);
  const reply={channel_id:CH,crew_id:CREW,author_kind:'crew',kind:'text',client_msg_id:`reply:${CREW}:${r.message_id}`,reply_to:r.message_id,thread_root:r.message_id,body:'Execution failed',meta:{failed:true}};
  rpc(U.owner,`public.msgr_execution_finish('lean','${CREW}',${r.message_id},'${CH}','${attempt}','${JSON.stringify(reply)}')`);
  assert.equal(sql(`select status from public.msgr_automation_runs where id='${r.id}'`),'failed');
  rpc(U.owner,`public.msgr_automation_delete('${a.id}')`);
});
test('excluded crew, expired membership and organization lock revoke scheduling permission', {skip},()=>{
  const a=create(U.member);due(a.id);
  sql(`update public.msgr_channels set excluded_crew_ids=array['${CREW}'::uuid] where id='${CH}'`);
  assert.equal(cloud()[0].status,'blocked');
  sql(`update public.msgr_channels set excluded_crew_ids='{}' where id='${CH}'`);
  rpc(U.member,`public.msgr_automation_set_enabled('${a.id}',true)`);due(a.id);
  sql(`update public.msgr_org_members set expires_at=now()-interval '1 minute' where org_id='${ORG}' and user_id='${U.member}'`);
  assert.equal(cloud()[0].status,'blocked');
  rpc(U.member,`public.msgr_automation_delete('${a.id}')`);
  sql(`update public.msgr_org_members set expires_at=null where org_id='${ORG}' and user_id='${U.member}'`);
  const locked=create();due(locked.id);
  sql(`update public.msgr_org_entitlements set ls_status='past_due' where org_id='${ORG}'`);
  assert.equal(cloud()[0].status,'blocked');
  sql(`update public.msgr_org_entitlements set ls_status=null where org_id='${ORG}'`);
  rpc(U.owner,`public.msgr_automation_delete('${locked.id}')`);
});

test('offline queued/running work prevents scheduled backlog and coalesces after actual completion', {skip},()=>{
  const a=create();due(a.id);const r=cloud()[0];due(a.id);
  assert.deepEqual(cloud(),[]);
  const attempt='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  rpc(U.owner,`public.msgr_execution_claim('lean','${CREW}',${r.message_id},'${CH}','${attempt}')`);
  assert.deepEqual(cloud(),[]);
  const reply={channel_id:CH,crew_id:CREW,author_kind:'crew',kind:'text',client_msg_id:`reply:${CREW}:${r.message_id}`,reply_to:r.message_id,thread_root:r.message_id,body:'Finished'};
  rpc(U.owner,`public.msgr_execution_finish('lean','${CREW}',${r.message_id},'${CH}','${attempt}','${JSON.stringify(reply)}')`);
  assert.equal(cloud().length,1);assert.deepEqual(cloud(),[]);
  rpc(U.owner,`public.msgr_automation_delete('${a.id}')`);
});

test('authorization is rechecked when an offline queued command eventually claims execution', {skip},()=>{
  const a=create(U.member);const r=rpc(U.member,`public.msgr_automation_run_now('${a.id}')`);
  sql(`update public.msgr_org_members set expires_at=now()-interval '1 minute' where org_id='${ORG}' and user_id='${U.member}'`);
  fails(asUserRaw(U.owner,`select public.msgr_execution_claim('lean','${CREW}',${r.message_id},'${CH}','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')`),/msgr_automation_forbidden/,'expired creator at execution start');
  sql(`update public.msgr_org_members set expires_at=null where org_id='${ORG}' and user_id='${U.member}'`);
  rpc(U.member,`public.msgr_automation_delete('${a.id}')`);
});

test('new automation save retry is idempotent after a committed response is lost', {skip},()=>{
 const q=`public.msgr_automation_save(null,'${CH}','${CREW}','Retry-safe','One schedule','{"kind":"interval","timezone":"UTC","minutes":10}','ffffffff-ffff-4fff-8fff-ffffffffffff')`;
 const first=rpc(U.owner,q),second=rpc(U.owner,q);assert.equal(first.id,second.id);
 assert.equal(sql(`select count(*) from public.msgr_automations where create_request_id='ffffffff-ffff-4fff-8fff-ffffffffffff'`),'1');
 rpc(U.owner,`public.msgr_automation_delete('${first.id}')`);
});

test('existing stale and permission system outcomes settle scheduled history without false success', {skip},()=>{
 for(const reason of ['deny','stale','hopcap','ratecap']) {
  const a=create();const r=run(a.id);
  asUser(U.owner,`insert into public.msgr_messages(org_id,channel_id,author_kind,crew_id,kind,body,reply_to,client_msg_id) values('${ORG}','${CH}','crew','${CREW}','system','Not executed',${r.message_id},'${reason}:${CREW}:${r.message_id}')`);
  assert.equal(sql(`select status || ':' || error from public.msgr_automation_runs where id='${r.id}'`),'blocked:'+reason);
  rpc(U.owner,`public.msgr_automation_delete('${a.id}')`);
 }
});
test('dispatcher settles revoked queued commands before their next schedule, without execution or resurrection', {skip},()=>{
  const a=create(U.member),r=rpc(U.member,`public.msgr_automation_run_now('${a.id}')`);
  sql(`update public.msgr_org_members set expires_at=now()-interval '1 minute' where org_id='${ORG}' and user_id='${U.member}'`);
  assert.deepEqual(cloud(),[]);
  assert.equal(sql(`select status || ':' || error from public.msgr_automation_runs where id='${r.id}'`),'blocked:permission_revoked');
  assert.equal(sql(`select count(*) from public.msgr_executions where source_msg_id=${r.message_id}`),'0');
  assert.equal(sql(`select enabled from public.msgr_automations where id='${a.id}'`),'f');
  sql(`update public.msgr_org_members set expires_at=null where org_id='${ORG}' and user_id='${U.member}'`);
  fails(asUserRaw(U.owner,`select public.msgr_execution_claim('lean','${CREW}',${r.message_id},'${CH}','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')`),/msgr_automation_forbidden/,'blocked work cannot resurrect');
  rpc(U.member,`public.msgr_automation_delete('${a.id}')`);
});
test('reconciliation does not cancel or retry an already-running execution after permission changes', {skip},()=>{
  const a=create(U.member),r=rpc(U.member,`public.msgr_automation_run_now('${a.id}')`);
  rpc(U.owner,`public.msgr_execution_claim('lean','${CREW}',${r.message_id},'${CH}','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')`);
  sql(`update public.msgr_org_members set expires_at=now()-interval '1 minute' where org_id='${ORG}' and user_id='${U.member}'`);
  cloud();assert.equal(sql(`select status from public.msgr_automation_runs where id='${r.id}'`),'running');
  assert.equal(sql(`select count(*) from public.msgr_executions where source_msg_id=${r.message_id}`),'1');
  sql(`update public.msgr_org_members set expires_at=null where org_id='${ORG}' and user_id='${U.member}'`);
  rpc(U.member,`public.msgr_automation_delete('${a.id}')`);
});
test('one invalid schedule cannot roll back other due commands in the batch', {skip},()=>{
  const bad=create(),good=create();due(bad.id);due(good.id);
  sql(`update public.msgr_automations set schedule='{}' where id='${bad.id}'`);
  const rows=cloud();assert.equal(rows.length,1);assert.equal(rows[0].automation_id,good.id);
  assert.equal(sql(`select status || ':' || error from public.msgr_automation_runs where automation_id='${bad.id}'`),'blocked:dispatch_failed');
  assert.equal(sql(`select count(*) from public.msgr_messages where meta->>'automation_id'='${bad.id}'`),'0');
  for(const a of [bad,good]) rpc(U.owner,`public.msgr_automation_delete('${a.id}')`);
});

test('ordinary, team-work and automation executions coexist under both migrations', {skip},()=>{
  const count=sql('select count(*) from public.msgr_automation_runs');
  const ordinary=last(asUser(U.owner,`insert into public.msgr_messages(channel_id,author_kind,author_user_id,kind,body,mentions) values('${CH}','user','${U.owner}','text','Ordinary request','[{"kind":"crew","id":"${CREW}"}]') returning id`));
  asUser(U.owner,`select public.msgr_work_heartbeat(ARRAY['${CREW}'::uuid])`);
  const work=rpc(U.owner,`public.msgr_work_create('${CH}','aaaaaaaa-1111-4111-8111-111111111111','Team request','Provide result','${CREW}')`);
  for(const [i,id] of [ordinary,work.root_message_id].entries()) {
    const attempt=i?'aaaaaaaa-2222-4222-8222-222222222222':'aaaaaaaa-3333-4333-8333-333333333333';
    assert.equal(rpc(U.owner,`public.${i ? 'msgr_work_execution_claim' : 'msgr_execution_claim'}('lean','${CREW}',${id},'${CH}','${attempt}')`).acquired,true);
    const reply={channel_id:CH,crew_id:CREW,author_kind:'crew',kind:'text',client_msg_id:`reply:${CREW}:${id}`,reply_to:Number(id),thread_root:Number(id),body:i?'Concrete team result\nWORK: completed\nMSGR: done':'Ordinary result',meta:i?{disposition:'done',work_status:'completed'}:{}};
    rpc(U.owner,`public.msgr_execution_finish('lean','${CREW}',${id},'${CH}','${attempt}','${JSON.stringify(reply)}')`);
  }
  assert.equal(sql(`select status from public.msgr_work_runs where id='${work.id}'`),'completed');
  assert.equal(sql('select count(*) from public.msgr_automation_runs'),count);
});
