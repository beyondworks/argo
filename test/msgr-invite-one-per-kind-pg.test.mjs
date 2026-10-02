// 조직 초대 링크는 멤버 하나·관리자 하나(새 앱의 '새 링크로 바꾸기' = msgr_invite_replace) + 지난 초대 30일 보존(20261002130000, 5차 피드백). 실행: bash scripts/billing-pg-drill.sh test/msgr-invite-one-per-kind-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-invite-one-per-kind-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333', d: '44444444-4444-4444-8444-444444444444', e: '55555555-5555-4555-8555-555555555555' };
const psqlRaw = (args) => psqlSpawn(DB, args);
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, `${label} — 실제 오류: ${raw.stderr.trim().slice(0, 200)}`); };
const post = (uid, ch, body, mentions = '[]') => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${body}', '${mentions}'::jsonb, gen_random_uuid()::text) returning id`));
const personalCrew = (uid, slug) => last(asUser(uid, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values (null, '${uid}', 'ws-${uid.slice(0, 4)}', '${slug}', '${slug}', 'local', 'active', 'owner') returning id`));
const befriend = (x, y) => { asUser(x, `select public.msgr_friend_request('${y}')`); asUser(y, `select public.msgr_friend_decide('${x}', true)`); };
const join = (uid, ch, crew) => last(asUser(uid, `select public.msgr_crew_join('${ch}', '${crew}')`));

let ORG, PRIV;
before(() => {
  if (!DB) return;
  psql(['-c', `
    do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end $$;
    grant usage on schema public to anon, authenticated, service_role;
    create schema if not exists auth; grant usage on schema auth to anon, authenticated, service_role;
    create table if not exists auth.users (id uuid primary key, created_at timestamptz not null default now(), email text);
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('argo.uid', true), '')::uuid $$;
    create schema if not exists storage;
    create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
    create table if not exists storage.buckets (id text primary key, name text, public boolean not null default false);
    create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
    grant usage on schema storage to authenticated; grant select, insert, delete on storage.objects to authenticated;
    create schema if not exists realtime;
    create table if not exists realtime.messages (id bigint generated always as identity primary key, topic text, extension text, payload jsonb);
    create or replace function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language sql as $$ select null::void $$;
    alter table realtime.messages enable row level security; grant select, insert on realtime.messages to authenticated; grant usage on schema realtime to authenticated;
    create schema if not exists net; create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;
  `]);
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  const base = ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260929110000_plan_no_trial.sql'];
  for (const f of [...base, ...readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x))].sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  sql(`delete from public.msgr_settings where key = 'free_limits_grace_until'`);
  ORG = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  ORG = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean-inv-${Date.now()}', '${U.a}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  PRIV = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','private','Secret')`));
});

const mk = (role) => last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', '${role}', '${U.a}') returning id`));
const revoked = (id) => sql(`select revoked_at is not null from public.msgr_invites where id = '${id}'`) === 't';

const replace = (id) => last(asUser(U.a, `select public.msgr_invite_replace('${id}')`));
const audits = (id) => sql(`select count(*) from public.msgr_audit_log where action = 'invite.revoke' and target_kind = 'invite' and target_id = '${id}'`);

// 분리 검수 MEDIUM(2026-10-02): 옛 앱(스토어 버전)은 초대 창을 열자마자 링크를 만들고, 복사하지 않고 닫으면 그 링크를 지운다.
// 새 링크를 넣을 때마다 이전 링크를 취소하면, 창을 열고 닫기만 해도 밖에 뿌린 링크가 말없이 죽는다 — 넣기만으로는 아무것도 취소하지 않는다.
test('새 링크를 넣기만 해서는 이전 링크가 취소되지 않는다 — 옛 앱이 창을 열고(만들고) 닫아도(지움) 공유한 링크가 산다', { skip }, () => {
  const shared = mk('member');
  const opened = mk('member'); // 옛 앱: 창을 열면 바로 만든다
  assert.equal(revoked(shared), false, '공유한 링크는 그대로');
  asUser(U.a, `delete from public.msgr_invites where id = '${opened}' and use_count = 0`); // 옛 앱: 복사 안 하고 닫으면 지운다
  assert.equal(revoked(shared), false);
  const code = sql(`select code from public.msgr_invites where id = '${shared}'`);
  assert.equal(last(asUser(U.b, `select public.msgr_accept_invite_v2('${code}')->>'org_id'`)), ORG, '공유한 링크로 들어올 수 있다');
});

test('새 링크로 바꾸기(msgr_invite_replace) — 같은 종류의 다른 살아 있는 링크만 취소하고, 취소마다 invite.revoke 감사를 남긴다', { skip }, () => {
  sql(`delete from public.msgr_invites where org_id = '${ORG}'`);
  const m1 = mk('member'); const m2 = mk('member'); const a1 = mk('admin');
  const gone = last(sql(`insert into public.msgr_invites (org_id, role, created_by, expires_at) values ('${ORG}', 'member', '${U.a}', now() - interval '1 day') returning id`)); // 이미 만료 — 다시 쓸 일 없음
  const m3 = mk('member');
  assert.equal(replace(m3), '2', '살아 있는 이전 멤버 링크 둘');
  assert.equal(revoked(m1), true); assert.equal(revoked(m2), true); assert.equal(revoked(m3), false, '새 링크는 산다');
  assert.equal(revoked(a1), false, '관리자 링크는 따로 하나');
  assert.equal(revoked(gone), false, '이미 못 쓰는 링크는 건드리지 않는다(쓰기 0)');
  assert.equal(audits(m1), '1'); assert.equal(audits(m2), '1'); assert.equal(audits(m3), '0'); assert.equal(audits(gone), '0');
  assert.equal(sql(`select actor_user_id from public.msgr_audit_log where action = 'invite.revoke' and target_id = '${m1}'`), U.a, '누가 바꿨는지');
  assert.equal(replace(m3), '0', '두 번째는 할 일이 없다');
  const a2 = mk('admin'); assert.equal(replace(a2), '1'); assert.equal(revoked(a1), true); assert.equal(revoked(m3), false);
  assert.equal(sql(`select count(*) from public.msgr_invites where org_id = '${ORG}' and role in ('member','admin') and not for_node and revoked_at is null and (expires_at is null or expires_at > now())`), '2', '쓸 수 있는 조직 링크는 종류마다 하나');
});

test('바꾸기 권한·대상 — 관리자만, 취소된 링크로는 못 바꾸고, 취소된 이전 링크로는 들어올 수 없다', { skip }, () => {
  const old = mk('member'); const oldCode = sql(`select code from public.msgr_invites where id = '${old}'`);
  const neo = mk('member');
  fails(asUserRaw(U.c, `select public.msgr_invite_replace('${neo}')`), /msgr_invite_not_found/, '조직 밖 사람');
  fails(psqlRaw(['-A', '-t', '-c', `set role anon; select public.msgr_invite_replace('${neo}')`]), /permission denied/, 'anon');
  assert.equal(revoked(old), false, '거절된 호출은 아무것도 취소하지 않는다');
  replace(neo);
  fails(asUserRaw(U.c, `select public.msgr_accept_invite_v2('${oldCode}')`), /msgr_invite_revoked/, '이전 링크 수락');
  fails(asUserRaw(U.a, `select public.msgr_invite_replace('${old}')`), /msgr_invite_revoked/, '취소된 링크를 남기고 나머지를 취소하지 않는다');
  assert.equal(revoked(neo), false);
});

test('노드 코드·게스트 링크는 이 규칙 밖 — 멤버 링크를 취소하지도, 취소되지도 않는다', { skip }, () => {
  const m = mk('member');
  const node = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by, for_node) values ('${ORG}', 'member', '${U.a}', true) returning id`));
  assert.equal(revoked(m), false, '노드 코드가 멤버 링크를 취소하지 않는다');
  const g1 = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by, channel_ids, max_uses) values ('${ORG}', 'guest', '${U.a}', array['${PRIV}']::uuid[], 1) returning id`));
  const g2 = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by, channel_ids, max_uses) values ('${ORG}', 'guest', '${U.a}', array['${PRIV}']::uuid[], 1) returning id`));
  replace(mk('member'));
  assert.equal(revoked(node), false, '멤버 링크를 바꿔도 노드 코드는 그대로');
  assert.equal(last(asUser(U.a, `select public.msgr_invite_replace('${node}')`)), '0', '노드 코드로 바꾸기는 아무것도 하지 않는다');
  assert.equal(last(asUser(U.a, `select public.msgr_invite_replace('${g1}')`)), '0', '게스트 링크도 마찬가지');
  assert.equal(revoked(g1), false); assert.equal(revoked(g2), false, '게스트 링크는 여러 개');
});

test('보존 기간 — 만료·취소 30일 지난 초대만 지운다(사용 기록도 함께), 그 안의 것과 살아 있는 링크는 둔다', { skip }, () => {
  sql(`delete from public.msgr_invites where org_id = '${ORG}'`);
  const ins = (expr) => { const id = last(sql(`insert into public.msgr_invites (org_id, role, created_by, for_node) values ('${ORG}', 'member', '${U.a}', true) returning id`)); sql(`update public.msgr_invites set ${expr} where id = '${id}'`); return id; }; // 노드 코드로 넣는다 — 서로 취소하지 않게(규칙 밖)
  const oldExp = ins(`expires_at = now() - interval '40 days'`);
  const oldRev = ins(`revoked_at = now() - interval '31 days'`);
  const newExp = ins(`expires_at = now() - interval '10 days'`);
  const newRev = ins(`revoked_at = now() - interval '2 days'`);
  const live = ins(`expires_at = now() + interval '7 days'`);
  sql(`insert into public.msgr_invite_uses (invite_id, user_id) values ('${oldExp}', '${U.b}')`);
  assert.equal(sql(`select public.msgr_invites_purge()`), '2');
  const left = sql(`select string_agg(id::text, ',' order by id) from public.msgr_invites where org_id = '${ORG}'`).split(',');
  assert.deepEqual(left.sort(), [newExp, newRev, live].sort());
  assert.equal(sql(`select count(*) from public.msgr_invite_uses where invite_id = '${oldExp}'`), '0', '사용 기록도 함께');
  assert.equal(sql(`select public.msgr_invites_purge()`), '0', '두 번째 실행은 0');
  fails(asUserRaw(U.a, `select public.msgr_invites_purge()`), /permission denied/, '사용자는 부를 수 없다');
});
