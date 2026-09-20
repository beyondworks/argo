// DM 전달(relay): 수신·참조로 지정된 비멤버 크루의 지시가 "지시자와 그 크루의 1:1 방"으로 옮겨지고, 원래 방에는 안내만 남는다(유건 2026-09-14).
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
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

let DM, SECOND, SECOND_DM;
const mention=(id,role='to')=>JSON.stringify([{kind:'crew',id,role}]);
const post=(body,mentions='[]',channel=DM)=>last(asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,author_user_id,body,mentions) values('${channel}','user','${U.owner}','${body}','${mentions}') returning id`));
const row=(id)=>JSON.parse(sql(`select to_jsonb(m) from msgr_messages m where id=${id}`));
const relayOf=(source,crew)=>sql(`select id from msgr_messages where client_msg_id='relay:${source}:${crew}'`);
const noteOf=(source)=>sql(`select id from msgr_messages where client_msg_id='relaynote:${source}'`);
const dmUsers=(ch)=>sql(`select coalesce(string_agg(member_id::text,',' order by member_id),'') from msgr_channel_members where channel_id='${ch}' and member_kind='user'`);
const dmCrews=(ch)=>sql(`select coalesce(string_agg(member_id::text,','),'') from msgr_channel_members where channel_id='${ch}' and member_kind='crew'`);

test('setup: my DM with my crew; a second crew of mine already has its own DM',{skip},()=>{
 DM=last(asUser(U.owner,`select msgr_create_channel('${ORG}','dm','Mine','[{"kind":"crew","id":"${CREW}"}]')`));
 SECOND=last(asUser(U.owner,`insert into msgr_crews(org_id,owner_user_id,ws_id,slug,display_name,allow,status,last_seen_at) values('${ORG}','${U.owner}','lean','second','Second','all','active',now()) returning id`));
 SECOND_DM=last(asUser(U.owner,`select msgr_create_channel('${ORG}','dm','Second','[{"kind":"crew","id":"${SECOND}"}]')`));
 post('Private history with Mine');
});

test('To for a crew outside this DM is relayed into the user↔crew DM (created on demand) and only executes there',{skip},()=>{
 const before=sql(`select count(*) from msgr_channels where org_id='${ORG}' and kind='dm'`);
 const id=post('Ask specialist',mention(OTHER_CREW));
 assert.equal(sql(`select count(*) from msgr_channels where org_id='${ORG}' and kind='dm'`),String(Number(before)+1),'a DM for the specialist was created');
 const relay=relayOf(id,OTHER_CREW); assert.ok(relay,'relay row exists');
 const r=row(relay);
 assert.notEqual(r.channel_id,DM,'relay lives in another channel');
 assert.equal(dmUsers(r.channel_id),[U.owner,U.member].sort().join(','),'DM users = instructing user + crew owner');
 assert.equal(dmCrews(r.channel_id),OTHER_CREW);
 assert.equal(sql(`select name from msgr_channels where id='${r.channel_id}'`),'Theirs');
 assert.equal(r.author_kind,'user'); assert.equal(r.author_user_id,U.owner); assert.equal(r.body,'Ask specialist');
 assert.equal(r.thread_root,Number(relay),'relay is its own root');
 assert.deepEqual(r.mentions,[{kind:'crew',id:OTHER_CREW,role:'to'}]);
 assert.equal(r.meta.relay.source_id,Number(id)); assert.equal(r.meta.relay.channel_id,DM); assert.equal(r.meta.relay.role,'to'); assert.equal(r.meta.relay.via_crew_id,null);
 const note=noteOf(id); assert.ok(note,'origin DM has a relay note');
 const n=row(note); assert.equal(n.channel_id,DM); assert.equal(n.kind,'system'); assert.equal(n.reply_to,Number(id)); assert.equal(n.author_user_id,U.owner);
 assert.deepEqual(n.meta.relay_to.map(x=>[x.crew_id,x.channel_id,x.role,x.name]),[[OTHER_CREW,r.channel_id,'to','Theirs']]);
 assert.match(n.body,/Theirs에게 전달했습니다/);
 assert.equal(sql(`select msgr_delivery_allowed('${OTHER_CREW}',${id})`),'f','no execution from the origin DM');
 assert.equal(sql(`select msgr_delivery_target('${CREW}',${id})`),'f','the DM counterpart is not woken by an explicit To for someone else');
 assert.equal(sql(`select msgr_delivery_allowed('${OTHER_CREW}',${relay})`),'t','execution happens from the relay in its own DM');
 assert.equal(last(asUser(U.member,`select count(*) from msgr_messages where channel_id='${DM}'`)),'0','specialist owner never sees the origin DM');
 assert.equal(last(asUser(U.member,`select body from msgr_messages where id=${relay}`)),'Ask specialist','specialist owner reads the relay in the shared DM');
 const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
 assert.equal(JSON.parse(last(asUser(U.member,`select msgr_execution_claim('lean','${OTHER_CREW}',${relay},'${r.channel_id}','${a}')`))).acquired,true);
 const reply={channel_id:r.channel_id,author_kind:'crew',crew_id:OTHER_CREW,kind:'text',client_msg_id:`reply:${OTHER_CREW}:${relay}`,reply_to:Number(relay),thread_root:Number(relay),body:'Specialist answer',mentions:[],meta:{disposition:'done'}};
 const done=JSON.parse(last(asUser(U.member,`select msgr_execution_finish('lean','${OTHER_CREW}',${relay},'${r.channel_id}','${a}','${JSON.stringify(reply)}')`)));
 assert.equal(sql(`select channel_id from msgr_messages where id=${done.id}`),r.channel_id,'the answer stays in the specialist DM');
 assert.equal(sql(`select count(*) from msgr_messages where channel_id='${DM}' and author_kind='crew'`),'0','origin DM never receives another crew\'s reply');
 fails(asUserRaw(U.member,`select msgr_execution_claim('lean','${OTHER_CREW}',${id},'${DM}','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2')`),/forbidden|not_targeted|not_allowed/,'origin source cannot be claimed');
 const again=post('Second ask',mention(OTHER_CREW));
 assert.equal(row(relayOf(again,OTHER_CREW)).channel_id,r.channel_id,'existing specialist DM is reused');
});

test('same-owner crew reuses my existing DM with it; CC is relayed as a passive copy',{skip},()=>{
 const id=post('Both of you',`[{"kind":"crew","id":"${OTHER_CREW}","role":"to"},{"kind":"crew","id":"${SECOND}","role":"cc"}]`);
 const cc=row(relayOf(id,SECOND));
 assert.equal(cc.channel_id,SECOND_DM,'no duplicate DM for a crew that already has one');
 assert.deepEqual(cc.mentions,[{kind:'crew',id:SECOND,role:'cc'}]); assert.equal(cc.meta.relay.role,'cc');
 assert.equal(sql(`select msgr_delivery_target('${SECOND}',${cc.id})`),'f','CC copy never executes');
 assert.equal(sql(`select msgr_cc_delivery_allowed('${SECOND}',${cc.id})`),'t','CC copy is delivered passively in its own DM');
 assert.equal(sql(`select msgr_cc_delivery_allowed('${SECOND}',${id})`),'f','no passive delivery from the origin DM');
 const n=row(noteOf(id)); assert.equal(n.meta.relay_to.length,2); assert.match(n.body,/Second\(참조\)/); assert.match(n.body,/Theirs/);
 assert.equal(sql(`select count(*) from msgr_messages where client_msg_id like 'relay:${cc.id}:%'`),'0','a relay row is never relayed again');
});

test('crew handoff inside a DM is relayed under the user name with the via crew recorded; done never relays',{skip},()=>{
 const rootId=post('Plan this');
 const hand=last(asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,crew_id,body,reply_to,thread_root,mentions,meta) values('${DM}','crew','${CREW}','@Theirs please research',${rootId},${rootId},'${mention(OTHER_CREW)}','{"disposition":"handoff"}') returning id`));
 const r=row(relayOf(hand,OTHER_CREW));
 assert.equal(r.author_kind,'user'); assert.equal(r.author_user_id,U.owner); assert.equal(r.body,'@Theirs please research');
 assert.equal(r.meta.relay.via_crew_id,CREW); assert.equal(r.meta.relay.via_name,'Mine');
 assert.equal(sql(`select msgr_delivery_allowed('${OTHER_CREW}',${r.id})`),'t');
 assert.equal(sql(`select msgr_delivery_allowed('${OTHER_CREW}',${hand})`),'f','no execution from the origin DM');
 assert.ok(noteOf(hand),'origin DM gets the relay note under the crew handoff');
 const done=last(asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,crew_id,body,reply_to,thread_root,mentions,meta) values('${DM}','crew','${CREW}','Done @Theirs',${rootId},${rootId},'${mention(OTHER_CREW)}','{"disposition":"done"}') returning id`));
 assert.equal(relayOf(done,OTHER_CREW),'','done clears mentions and relays nothing');
});

test('relay is DM-only; the DM counterpart itself and public channels are untouched',{skip},()=>{
 const id=post('Just you',mention(CREW));
 assert.equal(relayOf(id,CREW),'','a member crew is not relayed'); assert.equal(noteOf(id),'');
 assert.equal(sql(`select msgr_delivery_allowed('${CREW}',${id})`),'t');
 const pub=post('Public ask',mention(OTHER_CREW),PUB);
 assert.equal(sql(`select count(*) from msgr_messages where client_msg_id like 'relay:${pub}:%'`),'0','public channels keep their own scope rules');
 const choices=JSON.parse(last(asUser(U.owner,`select coalesce(jsonb_agg(c),'[]') from msgr_dm_candidates('${DM}') c`)));
 assert.ok(choices.every(c=>c.delivery_ready===true),'every instructable crew is ready — relay does not depend on runtime version');
});

test('crew-to-crew relay stops before revisiting an agent, while a user instruction starts a fresh chain',{skip},()=>{
 const rootId=post('Start the loop',mention(OTHER_CREW));
 const relay=row(relayOf(rootId,OTHER_CREW)); assert.equal(relay.meta.relay.depth,1); assert.deepEqual(relay.meta.relay.visited_crew_ids,[OTHER_CREW]);
 const forward=last(asUser(U.member,`insert into msgr_messages(channel_id,author_kind,crew_id,body,reply_to,thread_root,mentions,meta) values('${relay.channel_id}','crew','${OTHER_CREW}','@Mine continue',${relay.id},${relay.id},'${mention(CREW)}','{"disposition":"handoff"}') returning id`));
 const second=row(relayOf(forward,CREW)); assert.equal(second.meta.relay.depth,2); assert.deepEqual(second.meta.relay.visited_crew_ids,[OTHER_CREW,CREW]);
 const hand=last(asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,crew_id,body,reply_to,thread_root,mentions,meta) values('${second.channel_id}','crew','${CREW}','@Theirs again',${second.id},${second.id},'${mention(OTHER_CREW)}','{"disposition":"handoff"}') returning id`));
 assert.equal(relayOf(hand,OTHER_CREW),'','a crew already in the relay chain is never revisited');
 const cap=row(sql(`select id from msgr_messages where client_msg_id='relaycap:${hand}'`));
 assert.equal(cap.channel_id,second.channel_id); assert.equal(cap.meta.relay_capped,3); assert.equal(cap.meta.relay_cycle,true);
 const fresh=post('Human asks again',mention(OTHER_CREW));
 const next=row(relayOf(fresh,OTHER_CREW)); assert.equal(next.meta.relay.depth,1,'a human instruction resets the chain'); assert.notEqual(next.meta.relay.chain_id,relay.meta.relay.chain_id);
});

test('a crew initiating a handoff is included in the chain and cannot receive the return hop',{skip},()=>{
 const rootId=post('Ask Mine to delegate');
 const hand=last(asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,crew_id,body,reply_to,thread_root,mentions,meta) values('${DM}','crew','${CREW}','Delegate research',${rootId},${rootId},'${mention(OTHER_CREW)}','{"disposition":"handoff"}') returning id`));
 const relay=row(relayOf(hand,OTHER_CREW));
 const back=last(asUser(U.member,`insert into msgr_messages(channel_id,author_kind,crew_id,body,reply_to,thread_root,mentions,meta) values('${relay.channel_id}','crew','${OTHER_CREW}','Return to Mine',${relay.id},${relay.id},'${mention(CREW)}','{"disposition":"handoff"}') returning id`));
 assert.equal(relayOf(back,CREW),'','A → B → A must stop before the first return to A');
 assert.deepEqual(relay.meta.relay.visited_crew_ids,[CREW,OTHER_CREW]);
 assert.equal(row(sql(`select id from msgr_messages where client_msg_id='relaycap:${back}'`)).meta.relay_cycle,true);
 assert.equal(noteOf(back),'','no delivery note when the only target was blocked');
});

for (const cycleFirst of [true,false]) test(`mixed cyclic and valid recipients preserve delivery and truthful notes (cycle first: ${cycleFirst})`,{skip},()=>{
 const rootId=post('Start mixed route',mention(OTHER_CREW));
 const first=row(relayOf(rootId,OTHER_CREW));
 const forward=last(asUser(U.member,`insert into msgr_messages(channel_id,author_kind,crew_id,body,reply_to,thread_root,mentions,meta) values('${first.channel_id}','crew','${OTHER_CREW}','Next agent',${first.id},${first.id},'${mention(CREW)}','{"disposition":"handoff"}') returning id`));
 const relay=row(relayOf(forward,CREW));
 const targets=(cycleFirst?[OTHER_CREW,SECOND]:[SECOND,OTHER_CREW]).map(id=>({kind:'crew',id,role:'to'}));
 const hand=last(asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,crew_id,body,reply_to,thread_root,mentions,meta) values('${relay.channel_id}','crew','${CREW}','Try both targets',${relay.id},${relay.id},'${JSON.stringify(targets)}','{"disposition":"handoff"}') returning id`));
 assert.equal(relayOf(hand,OTHER_CREW),'','cyclic recipient is blocked');
 assert.ok(relayOf(hand,SECOND),'the independent valid recipient receives the handoff');
 assert.ok(noteOf(hand),'valid delivery always produces its notice');
 const note=row(noteOf(hand));
 assert.deepEqual(note.meta.relay_to.map(x=>x.crew_id),[SECOND]);
 assert.match(note.body,/Second에게 전달했습니다/);
 assert.doesNotMatch(note.body,/Theirs/);
 const cap=row(sql(`select id from msgr_messages where client_msg_id='relaycap:${hand}'`));
 assert.equal(cap.meta.relay_cycle,true);
 assert.equal(row(relayOf(hand,SECOND)).meta.relay.depth,3);
});

test('relay permits five distinct hops and stops a sixth before delivery',{skip},()=>{
 const extras=['Third','Fourth','Fifth','Sixth','Seventh'].map((name,i)=>last(asUser(U.owner,`insert into msgr_crews(org_id,owner_user_id,ws_id,slug,display_name,allow,status,last_seen_at,dm_delivery_protocol,work_protocol) values('${ORG}','${U.owner}','lean','route-${i}','${name}','all','active',now(),1,1) returning id`)));
 const route=[OTHER_CREW,...extras];
 const rootId=post('Visit each specialist once',mention(route[0]));
 let relay=row(relayOf(rootId,route[0]));
 for (let depth=2; depth<=5; depth++) {
   const sender=route[depth-2]; const target=route[depth-1]; const senderUser=sender===OTHER_CREW?U.member:U.owner;
   const hand=last(asUser(senderUser,`insert into msgr_messages(channel_id,author_kind,crew_id,body,reply_to,thread_root,mentions,meta) values('${relay.channel_id}','crew','${sender}','continue',${relay.id},${relay.id},'${mention(target)}','{"disposition":"handoff"}') returning id`));
   relay=row(relayOf(hand,target)); assert.equal(relay.meta.relay.depth,depth); assert.equal(relay.meta.relay.visited_crew_ids.length,depth);
 }
 const hand=last(asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,crew_id,body,reply_to,thread_root,mentions,meta) values('${relay.channel_id}','crew','${route[4]}','one more',${relay.id},${relay.id},'${mention(route[5])}','{"disposition":"handoff"}') returning id`));
 assert.equal(relayOf(hand,route[5]),'','the sixth hop is not delivered');
 const cap=row(sql(`select id from msgr_messages where client_msg_id='relaycap:${hand}'`));
 assert.equal(cap.meta.relay_capped,6); assert.equal(cap.meta.relay_cycle,false); assert.match(cap.body,/5단계/);
});

test('a failing relay target never rolls back the original message; the notice marks that target as failed',{skip},()=>{
 const theirsDm=sql(`select msgr_dm_for_crew('${ORG}','${U.owner}','${OTHER_CREW}')`);
 sql(`update msgr_channels set personal_crews='read_only' where id='${theirsDm}'`);
 const id=post('Still recorded here',mention(OTHER_CREW));
 assert.equal(sql(`select count(*) from msgr_messages where id=${id}`),'1','my message survives');
 assert.equal(relayOf(id,OTHER_CREW),'','no relay into a read-only DM');
 const n=row(noteOf(id)); assert.equal(n.meta.relay_to[0].channel_id,null); assert.ok(n.meta.relay_to[0].failed); assert.match(n.body,/전달 실패/);
 sql(`update msgr_channels set personal_crews='allowed' where id='${theirsDm}'`);
});

test('clients cannot forge relay markers; only the trigger writes them',{skip},()=>{
 const id=last(asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,author_user_id,body,meta) values('${DM}','user','${U.owner}','Spoof','{"relay":{"via_name":"대표님"},"relay_to":[{"name":"x"}],"relay_capped":9,"keep":1}') returning id`));
 assert.deepEqual(row(id).meta,{keep:1},'relay/relay_to/relay_capped stripped from a top-level insert');
 const real=post('Real',mention(OTHER_CREW));
 assert.ok(row(relayOf(real,OTHER_CREW)).meta.relay,'trigger-written relay marker survives');
 assert.equal(sql(`select count(*) from msgr_dm_grants`),'0','no grants are written any more');
});
