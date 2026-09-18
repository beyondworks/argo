// Real HTTP facade → PostgreSQL anon/authenticated RPC → packaged OpenClaw relay in a disposable database.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handle, parseRequest } from '../supabase/functions/msgr-bot/core.js';
import { makeApi, relayReply } from '../integrations/openclaw-argo-msgr/src/api.js';
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
    '20260911150000_msgr_channel_manage.sql', '20260911230000_msgr_channel_scope_enforce.sql', '20260912001000_msgr_bot_files.sql', '20260912135036_msgr_target_favorites_dm_leave.sql',
    '20260912150000_msgr_push.sql', '20260912160000_msgr_push_register_fix.sql', '20260912161000_msgr_push_recipients_all.sql', '20260912170000_msgr_push_sound.sql',
    '20260912171000_msgr_push_badge.sql', '20260912172000_msgr_push_badge_sync.sql', '20260912180000_msgr_pinned_and_push_mute.sql', '20260912200000_msgr_prefs_pin_pos_folder.sql',
    '20260913010000_msgr_work_runs.sql', '20260913084237_msgr_friend_member_search.sql', '20260913110000_msgr_automations.sql', '20260913110500_msgr_notification_destinations.sql',
    '20260913122421_msgr_dm_thread_delegation.sql', '20260913160000_msgr_wood_sound_default.sql', '20260914090000_msgr_dm_relay.sql'])
    psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]); // net.http_post is stubbed in the harness above; pg_net itself is unavailable here
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

// This transport substitutes only PostgREST serialization. Every authorization,
// claim, context, recipient, and persistence result comes from the real SQL RPC.
const literal = value => value == null ? 'null' : typeof value === 'number' ? String(value) : `'${(typeof value === 'object' ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'`;
async function databaseRpc(name, args) {
  assert.match(name, /^msgr_bot_[a-z_]+$/);
  const expression = `public.${name}(${Object.entries(args).map(([key, value]) => {
    assert.match(key, /^[a-z_]+$/);
    const cast = ['channel','attempt','attachment'].includes(key) ? '::uuid' : key === 'mentions' ? '::jsonb' : '';
    return `${key} => ${literal(value)}${cast}`;
  }).join(',')})`;
  const result = sqlRaw(`set role anon; select ${name.startsWith('msgr_bot_updates') ? `coalesce(jsonb_agg(r),'[]') from ${expression} r` : `to_jsonb(${expression})`}`);
  if (result.status !== 0) throw new Error(result.stderr.replaceAll(String(args.token), '[fixture credential]'));
  return JSON.parse(last(result.stdout) || 'null');
}
let server, base, outbox, pepper, feynman, wolff, DM, OTHER_DM, memberSnapshot;
const post = (body, mentions = [], channel = DM) => Number(last(asUser(U.owner, `insert into msgr_messages(channel_id,author_kind,author_user_id,body,mentions) values('${channel}','user','${U.owner}',${literal(body)},${literal(mentions)}) returning id`)));
const mention = (crew, role = 'to') => ({kind:'crew',id:crew.crew_id,role});
// Non-member To/CC recipients are relayed (2026-09-14 contract): the bot never sees the origin DM message id;
// it only ever receives the relay copy that lands in its own "instructor↔bot" DM (msgr_dm_for_crew).
const relayOf = (source, crewId) => { const id = sql(`select id from msgr_messages where client_msg_id='relay:${source}:${crewId}'`); return id ? Number(id) : null; };
const chanOf = (id) => sql(`select channel_id from msgr_messages where id=${id}`);
const call = async (bot, method, params = {}) => {
  const response = await fetch(`${base}/bot${bot.token}/${method}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(method === 'getUpdates' ? {delivery_protocol:1,...params} : params)});
  return {status:response.status, ...(await response.json())};
};
const update = async (bot, source) => {
  const result = await call(bot,'getUpdates',{offset:source,limit:100,timeout:0});
  assert.equal(result.status,200,JSON.stringify(result));
  const found = result.result.find(item => item.update_id === source)?.message;
  assert.ok(found, `Expected source ${source} in real bot updates`);
  return found;
};
const answer = async (bot, message, text) => {
  const output = relayReply(text, message);
  const api = makeApi({url:base,token:bot.token,outboxDir:outbox});
  return api.sendMessage(message.chat.id,output.text,message.message_id,output.execution);
};
before(async () => {
  if (!DB) return;
  // Creating bots is an actual admin RPC; the specialist has a distinct owner.
  sql(`update msgr_org_members set role='admin' where org_id='${ORG}' and user_id='${U.admin}'`);
  const create = (uid,name) => JSON.parse(last(asUser(uid,`select msgr_bot_create('${ORG}','openclaw','${name}','Specialist')`)));
  pepper=create(U.owner,'Pepper'); feynman=create(U.admin,'Feynman'); wolff=create(U.owner,'Wolff');
  sql(`update msgr_crews set work_protocol=1,last_seen_at=now() where id in ('${pepper.crew_id}','${feynman.crew_id}','${wolff.crew_id}')`);
  DM=last(asUser(U.owner,`select msgr_create_channel('${ORG}','dm','Pepper','[{"kind":"crew","id":"${pepper.crew_id}"}]')`));
  OTHER_DM=last(asUser(U.owner,`select msgr_create_channel('${ORG}','dm','Mine','[{"kind":"crew","id":"${CREW}"}]')`));
  memberSnapshot=sql(`select jsonb_agg(jsonb_build_array(member_kind,member_id) order by member_kind,member_id) from msgr_channel_members where channel_id='${DM}'`);
  post('Another DM confidential history',[],OTHER_DM);
  outbox=await mkdtemp(join(tmpdir(),'argo-dm-http-outbox-'));
  server=createServer(async (req,res) => {
    try {
      let body='';for await (const chunk of req) body+=chunk;
      const parsed=parseRequest(`http://127.0.0.1${req.url}`,req.headers,body ? JSON.parse(body) : null);
      const result=await handle(parsed,databaseRpc);
      res.writeHead(result.status,{'Content-Type':'application/json'});res.end(JSON.stringify(result.body));
    } catch {
      res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,description:'Fixture HTTP transport failed'}));
    }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}/msgr-bot`;
  for (const bot of [pepper,feynman,wolff]) {
    const ready=await call(bot,'getUpdates',{timeout:0});
    assert.equal(ready.status,200,JSON.stringify(ready));
    assert.deepEqual(ready.result,[],'capability handshake has no initial bot work');
  }
});
after(async () => {
  if(server) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(outbox) await rm(outbox,{recursive:true,force:true});
});

let firstRoot, root, delegation, delegationRelay, returned;
test('native DM remembers earlier turns while bot handoff relays into the target bot\'s own DM', {skip}, async () => {
  firstRoot=post('My private project codename is SILVER-PINE.');
  await answer(pepper,await update(pepper,firstRoot),'I remember the project.\nMSGR: done');
  root=post('Ask Feynman for a one-line role and report back.');
  const initial=await update(pepper,root);
  assert.ok(initial.context.some(m=>m.text.includes('SILVER-PINE')),'same DM counterpart sees continuous native history');
  assert.ok(initial.context.every(m=>!m.text.includes('Another DM confidential')),'another DM remains private');
  assert.ok(initial.peers.some(p=>p.id===feynman.crew_id),'cross-owner specialist is addressable');
  delegation=await answer(pepper,initial,'@Feynman explain your role and send it back to @Pepper.\nCC: @Wolff\nMSGR: handoff');
  delegationRelay=relayOf(delegation.message_id,feynman.crew_id); assert.ok(delegationRelay,'handoff relays into Feynman\'s own DM with the instructing user');
  // The relay lands in a channel where Feynman is a genuine member, so even a legacy (protocol 0) poll finds it —
  // delegation no longer needs a protocol handshake at all, it is just an ordinary native DM message from Feynman's
  // point of view. What legacy polling still never sees is the origin id itself (Pepper's DM, Feynman not a member).
  // A poll consumes/claims each update at most once (execution claim), so check both properties from the same
  // single legacy(protocol 0) call rather than polling this id twice.
  const legacy=await call(feynman,'getUpdates',{offset:delegation.message_id,timeout:0,delivery_protocol:0});
  assert.equal(legacy.status,200);
  assert.ok(!legacy.result.some(u=>u.update_id===delegation.message_id),'legacy polling never receives the origin DM message id');
  const delegated=legacy.result.find(u=>u.update_id===delegationRelay)?.message;
  assert.ok(delegated,'legacy polling already sees the relay copy — it is a normal member DM message, no protocol handshake required');
  const feynmanDm=chanOf(delegationRelay);
  assert.equal(delegated.delegated,false,'the relay DM is a normal member conversation for Feynman');
  assert.equal(delegated.thread_root,delegationRelay);
  assert.ok(delegated.context.every(m=>!m.text.includes('SILVER-PINE')&&!m.text.includes('Another DM confidential')));
  assert.deepEqual(delegated.context.map(m=>m.message_id),[delegationRelay],'no leak of Pepper\'s DM history into the relay context');
  assert.equal(last(asUser(U.admin,`select count(*) from msgr_messages where channel_id='${DM}'`)),'0','Feynman\'s owner does not gain broad SELECT on Pepper\'s DM');
  const typing=await call(feynman,'sendChatAction',{chat_id:feynmanDm,reply_to_message_id:delegated.message_id,execution_attempt:delegated.execution_attempt});
  assert.equal(typing.status,200);
  assert.equal((await call(feynman,'sendChatAction',{chat_id:DM,reply_to_message_id:delegation.message_id,execution_attempt:delegated.execution_attempt})).status,403,'no execution from the origin DM');
  returned=await answer(feynman,delegated,'@Pepper I verify research evidence.\nMSGR: handoff');
  const returnRelay=relayOf(returned.message_id,pepper.crew_id); assert.ok(returnRelay,'the handoff back to Pepper relays again, reusing Pepper\'s existing DM');
  assert.equal(chanOf(returnRelay),DM,'Pepper\'s own DM is the origin DM itself, reused rather than duplicated');
  const returnMessage=await update(pepper,returnRelay);
  assert.equal(returnMessage.chat.id,DM);assert.equal(returnMessage.thread_root,returnRelay);
  const final=await answer(pepper,returnMessage,'Feynman verifies research evidence.\nMSGR: done');
  assert.equal(sql(`select channel_id from msgr_messages where id=${final.message_id}`),DM);
  assert.equal(sql(`select meta->>'disposition' from msgr_messages where id=${final.message_id}`),'done');
  assert.equal(sql(`select jsonb_agg(jsonb_build_array(member_kind,member_id) order by member_kind,member_id) from msgr_channel_members where channel_id='${DM}'`),memberSnapshot,'DM participants unchanged');
  assert.equal(sql(`select name from msgr_channels where id='${DM}'`),'Pepper');
});

test('CC arrives in its own relay DM without execution authority and cannot reply, type, or promote itself to To', {skip}, async () => {
  const legacy=await call(wolff,'getUpdates',{offset:delegation.message_id,timeout:0,delivery_protocol:0});
  assert.equal(legacy.status,200);assert.equal(legacy.result.length,0,'legacy adapters never receive a passive CC');
  const ccRelay=relayOf(delegation.message_id,wolff.crew_id); assert.ok(ccRelay,'the cc copy relays into Wolff\'s own DM');
  const wolffDm=chanOf(ccRelay);
  assert.notEqual(wolffDm,DM,'Wolff\'s relay DM is not Pepper\'s DM');
  const copy=await update(wolff,ccRelay);
  assert.equal(copy.delivery_role,'cc');assert.equal(copy.execution_attempt,null);
  assert.equal(sql(`select count(*) from msgr_executions where crew_id='${wolff.crew_id}' and source_msg_id=${copy.message_id}`),'0');
  const denied=await call(wolff,'sendMessage',{chat_id:wolffDm,text:'I will execute',reply_to_message_id:copy.message_id});
  assert.equal(denied.status,403);
  const forged=await call(wolff,'sendMessage',{chat_id:wolffDm,text:'@Feynman do this',reply_to_message_id:copy.message_id,execution_attempt:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',disposition:'handoff',mentions:[mention(feynman)]});
  assert.ok([403,409].includes(forged.status));
  // msgr_bot_typing only ever required plain channel membership (unscoped path, pre-dates relay); wolff genuinely
  // is a member of its own relay DM, so a typing indicator there succeeds with or without a real claim — same as
  // any other member of any other channel. This is not a new bypass: it grants no data access or execution, only
  // a "typing…" UI hint, and it was never gated on execution_attempt validity even in the pre-relay member case.
  assert.equal((await call(wolff,'sendChatAction',{chat_id:wolffDm,reply_to_message_id:copy.message_id,execution_attempt:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'})).status,200);
});

test('a new DM root does not inherit a prior delegated thread grant', {skip}, async () => {
  const newer=post('A later unrelated native-only question.');
  const target=await call(feynman,'getUpdates',{offset:newer,timeout:0});
  assert.equal(target.status,200);assert.equal(target.result.length,0);
  assert.equal((await call(feynman,'sendMessage',{chat_id:DM,text:'Unsolicited answer',reply_to_message_id:newer})).status,403);
  const native=await update(pepper,newer);
  assert.ok(native.context.some(m=>m.text.includes('research evidence')));
  await answer(pepper,native,'Same DM continues.\nMSGR: done');
});

test('source-free notifications still work for the native DM bot, but never for delegated outsiders', {skip}, async () => {
  const notification=await call(pepper,'sendMessage',{chat_id:DM,text:'Routine: today has one meeting.'});
  assert.equal(notification.status,200,JSON.stringify(notification));
  assert.equal(sql(`select reply_to is null and channel_id='${DM}' from msgr_messages where id=${notification.result.message_id}`),'t');
  assert.equal((await call(feynman,'sendMessage',{chat_id:DM,text:'Outside routine'})).status,403);
});

test('revoking the specialist owner after claim rejects its finish at the real HTTP boundary', {skip}, async () => {
  const id=post('Check this request',[mention(feynman)]);
  const relay=relayOf(id,feynman.crew_id); assert.ok(relay); const relayCh=chanOf(relay);
  const pending=await update(feynman,relay);
  sql(`update msgr_org_members set removed_at=now() where org_id='${ORG}' and user_id='${U.admin}'`);
  const rejected=await call(feynman,'sendMessage',{chat_id:relayCh,text:'Late answer',reply_to_message_id:relay,execution_attempt:pending.execution_attempt,disposition:'done'});
  assert.ok([401,403].includes(rejected.status),JSON.stringify(rejected));
  assert.equal(sql(`select count(*) from msgr_messages where reply_to=${relay} and crew_id='${feynman.crew_id}'`),'0');
  sql(`update msgr_org_members set removed_at=null where org_id='${ORG}' and user_id='${U.admin}'`);
  sql(`update msgr_crews set status='active' where id='${feynman.crew_id}'`);
});

test('stopped DM work halts the origin thread; the relay is a fresh root the cancelled run never covered (reported)', {skip}, async () => {
  const work=JSON.parse(last(asUser(U.owner,`select msgr_work_create('${DM}','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','Research comparison','One answer','${pepper.crew_id}')`)));
  const lead=await update(pepper,Number(work.root_message_id));
  const handoff=await answer(pepper,lead,'@Feynman compare sources.\nMSGR: handoff');
  const handoffRelay=relayOf(handoff.message_id,feynman.crew_id); assert.ok(handoffRelay,'the handoff relays into Feynman\'s own DM before the run is even cancelled');
  asUser(U.owner,`select msgr_work_cancel('${work.id}')`);
  // One poll (offset just below the origin id) covers both properties — the offset window naturally includes
  // the higher-id relay row too, and a poll claims/consumes each id at most once, so this must not be split
  // into two separate getUpdates calls for the same ids.
  const result=await call(feynman,'getUpdates',{offset:handoff.message_id,timeout:0});
  assert.equal(result.status,200);
  assert.ok(!result.result.some(u=>u.update_id===handoff.message_id),'the origin DM message is still never handed to a non-member');
  // KNOWN GAP (reported separately, not fixed here): msgr_delivery_allowed's work-stop check matches
  // (root_message_id, channel_id) of the message it is evaluating. A relay is its own fresh root in a different
  // channel, so it carries no reference back to the origin msgr_work_runs row — cancelling the original run does
  // not retroactively stop a handoff that already relayed into the specialist's own DM.
  assert.ok(result.result.some(u=>u.update_id===handoffRelay),'the already-relayed copy still executes despite the cancelled work run');
});

test('a transport retry keeps one persisted answer and cannot forge a different source thread', {skip}, async () => {
  const id=post('Answer once',[mention(feynman)]);
  const relay=relayOf(id,feynman.crew_id); assert.ok(relay); const relayCh=chanOf(relay);
  const pending=await update(feynman,relay);
  const reply=relayReply('One answer.\nMSGR: done',pending);
  const params={...reply.execution,chat_id:relayCh,text:reply.text,reply_to_message_id:relay,thread_root:firstRoot,origin:U.guest};
  const first=await call(feynman,'sendMessage',params);
  const retry=await call(feynman,'sendMessage',params);
  assert.equal(first.status,200);assert.equal(retry.status,200);
  assert.equal(first.result.message_id,retry.result.message_id);
  assert.equal(sql(`select count(*) from msgr_messages where reply_to=${relay} and crew_id='${feynman.crew_id}'`),'1');
  const stored=JSON.parse(sql(`select jsonb_build_object('thread_root',thread_root,'origin',meta->>'origin') from msgr_messages where id=${first.result.message_id}`));
  assert.deepEqual(stored,{thread_root:relay,origin:U.owner},'client-supplied thread_root/origin spoofing is ignored; the server derives both from the real relay root');
});

test('legacy ordered mentions in public channels still wait for the first agent answer', {skip}, async () => {
  const id=post('Both agents report in order',[{kind:'crew',id:pepper.crew_id},{kind:'crew',id:feynman.crew_id}],PUB);
  const premature=await call(feynman,'getUpdates',{offset:id,timeout:0});
  assert.equal(premature.status,200);assert.equal(premature.result.length,0);
  const first=await update(pepper,id);
  assert.equal(first.chat.kind,'public');
  await answer(pepper,first,'Pepper first.\nMSGR: done');
  const second=await update(feynman,id);
  assert.ok(second.context.some(m=>m.text==='Pepper first.'));
  const finished=await answer(feynman,second,'Feynman second.\nMSGR: done');
  assert.equal(finished.chat.id,PUB);
});

test('legacy bots remain native DM recipients; the runtime protocol flag no longer gates relay delegation', {skip}, async () => {
  const legacy=JSON.parse(last(asUser(U.owner,`select msgr_bot_create('${ORG}','openclaw','Legacy','Old installed adapter')`)));
  const candidates=()=>JSON.parse(last(asUser(U.owner,`select coalesce(jsonb_agg(c),'[]') from msgr_dm_candidates('${DM}') c`)));
  assert.equal(candidates().find(c=>c.id===legacy.crew_id)?.delivery_ready,true,'candidates are always ready now — the runtime protocol column no longer gates anything');
  const outside=post('Do not share',[mention(legacy)]);
  const outsideRelay=relayOf(outside,legacy.crew_id); assert.ok(outsideRelay,'an outside To still relays, even to a bot that has never done a protocol handshake');
  const seen=await call(legacy,'getUpdates',{offset:outsideRelay,timeout:0,delivery_protocol:0});
  assert.equal(seen.status,200);
  assert.ok(seen.result.some(u=>u.update_id===outsideRelay),'legacy (protocol 0) polling already sees the relay copy — it is a normal member DM message');
  const native=last(asUser(U.owner,`select msgr_create_channel('${ORG}','dm','Legacy','[{"kind":"crew","id":"${legacy.crew_id}"}]')`));
  const id=post('Legacy normal question',[],native);
  const old=await call(legacy,'getUpdates',{offset:id,timeout:0,delivery_protocol:0});
  assert.equal(old.status,200);assert.equal(old.result.length,1);
  assert.equal(old.result[0].message.text,'Legacy normal question');
  assert.equal(old.result[0].message.delegated,false);
  const response=await call(legacy,'sendMessage',{chat_id:native,text:'Legacy normal answer',reply_to_message_id:id,execution_attempt:old.result[0].message.execution_attempt,disposition:'done'});
  assert.equal(response.status,200);
});
