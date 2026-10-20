// qbwr Q6~Q11 실행기(test/fixtures/msgr2/qbwr-q6.mjs) — ① 검문: --local은 로컬 연습 DB만, qbwr 방식은 검문한 접속·qbwr anon 키만(실제 접속 없음)
// ② 실제 PG(드릴): 옛 메신저 + msgr2를 운영 순서로 적용 → 합성 데이터(scale 0.01) → 작업 창·백필·검증 → Q6~Q11을 --local로 끝까지 돌려 칸마다 JSON이 나오고 실패 0인지.
// 실행: bash scripts/billing-pg-drill.sh test/qbwr-q6-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setupFull, v2FullMode } from './helpers/msgr2-work-pg.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/qbwr-q6-pg.test.mjs';
const NO_POSIX_SHELL = process.platform === 'win32' ? 'POSIX 셸 하네스 — qbwr 도구는 맥 전용(macOS CI가 검증)' : false;
const PROD = 'nvqorpdorlbkhpcvwoty', QBWR = 'qbwrlynzvjmphwuqglsx';
const node = (args, env = {}) => spawnSync('node', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH, ...env } });

test('검문: --local은 127.0.0.1·localhost 연습 DB만, qbwr 방식은 검문한 접속·qbwr anon 키가 아니면 exit 5', () => {
  for (const url of [`postgresql://postgres@db.${PROD}.supabase.co:5432/postgres`, 'postgresql://postgres@127.0.0.1.evil.com:5432/postgres',
    `postgresql://postgres.${QBWR}:x@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres`, 'postgresql://postgres@127.0.0.1:5432/postgres?host=10.0.0.1', '',
    `postgresql://postgres.${PROD}@127.0.0.1:5432/postgres`, `postgresql://postgres:x@127.0.0.1:5432/${PROD}`]) {
    const r = node(['test/fixtures/msgr2/qbwr-q6.mjs', '--local', url, 'q6']);
    assert.equal(r.status, 5, `${url}: ${r.stderr}`);
  }
  const jwt = (p) => ['e30', Buffer.from(JSON.stringify(p)).toString('base64url'), 's'].join('.');
  const goodC = `host=aws-1-ap-southeast-1.pooler.supabase.com port=5432 user=postgres.${QBWR} dbname=postgres sslmode=require`;
  for (const env of [{}, { C: goodC, QBWR_ANON_KEY: jwt({ ref: PROD, role: 'anon' }), QBWR_SEED_PASSWORD: 'x' }, { C: 'host=127.0.0.1 port=5432 user=postgres dbname=postgres sslmode=require', QBWR_ANON_KEY: jwt({ ref: QBWR, role: 'anon' }), QBWR_SEED_PASSWORD: 'x' }]) {
    const r = node(['test/fixtures/msgr2/qbwr-q6.mjs', 'q6'], env);
    assert.equal(r.status, 5, JSON.stringify(env) + r.stderr);
  }
});

test('검문: --local 사용자 칸은 점 없는 이름만(postgres.<아무 ref>@127.0.0.1 거부 — 운영 ref가 없어도)', () => {
  for (const url of ['postgresql://postgres.abcdefghijklmnopqrst@127.0.0.1:5432/postgres', 'postgresql://a.b:x@localhost/postgres']) {
    const r = node(['test/fixtures/msgr2/qbwr-q6.mjs', '--local', url, 'q6']);
    assert.equal(r.status, 5, `${url}: ${r.stderr}`);
    assert.match(r.stderr, /127\.0\.0\.1·localhost의 연습 DB만/, `${url}: 주소 검사가 아닌 다른 단계에서 멈췄다 — ${r.stderr}`); // 뒤의 루프백 확인(접속 실패)으로 멈춘 것과 구분
  }
});

test('검문: --local 주소가 localhost여도 서버가 알려 준 연결 상대가 루프백이 아니면 exit 5(터널 막기)', { skip: NO_POSIX_SHELL }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'qbwr-q6-peer-'));
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    for (const [name, peer] of [['터널 너머 주소', '10.0.0.5'], ['알 수 없음(빈 값)', '']]) {
      writeFileSync(join(bin, 'psql'), `#!/bin/bash\necho '${peer}'\n`); chmodSync(join(bin, 'psql'), 0o755);
      const r = node(['test/fixtures/msgr2/qbwr-q6.mjs', '--local', 'postgresql://postgres@localhost:5432/postgres', 'q6'], { PATH: `${bin}:${process.env.PATH}` });
      assert.equal(r.status, 5, `${name}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /루프백이 아닙니다/, name);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('검문: scripts/qbwr-q6.sh는 운영 접속·운영 anon 키면 실행기·psql 전에 exit 5(키 검사는 진짜 node, psql만 가짜)', { skip: NO_POSIX_SHELL }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'qbwr-q6-'));
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'psql'), '#!/bin/bash\necho called >> "$FAKE_LOG"\n'); chmodSync(join(bin, 'psql'), 0o755);
    const jwt = (p) => ['e30', Buffer.from(JSON.stringify(p)).toString('base64url'), 's'].join('.');
    for (const [name, text] of [
      ['운영 접속', `QBWR_DB_URL=postgresql://postgres.${PROD}:x@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres\n`],
      ['운영 anon 키', `QBWR_DB_URL=postgresql://postgres.${QBWR}:x@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres\nQBWR_ANON_KEY=${jwt({ ref: PROD, role: 'anon' })}\nQBWR_SEED_PASSWORD=x\n`],
    ]) {
      const f = join(dir, '.env.qbwr-x'); writeFileSync(f, text);
      const log = join(dir, 'log');
      const r = spawnSync('bash', ['scripts/qbwr-q6.sh', 'q6'], { cwd: ROOT, encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, QBWR_ENV: f, FAKE_LOG: log } });
      assert.equal(r.status, 5, `${name}: ${r.stdout}${r.stderr}`);
      assert.ok(!existsSync(log) || readFileSync(log, 'utf8') === '', `${name}: psql을 불렀다(실행기가 돌았다)`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

let db;
const REAL = '00000000-0000-4000-8000-0000000000aa'; // 합성이 아닌 계정
before(() => {
  if (!DB) return;
  db = setupFull(DB);
  v2FullMode(db); // A+ 1:1 밖 막기·Pro 검사를 끈다(이 시험은 A+ 앞 v2 전체 기능을 잠근다)
  // 실 Supabase에 있고 대역에 없는 것: auth 열·identities·sessions, pgcrypto. pg_net은 호출을 표에 남기는 대역(가짜 엣지 — 경로만)
  db.psql(['-c', `create extension if not exists pgcrypto;
    alter table auth.users add column if not exists email_confirmed_at timestamptz, add column if not exists instance_id uuid, add column if not exists aud text, add column if not exists role text,
      add column if not exists encrypted_password text, add column if not exists raw_app_meta_data jsonb, add column if not exists raw_user_meta_data jsonb, add column if not exists updated_at timestamptz,
      add column if not exists confirmation_token text, add column if not exists recovery_token text, add column if not exists email_change_token_new text, add column if not exists email_change text;
    create table if not exists auth.identities (id uuid primary key, user_id uuid, provider_id text, provider text, identity_data jsonb, created_at timestamptz, updated_at timestamptz, last_sign_in_at timestamptz, unique (provider_id, provider));
    create table if not exists auth.sessions (id uuid primary key, user_id uuid, created_at timestamptz not null default now());
    create table if not exists public._net_calls (id bigserial primary key, url text, headers jsonb, body jsonb);
    drop function if exists net.http_post(text, jsonb, jsonb, int);
    create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', params jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
      language plpgsql security definer as $$ begin insert into public._net_calls (url, headers, body) values (url, headers, body); return currval('public._net_calls_id_seq'); end $$;`]);
  const seed = node(['test/fixtures/msgr2/qbwr-seed.mjs', '--scale', '0.01']);
  assert.equal(seed.status, 0, seed.stderr);
  db.psql(['-c', `select set_config('argo.seed_pw', 'drill-only', false);\n${seed.stdout}`]);
  db.sql(`insert into public.msgr_settings (key, value) values ('msgr2_migration_window', now()::text) on conflict (key) do update set value = excluded.value`);
  const env = { ...process.env, MSGR2_MIGRATE_DB: DB };
  for (const cmd of ['run', 'verify']) { const r = spawnSync('bash', ['scripts/msgr2-migrate.sh', cmd], { cwd: ROOT, encoding: 'utf8', env }); assert.equal(r.status, 0, `${cmd}: ${r.stdout}${r.stderr}`); }
  db.sql(`delete from public.msgr_settings where key = 'msgr2_migration_window'`); // 런북 6단계(Q6이 스위치를 넣는다)
  // 합성이 아닌 계정(체험 계정 대역)을 조직1 공간·큰 방에 넣어 둔다 — id가 합성 계정보다 앞서 정렬돼, 실행기가 @example.test로 거르지 않으면 이 계정을 고른다
  db.sql(`insert into auth.users (id, email) values ('${REAL}', 'real.person@example.com');
    insert into public.msgr2_space_members (space_id, user_id, role) select id, '${REAL}', 'member' from public.msgr2_spaces where slug = 'qbwr-org-1';
    insert into public.msgr2_room_members (room_id, member_kind, member_id) select c.id, 'user', '${REAL}' from public.msgr_channels c join public.msgr_orgs o on o.id = c.org_id where o.slug = 'qbwr-org-1' and c.name = '공개1'`);
});

const windowOpen = () => db.sql(`select count(*) from public.msgr_settings where key = 'msgr2_migration_window'`);
const p059 = () => db.sql(`select count(*) from auth.users where email = 'p059@example.test'`);

test('실제 PG: Q11이 창을 연 뒤 실패해도 작업 창 표지는 원래대로(닫힘) 돌아오고 p059는 남는다(실패 주입)', { skip }, () => {
  assert.equal(windowOpen(), '0');
  const r = node(['test/fixtures/msgr2/qbwr-q6.mjs', '--local', DB, 'q11'], { QBWR_FAULT: 'q11-after-open' });
  assert.notEqual(r.status, 0, '주입한 실패로 끝나야 한다');
  assert.match(r.stderr, /주입한 실패/);
  assert.equal(windowOpen(), '0', '창 표지가 열린 채 남았다');
  assert.equal(p059(), '1');
});

test('실제 PG: 작업 창 표지가 빈 값으로 있던 경우 Q11 실패 뒤에도 행을 지우지 않고 빈 값 그대로 되살린다(행 없음과 구분)', { skip }, () => {
  db.sql(`insert into public.msgr_settings (key, value) values ('msgr2_migration_window', '')`);
  try {
    const r = node(['test/fixtures/msgr2/qbwr-q6.mjs', '--local', DB, 'q11'], { QBWR_FAULT: 'q11-after-open' });
    assert.notEqual(r.status, 0);
    assert.equal(db.sql(`select count(*) || '|' || coalesce(max(value), 'null') from public.msgr_settings where key = 'msgr2_migration_window'`), '1|', '빈 값 행이 그대로여야 한다');
  } finally { db.sql(`delete from public.msgr_settings where key = 'msgr2_migration_window'`); }
  assert.equal(p059(), '1');
});

test('실제 PG: 백필 검증(verified_at)이 안 된 단계가 있으면 Q6은 스위치를 넣지 않고 실패로 멈추고 뒤 Q도 돌지 않는다', { skip }, () => {
  const job = db.sql(`select name from public.msgr2_backfill_jobs order by step limit 1`);
  const at = db.sql(`select verified_at::text from public.msgr2_backfill_jobs where name = '${job}'`);
  db.sql(`update public.msgr2_backfill_jobs set verified_at = null where name = '${job}'`);
  try {
    const r = node(['test/fixtures/msgr2/qbwr-q6.mjs', '--local', DB, 'q6', 'q7']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const rows = r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    assert.equal(rows.find((x) => /스위치 전 백필/.test(x.name))?.pass, false);
    assert.ok(!rows.some((x) => x.q === 'Q7'), 'Q7이 돌았다');
    assert.equal(db.sql(`select count(*) from public.msgr_settings where key in ('msgr2_switched_at', 'msgr2_enabled')`), '0', '스위치 표지가 들어갔다');
  } finally { db.sql(`update public.msgr2_backfill_jobs set verified_at = '${at}' where name = '${job}'`); }
});

test('실제 PG: 셸 PG* 변수(PGHOSTADDR·PGPORT·PGUSER·PGSERVICE)는 --local 접속을 바꾸지 못한다', { skip }, () => {
  const svc = join(tmpdir(), `qbwr-q6-svc-${process.pid}`); writeFileSync(svc, '[x]\nhost=192.0.2.1\nport=1\n');
  try {
    const r = node(['test/fixtures/msgr2/qbwr-q6.mjs', '--local', DB, 'q9'], { PGHOSTADDR: '::1', PGPORT: '1', PGUSER: 'nobody', PGSERVICE: 'x', PGSERVICEFILE: svc, PGCONNECT_TIMEOUT: '2' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.split('\n').some((l) => l.startsWith('{') && JSON.parse(l).q === 'Q9'), r.stdout);
  } finally { rmSync(svc, { force: true }); }
});

test('실제 PG: 백필 뒤 Q6~Q11이 칸마다 JSON 한 줄을 내고 실패 0(Q7 유휴 쓰기 0·Q8 엣지 호출 1·Q10 색인 충돌 없음·Q11 창 거부 후 정상)', { skip }, () => {
  const r = node(['test/fixtures/msgr2/qbwr-q6.mjs', '--local', DB], { QBWR_IDLE_S: '1' });
  const rows = r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}\n${r.stderr}`);
  assert.ok(rows.every((x) => x.pass !== false), JSON.stringify(rows.filter((x) => x.pass === false)));
  const cell = (q, re) => rows.find((x) => x.q === q && re.test(x.name));
  assert.equal(cell('Q6', /같은 방/)?.pass, true);
  assert.equal(cell('Q6', /새 방 0/)?.pass, true);
  assert.equal(cell('Q7', /^7 결과/)?.memo?.state, 'done');
  assert.equal(cell('Q7', /유휴/)?.pass, true);
  assert.equal(cell('Q8', /엣지 호출 1번/)?.pass, true);
  assert.equal(cell('Q8', /무효 토큰/)?.actual, '엣지 대기');
  assert.equal(cell('Q10', /id >/)?.pass, true);
  assert.equal(cell('Q10', /신고 둘 다/)?.pass, true);
  assert.equal(cell('Q11', /거부/)?.pass, true);
  assert.equal(cell('Q11', /정상/)?.pass, true);
  for (const q of ['Q6', 'Q7', 'Q8', 'Q9', 'Q10', 'Q11']) assert.ok(rows.some((x) => x.q === q), `${q} 칸이 없다`);
  assert.equal(cell('끝', /작업 창/)?.actual, '닫힘');
  assert.match(cell('Q9', /보내지 못한 알림/)?.actual ?? '', /엣지 대기/); // 로컬엔 엣지가 없어 장부 0행
  assert.match(cell('Q8', /20초 끊김/)?.actual ?? '', /엣지 대기/);
  assert.equal(cell('Q11', /거부/)?.expect, 'msgr2_migration_in_progress');
  assert.equal(db.sql(`select count(*) from public.msgr2_devices where user_id = '${REAL}'`), '0', '합성이 아닌 계정으로 로그인·기기 등록을 했다');
  assert.equal(p059(), '0', 'Q11이 p059를 실제로 지웠다');
});

test('실제 PG: Q11을 다시 돌리면 p059가 없어 건너뛰고 작업 창을 건드리지 않는다', { skip }, () => {
  const r = node(['test/fixtures/msgr2/qbwr-q6.mjs', '--local', DB, 'q11']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rows = r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  assert.match(rows.find((x) => x.q === 'Q11')?.actual ?? '', /건너뜀/);
  assert.equal(windowOpen(), '0', '다시 돌린 뒤 창 표지가 열려 있다');
});

test('실제 PG: 보내지 못한 알림 비율 — 0.1%까지는 통과, 넘으면 Q9 칸이 실패(합성 장부 행으로)', { skip }, () => {
  const base = 9_000_000_000_000;
  db.sql(`insert into public.msgr2_push_sent (message_id, claimed_at, finished_at) select ${base} + g, now() - interval '10 minutes', now() - interval '9 minutes' from generate_series(1, 999) g;
    insert into public.msgr2_push_sent (message_id, claimed_at) values (${base} + 1000, now() - interval '5 minutes')`);
  try {
    const q9 = () => { const r = node(['test/fixtures/msgr2/qbwr-q6.mjs', '--local', DB, 'q9']); return { r, row: r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).find((x) => /보내지 못한 알림/.test(x.name)) }; };
    const a = q9();
    assert.equal(a.row?.pass, true, JSON.stringify(a.row)); assert.match(a.row.actual, /0\.100%\(1\/1000\)/);
    assert.equal(a.r.status, 0);
    db.sql(`insert into public.msgr2_push_sent (message_id, claimed_at) values (${base} + 1001, now() - interval '3 minutes'), (${base} + 1002, now() - interval '30 seconds')`); // 2분 안 된 것은 세지 않는다
    const b = q9();
    assert.equal(b.row?.pass, false, JSON.stringify(b.row)); assert.match(b.row.actual, /\(2\/1002\)/);
    assert.equal(b.r.status, 1);
  } finally { db.sql(`delete from public.msgr2_push_sent where message_id > ${base}`); }
});
