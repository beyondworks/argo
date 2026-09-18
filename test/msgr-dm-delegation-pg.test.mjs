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
const env=(id,crew=OTHER_CREW,uid=U.member,channel=DM)=>JSON.parse(last(asUser(uid,`select msgr_crew_context('lean','${crew}',${id},'${channel}')`)));
// Non-member To/CC recipients are relayed (2026-09-14 contract): the instruction is copied under the instructor's
// own name into "instructor↔crew" DM (msgr_dm_for_crew), where the crew IS a member and executes normally.
const relayOf=(source,crew)=>sql(`select id from msgr_messages where client_msg_id='relay:${source}:${crew}'`);
const noteOf=(source)=>sql(`select id from msgr_messages where client_msg_id='relaynote:${source}'`);
const row=(id)=>JSON.parse(sql(`select to_jsonb(m) from msgr_messages m where id=${id}`));
const chanOf=(id)=>sql(`select channel_id from msgr_messages where id=${id}`);
test('adjacent private DM hides the whole channel from another owner, and only its participants may bring an agent',{skip},()=>{
 DM=last(asUser(U.owner,`select msgr_create_channel('${ORG}','dm','Mine','[{"kind":"crew","id":"${CREW}"}]')`));
 post('Unrelated prior private conversation');
 assert.equal(last(asUser(U.member,`select count(*) from msgr_messages where channel_id='${DM}'`)),'0');
 // 2026-09-16부터 조직 대화방에는 에이전트 정원이 없다(유건 지시: 대화방에 에이전트 초대). 지키는 선은 "방 밖의 사람은 넣지 못한다"로 옮겼다.
 fails(asUserRaw(U.member,`insert into msgr_channel_members(channel_id,member_kind,member_id,added_by) values('${DM}','crew','${OTHER_CREW}','${U.member}')`),/row-level security|permission denied/,'a nonparticipant cannot push an agent in');
});
test('cross-owner explicit To relays into the user↔crew DM and executes only there',{skip},()=>{
 ROOT=post('Ask specialist',mention(OTHER_CREW));
 const relay=relayOf(ROOT,OTHER_CREW); assert.ok(relay,'relay row exists'); const relayCh=chanOf(relay);
 const e=env(relay,OTHER_CREW,U.member,relayCh);
 assert.equal(e.source.id,Number(relay)); assert.equal(e.root.id,Number(relay));
 assert.equal(e.delegated,false,'the relay lands as a normal member conversation in its own DM, not a delegated read of the origin');
 assert.deepEqual(e.context.map(r=>r.id),[Number(relay)],'no leak of the origin DM history into the relay context');
 assert.equal(sql(`select msgr_delivery_target('${CREW}',${ROOT})`),'f','default DM crew suppressed by explicit To');
 assert.equal(sql(`select msgr_delivery_target('${OTHER_CREW}',${ROOT})`),'t','origin still marks the specialist as addressed (drives the relay)');
 assert.equal(sql(`select msgr_delivery_allowed('${OTHER_CREW}',${ROOT})`),'f','no execution from the origin DM');
 assert.equal(last(asUser(U.member,`select count(*) from msgr_messages where channel_id='${DM}'`)),'0','no broad RLS grant into the origin DM');
 fails(asUserRaw(U.member,`select msgr_execution_claim('lean','${OTHER_CREW}',${ROOT},'${DM}','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0')`),/forbidden/,'origin source cannot be claimed');
 const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 const claim=JSON.parse(last(asUser(U.member,`select msgr_execution_claim('lean','${OTHER_CREW}',${relay},'${relayCh}','${a}')`)));
 assert.equal(claim.acquired,true);
 const reply={channel_id:relayCh,author_kind:'crew',crew_id:OTHER_CREW,kind:'text',client_msg_id:`reply:${OTHER_CREW}:${relay}`,reply_to:Number(relay),thread_root:Number(relay),body:'Specialist answer',mentions:[],meta:{disposition:'done'}};
 const done=JSON.parse(last(asUser(U.member,`select msgr_execution_finish('lean','${OTHER_CREW}',${relay},'${relayCh}','${a}','${JSON.stringify(reply)}')`)));
 assert.ok(done.id); assert.equal(env(relay,OTHER_CREW,U.member,relayCh).settled_source,true);
});
test('CC-only relays a passive copy into its own DM; cannot claim, respond or read the origin history',{skip},()=>{
 const id=post('For reference',mention(OTHER_CREW,'cc'));
 assert.equal(sql(`select msgr_delivery_target('${CREW}',${id})`),'t');
 assert.equal(sql(`select msgr_delivery_target('${OTHER_CREW}',${id})`),'f');
 const relay=relayOf(id,OTHER_CREW); assert.ok(relay,'cc relay exists'); const relayCh=chanOf(relay);
 fails(asUserRaw(U.member,`select msgr_execution_claim('lean','${OTHER_CREW}',${id},'${DM}','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab')`),/forbidden/,'CC cannot execute in the origin DM');
 fails(asUserRaw(U.member,`select msgr_execution_claim('lean','${OTHER_CREW}',${relay},'${relayCh}','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac')`),/forbidden/,'CC cannot execute even in its own relay copy');
 assert.equal(env(relay,OTHER_CREW,U.member,relayCh).delivery_role,'cc','passive context has explicit nonexecution role');
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
test('bot handoff from a DM crew relays under the human name into the bot\'s own DM and only executes there',{skip},()=>{
 const bot=JSON.parse(last(asUser(U.owner,`select msgr_bot_create('${ORG}','hermes','Feynman','Research')`)));
 const anon=q=>sql(`set role anon; ${q}`);
 anon(`select * from msgr_bot_updates_with_delivery('${bot.token}')`);
 const human=post('Ask Feynman');
 const first=last(asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,crew_id,body,reply_to,thread_root,mentions,meta) values('${DM}','crew','${CREW}','@Feynman role?',${human},${human},'${mention(bot.crew_id)}','{"disposition":"handoff","origin":"${U.guest}","hop":-100}') returning id`));
 assert.equal(sql(`select meta->>'origin' from msgr_messages where id=${first}`),U.owner,'server derives origin');
 const relay=relayOf(first,bot.crew_id); assert.ok(relay,'handoff relays into the bot\'s own DM'); const relayCh=chanOf(relay);
 const ups=JSON.parse(last(anon(`select coalesce(jsonb_agg(x),'[]') from msgr_bot_updates_with_delivery('${bot.token}') x`)));
 assert.ok(!ups.some(u=>Number(u.update_id)===Number(first)),'the bot never receives the origin DM message directly');
 const m=ups.find(u=>Number(u.update_id)===Number(relay))?.message; assert.ok(m);
 assert.equal(m.delegated,false,'the relay DM is a normal member conversation for the bot'); assert.equal(m.thread_root,Number(relay));
 assert.ok(m.context.every(row=>!row.text.includes('Unrelated prior')));
 anon(`select msgr_bot_typing('${bot.token}','${relayCh}',${m.message_id},'${m.execution_attempt}')`);
 const reply=last(anon(`select msgr_bot_finish('${bot.token}','${relayCh}','I research.',${m.message_id},'${m.execution_attempt}','done','[]')`));
 assert.equal(sql(`select channel_id from msgr_messages where id=${reply}`),relayCh);
 assert.equal(sql(`select count(*) from msgr_channel_members where channel_id='${DM}' and member_kind='crew'`),'1','origin DM membership untouched');
 assert.equal(sql(`select has_function_privilege('anon','msgr_bot_updates_before_work(text,bigint,int)','EXECUTE')`),'f');
 const cc=post('Bot reference',mention(bot.crew_id,'cc'));
 const ccRelay=relayOf(cc,bot.crew_id); assert.ok(ccRelay,'the cc copy also relays into the bot\'s own DM');
 const copy=JSON.parse(last(anon(`select coalesce(jsonb_agg(x),'[]') from msgr_bot_updates_with_delivery('${bot.token}') x`))).find(u=>Number(u.update_id)===Number(ccRelay));
 assert.equal(copy.message.delivery_role,'cc');assert.equal(copy.message.execution_attempt,null);
 assert.equal(sql(`select count(*) from msgr_executions where crew_id='${bot.crew_id}' and source_msg_id=${ccRelay}`),'0');
});
test('CC can read only granted thread; routing tamper, archived channel and root departure fail closed',{skip},()=>{
 const id=post('Reference facts',mention(OTHER_CREW,'cc'));
 // The origin DM is never readable by a non-member crew: grants are no longer written and old rows were cleared, so
 // even a CC recipient cannot see the origin thread (nor the relay note naming other recipients). It reads its own DM instead.
 fails(asUserRaw(U.member,`select * from msgr_crew_thread('lean','${OTHER_CREW}',${id})`),/forbidden/,'origin thread closed to the CC crew');
 const copy=row(relayOf(id,OTHER_CREW)); assert.equal(copy.meta.relay.role,'cc');
 const own=JSON.parse(last(asUser(U.member,`select coalesce(jsonb_agg(x),'[]') from msgr_crew_thread('lean','${OTHER_CREW}',${copy.id}) x`)));
 assert.deepEqual(own.map(x=>x.id),[copy.id],'the CC crew reads exactly its own relayed copy');
 const unrelated=post('Unshared secret');
 fails(asUserRaw(U.member,`select * from msgr_crew_thread('lean','${OTHER_CREW}',${unrelated})`),/forbidden/,'ungranted root');
 fails(asUserRaw(U.owner,`update msgr_messages set thread_root=${unrelated} where id=${id}`),/routing_immutable/,'root cannot be moved');
 sql(`update msgr_channels set archived_at=now() where id='${DM}'`);
 fails(asUserRaw(U.member,`select * from msgr_crew_thread('lean','${OTHER_CREW}',${id})`),/forbidden/,'archived DM');
 sql(`update msgr_channels set archived_at=null where id='${DM}'`);
 // 규칙 14(20260918130000): 주인이 나가면 그 주인의 에이전트도 같이 나간다 — 되돌릴 때 에이전트 행도 함께 복원한다
 const ownerCrews=sql(`select coalesce(string_agg(m.member_id::text,','),'') from msgr_channel_members m join msgr_crews c on c.id=m.member_id where m.channel_id='${DM}' and m.member_kind='crew' and c.owner_user_id='${U.owner}'`).split(',').filter(Boolean);
 sql(`delete from msgr_channel_members where channel_id='${DM}' and member_kind='user' and member_id='${U.owner}'`);
 assert.equal(sql(`select count(*) from msgr_channel_members m join msgr_crews c on c.id=m.member_id where m.channel_id='${DM}' and m.member_kind='crew' and c.owner_user_id='${U.owner}'`),'0','주인이 나가면 주인의 에이전트도 빠진다');
 fails(asUserRaw(U.member,`select * from msgr_crew_thread('lean','${OTHER_CREW}',${id})`),/forbidden/,'root user left');
 sql(`insert into msgr_channel_members(channel_id,member_kind,member_id,added_by) values('${DM}','user','${U.owner}','${U.owner}')`);
 for (const c of ownerCrews) sql(`insert into msgr_channel_members(channel_id,member_kind,member_id,added_by) values('${DM}','crew','${c}','${U.owner}') on conflict do nothing`);
});
test('bots never receive origin DM files through a relay and are denied direct typing or CC execution',{skip},()=>{
 const b=JSON.parse(last(asUser(U.owner,`select msgr_bot_create('${ORG}','openclaw','Wolff','Finance')`)));
 sql(`set role anon; select * from msgr_bot_updates_with_delivery('${b.token}')`);
 const id=post('Read attachment',mention(b.crew_id)); const secret=post('Unrelated file');
 const fid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', hidden='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
 for(const [f,m] of [[fid,id],[hidden,secret]])sql(`insert into msgr_attachments(id,message_id,org_id,storage_path,name,mime,bytes) values('${f}',${m},'${ORG}','${ORG}/${DM}/${m}/${f}-file.txt','file.txt','text/plain',4)`);
 // Attachments do not follow a relay (documented limit): the origin DM's files stay closed to the non-member bot,
 // exactly like any unrelated DM file. The bot only sees the relayed text in its own DM.
 fails(sqlRaw(`set role anon; select msgr_bot_file('${b.token}','${fid}')`),/not_member/,'origin DM file is not granted through a relay');
 fails(sqlRaw(`set role anon; select msgr_bot_file('${b.token}','${hidden}')`),/not_member/,'unrelated DM file');
 assert.ok(relayOf(id,b.crew_id),'the text itself was relayed');
 fails(sqlRaw(`set role anon; select msgr_bot_typing('${b.token}','${DM}',${id},'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3')`),/not_member/,'no matching execution');
 asUser(U.owner,`update msgr_messages set deleted_at=now() where id=${id}`);
 fails(sqlRaw(`set role anon; select msgr_bot_file('${b.token}','${fid}')`),/no_file|not_member/,'deleted source file');
});
test('crew-to-crew handoff chains relay hop by hop into each crew\'s own DM; an already-delivered relay copy is not retracted by later deleting a distant ancestor; done never relays or grants',{skip},()=>{
 const third=last(asUser(U.admin,`insert into msgr_crews(org_id,owner_user_id,ws_id,slug,display_name,allow) values('${ORG}','${U.admin}','different-ws','third','Third','all') returning id`));
 sql(`update msgr_crews set dm_delivery_protocol=1 where id='${third}'`);
 const id=post('Chain work');
 const first=last(asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,crew_id,body,reply_to,thread_root,mentions,meta) values('${DM}','crew','${CREW}','First',${id},${id},'${mention(OTHER_CREW)}','{"disposition":"handoff"}') returning id`));
 const relay1=relayOf(first,OTHER_CREW); assert.ok(relay1,'first hop relays into Theirs\' own DM'); const relay1Ch=chanOf(relay1);
 const attempt='cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
 asUser(U.member,`select msgr_execution_claim('lean','${OTHER_CREW}',${relay1},'${relay1Ch}','${attempt}')`);
 const payload={channel_id:relay1Ch,author_kind:'crew',crew_id:OTHER_CREW,kind:'text',client_msg_id:`reply:${OTHER_CREW}:${relay1}`,reply_to:Number(relay1),thread_root:Number(relay1),body:'Third please',mentions:[{kind:'crew',id:third,role:'to'}],meta:{disposition:'handoff'}};
 const result=JSON.parse(last(asUser(U.member,`select msgr_execution_finish('lean','${OTHER_CREW}',${relay1},'${relay1Ch}','${attempt}','${JSON.stringify(payload)}')`)));
 const relay2=relayOf(result.id,third); assert.ok(relay2,'second hop relays again, into a fresh DM with Third'); const relay2Ch=chanOf(relay2);
 const thirdEnv=JSON.parse(last(asUser(U.admin,`select msgr_crew_context('different-ws','${third}',${relay2},'${relay2Ch}')`)));
 assert.equal(thirdEnv.delegated,false); assert.equal(thirdEnv.source.meta.relay.via_crew_id,OTHER_CREW,'the forwarding crew is recorded');
 // KNOWN CONTRACT CONSEQUENCE (not a bug to fix here, see report): each relay is an independent, already-delivered
 // message in the recipient's own DM, with no live FK back to the origin. Deleting a distant ancestor note therefore
 // does not retract capability that was already relayed downstream — the old grant-chain revocation this test used
 // to exercise no longer applies once relay has fired.
 sql(`update msgr_messages set deleted_at=now() where id=${first}`);
 assert.equal(sql(`select deleted_at is not null from msgr_messages where id=${first}`),'t');
 assert.equal(sql(`select msgr_delivery_allowed('${third}',${relay2})`),'t','ancestor deletion does not retract the already-delivered relay copy');
 const root=post('Done now');
 const done=last(asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,crew_id,body,reply_to,thread_root,mentions,meta) values('${DM}','crew','${CREW}','Done @Third',${root},${root},'${mention(third)}','{"disposition":"done"}') returning id`));
 assert.equal(relayOf(done,third),'','done clears mentions and relays nothing');
 assert.equal(sql(`select count(*) from msgr_dm_grants where source_message_id=${done}`),'0');
});
test('native DM counterpart explicitly marked CC never wakes despite default routing',{skip},()=>{
 const id=post('Only a reference for you',mention(CREW,'cc'));
 assert.equal(sql(`select msgr_delivery_target('${CREW}',${id})`),'f');
 fails(asUserRaw(U.owner,`select msgr_execution_claim('lean','${CREW}',${id},'${DM}','cccccccc-cccc-4ccc-8ccc-ccccccccccc4')`),/forbidden/,'CC native recipient');
});
test('cross-owner Storage download policy grants nothing from the origin DM (attachments do not follow relays)',{skip},()=>{
 const id=post('Scoped file',mention(OTHER_CREW));const hidden=post('Hidden file');
 for(const [n,m] of [[5,id],[6,hidden]]){
 const f=`dddddddd-dddd-4ddd-8ddd-ddddddddddd${n}`;const path=`${ORG}/${DM}/${m}/${f}-file.txt`;
 sql(`insert into msgr_attachments(id,message_id,org_id,storage_path,name,mime,bytes) values('${f}',${m},'${ORG}','${path}','file.txt','text/plain',4)`);
 sql(`insert into storage.objects(id,bucket_id,name) values('${f}','msgr','${path}')`);
 }
 const names=JSON.parse(last(asUser(U.member,`select coalesce(jsonb_agg(name),'[]') from storage.objects where name like '%${DM}%'`)));
 assert.equal(names.length,0,'no origin DM file is readable by the other owner — attachments do not follow a relay');
});
test('native DM ordinary conversation retains prior context and source-less notifications never delegate',{skip},()=>{
 const name=post('My name is Yoogeon');const ask=post('What is my name?');
 const e=env(ask,CREW,U.owner);assert.equal(e.delegated,false);assert.ok(e.context.some(r=>r.id===Number(name)));
 const notification=last(asUser(U.owner,`insert into msgr_messages(channel_id,author_kind,crew_id,body,mentions,meta) values('${DM}','crew','${CREW}','Routine result','${mention(OTHER_CREW)}','{"disposition":"handoff"}') returning id`));
 assert.equal(sql(`select meta->>'disposition' from msgr_messages where id=${notification}`),'done');
 assert.equal(sql(`select count(*) from msgr_dm_grants where source_message_id=${notification}`),'0');
 fails(sqlRaw(`insert into msgr_messages(channel_id,author_kind,crew_id,body) values('${DM}','crew','${OTHER_CREW}','Unrequested')`),/not_allowed|not_in_channel/,'delegate source required');
});
test('delegated output attachment upload and atomic approval card bind the real execution source in its own relay DM',{skip},()=>{
 const root=post('Make a file and request approval',mention(OTHER_CREW));
 const relay=relayOf(root,OTHER_CREW); assert.ok(relay); const relayCh=chanOf(relay);
 const attempt='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
 asUser(U.member,`select msgr_execution_claim('lean','${OTHER_CREW}',${relay},'${relayCh}','${attempt}')`);
 const approval={approval_id:'ap-dm-test',action:'publish_report',reason:'Review first',risk:'low'};
 const makeApproval=()=>JSON.parse(last(asUser(U.member,`select msgr_create_thread_approval('lean','${OTHER_CREW}',${relay},'${relayCh}','${JSON.stringify(approval)}','Please approve report')`)));
 const a=makeApproval();assert.ok(a.approval.id);assert.ok(a.message.id);assert.deepEqual(makeApproval(),a);
 assert.equal(sql(`select reply_to from msgr_messages where id=${a.message.id}`),relay);
 assert.equal(last(asUser(U.member,`select count(*) from msgr_crew_approvals where id='${a.approval.id}'`)),'1','owner sees own scoped approval');
 const payload={channel_id:relayCh,author_kind:'crew',crew_id:OTHER_CREW,kind:'text',client_msg_id:`reply:${OTHER_CREW}:${relay}`,reply_to:Number(relay),thread_root:Number(relay),body:'Report attached',mentions:[],meta:{disposition:'done'}};
 const reply=JSON.parse(last(asUser(U.member,`select msgr_execution_finish('lean','${OTHER_CREW}',${relay},'${relayCh}','${attempt}','${JSON.stringify(payload)}')`)));
 const path=`${ORG}/${relayCh}/${reply.id}/report.txt`;
 asUser(U.member,`insert into storage.objects(bucket_id,name) values('msgr','${path}')`);
 asUser(U.member,`insert into msgr_attachments(message_id,org_id,storage_path,name,mime,bytes) values(${reply.id},'${ORG}','${path}','report.txt','text/plain',4)`);
 // The specialist's owner is a genuine member of their own relay DM (unlike the old cross-tenant delegate),
 // so the general per-channel file policy already covers paths inside it; the boundary that still holds is that
 // they cannot write anything at all into the origin DM they are not a member of.
 fails(asUserRaw(U.member,`insert into storage.objects(bucket_id,name) values('msgr','${ORG}/${DM}/${root}/unexpected.txt')`),/row-level security/,'cannot write into the origin DM at all');
 fails(asUserRaw(U.member,`insert into msgr_attachments(message_id,org_id,storage_path,name,bytes) values(${reply.id},'${OTHER_ORG}','${path}','wrong.txt',4)`),/row-level security/,'output cannot spoof org');
});
test('cancelled work halts continuation at the recheck gate',{skip},()=>{
 // REMOVED (documented, not faked — see report): the old hop-cap loop inserted 10 non-member crew replies
 // directly into the shared origin DM and expected msgr_delivery_allowed to block the 11th on hop count.
 // Under relay, msgr_delivery_allowed requires channel membership *before* it ever reaches the hop-count
 // branch, and a DM caps at exactly one member crew (see test 1), so two crews can never both be "in channel"
 // in the same DM — the hop-cap branch is structurally unreachable for DM-to-DM crew handoffs now (each relay
 // hop starts a fresh thread_root with hop=0 in a brand-new channel). Reproduced directly: 25 alternating
 // handoffs between two crews via real relay hops all succeeded with no cap (see report — possible unbounded
 // relay loop). There is no corresponding assertion to make here without asserting insecure behavior as "fixed".
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
test('delivery readiness no longer depends on the legacy runtime protocol flag; relay fires for To and CC either way',{skip},()=>{
 sql(`update msgr_crews set dm_delivery_protocol=0 where id in ('${CREW}','${OTHER_CREW}')`);
 const candidates=JSON.parse(last(asUser(U.owner,`select jsonb_agg(x) from msgr_dm_candidates('${DM}') x`)));
 assert.equal(candidates.find(c=>c.id===CREW).delivery_ready,true);
 assert.equal(candidates.find(c=>c.id===OTHER_CREW).delivery_ready,true,'candidates are always ready now — relay does not gate on the runtime protocol');
 for(const role of ['to','cc']){
  const id=post(`Not gated ${role}`,mention(OTHER_CREW,role));
  assert.ok(relayOf(id,OTHER_CREW),`${role} still relays at protocol 0`);
 }
 const native=post('Native without upgrade');assert.equal(sql(`select msgr_delivery_allowed('${CREW}',${native})`),'t','native member delivery is unaffected by the protocol flag');
 sql(`update msgr_crews set dm_delivery_protocol=1 where id in ('${CREW}','${OTHER_CREW}')`);
});
test('scoped delayed followup relays its To recipient into their own DM; approval binding, idempotency and output uploads stay bound to the relay source',{skip},()=>{
 const root=post('Delayed specialist task',mention(OTHER_CREW));
 const relay=relayOf(root,OTHER_CREW); assert.ok(relay); const relayCh=chanOf(relay);
 const attempt='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9';
 asUser(U.member,`select msgr_execution_claim('lean','${OTHER_CREW}',${relay},'${relayCh}','${attempt}')`);
 const ap=JSON.parse(last(asUser(U.member,`select msgr_create_thread_approval('lean','${OTHER_CREW}',${relay},'${relayCh}','{"approval_id":"followup-ap","action":"publish_report"}','Review delayed task')`)));
 const payload={channel_id:relayCh,author_kind:'crew',crew_id:OTHER_CREW,kind:'text',client_msg_id:`reply:${OTHER_CREW}:${relay}`,reply_to:Number(relay),thread_root:Number(relay),body:'Scheduled',mentions:[],meta:{disposition:'done'}};
 asUser(U.member,`select msgr_execution_finish('lean','${OTHER_CREW}',${relay},'${relayCh}','${attempt}','${JSON.stringify(payload)}')`);
 const recipients=JSON.stringify([{kind:'crew',id:CREW,role:'to'}]);
 const call=(source=relay,aid=ap.approval.id)=>`select msgr_post_thread_followup('lean','${OTHER_CREW}',${source},'${relayCh}','Delayed result','task-final','${recipients}','{"disposition":"handoff","origin":"${U.guest}","hop":-999}','${aid}')`;
 fails(asUserRaw(U.member,call()),/not_allowed/,'pending approval cannot authorize continuation');
 sql(`update msgr_crew_approvals set status='approved',decided_by='${U.owner}',decided_at=now() where id='${ap.approval.id}'`);
 const result=JSON.parse(last(asUser(U.member,call())));assert.deepEqual(JSON.parse(last(asUser(U.member,call()))),result);
 assert.equal(sql(`select meta->>'origin' from msgr_messages where id=${result.id}`),U.owner);
 const followupRelay=relayOf(result.id,CREW); assert.ok(followupRelay,'the To recipient of the followup gets it relayed into its own DM');
 assert.equal(chanOf(followupRelay),DM,'CREW\'s own DM is the origin DM itself, reused');
 assert.equal(sql(`select msgr_delivery_allowed('${CREW}',${followupRelay})`),'t','followup actually delegates, via relay');
 assert.equal(sql(`select msgr_delivery_allowed('${CREW}',${result.id})`),'f','no execution from the specialist\'s own channel on behalf of someone else');
 const path=`${ORG}/${relayCh}/${result.id}/delayed.txt`;
 asUser(U.member,`insert into storage.objects(bucket_id,name) values('msgr','${path}')`);
 asUser(U.member,`insert into msgr_attachments(message_id,org_id,storage_path,name,bytes) values(${result.id},'${ORG}','${path}','delayed.txt',4)`);
 const other=post('Unrelated delayed task',mention(OTHER_CREW));
 const otherRelay=relayOf(other,OTHER_CREW);
 fails(asUserRaw(U.member,call(otherRelay)),/not_allowed/,'other source cannot reuse approval');
 asUser(U.owner,`update msgr_messages set deleted_at=now() where id=${relay}`);
 fails(asUserRaw(U.member,call()),/forbidden/,'revoking the relay source prevents even idempotent followup access');
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
test('hard deletion of the relay source revokes capabilities without blocking foreign-key cleanup',{skip},()=>{
 const root=post('Disposable retention request',mention(OTHER_CREW));
 const relay=relayOf(root,OTHER_CREW); assert.ok(relay); const relayCh=chanOf(relay);
 const attempt='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee9';
 asUser(U.member,`select msgr_execution_claim('lean','${OTHER_CREW}',${relay},'${relayCh}','${attempt}')`);
 const ap=JSON.parse(last(asUser(U.member,`select msgr_create_thread_approval('lean','${OTHER_CREW}',${relay},'${relayCh}','{"approval_id":"retention-ap","action":"publish_report"}','Retention test')`)));
 sql(`delete from msgr_messages where id=${relay}`);
 assert.equal(sql(`select count(*) from msgr_dm_grants where root_message_id=${relay}`),'0');
 assert.equal(sql(`select dm_source_msg_id is null from msgr_crew_approvals where id='${ap.approval.id}'`),'t');
 fails(asUserRaw(U.member,`select msgr_crew_context('lean','${OTHER_CREW}',${relay},'${relayCh}')`),/forbidden/,'deleted request cannot expose context');
});
