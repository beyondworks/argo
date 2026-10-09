// 받은 글 일괄 조회(msgr_crew_inbox_many, 2026-10-09) — 게이트웨이 drain이 에이전트마다 msgr_crew_inbox를 부르던 것(운영 실측 분당 약 2,350회,
// 에이전트 200명 계정 하나가 10분에 10,828회)을 회사(작업 공간) 단위 한 번으로 묶었다. 이 파일이 잠그는 것:
//   ① 결과 = 같은 입력으로 msgr_crew_inbox를 에이전트마다 부른 것(같은 행·같은 순서·에이전트마다 limit) — 조직·개인 에이전트, 주인이 못 읽는 조직 1:1의
//      전달·참조, 보관 채널, 지운 글, 못 읽는 비공개 채널, 두 조직, 커서·limit 여러 조합
//   ② 권한 — 남의 에이전트·다른 회사·쉬는 에이전트·없는 id는 그 에이전트만 거절 표시(옛 함수의 42501과 같은 판정), anon 실행 권한 없음, 입력 형식
//   ③ 유휴 쓰기 0 — dm_delivery_protocol은 바뀐 행만 한 문장으로, 두 번째 호출부터 msgr_crews 행 xmin 불변
//   ④ 게이트웨이 어댑터(makeDb) — 일괄 응답을 풀어 낸 글 객체가 옛 crewInbox(PostgREST 모양)와 같다
// 실행: bash scripts/billing-pg-drill.sh test/msgr-crew-inbox-many-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { psqlSpawn } from './helpers/pg.mjs';
import { mkdtemp } from './helpers/tmp.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-crew-inbox-many-pg.test.mjs';
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-inbox-many-pg-'));
const M = await import('../src/gateway/msgr.mjs');

const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
// a = 에이전트 주인, b·d = 같은 조직 멤버, c = a의 친구(조직 밖)
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333', d: '44444444-4444-4444-8444-444444444444' };
const WS = 'ws-a';
const psqlRaw = (args) => psqlSpawn(DB, args);
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, `${label} — 실제 오류: ${raw.stderr.trim().slice(0, 200)}`); };
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const post = (uid, ch, body, mentions = []) => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', ${q(body)}, ${q(JSON.stringify(mentions))}::jsonb, gen_random_uuid()::text) returning id`));
const crewPost = (uid, ch, crew, body) => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body, mentions, client_msg_id, meta) values ('${ch}', 'crew', '${crew}', 'text', ${q(body)}, '[]'::jsonb, gen_random_uuid()::text, '{"disposition":"done"}'::jsonb) returning id`));
const to = (id, role = 'to') => ({ kind: 'crew', id, role });
const orgCrew = (uid, org, ws, slug) => last(asUser(uid, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${org}', '${uid}', '${ws}', '${slug}', '${slug}', 'local', 'active', 'all') returning id`));
const personalCrew = (uid, slug) => last(asUser(uid, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values (null, '${uid}', '${WS}', '${slug}', '${slug}', 'local', 'active', 'owner') returning id`));
const crewIn = (ch, crew) => sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${ch}', 'crew', '${crew}') on conflict do nothing`);
const userIn = (ch, uid) => sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${ch}', 'user', '${uid}') on conflict do nothing`);

const C = {}; // 에이전트 id
const CH = {}; // 방 id
let O1, O2, MSG_IDS = [];
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

  // 대조용 옛 경로 — 에이전트마다 옛 msgr_crew_inbox를 그대로 부르고(그 함수의 행 순서 그대로), 42501은 그 에이전트의 거절 표시로 적는다. 호출자 권한(invoker)으로 돈다.
  sql(`create schema if not exists t; grant usage on schema t to authenticated;
    create or replace function t.inbox_old(p_ws text, p_items jsonb, p_limit int) returns jsonb language plpgsql as $f$
    declare it jsonb; rows jsonb; out jsonb := '[]'::jsonb;
    begin
      for it in select value from jsonb_array_elements(p_items) loop
        begin
          select coalesce(jsonb_agg(to_jsonb(m) - 'ordinality' order by m.ordinality), '[]'::jsonb) into rows
            from public.msgr_crew_inbox(p_ws, (it->>'crew')::uuid, (it->>'after')::bigint, p_limit) with ordinality as m;
          out := out || jsonb_build_array(jsonb_build_object('crew', it->>'crew', 'rows', rows));
        exception when sqlstate '42501' then
          out := out || jsonb_build_array(jsonb_build_object('crew', it->>'crew', 'forbidden', true));
        end;
      end loop;
      return out;
    end $f$;
    grant execute on function t.inbox_old(text, jsonb, int) to authenticated;`);

  // 조직 두 개(a가 주인). O1에는 b·d가 멤버
  O1 = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  O2 = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Side', 'side', '${U.a}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id in ('${O1}', '${O2}')`);
  for (const uid of [U.b, U.d]) {
    const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${O1}', 'member', '${U.a}') returning code`));
    asUser(uid, `select public.msgr_accept_invite('${code}')`);
  }
  // a의 에이전트(이 회사 ws-a): 조직 K1·K2·K3(O1), K4(O2), 개인 P1(크루 1:1)·P2(친구 방)
  C.K1 = orgCrew(U.a, O1, WS, 'k1'); C.K2 = orgCrew(U.a, O1, WS, 'k2'); C.K3 = orgCrew(U.a, O1, WS, 'k3'); C.K4 = orgCrew(U.a, O2, WS, 'k4');
  C.P1 = personalCrew(U.a, 'p1'); C.P2 = personalCrew(U.a, 'p2');
  // 거절돼야 하는 것: 다른 회사(ws)의 a 에이전트, 쉬는(available) a 에이전트, b의 에이전트, 없는 id
  C.KX = orgCrew(U.a, O1, 'ws-z', 'kx'); C.KI = orgCrew(U.a, O1, WS, 'ki'); C.KB = orgCrew(U.b, O1, WS, 'kb');
  sql(`update public.msgr_crews set status = 'available' where id = '${C.KI}'`);
  C.NONE = '99999999-9999-4999-8999-999999999999';
  // 방
  CH.PUB = last(asUser(U.a, `select public.msgr_create_channel('${O1}', 'public', 'Work')`));
  for (const uid of [U.b, U.d]) userIn(CH.PUB, uid);
  for (const k of [C.K1, C.K2, C.K3]) crewIn(CH.PUB, k);
  CH.PRIV = last(asUser(U.b, `select public.msgr_create_channel('${O1}', 'private', 'Secret', '[{"kind":"user","id":"${U.d}"}]')`)); // a는 못 읽는다
  CH.ARCH = last(asUser(U.a, `select public.msgr_create_channel('${O1}', 'private', 'Old', '[{"kind":"crew","id":"${C.K1}"}]')`));
  CH.DMA1 = last(asUser(U.a, `select public.msgr_create_channel('${O1}', 'dm', 'K1', '[{"kind":"crew","id":"${C.K1}"}]')`)); // a ↔ K1
  // 주인(a)이 못 읽는데 a의 에이전트가 들어 있는 조직 1:1 — 옛 msgr_crew_inbox가 전달·참조(msgr_delivery_allowed·msgr_cc_delivery_allowed)로 받는 갈래.
  // 지금 앱 흐름은 주인이 나가면 에이전트도 따라 나가게 하지만(msgr_crews_follow_owner_out) 옛 데이터·관리 작업으로 이 상태가 있을 수 있어 옛 함수와 같아야 한다.
  const dmWithoutOwner = (name, users, crews) => {
    const others = JSON.stringify([...users.map((id) => ({ kind: 'user', id })), ...crews.map((id) => ({ kind: 'crew', id }))]);
    const ch = last(asUser(U.a, `select public.msgr_create_channel('${O1}', 'dm', '${name}', '${others}')`));
    sql(`delete from public.msgr_channel_members where channel_id = '${ch}' and member_kind = 'user' and member_id = '${U.a}'`);
    for (const k of crews) crewIn(ch, k); // 따라 나간 에이전트 참여만 되돌린다(슈퍼유저)
    return ch;
  };
  CH.DMB1 = dmWithoutOwner('K1 for b', [U.b], [C.K1]); // b ↔ K1
  CH.DMB12 = dmWithoutOwner('K1+K2 for b', [U.b], [C.K1, C.K2]); // b ↔ K1·K2(참조)
  CH.DMD2 = dmWithoutOwner('K2 for d', [U.d], [C.K2]); // d ↔ K2
  CH.PUB2 = last(asUser(U.a, `select public.msgr_create_channel('${O2}', 'public', 'Side')`));
  crewIn(CH.PUB2, C.K4);
  CH.P1 = last(asUser(U.a, `select public.msgr_dm_personal_crew('${C.P1}')`)); // a ↔ P1(개인)
  asUser(U.a, `select public.msgr_friend_request('${U.c}')`); asUser(U.c, `select public.msgr_friend_decide('${U.a}', true)`);
  CH.AC = last(asUser(U.a, `select public.msgr_dm_personal('${U.c}')`));
  asUser(U.a, `select public.msgr_crew_join('${CH.AC}', '${C.P2}')`); // 친구 방의 P2

  // 글 — 방마다 섞어서(조직 글 사이에 주인이 못 읽는 1:1 글이 끼게)
  const ids = [];
  const keep = (id) => { ids.push(Number(id)); return id; };
  keep(post(U.a, CH.ARCH, 'archived 1', [to(C.K1)]));
  for (let i = 1; i <= 14; i++) {
    keep(post(U.a, CH.PUB, `pub ${i}`, i % 5 === 0 ? [to(C.K2)] : []));
    if (i % 3 === 0) keep(post(U.b, CH.DMB1, `b → k1 ${i}`)); // 멘션 없는 조직 1:1 — K1에게 전달
    if (i % 4 === 0) keep(post(U.b, CH.DMB12, `b → k1, cc k2 ${i}`, [to(C.K1), to(C.K2, 'cc')])); // K1 전달 · K2 참조
    if (i % 5 === 0) keep(post(U.b, CH.PRIV, `secret ${i}`, []));
    if (i % 2 === 0) keep(post(U.a, CH.DMA1, `a → k1 ${i}`));
    if (i % 6 === 0) keep(post(U.d, CH.DMD2, `d → k2 ${i}`));
    if (i % 3 === 1) keep(post(U.a, CH.PUB2, `side ${i}`));
    if (i % 2 === 1) keep(post(U.a, CH.P1, `p1 ${i}`));
    if (i % 4 === 1) keep(post(U.c, CH.AC, `friend ${i}`));
    if (i === 7) keep(crewPost(U.a, CH.PUB, C.K2, 'crew says hi'));
  }
  keep(post(U.a, CH.ARCH, 'archived 2'));
  sql(`update public.msgr_channels set archived_at = now() where id = '${CH.ARCH}'`); // 보관 채널(읽기는 된다)
  const del = post(U.a, CH.PUB, 'deleted soon'); keep(del);
  sql(`update public.msgr_messages set deleted_at = now() where id = ${del}`); // 지운 글
  keep(post(U.b, CH.DMB1, 'b → k1 last')); // 가장 마지막 글이 주인이 못 읽는 1:1 — 그 글만 새 글인 틱
  MSG_IDS = ids.sort((x, y) => x - y);
});

const VALID = () => [C.K1, C.K2, C.K3, C.K4, C.P1, C.P2];
const DENIED = () => [C.KX, C.KI, C.KB, C.NONE];
/** 같은 사용자·같은 입력으로 옛 함수(에이전트마다)와 새 함수(한 번)를 부른다 — [옛, 새를 옛 모양으로 푼 것, 새 원본] */
function both(uid, items, limit) {
  const j = q(JSON.stringify(items));
  const lim = limit === null ? 'null' : String(limit);
  const old = JSON.parse(last(asUser(uid, `select t.inbox_old('${WS}', ${j}::jsonb, ${lim})`)));
  const raw = JSON.parse(last(asUser(uid, `select public.msgr_crew_inbox_many('${WS}', ${j}::jsonb, ${lim})`)));
  const byId = new Map(raw.messages.map((m) => [m.id, m]));
  const got = raw.crews.map((c) => (c.forbidden ? { crew: c.crew, forbidden: true } : { crew: c.crew, rows: c.ids.map((id) => byId.get(id)) }));
  return { old, got, raw };
}
let seed = 20261009;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

test('픽스처가 노리는 경우를 실제로 담는다(옛 함수 기준) — 주인이 못 읽는 1:1의 전달·참조, 보관 채널, 지운 글·못 읽는 비공개 제외, 두 조직, 개인 방', { skip }, () => {
  const old = JSON.parse(last(asUser(U.a, `select t.inbox_old('${WS}', ${q(JSON.stringify(VALID().map((crew) => ({ crew, after: 0 }))))}::jsonb, 200)`))); // 옛 함수만 — 새 함수와 무관하게 픽스처를 잠근다
  const rows = Object.fromEntries(old.map((o) => [o.crew, o.rows]));
  const chans = (id) => new Set(rows[id].map((m) => m.channel_id));
  assert.ok(chans(C.K1).has(CH.DMB1), 'K1: b ↔ K1 1:1(a는 못 읽음)의 전달');
  assert.ok(chans(C.K1).has(CH.DMB12) && chans(C.K2).has(CH.DMB12), 'DMB12: K1 전달·K2 참조');
  assert.ok(chans(C.K2).has(CH.DMD2), 'K2: d ↔ K2 1:1');
  assert.ok(!chans(C.K2).has(CH.DMB1) && !chans(C.K3).has(CH.DMB12), '다른 에이전트의 1:1 글은 받지 않는다');
  assert.equal(last(asUser(U.a, `select public.msgr_can_read_channel('${CH.DMB1}')`)), 'f', 'a는 DMB1을 못 읽는다(전달 경로로만 온다)');
  assert.ok(chans(C.K3).has(CH.ARCH), '보관 채널 글(읽을 수 있음)');
  assert.ok(!VALID().some((id) => chans(id).has(CH.PRIV)), '못 읽는 비공개 채널 글은 아무도 받지 않는다');
  assert.ok(!VALID().some((id) => rows[id].some((m) => m.body === 'deleted soon')), '지운 글 제외');
  assert.deepEqual([...chans(C.K4)], [CH.PUB2], 'O2 에이전트는 O2 글만');
  assert.deepEqual([...chans(C.P1)].sort(), [CH.P1].sort(), 'P1은 자기 방만');
  assert.deepEqual([...chans(C.P2)], [CH.AC], 'P2는 친구 방(주인이 읽음)');
  assert.ok(rows[C.K1].length > 20, `K1 받은 글 ${rows[C.K1].length}건`);
});

test('일괄 결과 = 에이전트마다 옛 함수를 부른 결과 — 커서·limit·순서 조합 전부(같은 행·같은 순서·에이전트마다 limit)', { skip }, () => {
  const lims = [1, 3, 7, 50, 200, null, 0, -5, 1000];
  const heads = [0, ...MSG_IDS, MSG_IDS.at(-1) + 100];
  const configs = [
    { label: '모두 0', items: VALID().map((crew) => ({ crew, after: 0 })) },
    { label: '모두 끝(유휴)', items: VALID().map((crew) => ({ crew, after: MSG_IDS.at(-1) })) },
    { label: '모두 같은 중간', items: VALID().map((crew) => ({ crew, after: MSG_IDS[20] })) },
    { label: '거절 섞임·순서 섞임', items: [C.KB, C.K2, C.NONE, C.P2, C.KX, C.K1, C.KI, C.K4, C.P1, C.K3].map((crew, i) => ({ crew, after: MSG_IDS[i * 3] ?? 0 })) },
    { label: 'after 없음(null)', items: [{ crew: C.K1, after: null }, { crew: C.K2, after: 0 }, { crew: C.P1 }] },
    // 유휴 지름길(받을 글의 필요조건이 하나도 없으면 빈 결과)이 한쪽만 새 글인 틱을 유휴로 오인하지 않는지
    { label: '개인만 새 글', items: VALID().map((crew) => ({ crew, after: [C.P1, C.P2].includes(crew) ? 0 : MSG_IDS.at(-1) })) },
    { label: '개인 하나만 새 글', items: VALID().map((crew) => ({ crew, after: crew === C.P2 ? MSG_IDS.at(-12) : MSG_IDS.at(-1) })) },
    { label: '두 번째 조직만 새 글', items: VALID().map((crew) => ({ crew, after: crew === C.K4 ? 0 : MSG_IDS.at(-1) })) },
    { label: '주인 못 읽는 1:1만 새 글', items: [C.K1, C.K3].map((crew) => ({ crew, after: crew === C.K1 ? MSG_IDS.at(-2) : MSG_IDS.at(-1) })) },
  ];
  for (let k = 0; k < 8; k++) configs.push({ label: `무작위 ${k}`, items: VALID().filter(() => rnd() > 0.2).map((crew) => ({ crew, after: pick(heads) })) });
  let compared = 0, nonEmpty = 0;
  const seen = {}; // 설정별로 받은 글이 실제로 있었던 에이전트(지름길 경우가 빈 결과끼리 같아서 통과하지 않게)
  for (const { label, items } of configs) for (const lim of lims) {
    const { old, got, raw } = both(U.a, items, lim);
    for (const o of old) if (o.rows?.length) (seen[label] ??= new Set()).add(o.crew);
    assert.deepEqual(got, old, `${label} · limit ${lim}`);
    assert.equal(raw.messages.length, new Set(raw.messages.map((m) => m.id)).size, `${label}: 글은 한 번씩만 싣는다`);
    for (const c of raw.crews) if (c.ids) assert.deepEqual(c.ids, [...c.ids].sort((x, y) => x - y), `${label}: id 오름차순`);
    compared += old.length; nonEmpty += old.filter((o) => o.rows?.length).length;
  }
  assert.ok(compared > 400 && nonEmpty > 200, `대조 ${compared}건(받은 글 있음 ${nonEmpty}건)`);
  assert.deepEqual([...seen['개인만 새 글']].sort(), [C.P1, C.P2].sort());
  assert.deepEqual([...seen['개인 하나만 새 글']], [C.P2]);
  assert.deepEqual([...seen['두 번째 조직만 새 글']], [C.K4]);
  assert.deepEqual([...seen['주인 못 읽는 1:1만 새 글']], [C.K1], 'K1만 — a가 못 읽는 1:1의 마지막 글');
  assert.equal(seen['모두 끝(유휴)'], undefined, '유휴는 모두 빈 결과');
});

test('limit은 에이전트마다 따로다 — 같은 커서의 에이전트 셋이 각자 앞 3건, 1:1 전달이 낀 K1은 조직 글이 밀린다', { skip }, () => {
  const { got } = both(U.a, [C.K1, C.K2, C.K3].map((crew) => ({ crew, after: 0 })), 3);
  for (const g of got) assert.equal(g.rows.length, 3, `${g.crew}: 3건`);
  const k1 = got.find((g) => g.crew === C.K1).rows.map((m) => m.id);
  const k3 = got.find((g) => g.crew === C.K3).rows.map((m) => m.id);
  assert.deepEqual(k3, MSG_IDS.filter((id) => k3.includes(id)).slice(0, 3));
  assert.ok(k1.every((id, i) => i === 0 || id > k1[i - 1]));
});

test('거절: 남의 에이전트·다른 회사·쉬는 에이전트·없는 id는 그 에이전트만 거절 표시 — 나머지는 받는다. 로그인 없음은 전부 거절, anon은 실행 권한 없음', { skip }, () => {
  const items = [...VALID(), ...DENIED()].map((crew) => ({ crew, after: 0 }));
  const { got } = both(U.a, items, 5);
  assert.deepEqual(got.filter((g) => g.forbidden).map((g) => g.crew).sort(), DENIED().sort());
  assert.ok(got.filter((g) => !g.forbidden).every((g) => g.rows.length > 0));
  // b가 a의 에이전트를 물으면 전부 거절 — b 자신의 에이전트(KB)만 받는다
  const asB = JSON.parse(last(asUser(U.b, `select public.msgr_crew_inbox_many('${WS}', ${q(JSON.stringify(items))}::jsonb, 5)`)));
  assert.deepEqual(asB.crews.filter((c) => !c.forbidden).map((c) => c.crew), [C.KB]);
  assert.equal(asB.messages.filter((m) => [CH.DMB1, CH.DMA1, CH.P1, CH.AC].includes(m.channel_id) && !asB.crews.find((c) => c.crew === C.KB).ids.includes(m.id)).length, 0, 'a 에이전트의 글이 새지 않는다');
  const anonUid = JSON.parse(last(asUser('', `select public.msgr_crew_inbox_many('${WS}', ${q(JSON.stringify(items))}::jsonb, 5)`)));
  assert.ok(anonUid.crews.every((c) => c.forbidden) && anonUid.messages.length === 0, '로그인 없음 → 전부 거절');
  fails(psqlRaw(['-A', '-t', '-c', `set role anon; select public.msgr_crew_inbox_many('${WS}', '[]'::jsonb, 5)`]), /permission denied/, 'anon 실행');
  assert.equal(sql(`select has_function_privilege('anon', 'public.msgr_crew_inbox_many(text, jsonb, integer)', 'execute')`), 'f');
  assert.equal(sql(`select has_function_privilege('authenticated', 'public.msgr_crew_inbox_many(text, jsonb, integer)', 'execute')`), 't');
  assert.equal(sql(`select count(*) from information_schema.routine_privileges where routine_name = 'msgr_crew_inbox_many' and grantee = 'PUBLIC'`), '0', 'PUBLIC 실행 권한 없음');
  assert.equal(sql(`select prosecdef::text || ' ' || array_to_string(proconfig, ',') from pg_proc where proname = 'msgr_crew_inbox_many'`), 'true search_path=public, pg_temp');
});

test('입력 형식 — 배열 아님·200개 초과·같은 에이전트 두 번·에이전트 없음은 22023, 형식이 틀린 uuid·커서는 22P02, 빈 배열은 빈 결과', { skip }, () => {
  const call = (j) => asUserRaw(U.a, `select public.msgr_crew_inbox_many('${WS}', ${q(j)}::jsonb, 5)`);
  for (const j of ['{}', '"x"', 'null']) fails(call(j), /msgr_bad_items/, `배열 아님 ${j}`);
  fails(call(JSON.stringify(Array.from({ length: 201 }, (_, i) => ({ crew: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`, after: 0 })))), /msgr_too_many_items/, '201개');
  fails(call(JSON.stringify([{ crew: C.K1, after: 0 }, { crew: C.K1, after: 5 }])), /msgr_bad_items/, '같은 에이전트 두 번');
  fails(call(JSON.stringify([{ after: 0 }])), /msgr_bad_items/, '에이전트 없음');
  fails(call(JSON.stringify([5])), /msgr_bad_items/, '객체 아님');
  fails(call(JSON.stringify([{ crew: 'nope', after: 0 }])), /invalid input syntax for type uuid/, 'uuid 형식');
  fails(call(JSON.stringify([{ crew: C.K1, after: 'x' }])), /invalid input syntax for type bigint/, '커서 형식');
  assert.deepEqual(JSON.parse(last(call('[]').stdout)), { messages: [], crews: [] });
  assert.equal(call(JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ crew: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`, after: 0 })))).status, 0, '200개는 받는다');
});

test('유휴 쓰기 0 — dm_delivery_protocol은 바뀐 행만(거절된 에이전트는 안 씀), 두 번째 호출부터는 msgr_crews·msgr_messages 행이 그대로(xmin 불변)', { skip }, () => {
  const all = [...VALID(), C.KX, C.KI, C.KB];
  sql(`update public.msgr_crews set dm_delivery_protocol = 0 where id in (${all.map((x) => `'${x}'`).join(',')})`);
  const xmin = () => sql(`select string_agg(id || ':' || xmin::text || ':' || dm_delivery_protocol, ',' order by id) from public.msgr_crews where id in (${all.map((x) => `'${x}'`).join(',')})`);
  const msgXmin = () => sql(`select md5(string_agg(id || ':' || xmin::text, ',' order by id)) from public.msgr_messages`);
  const items = [...VALID(), ...DENIED()].map((crew) => ({ crew, after: 0 }));
  asUser(U.a, `select public.msgr_crew_inbox_many('${WS}', ${q(JSON.stringify(items))}::jsonb, 5)`);
  const proto = Object.fromEntries(sql(`select id || '=' || dm_delivery_protocol from public.msgr_crews where id in (${all.map((x) => `'${x}'`).join(',')})`).split('\n').map((l) => l.split('=')));
  for (const id of VALID()) assert.equal(proto[id], '1', `유효한 에이전트 ${id}: 1로`);
  for (const id of [C.KX, C.KI, C.KB]) assert.equal(proto[id], '0', `거절된 에이전트 ${id}: 그대로`);
  const before1 = xmin(); const m1 = msgXmin();
  for (const after of [0, MSG_IDS.at(-1)]) asUser(U.a, `select public.msgr_crew_inbox_many('${WS}', ${q(JSON.stringify(items.map((i) => ({ ...i, after }))))}::jsonb, 5)`);
  assert.equal(xmin(), before1, '두 번째부터 msgr_crews 행을 다시 쓰지 않는다');
  assert.equal(msgXmin(), m1, '글 행도 그대로');
});

/* ── 게이트웨이 어댑터(makeDb)를 PostgREST 모양을 흉내 낸 작은 클라이언트로 그 사용자 권한(psql)에 붙인다 ── */
const lit = (v) => (v === null || v === undefined ? 'null' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : typeof v === 'object' ? `${q(JSON.stringify(v))}::jsonb` : q(v));
function pgClient(uid) {
  const run = (text) => {
    const r = psqlRaw(['-v', 'VERBOSITY=verbose', '-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${text}`]);
    if (r.status !== 0) { const m = /ERROR:\s+([0-9A-Z]{5}):\s+(.*)/.exec(r.stderr); return { data: null, error: { code: m?.[1] ?? 'XX000', message: m?.[2] ?? r.stderr.trim() } }; }
    return { data: JSON.parse(last(r.stdout) || 'null'), error: null };
  };
  const args = (a) => Object.entries(a).map(([k, v]) => `${k} => ${lit(v)}`).join(', ');
  // PostgREST: 집합을 돌려주는 함수는 행 배열(json_agg), 값 하나를 돌려주는 함수는 그 값
  const rpc = async (name, a = {}) => (name === 'msgr_crew_inbox'
    ? run(`select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from public.msgr_crew_inbox(${args(a)}) x`)
    : run(`select to_jsonb(public.${name}(${args(a)}))`));
  return { rpc, from: () => { throw new Error('이 시험은 표를 직접 읽지 않는다'); } };
}

test('makeDb.crewInboxMany가 풀어 낸 글 = 옛 crewInbox(PostgREST 행 모양) — 에이전트마다 같은 객체·같은 순서, 거절은 옛 오류와 같은 코드·문구', { skip }, async () => {
  const db = M.makeDb(pgClient(U.a));
  const crews = [...VALID(), C.KB];
  const cursors = Object.fromEntries(crews.map((id, i) => [id, MSG_IDS[i * 4] ?? 0]));
  const got = await db.crewInboxMany(WS, crews.map((crew) => ({ crew, after: cursors[crew] })));
  assert.ok(got instanceof Map);
  for (const id of crews) {
    const old = await db.crewInbox(WS, id, cursors[id]).then((v) => v, (e) => e);
    const now = got.get(id);
    if (old instanceof Error) {
      assert.ok(now instanceof Error, `${id}: 거절`);
      assert.equal(now.code, old.code); assert.equal(now.message, old.message);
    } else assert.deepEqual(now, old, `${id}: 같은 글 객체`);
  }
  assert.ok(got.get(C.K1).length > 0 && got.get(C.P2).length > 0);
});

test('서버에 일괄 함수가 없으면(42883) makeDb.crewInboxMany는 undefined — 게이트웨이가 옛 경로로 돌아간다', { skip }, async () => {
  const db = M.makeDb({ rpc: async () => pgClient(U.a).rpc('msgr_crew_inbox_many_absent', { p_ws: WS }) });
  assert.equal(await db.crewInboxMany(WS, [{ crew: C.K1, after: 0 }]), undefined);
});
