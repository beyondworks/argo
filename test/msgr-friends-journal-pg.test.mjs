// 친구(같은 조직=즉시 친구·1:1 백필)와 채널 일지(크루 답글 → journal/YYYY-MM-DD.md) — 유건 제보 2026-09-14.
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

const row=(id)=>JSON.parse(sql(`select to_jsonb(m) from msgr_messages m where id=${id}`));
const today=()=>sql(`select to_char(now() at time zone 'Asia/Seoul','YYYY-MM-DD')`);
const journal=(ch)=>{ const r=sql(`select coalesce((select to_jsonb(d) from msgr_org_docs d where d.channel_id='${ch}' and d.path='journal/${today()}.md'),'null')`); return JSON.parse(r); };

test('same-org members become friends immediately; a stranger still gets a pending request',{skip},()=>{
 assert.equal(last(asUser(U.owner,`select msgr_friend_request('${U.member}')`)),'friend');
 assert.equal(sql(`select status from msgr_friends where a=least('${U.owner}','${U.member}')::uuid and b=greatest('${U.owner}','${U.member}')::uuid`),'accepted');
 const mine=JSON.parse(last(asUser(U.owner,`select coalesce(jsonb_agg(f),'[]') from msgr_my_friends() f`)));
 assert.ok(mine.some(f=>f.user_id===U.member && f.status==='accepted'),'friend list shows the colleague');
 assert.equal(last(asUser(U.owner,`select msgr_friend_request('${U.guest}')`)),'sent','different org keeps the request flow');
 assert.equal(last(asUser(U.owner,`select msgr_friend_request('${U.member}')`)),'friend','idempotent');
});

test('backfill: an existing person-to-person DM inside the org already produced a friend row',{skip},()=>{
 // The migration ran before this test's org existed, so replay its backfill statement against a fresh DM to pin the shape.
 sql(`delete from msgr_friends where a=least('${U.owner}','${U.admin}')::uuid and b=greatest('${U.owner}','${U.admin}')::uuid`);
 const dm=last(asUser(U.owner,`select msgr_create_channel('${ORG}','dm','admin','[{"kind":"user","id":"${U.admin}"}]')`));
 sql(`insert into public.msgr_friends (a, b, status, requested_by, decided_at)
  select p.pr[1], p.pr[2], 'accepted', coalesce(p.created_by, p.pr[1]), p.created_at from (
   select ch.created_by, ch.created_at, public.msgr_friend_pair((array_agg(m.member_id order by m.member_id))[1], (array_agg(m.member_id order by m.member_id))[2]) pr
   from public.msgr_channels ch join public.msgr_channel_members m on m.channel_id=ch.id and m.member_kind='user'
   where ch.kind='dm' and ch.archived_at is null and ch.id='${dm}'
   and not exists (select 1 from public.msgr_channel_members c where c.channel_id=ch.id and c.member_kind='crew')
   group by ch.id, ch.created_by, ch.created_at having count(*)=2) p where public.msgr_same_org_active(p.pr[1], p.pr[2]) on conflict (a, b) do nothing`);
 assert.equal(sql(`select status||':'||requested_by from msgr_friends where a=least('${U.owner}','${U.admin}')::uuid and b=greatest('${U.owner}','${U.admin}')::uuid`),`accepted:${U.owner}`);
});

test('crew replies in a memory-enabled channel append to that channel journal; DMs journal for their members only; memory-off channels never do; no audit noise',{skip},()=>{
 const before=sql(`select count(*) from msgr_audit_log where org_id='${ORG}' and action like 'doc.%'`);
 const ask=last(asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,author_user_id,body,mentions) values('${PUB}','user','${U.owner}','오늘 할 일 정리해줘','[{"kind":"crew","id":"${CREW}"}]') returning id`));
 const reply=last(asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,crew_id,body,reply_to,thread_root,client_msg_id,meta) values('${PUB}','crew','${CREW}','1. 브리프 2. 회의록',${ask},${ask},'reply:${CREW}:${ask}','{"disposition":"done"}') returning id`));
 const j=journal(PUB); assert.ok(j,'journal doc exists');
 assert.equal(j.path,`journal/${today()}.md`); assert.equal(j.title,today()); assert.equal(j.created_by,U.owner); assert.equal(j.version,1);
 assert.match(j.body,/\*\*Mine\*\* ← .*: 오늘 할 일 정리해줘 → 1\. 브리프 2\. 회의록/);
 const ask2=last(asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,author_user_id,body) values('${PUB}','user','${U.owner}','두 번째') returning id`));
 asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,crew_id,body,reply_to,thread_root,client_msg_id,meta) values('${PUB}','crew','${CREW}','두 번째 답',${ask2},${ask2},'reply:${CREW}:${ask2}','{"disposition":"done"}')`);
 const j2=journal(PUB); assert.equal(j2.version,2,'second reply appends'); assert.equal(j2.body.split('\n').length,2);
 assert.equal(sql(`select count(*) from msgr_audit_log where org_id='${ORG}' and action like 'doc.%'`),before,'journal writes leave no doc audit rows');
 const dm=last(asUser(U.owner,`select msgr_create_channel('${ORG}','dm','Mine','[{"kind":"crew","id":"${CREW}"}]')`));
 const dask=last(asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,author_user_id,body) values('${dm}','user','${U.owner}','DM 질문') returning id`));
 asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,crew_id,body,reply_to,thread_root,client_msg_id,meta) values('${dm}','crew','${CREW}','DM 답',${dask},${dask},'reply:${CREW}:${dask}','{"disposition":"done"}')`);
 const dj=journal(dm); assert.ok(dj,'DM crew replies journal too (2026-09-16 — 문서는 채널 범위 RLS)'); assert.equal(dj.channel_id,dm); assert.match(dj.body,/DM 질문 → DM 답/);
 assert.equal(last(asUser(U.owner,`select count(*) from msgr_org_docs where channel_id='${dm}'`)),'1','DM 참여자(소유자)는 DM 일지를 읽는다');
 assert.equal(last(asUser(U.member,`select count(*) from msgr_org_docs where channel_id='${dm}'`)),'0','DM 밖 조직 멤버에게는 DM 일지가 보이지 않는다(RLS)');
 assert.equal(sql(`select count(*) from msgr_audit_log where org_id='${ORG}' and action like 'doc.%'`),before,'DM journal writes leave no doc audit rows either');
 sql(`update msgr_channels set crew_memory=false where id='${PUB}'`);
 const off=last(asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,author_user_id,body) values('${PUB}','user','${U.owner}','기억 끔') returning id`));
 asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,crew_id,body,reply_to,thread_root,client_msg_id,meta) values('${PUB}','crew','${CREW}','기억 끔 답',${off},${off},'reply:${CREW}:${off}','{"disposition":"done"}')`);
 assert.equal(journal(PUB).version,2,'memory-off channel stops journaling');
 sql(`update msgr_channels set crew_memory=true where id='${PUB}'`);
 fails(asUserRaw(U.owner,`insert into msgr_org_docs(org_id,channel_id,path,title,body,created_by,updated_by) values('${ORG}','${PUB}','secret/x.md','x','',$$${U.owner}$$,$$${U.owner}$$)`),/check|violates/,'folder set stays closed');
});
