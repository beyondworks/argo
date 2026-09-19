// Team-work RPC, root ownership and cross-runtime lifecycle in a disposable PostgreSQL database.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { // 고정 uuid — 값은 전부 이 파일의 상수(주입 표면 없음)
  owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222',
  member: '33333333-3333-4333-8333-333333333333', guest: '44444444-4444-4444-8444-444444444444',
  svc: '77777777-7777-4777-8777-777777777777',
};

function psqlRaw(args) { return psqlSpawn(DB, args); }
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
    '20260911150000_msgr_channel_manage.sql', '20260911230000_msgr_channel_scope_enforce.sql', '20260912135036_msgr_target_favorites_dm_leave.sql', '20260912001000_msgr_bot_files.sql', '20260913010000_msgr_work_runs.sql', '20260919110000_msgr_work_stall_blocked.sql']) psql(['-f', mig(f)]);
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
const handoff=(w,to,body)=>last(asUser(U.owner,`insert into public.msgr_messages(channel_id,author_kind,crew_id,kind,body,thread_root,reply_to,client_msg_id,mentions,meta) values('${w.channel_id}','crew','${CREW}','text','${body}',${w.root_message_id},${w.root_message_id},'reply:${CREW}:${w.root_message_id}:${request()}','[{"kind":"crew","id":"${to}"}]','{"disposition":"handoff","origin":"${U.owner}"}') returning id`));
const status=(w)=>sql(`select status from public.msgr_work_runs where id='${w.id}'`);
const reply=(w,crew=CREW,meta='{"disposition":"done"}',body='Result',uid=U.owner)=>last(asUser(uid,`insert into public.msgr_messages(channel_id,author_kind,crew_id,kind,body,thread_root,reply_to,client_msg_id,meta) values('${w.channel_id}','crew','${crew}','text','${body}',${w.root_message_id},${w.root_message_id},'reply:${crew}:${w.root_message_id}:${request()}','${meta}') returning id`));
const pendingApproval=(w,{source=true,link=true}={})=>{
  const id=sql(`insert into public.msgr_crew_approvals(org_id,channel_id,crew_id,approval_id,action${source?',source_msg_id':''}) values('${ORG}','${w.channel_id}','${CREW}','ap-${request()}','Send the report'${source?`,${w.root_message_id}`:''}) returning id`);
  const mid=sql(`insert into public.msgr_messages(channel_id,author_kind,crew_id,kind,body,thread_root,reply_to,client_msg_id,mentions) values('${w.channel_id}','crew','${CREW}','approval_card','Approval needed',${w.root_message_id},${w.root_message_id},'ap:${CREW}:${request()}','[{"kind":"approval","id":"${id}"}]') returning id`);
  if(link) sql(`update public.msgr_crew_approvals set message_id=${mid} where id='${id}'`);
  return id;
};

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
  const plan=handoff(w,OTHER_CREW,'A plan — @Theirs please research'); assert.equal(status(w),'running','넘김이 있는 계획은 진행 중(완료 아님)');
  reply(w,OTHER_CREW,'{"disposition":"handoff"}','Research for the lead',U.member); assert.equal(status(w),'running');
  sql(`select set_config('argo.msgr_work_protocol','1',false); insert into public.msgr_executions(crew_id,source_msg_id,attempt,state) values('${OTHER_CREW}',${plan},'${request()}','completed')`); // 동료 실행 끝남
  const rid=reply(w,CREW,'{"disposition":"done","work_status":"completed"}','Three checked sources');
  assert.equal(status(w),'completed');
  assert.equal(sql(`select result_message_id from public.msgr_work_runs where id='${w.id}'`),rid);
});
// D48(정비사 원장 P-C11·P3-4): 총괄이 판정 표지 없이 넘김도 없이 답을 마치면 스레드에서 더 움직일 에이전트가 없다 — 종전엔 영원히 running
test('D48: 총괄이 판정 없이 넘김 없이 답을 마치고 대기 중인 동료도 없으면 도움 필요(blocked) — 완료로 올리지 않는다', {skip},()=>{
  for (const meta of ['{}', '{"disposition":"done"}']) {
    const w=create(); const rid=reply(w,CREW,meta,'Here is a summary');
    assert.equal(status(w),'blocked',meta);
    const [res,rmid]=sql(`select coalesce(result,'<null>'), result_message_id from public.msgr_work_runs where id='${w.id}'`).split('|');
    assert.equal(res,'<null>','정지 이유는 앱이 사용자 언어로 그린다'); assert.equal(rmid,rid,'총괄의 마지막 답을 가리킨다');
    const key=request(); assert.equal(JSON.parse(last(asUser(U.owner,`select public.msgr_work_resume('${w.id}','${key}','Also add the price table')`))).status,'running','보완하여 계속으로 이어간다');
  }
});
test('D48: 동료에게 넘긴 지시가 아직 끝나지 않았거나 총괄 판정이 넘김이면 종전처럼 진행 중', {skip},()=>{
  const w=create(); const h=handoff(w,OTHER_CREW,'Please research');
  reply(w,CREW,'{"disposition":"done"}','Waiting for research'); assert.equal(status(w),'running','동료 실행이 끝나지 않았다');
  sql(`select set_config('argo.msgr_work_protocol','1',false); insert into public.msgr_executions(crew_id,source_msg_id,attempt,state) values('${OTHER_CREW}',${h},'${request()}','completed')`);
  reply(w,CREW,'{"disposition":"done"}','Summary without a verdict'); assert.equal(status(w),'blocked','동료가 끝난 뒤 판정 없는 총괄 답은 정지');
  const w2=create(); reply(w2,CREW,'{"disposition":"handoff"}','Handing off'); assert.equal(status(w2),'running','넘김 판정');
  const w4=create(); asUser(U.owner,`insert into public.msgr_messages(channel_id,author_kind,crew_id,kind,body,thread_root,reply_to,client_msg_id,mentions,meta) values('${w4.channel_id}','crew','${CREW}','text','Tool handoff',${w4.root_message_id},${w4.root_message_id},'reply:${CREW}:${w4.root_message_id}:${request()}','[{"kind":"crew","id":"${OTHER_CREW}"}]','{}')`);
  assert.equal(status(w4),'running','판정 줄 없이도 도구로 넘긴 멘션이 실린 답은 동료가 이어받는다');
  const cc=create(); asUser(U.owner,`insert into public.msgr_messages(channel_id,author_kind,crew_id,kind,body,thread_root,reply_to,client_msg_id,mentions,meta) values('${cc.channel_id}','crew','${CREW}','text','For reference only',${cc.root_message_id},${cc.root_message_id},'reply:${CREW}:${cc.root_message_id}:${request()}','[{"kind":"crew","id":"${OTHER_CREW}","role":"cc"}]','{"disposition":"done"}')`);
  assert.equal(status(cc),'blocked','참조(cc)는 실행 대상이 아니므로 업무를 진행 중에 붙잡지 않는다');
  const w3=create(); reply(w3,OTHER_CREW,'{"disposition":"done"}','Specialist only',U.member); assert.equal(status(w3),'running','총괄이 아닌 에이전트의 답은 판정하지 않는다');
});
test('D48: 같은 업무의 총괄 결재가 대기 중이면 running, 결정 뒤 남은 후속 실행 없는 답에서 다시 판정', {skip},()=>{
  const other=create(); pendingApproval(other);
  const isolated=create(); reply(isolated,CREW,'{"disposition":"done"}','No action remains');
  assert.equal(status(isolated),'blocked','다른 업무의 결재 대기는 이 업무 판정을 막지 않는다');

  const legacy=create(); pendingApproval(legacy,{source:false});
  reply(legacy,CREW,'{"disposition":"done"}','Waiting on a pre-migration linked card');
  assert.equal(status(legacy),'running','source_msg_id가 없는 기존 행도 검증된 카드 링크로 기다린다');

  for (const decision of ['approved','rejected']) {
    const w=create(); const approval=pendingApproval(w);
    reply(w,CREW,'{"disposition":"done"}','Approval is pending; I will continue after the decision');
    assert.equal(status(w),'running','같은 스레드에서 이 총괄이 올린 pending 결재가 있으면 기다린다');
    sql(`update public.msgr_crew_approvals set status='${decision}',decided_by='${U.owner}',decided_at=now() where id='${approval}'`);
    reply(w,CREW,'{"disposition":"done"}','The approval was decided; there is no remaining action');
    assert.equal(status(w),'blocked',`${decision} 뒤 후속 답에서 남은 실행이 없으면 다시 도움 필요로 판정한다`);
  }

  const chained=create(); const chainedApproval=pendingApproval(chained,{link:false});
  const priorCard=sql(`select id from public.msgr_messages where thread_root=${chained.root_message_id} and kind='approval_card' order by id desc limit 1`);
  asUser(U.owner,`insert into public.msgr_messages(channel_id,author_kind,crew_id,kind,body,thread_root,reply_to,client_msg_id,meta) values('${chained.channel_id}','crew','${CREW}','text','Follow-up created another approval',${chained.root_message_id},${priorCard},'reply:${CREW}:${priorCard}:${request()}','{"disposition":"done"}')`);
  assert.equal(status(chained),'running','결재 카드에 단 후속 답도 같은 work root의 새 pending 결재를 기다린다');
  assert.equal(sql(`select source_msg_id from public.msgr_crew_approvals where id='${chainedApproval}'`),String(chained.root_message_id));
});
test('D48: 현재 실행에서 pending 결재가 먼저 생기고 카드 연결이 실패해도 업무를 정지시키지 않는다', {skip},()=>{
  const w=create();
  sql(`select set_config('argo.msgr_work_protocol','1',false); insert into public.msgr_executions(crew_id,source_msg_id,attempt) values('${CREW}',${w.root_message_id},'${request()}')`);
  const approval=sql(`insert into public.msgr_crew_approvals(org_id,channel_id,crew_id,approval_id,action,source_msg_id) values('${ORG}','${w.channel_id}','${CREW}','ap-${request()}','Send the report',${w.root_message_id}) returning id`);
  assert.equal(sql(`select message_id is null from public.msgr_crew_approvals where id='${approval}'`),'t','카드 insert/update 전 실패 경계');
  assert.equal(sql(`select source_msg_id from public.msgr_crew_approvals where id='${approval}'`),String(w.root_message_id),'현재 실행 원문을 결재 행에 동기 기록한다');
  reply(w,CREW,'{"disposition":"done"}','Approval is pending; I will continue after the decision');
  assert.equal(status(w),'running','현재 실행 중 먼저 만들어진 미연결 pending 결재를 기다린다');

  const linkFailed=create();
  sql(`select set_config('argo.msgr_work_protocol','1',false); insert into public.msgr_executions(crew_id,source_msg_id,attempt) values('${CREW}',${linkFailed.root_message_id},'${request()}')`);
  const linkFailedApproval=pendingApproval(linkFailed,{link:false});
  assert.equal(sql(`select message_id is null from public.msgr_crew_approvals where id='${linkFailedApproval}'`),'t','카드는 생겼지만 approval 링크 갱신이 실패한 경계');
  reply(linkFailed,CREW,'{"disposition":"done"}','The card link update failed, but approval is pending');
  assert.equal(status(linkFailed),'running','불변 source_msg_id로 카드 링크 실패와 무관하게 기다린다');

  const next=create();
  sql(`select set_config('argo.msgr_work_protocol','1',false); insert into public.msgr_executions(crew_id,source_msg_id,attempt) values('${CREW}',${next.root_message_id},'${request()}')`);
  reply(next,CREW,'{"disposition":"done"}','No approval belongs to this later execution');
  assert.equal(status(next),'blocked','이전 실행에서 pending으로 남은 미연결 결재는 이후 업무를 붙잡지 않는다');

  const first=create(); const second=create();
  sql(`select set_config('argo.msgr_work_protocol','1',false); insert into public.msgr_executions(crew_id,source_msg_id,attempt) values('${CREW}',${first.root_message_id},'${request()}'),('${CREW}',${second.root_message_id},'${request()}')`);
  const firstApproval=pendingApproval(first,{link:false}); pendingApproval(second,{link:false});
  reply(first,CREW,'{"disposition":"done"}','First approval is pending'); assert.equal(status(first),'running');
  sql(`update public.msgr_crew_approvals set status='rejected',decided_by='${U.owner}',decided_at=now() where id='${firstApproval}'`);
  reply(first,CREW,'{"disposition":"done"}','Only the other execution approval remains');
  assert.equal(status(first),'blocked','동시 실행의 다른 결재를 현재 업무에 오귀속하지 않는다');
  reply(second,CREW,'{"disposition":"done"}','Second approval is still pending'); assert.equal(status(second),'running');

  assert.match(asUserRaw(U.owner,`update public.msgr_crew_approvals set source_msg_id=${second.root_message_id} where id='${approval}'`).stderr,/msgr_immutable_source_msg_id/,'결재의 실행 원문은 바꿀 수 없다');
});
test('D48: 비총괄 크루가 직접 넣은 비배열·가짜 멘션은 주관 답을 깨뜨리거나 업무를 고착시키지 않는다', {skip},()=>{
  for (const mentions of ['{}', `[{"kind":"crew","id":"${request()}"}]`, `[{"kind":"crew","id":"${OTHER_CREW}"}]`]) {
    const w=create();
    asUser(U.member,`insert into public.msgr_messages(channel_id,author_kind,crew_id,kind,body,thread_root,reply_to,client_msg_id,mentions,meta) values('${w.channel_id}','crew','${OTHER_CREW}','text','Injected mention',${w.root_message_id},${w.root_message_id},'reply:${OTHER_CREW}:${w.root_message_id}:${request()}','${mentions}','{"disposition":"handoff"}')`);
    reply(w,CREW,'{"disposition":"done"}','No authorized handoff remains');
    assert.equal(status(w),'blocked',mentions);
  }
});
test('external bot-style terminal markers follow the same fenced/quoted rules', {skip},()=>{
  // 코드 블록·인용 속 표지는 판정이 아니다 — 완료로 올리지 않는다(판정 없는 정지는 D48에 따라 도움 필요)
  const f=create(); reply(f,CREW,'{"disposition":"done"}','```\nWORK: completed'); assert.notEqual(status(f),'completed');
  const q=create(); reply(q,CREW,'{"disposition":"done"}','> WORK: completed'); assert.notEqual(status(q),'completed');
  const w=create();
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
