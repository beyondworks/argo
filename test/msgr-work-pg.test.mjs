// Team-work RPC, root ownership and cross-runtime lifecycle in a disposable PostgreSQL database.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

let ORG, OTHER_ORG, CREW, OTHER_CREW, PUB;
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
    '20260911150000_msgr_channel_manage.sql', '20260911230000_msgr_channel_scope_enforce.sql', '20260912135036_msgr_target_favorites_dm_leave.sql', '20260912001000_msgr_bot_files.sql', '20260913010000_msgr_work_runs.sql']) psql(['-f', mig(f)]);
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
  PUB = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}','public','Work')`));
  sql(`update public.msgr_crews set work_protocol=1,last_seen_at=now(),allow='all',role_text=case when id='${CREW}' then '총괄 moderator' else 'Research' end where org_id='${ORG}'`);

});
let seq=0;
const request=()=>`99999999-9999-4999-8999-${String(++seq).padStart(12,'0')}`;
const create=(opts={})=>JSON.parse(last(asUser(opts.user??U.owner,`select public.msgr_work_create('${opts.channel??PUB}','${opts.request??request()}','${opts.goal??'Compare suppliers'}','${opts.criteria??'Three verified sources'}',${opts.lead?`'${opts.lead}'`:'null'})`)));
const status=(w)=>sql(`select status from public.msgr_work_runs where id='${w.id}'`);
const reply=(w,crew=CREW,meta='{"disposition":"done"}',body='Result',uid=U.owner)=>last(asUser(uid,`insert into public.msgr_messages(channel_id,author_kind,crew_id,kind,body,thread_root,reply_to,client_msg_id,meta) values('${w.channel_id}','crew','${crew}','text','${body}',${w.root_message_id},${w.root_message_id},'reply:${crew}:${w.root_message_id}:${request()}','${meta}') returning id`));

test('create chooses an eligible coordinator and atomically persists one root across retries', {skip},()=>{
  const key=request(); const w=create({request:key}); const again=create({request:key});
  assert.equal(w.id,again.id); assert.equal(w.lead_crew_id,CREW); assert.equal(w.status,'running');
  assert.equal(sql(`select count(*) from public.msgr_messages where meta->>'work_run_id'='${w.id}'`),'1');
  assert.equal(sql(`select thread_root=id from public.msgr_messages where id=${w.root_message_id}`),'t');
  fails(asUserRaw(U.owner,`select public.msgr_work_create('${PUB}','${key}','Different','Three verified sources',null)`),/msgr_work_request_conflict/,'same key different goal');
});
test('auto selection respects channel participation, caller permission and live availability', {skip},()=>{
  sql(`update public.msgr_channels set excluded_crew_ids=array['${CREW}'::uuid] where id='${PUB}'`);
  assert.equal(create().lead_crew_id,OTHER_CREW);
  sql(`update public.msgr_crews set allow='owner' where id='${OTHER_CREW}'`);
  fails(asUserRaw(U.owner,`select public.msgr_work_create('${PUB}','${request()}','X','',null)`),/no_available_lead/,'excluded and forbidden');
  sql(`update public.msgr_channels set excluded_crew_ids='{}' where id='${PUB}'`);
  sql(`update public.msgr_crews set last_seen_at=now()-interval '1 day' where id='${CREW}'`);
  fails(asUserRaw(U.owner,`select public.msgr_work_create('${PUB}','${request()}','X','',null)`),/no_available_lead/,'no online lead');
  assert.equal(create({lead:CREW}).lead_crew_id,CREW,'explicit offline lead queues honestly');
  sql(`update public.msgr_crews set last_seen_at=now(),allow='all' where org_id='${ORG}'`);
});
test('private channels and work rows remain inaccessible to outsiders and cannot be directly modified', {skip},()=>{
  const ch=last(asUser(U.owner,`select public.msgr_create_channel('${ORG}','private','Private work','[{"kind":"crew","id":"${CREW}"}]')`));
  const w=create({channel:ch});
  assert.equal(last(asUser(U.member,`select count(*) from public.msgr_work_runs where id='${w.id}'`)),'0');
  assert.equal(last(asUser(U.guest,'select count(*) from public.msgr_work_runs')),'0');
  fails(asUserRaw(U.member,`select public.msgr_work_create('${ch}','${request()}','X','',null)`),/forbidden/,'private outsider kickoff');
  fails(asUserRaw(U.owner,`update public.msgr_work_runs set status='completed' where id='${w.id}'`),/permission denied/,'direct state spoof');
  fails(asUserRaw(U.member,`select public.msgr_work_cancel('${w.id}')`),/forbidden/,'outsider cancel');
});
test('specialist completion is not whole-work completion; lead must explicitly report actual completion', {skip},()=>{
  const w=create();
  reply(w,OTHER_CREW,'{"disposition":"done","work_status":"completed"}','Research only',U.member);
  assert.equal(status(w),'running');
  reply(w,CREW,'{"disposition":"done"}','A plan'); assert.equal(status(w),'running');
  const rid=reply(w,CREW,'{"disposition":"done","work_status":"completed"}','Three checked sources');
  assert.equal(status(w),'completed');
  assert.equal(sql(`select result_message_id from public.msgr_work_runs where id='${w.id}'`),rid);
});
test('external bot-style terminal markers follow the same fenced/quoted rules', {skip},()=>{
  const w=create();
  reply(w,CREW,'{"disposition":"done"}','```\nWORK: completed'); assert.equal(status(w),'running');
  reply(w,CREW,'{"disposition":"done"}','> WORK: completed'); assert.equal(status(w),'running');
  reply(w,CREW,'{"disposition":"done"}','```text\nResult\n```\nWORK: completed'); assert.equal(status(w),'completed');
  assert.ok(!sql(`select result from public.msgr_work_runs where id='${w.id}'`).includes('WORK:'));
});
test('cancel prevents new claims and strips late handoffs without deleting their result', {skip},()=>{
  const w=create(); asUser(U.owner,`select public.msgr_work_cancel('${w.id}')`);
  sql(`insert into public.msgr_executions(crew_id,source_msg_id,attempt) values('${CREW}',${w.root_message_id},'${request()}')`);
  assert.equal(sql(`select count(*) from public.msgr_executions where source_msg_id=${w.root_message_id}`),'0');
  const mid=last(asUser(U.owner,`insert into public.msgr_messages(channel_id,author_kind,crew_id,body,thread_root,reply_to,mentions,meta) values('${PUB}','crew','${CREW}','Already running result',${w.root_message_id},${w.root_message_id},'[{"kind":"crew","id":"${OTHER_CREW}"}]','{"origin":"${U.owner}","work_status":"completed","disposition":"handoff"}') returning id`));
  assert.equal(sql(`select mentions from public.msgr_messages where id=${mid}`),'[]');
  assert.equal(sql(`select body from public.msgr_messages where id=${mid}`),'Already running result'); assert.equal(status(w),'cancelled');
});
test('blocked work resumes only with a new authorized, idempotent instruction in the same thread', {skip},()=>{
  const w=create(); reply(w,CREW,'{"disposition":"done","work_status":"blocked"}','Need access');
  assert.equal(status(w),'blocked'); const key=request();
  const rpc=`select public.msgr_work_resume('${w.id}','${key}','Access is now available')`;
  assert.equal(JSON.parse(last(asUser(U.owner,rpc))).status,'running'); asUser(U.owner,rpc);
  assert.equal(sql(`select count(*) from public.msgr_messages where client_msg_id='work-resume:${key}'`),'1');
  assert.equal(sql(`select thread_root from public.msgr_messages where client_msg_id='work-resume:${key}'`),String(w.root_message_id));
  asUser(U.owner,`select public.msgr_work_cancel('${w.id}')`);
  fails(asUserRaw(U.owner,`select public.msgr_work_resume('${w.id}','${request()}','Continue')`),/not_blocked/,'cancelled cannot resume');
});
test('ordinary conversations and execution claims remain unaffected', {skip},()=>{
  const id=last(asUser(U.owner,`insert into public.msgr_messages(channel_id,author_kind,author_user_id,body) values('${PUB}','user','${U.owner}','Ordinary') returning id`));
  sql(`insert into public.msgr_executions(crew_id,source_msg_id,attempt) values('${CREW}',${id},'${request()}')`);
  assert.equal(sql(`select count(*) from public.msgr_executions where source_msg_id=${id}`),'1');
  assert.equal(sql(`select has_function_privilege('anon','public.msgr_work_create(uuid,uuid,text,text,uuid)','EXECUTE')`),'f');
});

test('handoff/rate/permission/uncertain-execution stops become recoverable blocked work', {skip},()=>{
  for (const kind of ['hopcap','ratecap','stale','deny','execution-unknown','unknown']) {
    const w=create();
    asUser(U.owner,`insert into public.msgr_messages(channel_id,author_kind,crew_id,kind,body,thread_root,reply_to,client_msg_id) values('${PUB}','crew','${CREW}','system','Needs a new decision',${w.root_message_id},${w.root_message_id},'${kind}:${CREW}:${w.root_message_id}')`);
    assert.equal(status(w),'blocked',kind);
  }
});

test('real external bot updates carry the objective and roles, then terminal result and cancellation use the shared lifecycle', {skip},()=>{
  const bot=JSON.parse(last(asUser(U.owner,`select public.msgr_bot_create('${ORG}','hermes','External coordinator','coordination')`)));
  const anon=(query)=>sql(`set role anon; ${query}`);
  const read=()=>JSON.parse(last(anon(`select coalesce(jsonb_agg(x),'[]') from public.msgr_bot_updates('${bot.token}') x`)));
  const w=create({lead:bot.crew_id});
  const updates=read(); const msg=updates.find((x)=>Number(x.update_id)===Number(w.root_message_id))?.message;
  assert.ok(msg); assert.ok(msg.text.includes(w.goal)); assert.ok(msg.text.includes(w.completion_criteria)); assert.ok(msg.text.includes('Research')); assert.equal(msg.work_run.id,w.id);
  anon(`select public.msgr_bot_finish('${bot.token}','${PUB}','Evidence\nWORK: completed',${msg.message_id},'${msg.execution_attempt}','done','[]')`);
  assert.equal(status(w),'completed');
  const cancelled=create({lead:bot.crew_id}); asUser(U.owner,`select public.msgr_work_cancel('${cancelled.id}')`);
  assert.ok(!read().some((x)=>Number(x.update_id)===Number(cancelled.root_message_id)));
  assert.equal(sql(`select count(*) from public.msgr_executions where source_msg_id=${cancelled.root_message_id}`),'0');
  assert.equal(sql(`select has_function_privilege('anon','public.msgr_bot_updates_before_work(text,bigint,int)','EXECUTE')`),'f');
});

test('external bot resumed request keeps the canonical work thread and completes the same run', {skip},()=>{
  const bot=JSON.parse(last(asUser(U.owner,`select public.msgr_bot_create('${ORG}','openclaw','Resume coordinator','coordination')`)));
  const anon=(query)=>sql(`set role anon; ${query}`);
  const read=()=>JSON.parse(last(anon(`select coalesce(jsonb_agg(x),'[]') from public.msgr_bot_updates('${bot.token}') x`)));
  const w=create({lead:bot.crew_id}); const first=read().find((x)=>Number(x.update_id)===Number(w.root_message_id)).message;
  anon(`select public.msgr_bot_finish('${bot.token}','${PUB}','Access needed\nWORK: blocked',${first.message_id},'${first.execution_attempt}','done','[]')`);
  assert.equal(status(w),'blocked');
  const key=request(); asUser(U.owner,`select public.msgr_work_resume('${w.id}','${key}','Access granted')`);
  const source=Number(sql(`select id from public.msgr_messages where client_msg_id='work-resume:${key}'`));
  const resumed=read().find((x)=>Number(x.update_id)===source).message;
  assert.equal(resumed.work_run.id,w.id); assert.ok(resumed.text.includes(w.goal));
  const final=last(anon(`select public.msgr_bot_finish('${bot.token}','${PUB}','Finished\nWORK: completed',${resumed.message_id},'${resumed.execution_attempt}','done','[]')`));
  assert.equal(status(w),'completed'); assert.equal(sql(`select thread_root from public.msgr_messages where id=${final}`),String(w.root_message_id));
});

test('runtime capabilities gate kickoff; legacy execution blocks visibly and explicit new protocol can resume', {skip},()=>{
  sql(`update public.msgr_crews set work_protocol=0 where id='${CREW}'`);
  fails(asUserRaw(U.owner,`select public.msgr_work_create('${PUB}','${request()}','X','','${CREW}')`),/no_available_lead/,'unsupported runtime');
  asUser(U.member,`select public.msgr_work_heartbeat(array['${CREW}'::uuid])`);
  assert.equal(sql(`select work_protocol from public.msgr_crews where id='${CREW}'`),'0','another user cannot advertise support');
  asUser(U.owner,`select public.msgr_work_heartbeat(array['${CREW}'::uuid])`);
  const w=create({lead:CREW});
  asUser(U.owner,`select public.msgr_execution_claim('lean','${CREW}',${w.root_message_id},'${PUB}','${request()}')`);
  assert.equal(status(w),'blocked'); assert.match(sql(`select result from public.msgr_work_runs where id='${w.id}'`),/Update Argo/);
  const key=request(); asUser(U.owner,`select public.msgr_work_resume('${w.id}','${key}','Runtime updated')`);
  const resumed=sql(`select last_resume_message_id from public.msgr_work_runs where id='${w.id}'`);
  const claim=JSON.parse(last(asUser(U.owner,`select public.msgr_work_execution_claim('lean','${CREW}',${resumed},'${PUB}','${request()}')`)));
  assert.equal(claim.acquired,true);
});

test('only an authorized resume opens a new bounded round; previous queued turns and late completions cannot restart it', {skip},()=>{
  const w=create({lead:CREW});
  for(let i=0;i<8;i++)reply(w,CREW,`{"hop":${i+1}}`,`Round ${i+1}`);
  asUser(U.owner,`insert into public.msgr_messages(channel_id,author_kind,crew_id,kind,body,thread_root,reply_to,client_msg_id) values('${PUB}','crew','${CREW}','system','Eight hops reached',${w.root_message_id},${w.root_message_id},'hopcap:${CREW}:${w.root_message_id}')`);
  assert.equal(status(w),'blocked');
  fails(asUserRaw(U.member,`select public.msgr_work_resume('${w.id}','${request()}','Reset budget')`),/forbidden/,'other member cannot reset');
  const key=request(); asUser(U.owner,`select public.msgr_work_resume('${w.id}','${key}','Continue the bounded next round')`);
  const boundary=Number(sql(`select last_resume_message_id from public.msgr_work_runs where id='${w.id}'`));
  assert.ok(boundary>Number(w.root_message_id));
  assert.equal(sql(`select count(*) from public.msgr_messages where thread_root=${w.root_message_id} and author_kind='crew' and kind='text' and id>${boundary}`),'0');
  const old=JSON.parse(last(asUser(U.owner,`select public.msgr_work_execution_claim('lean','${CREW}',${w.root_message_id},'${PUB}','${request()}')`)));
  assert.equal(old.acquired,false);
  reply(w,CREW,'{"disposition":"done","work_status":"completed"}','Late previous-round result');
  assert.equal(status(w),'running');
});
