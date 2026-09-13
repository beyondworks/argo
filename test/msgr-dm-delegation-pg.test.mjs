// Team-work RPC, root ownership and cross-runtime lifecycle in a disposable PostgreSQL database.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';

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
  // Supabase's outbound HTTP extension is stubbed; all Messenger SQL, RLS and triggers run unchanged.
  sql(`create schema net;
    create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;`);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql',
    '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql']) psql(['-f', mig(f)]);
  const migrationDir=fileURLToPath(new URL('../supabase/migrations/',import.meta.url));
  for(const f of readdirSync(migrationDir).filter(f=>/^\d+_msgr.*\.sql$/.test(f)).sort()) {
    const source=readFileSync(mig(f),'utf8');
    psql(['-c',source.replace(/^create extension if not exists pg_net;$/m,'')]);
  }
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
  sql(`update public.msgr_crews set dm_delivery_protocol=1,work_protocol=1,last_seen_at=now(),allow='all',role_text=case when id='${CREW}' then '총괄 moderator' else 'Research' end where org_id='${ORG}'`);

});

let DM, ROOT;
const mention=(id,role='to')=>JSON.stringify([{kind:'crew',id,role}]);
const post=(body,mentions='[]',channel=DM)=>last(asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,author_user_id,body,mentions) values('${channel}','user','${U.owner}','${body}','${mentions}') returning id`));
const env=(id,crew=OTHER_CREW,uid=U.member)=>JSON.parse(last(asUser(uid,`select msgr_crew_context('lean','${crew}',${id},'${DM}')`)));
test('adjacent private DM keeps its membership cap and hides the whole channel from another owner',{skip},()=>{
 DM=last(asUser(U.owner,`select msgr_create_channel('${ORG}','dm','Mine','[{"kind":"crew","id":"${CREW}"}]')`));
 post('Unrelated prior private conversation');
 assert.equal(last(asUser(U.member,`select count(*) from msgr_messages where channel_id='${DM}'`)),'0');
 fails(sqlRaw(`insert into msgr_channel_members(channel_id,member_kind,member_id,added_by) values('${DM}','crew','${OTHER_CREW}','${U.owner}')`),/msgr_dm_full/,'DM remains one crew');
});
test('cross-owner explicit To executes only that target and exposes only its requested thread',{skip},()=>{
 ROOT=post('Ask specialist',mention(OTHER_CREW));
 const e=env(ROOT); assert.equal(e.source.id,Number(ROOT)); assert.equal(e.root.id,Number(ROOT)); assert.equal(e.delegated,true);
 assert.ok(e.context.every(r=>r.id===Number(ROOT)||r.thread_root===Number(ROOT)));
 assert.equal(sql(`select msgr_delivery_target('${CREW}',${ROOT})`),'f','default DM crew suppressed by explicit To');
 assert.equal(sql(`select msgr_delivery_target('${OTHER_CREW}',${ROOT})`),'t');
 assert.equal(last(asUser(U.member,`select count(*) from msgr_messages where channel_id='${DM}'`)),'0','no broad RLS grant');
 const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 const claim=JSON.parse(last(asUser(U.member,`select msgr_execution_claim('lean','${OTHER_CREW}',${ROOT},'${DM}','${a}')`)));
 assert.equal(claim.acquired,true);
 const reply={channel_id:DM,author_kind:'crew',crew_id:OTHER_CREW,kind:'text',client_msg_id:`reply:${OTHER_CREW}:${ROOT}`,reply_to:Number(ROOT),thread_root:Number(ROOT),body:'Specialist answer',mentions:[],meta:{disposition:'done'}};
 const done=JSON.parse(last(asUser(U.member,`select msgr_execution_finish('lean','${OTHER_CREW}',${ROOT},'${DM}','${a}','${JSON.stringify(reply)}')`)));
 assert.ok(done.id); assert.equal(env(ROOT).settled_source,true);
});
test('CC-only keeps normal DM recipient but cannot claim, respond or access unrelated history',{skip},()=>{
 const id=post('For reference',mention(OTHER_CREW,'cc'));
 assert.equal(sql(`select msgr_delivery_target('${CREW}',${id})`),'t');
 assert.equal(sql(`select msgr_delivery_target('${OTHER_CREW}',${id})`),'f');
 fails(asUserRaw(U.member,`select msgr_execution_claim('lean','${OTHER_CREW}',${id},'${DM}','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab')`),/forbidden|not_targeted/,'CC cannot execute');
 assert.equal(env(id).delivery_role,'cc','passive context has explicit nonexecution role');
});
test('candidate scope is current DM access, same org and allow policy, not owner/ws equality',{skip},()=>{
 const choices=JSON.parse(last(asUser(U.owner,`select coalesce(jsonb_agg(c),'[]') from msgr_dm_candidates('${DM}') c`)));
 assert.ok(choices.some(c=>c.id===OTHER_CREW));
 fails(asUserRaw(U.member,`select * from msgr_dm_candidates('${DM}')`),/forbidden/,'nonparticipant cannot enumerate DM candidates');
 const foreign=last(asUser(U.guest,`insert into msgr_crews(org_id,owner_user_id,ws_id,slug,display_name) values('${OTHER_ORG}','${U.guest}','foreign','foreign','Foreign') returning id`));
 fails(asUserRaw(U.owner,`insert into msgr_messages(channel_id,author_kind,author_user_id,body,mentions) values('${DM}','user','${U.owner}','Forbidden','${mention(foreign)}')`),/not_allowed/,'foreign org cannot receive');
 fails(asUserRaw(U.member,`select msgr_crew_context('other-ws','${OTHER_CREW}',${ROOT},'${DM}')`),/forbidden/,'wrong ws');
});
test('DM routing immutable but body edits remain; deleted root and departed user revoke scoped context',{skip},()=>{
 const id=post('Editable',mention(OTHER_CREW));
 asUser(U.owner,`update msgr_messages set body='Edited' where id=${id}`);
 fails(asUserRaw(U.owner,`update msgr_messages set mentions='[]' where id=${id}`),/routing_immutable/,'routing cannot move grant');
 asUser(U.owner,`update msgr_messages set deleted_at=now() where id=${id}`);
 fails(asUserRaw(U.member,`select msgr_crew_context('lean','${OTHER_CREW}',${id},'${DM}')`),/forbidden/,'deleted root');
 const live=post('Still here',mention(OTHER_CREW));
 sql(`update msgr_org_members set removed_at=now() where org_id='${ORG}' and user_id='${U.member}'`);
 fails(asUserRaw(U.member,`select msgr_crew_context('lean','${OTHER_CREW}',${live},'${DM}')`),/forbidden/,'target owner removed');
 sql(`update msgr_org_members set removed_at=null where org_id='${ORG}' and user_id='${U.member}'`);
 sql(`update msgr_crews set status='active' where id='${OTHER_CREW}'`);
});
test('bot delegated handoff returns actual second agent reply in same DM without adding members',{skip},()=>{
 const bot=JSON.parse(last(asUser(U.owner,`select msgr_bot_create('${ORG}','hermes','Feynman','Research')`)));
 const anon=q=>sql(`set role anon; ${q}`);
 anon(`select * from msgr_bot_updates_with_delivery('${bot.token}')`);
 const human=post('Ask Feynman');
 const first=last(asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,crew_id,body,reply_to,thread_root,mentions,meta) values('${DM}','crew','${CREW}','@Feynman role?',${human},${human},'${mention(bot.crew_id)}','{"disposition":"handoff","origin":"${U.guest}","hop":-100}') returning id`));
 assert.equal(sql(`select meta->>'origin' from msgr_messages where id=${first}`),U.owner,'server derives origin');
 const ups=JSON.parse(last(anon(`select coalesce(jsonb_agg(x),'[]') from msgr_bot_updates_with_delivery('${bot.token}') x`)));
 const m=ups.find(u=>Number(u.update_id)===Number(first))?.message; assert.ok(m);assert.equal(m.delegated,true);assert.equal(m.thread_root,Number(human));
 assert.ok(m.context.every(row=>!row.text.includes('Unrelated prior')));
 anon(`select msgr_bot_typing('${bot.token}','${DM}',${m.message_id},'${m.execution_attempt}')`);
 const reply=last(anon(`select msgr_bot_finish('${bot.token}','${DM}','I research.',${m.message_id},'${m.execution_attempt}','done','[]')`));
 assert.equal(sql(`select channel_id from msgr_messages where id=${reply}`),DM);
 assert.equal(sql(`select count(*) from msgr_channel_members where channel_id='${DM}' and member_kind='crew'`),'1');
 assert.equal(sql(`select has_function_privilege('anon','msgr_bot_updates_before_work(text,bigint,int)','EXECUTE')`),'f');
 const cc=post('Bot reference',mention(bot.crew_id,'cc'));
 const copy=JSON.parse(last(anon(`select coalesce(jsonb_agg(x),'[]') from msgr_bot_updates_with_delivery('${bot.token}') x`))).find(u=>Number(u.update_id)===Number(cc));
 assert.equal(copy.message.delivery_role,'cc');assert.equal(copy.message.execution_attempt,null);
 assert.equal(sql(`select count(*) from msgr_executions where crew_id='${bot.crew_id}' and source_msg_id=${cc}`),'0');
});
test('CC can read only granted thread; routing tamper, archived channel and root departure fail closed',{skip},()=>{
 const id=post('Reference facts',mention(OTHER_CREW,'cc'));
 const rows=JSON.parse(last(asUser(U.member,`select coalesce(jsonb_agg(x),'[]') from msgr_crew_thread('lean','${OTHER_CREW}',${id}) x`)));
 assert.deepEqual(rows.map(x=>x.id),[Number(id)]);
 const unrelated=post('Unshared secret');
 fails(asUserRaw(U.member,`select * from msgr_crew_thread('lean','${OTHER_CREW}',${unrelated})`),/forbidden/,'ungranted root');
 fails(asUserRaw(U.owner,`update msgr_messages set thread_root=${unrelated} where id=${id}`),/routing_immutable/,'root cannot be moved');
 sql(`update msgr_channels set archived_at=now() where id='${DM}'`);
 fails(asUserRaw(U.member,`select * from msgr_crew_thread('lean','${OTHER_CREW}',${id})`),/forbidden/,'archived DM');
 sql(`update msgr_channels set archived_at=null where id='${DM}'`);
 sql(`delete from msgr_channel_members where channel_id='${DM}' and member_kind='user' and member_id='${U.owner}'`);
 fails(asUserRaw(U.member,`select * from msgr_crew_thread('lean','${OTHER_CREW}',${id})`),/forbidden/,'root user left');
 sql(`insert into msgr_channel_members(channel_id,member_kind,member_id,added_by) values('${DM}','user','${U.owner}','${U.owner}')`);
});
test('delegated bots receive only authorized files and denied direct typing or CC execution',{skip},()=>{
 const b=JSON.parse(last(asUser(U.owner,`select msgr_bot_create('${ORG}','openclaw','Wolff','Finance')`)));
 sql(`set role anon; select * from msgr_bot_updates_with_delivery('${b.token}')`);
 const id=post('Read attachment',mention(b.crew_id)); const secret=post('Unrelated file');
 const fid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', hidden='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
 for(const [f,m] of [[fid,id],[hidden,secret]])sql(`insert into msgr_attachments(id,message_id,org_id,storage_path,name,mime,bytes) values('${f}',${m},'${ORG}','${ORG}/${DM}/${m}/${f}-file.txt','file.txt','text/plain',4)`);
 const file=JSON.parse(last(sql(`set role anon; select msgr_bot_file('${b.token}','${fid}')`))); assert.equal(file.file_id,fid);
 fails(sqlRaw(`set role anon; select msgr_bot_file('${b.token}','${hidden}')`),/not_member/,'unrelated DM file');
 fails(sqlRaw(`set role anon; select msgr_bot_typing('${b.token}','${DM}',${id},'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3')`),/not_member/,'no matching execution');
 asUser(U.owner,`update msgr_messages set deleted_at=now() where id=${id}`);
 fails(sqlRaw(`set role anon; select msgr_bot_file('${b.token}','${fid}')`),/no_file|not_member/,'deleted source file');
});
test('intermediate delegation deletion revokes descendants and done never issues outgoing grants',{skip},()=>{
 const third=last(asUser(U.admin,`insert into msgr_crews(org_id,owner_user_id,ws_id,slug,display_name,allow) values('${ORG}','${U.admin}','different-ws','third','Third','all') returning id`));
 sql(`update msgr_crews set dm_delivery_protocol=1 where id='${third}'`);
 const id=post('Chain work');
 const first=last(asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,crew_id,body,reply_to,thread_root,mentions,meta) values('${DM}','crew','${CREW}','First',${id},${id},'${mention(OTHER_CREW)}','{"disposition":"handoff"}') returning id`));
 const attempt='cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
 asUser(U.member,`select msgr_execution_claim('lean','${OTHER_CREW}',${first},'${DM}','${attempt}')`);
 const payload={channel_id:DM,author_kind:'crew',crew_id:OTHER_CREW,kind:'text',client_msg_id:`reply:${OTHER_CREW}:${first}`,reply_to:Number(first),thread_root:Number(id),body:'Third please',mentions:[{kind:'crew',id:third,role:'to'}],meta:{disposition:'handoff'}};
 const result=JSON.parse(last(asUser(U.member,`select msgr_execution_finish('lean','${OTHER_CREW}',${first},'${DM}','${attempt}','${JSON.stringify(payload)}')`)));
 const thirdEnv=JSON.parse(last(asUser(U.admin,`select msgr_crew_context('different-ws','${third}',${result.id},'${DM}')`)));assert.equal(thirdEnv.delegated,true);
 sql(`update msgr_messages set deleted_at=now() where id=${first}`);
 assert.equal(sql(`select deleted_at is not null from msgr_messages where id=${first}`),'t');
 fails(asUserRaw(U.admin,`select msgr_crew_context('different-ws','${third}',${result.id},'${DM}')`),/forbidden/,'deleted ancestor');
 const root=post('Done now');
 const done=last(asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,crew_id,body,reply_to,thread_root,mentions,meta) values('${DM}','crew','${CREW}','Done @Third',${root},${root},'${mention(third)}','{"disposition":"done"}') returning id`));
 assert.equal(sql(`select count(*) from msgr_dm_grants where source_message_id=${done}`),'0');
});
test('native DM counterpart explicitly marked CC never wakes despite default routing',{skip},()=>{
 const id=post('Only a reference for you',mention(CREW,'cc'));
 assert.equal(sql(`select msgr_delivery_target('${CREW}',${id})`),'f');
 fails(asUserRaw(U.owner,`select msgr_execution_claim('lean','${CREW}',${id},'${DM}','cccccccc-cccc-4ccc-8ccc-ccccccccccc4')`),/forbidden/,'CC native recipient');
});
test('cross-owner Storage download policy allows exact granted file only, no DM directory/history',{skip},()=>{
 const id=post('Scoped file',mention(OTHER_CREW));const hidden=post('Hidden file');
 for(const [n,m] of [[5,id],[6,hidden]]){
 const f=`dddddddd-dddd-4ddd-8ddd-ddddddddddd${n}`;const path=`${ORG}/${DM}/${m}/${f}-file.txt`;
 sql(`insert into msgr_attachments(id,message_id,org_id,storage_path,name,mime,bytes) values('${f}',${m},'${ORG}','${path}','file.txt','text/plain',4)`);
 sql(`insert into storage.objects(id,bucket_id,name) values('${f}','msgr','${path}')`);
 }
 const names=JSON.parse(last(asUser(U.member,`select coalesce(jsonb_agg(name),'[]') from storage.objects where name like '%${DM}%'`)));
 assert.equal(names.length,1); assert.ok(names[0].includes('/'+id+'/'));
});
test('native DM ordinary conversation retains prior context and source-less notifications never delegate',{skip},()=>{
 const name=post('My name is Yoogeon');const ask=post('What is my name?');
 const e=env(ask,CREW,U.owner);assert.equal(e.delegated,false);assert.ok(e.context.some(r=>r.id===Number(name)));
 const notification=last(asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,crew_id,body,mentions,meta) values('${DM}','crew','${CREW}','Routine result','${mention(OTHER_CREW)}','{"disposition":"handoff"}') returning id`));
 assert.equal(sql(`select meta->>'disposition' from msgr_messages where id=${notification}`),'done');
 assert.equal(sql(`select count(*) from msgr_dm_grants where source_message_id=${notification}`),'0');
 fails(sqlRaw(`insert into msgr_messages(channel_id,author_kind,crew_id,body) values('${DM}','crew','${OTHER_CREW}','Unrequested')`),/not_allowed|not_in_channel/,'delegate source required');
});
test('delegated output attachment upload and atomic approval card bind the real execution source',{skip},()=>{
 const root=post('Make a file and request approval',mention(OTHER_CREW));
 const attempt='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
 asUser(U.member,`select msgr_execution_claim('lean','${OTHER_CREW}',${root},'${DM}','${attempt}')`);
 const approval={approval_id:'ap-dm-test',action:'publish_report',reason:'Review first',risk:'low'};
 const makeApproval=()=>JSON.parse(last(asUser(U.member,`select msgr_create_thread_approval('lean','${OTHER_CREW}',${root},'${DM}','${JSON.stringify(approval)}','Please approve report')`)));
 const a=makeApproval();assert.ok(a.approval.id);assert.ok(a.message.id);assert.deepEqual(makeApproval(),a);
 assert.equal(sql(`select reply_to from msgr_messages where id=${a.message.id}`),root);
 assert.equal(last(asUser(U.member,`select count(*) from msgr_crew_approvals where id='${a.approval.id}'`)),'1','owner sees own scoped approval');
 const payload={channel_id:DM,author_kind:'crew',crew_id:OTHER_CREW,kind:'text',client_msg_id:`reply:${OTHER_CREW}:${root}`,reply_to:Number(root),thread_root:Number(root),body:'Report attached',mentions:[],meta:{disposition:'done'}};
 const reply=JSON.parse(last(asUser(U.member,`select msgr_execution_finish('lean','${OTHER_CREW}',${root},'${DM}','${attempt}','${JSON.stringify(payload)}')`)));
 const path=`${ORG}/${DM}/${reply.id}/report.txt`;
 asUser(U.member,`insert into storage.objects(bucket_id,name) values('msgr','${path}')`);
 asUser(U.member,`insert into msgr_attachments(message_id,org_id,storage_path,name,mime,bytes) values(${reply.id},'${ORG}','${path}','report.txt','text/plain',4)`);
 fails(asUserRaw(U.member,`insert into storage.objects(bucket_id,name) values('msgr','${ORG}/${DM}/${root}/unexpected.txt')`),/row-level security/,'cannot write into human message');
 fails(asUserRaw(U.member,`insert into msgr_attachments(message_id,org_id,storage_path,name,bytes) values(${reply.id},'${OTHER_ORG}','${path}','wrong.txt',4)`),/row-level security/,'output cannot spoof org');
});
test('work stop and handoff cap are rechecked at claim even with a previously issued grant',{skip},()=>{
 const id=post('Bounded dialogue',mention(OTHER_CREW));
 for(let n=0;n<10;n++)sql(`insert into msgr_messages(channel_id,author_kind,crew_id,body,reply_to,thread_root,mentions,meta) values('${DM}','crew','${OTHER_CREW}','Step ${n}',${id},${id},'${mention(CREW)}','{"disposition":"handoff"}')`);
 const lastMsg=sql(`select max(id) from msgr_messages where thread_root=${id} and author_kind='crew'`);
 assert.equal(sql(`select msgr_delivery_allowed('${CREW}',${lastMsg})`),'f','hop budget cannot be reset by metadata');
 const request='ffffffff-ffff-4fff-8fff-fffffffffff1';
 const w=JSON.parse(last(asUser(U.owner,`select msgr_work_create('${DM}','${request}','Test stop','', '${CREW}')`)));
 asUser(U.owner,`select msgr_work_cancel('${w.id}')`);
 fails(asUserRaw(U.owner,`select msgr_crew_context('lean','${CREW}',${w.root_message_id},'${DM}')`),/forbidden/,'cancelled work cannot continue');
});
test('attachment alias cannot turn a granted request into a read of another request file',{skip},()=>{
 const granted=post('Granted attachment alias',mention(OTHER_CREW));const secret=post('Hidden attachment data');
 const actual=`${ORG}/${DM}/${secret}/private.txt`;
 sql(`insert into storage.objects(bucket_id,name) values('msgr','${actual}')`);
 // The legacy attachment metadata API accepts arbitrary paths; the new scoped download helper must not trust them.
 asUser(U.owner,`insert into msgr_attachments(message_id,org_id,storage_path,name,bytes) values(${granted},'${ORG}','${actual}','alias.txt',4)`);
 assert.equal(last(asUser(U.member,`select count(*) from storage.objects where name='${actual}'`)),'0');
});
test('runtime readiness is advertised and enforced for To and CC while native DM remains usable',{skip},()=>{
 sql(`update msgr_crews set dm_delivery_protocol=0 where id in ('${CREW}','${OTHER_CREW}')`);
 const candidates=JSON.parse(last(asUser(U.owner,`select jsonb_agg(x) from msgr_dm_candidates('${DM}') x`)));
 assert.equal(candidates.find(c=>c.id===CREW).delivery_ready,true);
 assert.equal(candidates.find(c=>c.id===OTHER_CREW).delivery_ready,false);
 for(const role of ['to','cc'])fails(asUserRaw(U.owner,`insert into msgr_messages(channel_id,author_kind,author_user_id,body,mentions) values('${DM}','user','${U.owner}','Not ready','${mention(OTHER_CREW,role)}')`),/msgr_runtime_update_required/,'unsupported '+role);
 const native=post('Native without upgrade');assert.equal(sql(`select msgr_delivery_allowed('${CREW}',${native})`),'t');
 asUser(U.member,`select count(*) from msgr_crew_inbox('lean','${OTHER_CREW}',999999)`);
 assert.equal(sql(`select dm_delivery_protocol from msgr_crews where id='${OTHER_CREW}'`),'1');
 const id=post('Supported now',mention(OTHER_CREW));assert.equal(env(id).delegated,true);
 sql(`update msgr_crews set dm_delivery_protocol=0 where id='${OTHER_CREW}'`);
 fails(asUserRaw(U.member,`select msgr_execution_claim('lean','${OTHER_CREW}',${id},'${DM}','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9')`),/forbidden/,'runtime recheck at execution');
 sql(`update msgr_crews set dm_delivery_protocol=1 where id in ('${CREW}','${OTHER_CREW}')`);
});
test('scoped delayed followup preserves handoff and CC, approval binding, idempotency and output uploads',{skip},()=>{
 const root=post('Delayed specialist task',mention(OTHER_CREW));const attempt='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9';
 asUser(U.member,`select msgr_execution_claim('lean','${OTHER_CREW}',${root},'${DM}','${attempt}')`);
 const ap=JSON.parse(last(asUser(U.member,`select msgr_create_thread_approval('lean','${OTHER_CREW}',${root},'${DM}','{"approval_id":"followup-ap","action":"publish_report"}','Review delayed task')`)));
 const payload={channel_id:DM,author_kind:'crew',crew_id:OTHER_CREW,kind:'text',client_msg_id:`reply:${OTHER_CREW}:${root}`,reply_to:Number(root),thread_root:Number(root),body:'Scheduled',mentions:[],meta:{disposition:'done'}};
 asUser(U.member,`select msgr_execution_finish('lean','${OTHER_CREW}',${root},'${DM}','${attempt}','${JSON.stringify(payload)}')`);
 const recipients=JSON.stringify([{kind:'crew',id:CREW,role:'to'},{kind:'crew',id:OTHER_CREW,role:'cc'}]);
 const call=(source=root,aid=ap.approval.id)=>`select msgr_post_thread_followup('lean','${OTHER_CREW}',${source},'${DM}','Delayed result','task-final','${recipients}','{"disposition":"handoff","origin":"${U.guest}","hop":-999}','${aid}')`;
 fails(asUserRaw(U.member,call()),/not_allowed/,'pending approval cannot authorize continuation');
 sql(`update msgr_crew_approvals set status='approved',decided_by='${U.owner}',decided_at=now() where id='${ap.approval.id}'`);
 const result=JSON.parse(last(asUser(U.member,call())));assert.deepEqual(JSON.parse(last(asUser(U.member,call()))),result);
 assert.equal(sql(`select meta->>'origin' from msgr_messages where id=${result.id}`),U.owner);
 assert.equal(sql(`select msgr_delivery_allowed('${CREW}',${result.id})`),'t','followup actually delegates');
 assert.equal(sql(`select msgr_cc_delivery_allowed('${OTHER_CREW}',${result.id})`),'t','passive copy is retained');
 const path=`${ORG}/${DM}/${result.id}/delayed.txt`;
 asUser(U.member,`insert into storage.objects(bucket_id,name) values('msgr','${path}')`);
 asUser(U.member,`insert into msgr_attachments(message_id,org_id,storage_path,name,bytes) values(${result.id},'${ORG}','${path}','delayed.txt',4)`);
 const other=post('Unrelated delayed task',mention(OTHER_CREW));
 fails(asUserRaw(U.member,call(other)),/not_allowed/,'other source cannot reuse approval');
 asUser(U.owner,`update msgr_messages set deleted_at=now() where id=${root}`);
 fails(asUserRaw(U.member,call()),/forbidden/,'revocation prevents even idempotent followup access');
});
test('native DM automation completes through current status and notification triggers',{skip},()=>{
 const routes=JSON.parse(last(asUser(U.owner,`select msgr_notification_routes_sync('lean','[{"kind":"telegram","label":"Test route","ready":true}]','test-device')`)));
 const a=JSON.parse(last(asUser(U.owner,`select msgr_automation_save_with_notifications(null,'${DM}','${CREW}','Daily reminder','Summarize schedule','{"kind":"daily","time":"09:00","timezone":"Asia/Seoul"}',null,array['${routes[0].id}']::uuid[])`)));
 const run=JSON.parse(last(asUser(U.owner,`select msgr_automation_run_now('${a.id}')`)));
 assert.ok(run.message_id);const src=run.message_id; const attempt='cccccccc-cccc-4ccc-8ccc-ccccccccccc9';
 asUser(U.owner,`select msgr_execution_claim('lean','${CREW}',${src},'${DM}','${attempt}')`);
 const payload={channel_id:DM,author_kind:'crew',crew_id:CREW,kind:'text',client_msg_id:`reply:${CREW}:${src}`,reply_to:src,thread_root:src,body:'Daily reminder result',mentions:[],meta:{disposition:'done'}};
 asUser(U.owner,`select msgr_execution_finish('lean','${CREW}',${src},'${DM}','${attempt}','${JSON.stringify(payload)}')`);
 assert.equal(sql(`select status from msgr_automation_runs where id='${run.id}'`),'completed');
 assert.equal(sql(`select count(*) from msgr_notification_deliveries where run_id='${run.id}' and status='pending'`),'1');
});
test('native DM bot can still read source-free routine notification attachments',{skip},()=>{
 const b=JSON.parse(last(asUser(U.owner,`select msgr_bot_create('${ORG}','openclaw','Native notification bot','Notifications')`)));
 const dm=last(asUser(U.owner,`select msgr_create_channel('${ORG}','dm','Native bot','[{"kind":"crew","id":"${b.crew_id}"}]')`));
 const mid=sql(`insert into msgr_messages(channel_id,author_kind,crew_id,body) values('${dm}','crew','${b.crew_id}','Routine attachment') returning id`);
 const fid='dddddddd-dddd-4ddd-8ddd-ddddddddddd9';
 sql(`insert into msgr_attachments(id,message_id,org_id,storage_path,name,bytes) values('${fid}',${mid},'${ORG}','${ORG}/${dm}/${mid}/routine.txt','routine.txt',4)`);
 assert.equal(JSON.parse(sql(`set role anon; select msgr_bot_file('${b.token}','${fid}')`)).file_id,fid);
});
test('request hard deletion revokes capabilities without blocking foreign-key cleanup',{skip},()=>{
 const root=post('Disposable retention request',mention(OTHER_CREW));const attempt='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee9';
 asUser(U.member,`select msgr_execution_claim('lean','${OTHER_CREW}',${root},'${DM}','${attempt}')`);
 const ap=JSON.parse(last(asUser(U.member,`select msgr_create_thread_approval('lean','${OTHER_CREW}',${root},'${DM}','{"approval_id":"retention-ap","action":"publish_report"}','Retention test')`)));
 sql(`delete from msgr_messages where id=${root}`);
 assert.equal(sql(`select count(*) from msgr_dm_grants where root_message_id=${root}`),'0');
 assert.equal(sql(`select dm_source_msg_id is null from msgr_crew_approvals where id='${ap.approval.id}'`),'t');
 fails(asUserRaw(U.member,`select msgr_crew_context('lean','${OTHER_CREW}',${root},'${DM}')`),/forbidden/,'deleted request cannot expose context');
});
