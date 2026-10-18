// qbwr 실전 시험 도구(U9) — 운영을 지키는 대상 검문(scripts/qbwr-env.sh)과 합성 데이터 생성기를 본다. 실제 DB·Storage에는 붙지 않는다:
// psql은 받은 인자·PG* 환경·표준 입력을 적기만 하는 가짜로 바꾸고, Storage는 요청 수를 세는 로컬 수신기로 본다(#1093 검수 우회 경우 전부).
// 자식 node의 fetch·WebSocket은 test/helpers/qbwr-no-net.mjs로 가로챈다 — 검문이 깨져도 실제 qbwr·운영으로 요청이 나가지 않는다(#1093 재검수).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const NO_NET = fileURLToPath(new URL('./helpers/qbwr-no-net.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'qbwr-tools-'));
const PROD = 'nvqorpdorlbkhpcvwoty', QBWR = 'qbwrlynzvjmphwuqglsx';
const POOL = 'aws-1-ap-southeast-1.pooler.supabase.com';
const GOOD_URL = `postgresql://postgres.${QBWR}:pw-Secret1@${POOL}:5432/postgres`;
// 합성 JWT(서명 없음 — 검문은 페이로드 ref·역할만 본다)
const jwt = (p) => ['e30', Buffer.from(JSON.stringify(p)).toString('base64url'), 'sig'].join('.');
const ANON = jwt({ ref: QBWR, role: 'anon' }), SERVICE = jwt({ ref: QBWR, role: 'service_role' });

// 가짜 psql: 인자(한 줄에 하나)·PG* 환경·표준 입력을 로그 파일에 남기고, FAKE_PSQL_OUT이 있으면 그 내용을 출력한다.
// 실행기 공용 psql(qbwr-lib)은 환경을 비우고 부르므로 FAKE_PSQL_LOG가 없으면 bin/default.log에 남긴다
const bin = join(dir, 'bin'); mkdirSync(bin);
writeFileSync(join(bin, 'psql'), `#!/bin/bash
{ echo "--call"; for a in "$@"; do echo "arg:$a"; done; env | grep -E '^PG' | sed 's/^/env:/'; if [[ " $* " == *" -f - "* ]]; then cat | sed 's/^/in:/'; fi; } >> "\${FAKE_PSQL_LOG:-$(dirname "$0")/default.log}"
[ -n "\${FAKE_PSQL_OUT:-}" ] && cat "$FAKE_PSQL_OUT"
exit 0
`);
chmodSync(join(bin, 'psql'), 0o755);
let n = 0;
// 자식 프로세스 환경: 가짜 psql이 PATH 맨 앞, node는 네트워크 차단 미리 읽기. 가로챈 psql 호출·네트워크 요청은 파일로 돌려준다
const sandbox = (extra = {}) => {
  const i = ++n;
  const psqlLog = join(dir, `psql-${i}.log`), netLog = join(dir, `net-${i}.log`);
  const env = { PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: `--import=${NO_NET}`, FAKE_PSQL_LOG: psqlLog, QBWR_NET_LOG: netLog, ...extra };
  const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  return { i, env, calls: () => read(psqlLog), net: () => read(netLog) };
};
function run(script, args, envText, { shell = {}, name } = {}) {
  const sb = sandbox();
  const envFile = join(dir, name ?? `.env.qbwr-${sb.i}`);
  if (envText != null) writeFileSync(envFile, envText);
  const r = spawnSync('bash', [`scripts/${script}`, ...args], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...sb.env, HOME: dir, QBWR_ENV: envFile, QBWR_OUT: join(dir, `out-${sb.i}`), ...shell },
  });
  return { ...r, calls: sb.calls(), net: sb.net(), envFile };
}
const envText = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
// qbwr 도구는 맥에서만 돈다(bash 스크립트·가짜 psql). 윈도우 러너에는 POSIX 셸이 없어 셸을 부르는 칸은 건너뛰고 macOS CI가 검증한다
const NO_POSIX_SHELL = process.platform === 'win32' ? 'POSIX 셸 하네스 — qbwr 도구는 맥 전용(macOS CI가 검증)' : false;
const SCRIPTS = [['qbwr-apply.sh', ['plan']], ['qbwr-rate.sh', ['snap', join(dir, 'snap')]], ['qbwr-seed.sh', ['db', '0.01']], ['qbwr-q.sh', ['q1']]];

test('대상 검문: 운영·우회 접속(% 인코딩·대문자·conninfo·쿼리·다른 호스트)·운영 API 주소는 psql을 부르기 전에 exit 5', { skip: NO_POSIX_SHELL }, () => {
  const cases = [
    ['운영 ref', { QBWR_DB_URL: `postgresql://postgres.${PROD}:x@${POOL}:5432/postgres` }],
    ['운영 ref가 섞인 qbwr 문자열', { QBWR_DB_URL: `postgresql://postgres.${QBWR}:x@${POOL}:5432/postgres?x=${PROD}` }],
    ['B: % 인코딩 user + host 쿼리', { QBWR_DB_URL: `postgresql://postgres.%6Evqorpdorlbkhpcvwoty:x@qbwr-demo.invalid/postgres?host=127.0.0.1&application_name=${QBWR}` }],
    ['C: 대문자 운영 호스트', { QBWR_DB_URL: `postgresql://postgres:x@DB.NVQORPDORLBKHPCVWOTY.SUPABASE.CO:5432/postgres?application_name=${QBWR}` }],
    ['D: conninfo + application_name', { QBWR_DB_URL: `dbname=postgres application_name=${QBWR}` }],
    ['쿼리 host=', { QBWR_DB_URL: `${GOOD_URL}?host=127.0.0.1` }],
    ['비밀번호의 % 인코딩', { QBWR_DB_URL: `postgresql://postgres.${QBWR}:p%40w@${POOL}:5432/postgres` }],
    ['풀러가 아닌 호스트', { QBWR_DB_URL: `postgresql://postgres.${QBWR}:x@evil.example.com:5432/postgres` }],
    ['로컬 호스트', { QBWR_DB_URL: `postgresql://postgres.${QBWR}:x@127.0.0.1:5432/postgres` }],
    ['다른 프로젝트', { QBWR_DB_URL: `postgresql://postgres.abcdefghijklmnopqrst:x@${POOL}:5432/postgres` }],
    ['비밀번호 + 풀러가 아닌 호스트', { QBWR_DB_PASSWORD: 'x', QBWR_POOLER_HOST: '127.0.0.1' }],
    ['비밀번호 + 대문자 운영 호스트', { QBWR_DB_PASSWORD: 'x', QBWR_POOLER_HOST: `DB.${PROD.toUpperCase()}.SUPABASE.CO` }],
    ['API 주소가 운영(경로에 qbwr)', { QBWR_DB_URL: GOOD_URL, QBWR_URL: `https://${PROD}.supabase.co/${QBWR}/..` }],
    ['API 주소가 로컬', { QBWR_DB_URL: GOOD_URL, QBWR_URL: `http://127.0.0.1:9/${QBWR}` }],
    ['API 주소에 경로', { QBWR_DB_URL: GOOD_URL, QBWR_URL: `https://${QBWR}.supabase.co/x` }],
    ['변수 없음', { FOO: '1' }],
  ];
  for (const [script, args] of SCRIPTS) {
    for (const [name, env] of cases) {
      const r = run(script, args, envText(env));
      assert.equal(r.status, 5, `${script} ${name}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /^거부 /, `${script} ${name}`);
      assert.equal(r.calls, '', `${script} ${name}: psql을 불렀다`);
      assert.equal(r.net, '', `${script} ${name}: 네트워크 요청을 보냈다`);
    }
    const missing = run(script, args, null);
    assert.equal(missing.status, 5, `${script} 파일 없음`);
  }
});

test('대상 검문: env 파일 이름은 .env.qbwr*만(운영 env 파일은 내용과 상관없이 읽지 않는다)', { skip: NO_POSIX_SHELL }, () => {
  for (const name of ['.env.local', '.env.production', '.env', 'env-qbwr']) {
    const r = run('qbwr-apply.sh', ['plan'], envText({ QBWR_DB_URL: GOOD_URL }), { name });
    assert.equal(r.status, 5, name); assert.match(r.stdout, /\.env\.qbwr로 시작/, name); assert.equal(r.calls, '');
  }
});

test('대상 검문: 셸 PG* 변수(PGHOSTADDR·PGHOST·PGUSER·PGSERVICE·PGSERVICEFILE·PGOPTIONS)는 psql에 넘어가지 않는다(A·D·E2)', { skip: NO_POSIX_SHELL }, () => {
  const svc = join(dir, 'pg_service.conf'); writeFileSync(svc, `[x]\nhost=127.0.0.1\nuser=postgres.${PROD}\n`);
  const r = run('qbwr-apply.sh', ['plan'], envText({ QBWR_DB_URL: GOOD_URL }), {
    shell: { PGHOSTADDR: '127.0.0.1', PGHOST: 'db.evil', PGUSER: `postgres.${PROD}`, PGSERVICE: 'x', PGSERVICEFILE: svc, PGOPTIONS: '-c x=y', PGDATABASE: 'other' },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const envs = r.calls.split('\n').filter((l) => l.startsWith('env:'));
  for (const k of ['PGHOSTADDR', 'PGHOST', 'PGUSER', 'PGSERVICE', 'PGOPTIONS', 'PGDATABASE']) assert.ok(!envs.some((l) => l.startsWith(`env:${k}=`)), `${k}가 넘어갔다`);
  assert.ok(envs.includes('env:PGSERVICEFILE=/dev/null') && envs.includes('env:PGPASSFILE=/dev/null'));
  assert.ok(r.calls.includes(`arg:host=${POOL} port=5432 user=postgres.${QBWR} dbname=postgres sslmode=require`));
  assert.ok(!r.calls.includes(PROD));
});

test('대상 검문: env 파일 안의 QBWR_REF·PROD_REF·QBWR_ENV·PATH 줄은 기준값을 바꾸지 못한다', { skip: NO_POSIX_SHELL }, () => {
  const r = run('qbwr-apply.sh', ['plan'], `QBWR_REF=${PROD}\nPROD_REF=x0\nPATH=/nonexistent\nQBWR_DB_PASSWORD=pw-Secret1\nQBWR_POOLER_HOST=aws-1-ap-northeast-2.pooler.supabase.com\n`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.calls.includes(`user=postgres.${QBWR} `), r.calls);
  assert.ok(!r.calls.includes(PROD));
  // 합성 비밀번호를 새로 만들 때도 검문이 고정한 파일에만 붙인다(파일 안의 QBWR_ENV 줄로 바뀌지 않는다)
  const other = join(dir, '.env.qbwr-other');
  const s = run('qbwr-seed.sh', ['db', '0.01'], `QBWR_ENV=${other}\nQBWR_DB_URL=${GOOD_URL}\n`);
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.ok(!existsSync(other));
  assert.match(readFileSync(s.envFile, 'utf8'), /^QBWR_SEED_PASSWORD=.+$/m);
});

test('평문: DB 비밀번호는 psql 인자에 없고 PGPASSWORD로만, 합성 비밀번호는 정규화되는 select set_config로 넣고 스냅샷에서 거른다', { skip: NO_POSIX_SHELL }, () => {
  const r = run('qbwr-apply.sh', ['plan'], envText({ QBWR_DB_URL: GOOD_URL }));
  assert.ok(!r.calls.split('\n').some((l) => l.startsWith('arg:') && l.includes('pw-Secret1')), '비밀번호가 인자에 있다');
  assert.ok(r.calls.includes('env:PGPASSWORD=pw-Secret1'));
  const s = run('qbwr-seed.sh', ['db', '0.01'], envText({ QBWR_DB_URL: GOOD_URL, QBWR_SEED_PASSWORD: 'seed-Secret9' }));
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.ok(s.calls.includes("in:select set_config('argo.seed_pw', 'seed-Secret9', false);"));
  assert.ok(!/in:set argo\.seed_pw/.test(s.calls));
  assert.ok(!s.calls.split('\n').some((l) => l.startsWith('arg:') && l.includes('seed-Secret9')));
  const out = join(dir, 'fake-snap.txt');
  writeFileSync(out, "t:public.msgr2_messages|10|\nq:1|1|select set_config($1, $2, $3)\nq:2|1|select set_config('argo.seed_pw', 'seed-Secret9', false)\nq:3|5|select 1\n");
  const snapFile = join(dir, 'snap-out');
  const sn = run('qbwr-rate.sh', ['snap', snapFile], envText({ QBWR_DB_URL: GOOD_URL }), { shell: { FAKE_PSQL_OUT: out } });
  assert.equal(sn.status, 0, sn.stdout + sn.stderr);
  const snap = readFileSync(snapFile, 'utf8');
  assert.ok(!snap.includes('seed-Secret9') && !snap.includes('set_config'), snap);
  assert.ok(snap.includes('select 1'));
});

// Storage: 운영 주소·로컬 주소·다른 ref 키로는 요청이 한 건도 나가지 않는다(로컬 수신기로 센다)
// 서버는 before()에서 연다 — 최상위 await로 열면 --test-force-exit(scripts/gate-a.sh)에서 뒤쪽 시험이 등록되지 않았다(#1093 재검수)
let hits = 0, srv, PORT;
before(async () => {
  srv = createServer((req, res) => { hits++; res.end('[]'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  PORT = srv.address().port;
});
after(() => { srv?.close(); rmSync(dir, { recursive: true, force: true }); }); // 돌 때마다 임시 폴더가 남지 않게
const nodeRun = (args, extra) => new Promise((resolve) => {
  const sb = sandbox(extra);
  const p = spawn('node', args, { cwd: ROOT, env: sb.env });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => resolve({ code, out, calls: sb.calls(), net: sb.net() }));
});
const manifestFile = () => { const f = join(dir, `att-${n}.json`); writeFileSync(f, JSON.stringify([{ bucket: 'msgr', path: 'p/c905/f1.txt', bytes: 3 }])); return f; };
const filesRun = (base, key, mode = '-rm') => nodeRun(['test/fixtures/msgr2/qbwr-files.mjs', mode, manifestFile()], { QBWR_STORAGE_URL: base, QBWR_SERVICE_ROLE_KEY: key });

test('Storage 검문: 주소는 정확히 https://<qbwr>.supabase.co, 키는 JWT ref = qbwr·service_role — 아니면 요청 0으로 exit 5', { skip: NO_POSIX_SHELL }, async () => {
  const bad = [
    [`https://${PROD}.supabase.co/${QBWR}/..`, SERVICE],
    [`http://127.0.0.1:${PORT}/${QBWR}`, SERVICE],
    [`http://127.0.0.1:${PORT}/`, SERVICE],
    [`https://${QBWR}.supabase.co.evil.com`, SERVICE],
    [`https://${QBWR}.supabase.co/x`, SERVICE],
    [`https://${QBWR}.supabase.co`, jwt({ ref: PROD, role: 'service_role' })],
    [`https://${QBWR}.supabase.co`, jwt({ ref: QBWR, role: 'anon' })],
    [`https://${QBWR}.supabase.co`, 'sb_secret_not_a_jwt'],
  ];
  for (const mode of ['-rm', '']) for (const [base, key] of bad) {
    const r = await filesRun(base, key, mode);
    assert.equal(r.code, 5, `${mode} ${base}: ${r.out}`);
    assert.equal(r.net, '', `${mode} ${base}: 네트워크 요청을 보냈다`);
  }
  assert.equal(hits, 0, '수신기에 요청이 왔다');
  // 셸 스크립트도 서비스 키 ref를 먼저 본다
  const s = run('qbwr-seed.sh', ['files-rm'], envText({ QBWR_DB_URL: GOOD_URL, QBWR_SERVICE_ROLE_KEY: jwt({ ref: PROD, role: 'service_role' }) }));
  assert.equal(s.status, 5, s.stdout); assert.match(s.stdout, /service_role JWT가 아닙니다/);
  // 셸의 SUPABASE_SERVICE_ROLE_KEY·QBWR_SERVICE_ROLE_KEY는 읽지 않는다(파일 안의 이름만 읽는다)
  const sh = run('qbwr-seed.sh', ['files-rm'], envText({ QBWR_DB_URL: GOOD_URL }), { shell: { SUPABASE_SERVICE_ROLE_KEY: SERVICE, QBWR_SERVICE_ROLE_KEY: SERVICE } });
  assert.equal(sh.status, 5, sh.stdout); assert.match(sh.stdout, /QBWR_SERVICE_ROLE_KEY, 또는 QBWR_ANON_KEY·QBWR_SEED_PASSWORD가 필요/);
});

test('Storage 사용자 토큰 방식(서비스 키 없음): 검문한 접속·qbwr anon 키가 아니면 psql·요청 0으로 exit 5', { skip: NO_POSIX_SHELL }, async () => {
  const goodC = `host=${POOL} port=5432 user=postgres.${QBWR} dbname=postgres sslmode=require`;
  const userRun = (env) => nodeRun(['test/fixtures/msgr2/qbwr-files.mjs', '-rm', manifestFile()], { QBWR_SEED_PASSWORD: 'x', ...env });
  for (const env of [
    { C: `host=127.0.0.1 port=5432 user=postgres.${QBWR} dbname=postgres sslmode=require`, QBWR_ANON_KEY: ANON },
    { C: goodC, QBWR_ANON_KEY: jwt({ ref: PROD, role: 'anon' }) },
    { C: goodC, QBWR_ANON_KEY: SERVICE }, // 역할이 anon이 아님
    { C: goodC, QBWR_ANON_KEY: ANON, QBWR_URL: `http://127.0.0.1:${PORT}/${QBWR}` },
  ]) {
    const r = await userRun(env);
    assert.equal(r.code, 5, JSON.stringify(env) + r.out);
    assert.equal(r.calls, '');
    assert.equal(r.net, '');
  }
  assert.equal(hits, 0, '수신기에 요청이 왔다');
  const s = run('qbwr-seed.sh', ['files'], envText({ QBWR_DB_URL: GOOD_URL, QBWR_ANON_KEY: jwt({ ref: PROD, role: 'anon' }), QBWR_SEED_PASSWORD: 'x' }));
  assert.equal(s.status, 5, s.stdout); assert.match(s.stdout, /anon JWT가 아닙니다/);
});

test('Q 실행기: 검문을 거치지 않은 접속(C)·다른 주소·다른 ref anon 키로는 exit 5', { skip: NO_POSIX_SHELL }, () => {
  const q = (env) => { const sb = sandbox({ QBWR_SEED_PASSWORD: 'x', ...env }); const r = spawnSync('node', ['test/fixtures/msgr2/qbwr-q.mjs', 'q1'], { cwd: ROOT, encoding: 'utf8', env: sb.env }); return { ...r, calls: sb.calls(), net: sb.net() }; };
  const goodC = `host=${POOL} port=5432 user=postgres.${QBWR} dbname=postgres sslmode=require`;
  for (const env of [
    { C: `host=127.0.0.1 port=5432 user=postgres.${QBWR} dbname=postgres sslmode=require`, QBWR_ANON_KEY: ANON },
    { C: `postgresql://postgres.${QBWR}:x@${POOL}:5432/postgres`, QBWR_ANON_KEY: ANON },
    { C: `${goodC} application_name=${PROD}`, QBWR_ANON_KEY: ANON },
    { C: goodC, QBWR_ANON_KEY: jwt({ ref: PROD, role: 'anon' }) },
    { C: goodC, QBWR_ANON_KEY: ANON, QBWR_URL: `https://${PROD}.supabase.co` },
  ]) {
    const r = q(env);
    assert.equal(r.status, 5, JSON.stringify(env) + r.stderr);
    assert.equal(r.calls + r.net, '', '검문 전에 psql·네트워크를 불렀다');
  }
  const s = run('qbwr-q.sh', ['q1'], envText({ QBWR_DB_URL: GOOD_URL, QBWR_ANON_KEY: jwt({ ref: PROD, role: 'anon' }), QBWR_SEED_PASSWORD: 'x' }));
  assert.equal(s.status, 5, s.stdout); assert.match(s.stdout, /anon JWT가 아닙니다/);
});

test('psql은 언제나 -X로 부른다(~/.psqlrc가 접속·설정을 바꾸지 못하게), 검문을 지난 실행도 네트워크는 차단된 채 돈다', { skip: NO_POSIX_SHELL }, async () => {
  const blocks = (calls) => calls.split('--call\n').filter(Boolean);
  const env = envText({ QBWR_DB_URL: GOOD_URL, QBWR_ANON_KEY: ANON, QBWR_SEED_PASSWORD: 'seed-x' });
  const runs = [
    run('qbwr-apply.sh', ['plan'], env),
    run('qbwr-apply.sh', ['run', '20260714090000'], env), // 준비 + 첫 파일 1개
    run('qbwr-apply.sh', ['buckets'], env),
    run('qbwr-rate.sh', ['snap', join(dir, 'snap-x')], env),
    run('qbwr-seed.sh', ['db', '0.01'], env),
  ];
  // 사용자 토큰 방식(가짜 psql이 빈 결과 → 로그인할 사람 없음): 실행기 공용 psql도 -X, 네트워크 0
  const goodC = `host=${POOL} port=5432 user=postgres.${QBWR} dbname=postgres sslmode=require`;
  const def = join(bin, 'default.log'); writeFileSync(def, '');
  const u0 = await nodeRun(['test/fixtures/msgr2/qbwr-files.mjs', '-rm', manifestFile()], { C: goodC, QBWR_ANON_KEY: ANON, QBWR_SEED_PASSWORD: 'x' });
  assert.equal(u0.code, 0, u0.out);
  const u = { ...u0, calls: readFileSync(def, 'utf8') };
  for (const r of [...runs, u]) {
    const bs = blocks(r.calls);
    assert.ok(bs.length > 0, `psql을 부르지 않았다: ${r.stdout ?? r.out}${r.stderr ?? ''}`);
    for (const b of bs) assert.ok(b.split('\n').includes('arg:-X'), `-X 없이 psql을 불렀다:\n${b.slice(0, 300)}`);
    assert.equal(r.net, '');
  }
});

test('합성 데이터 생성기: 계정은 전부 @example.test, id는 c9 접두, 운영 ref·비밀번호 평문이 없다, 같은 씨앗이면 같은 SQL', () => {
  const gen = () => spawnSync('node', ['test/fixtures/msgr2/qbwr-seed.mjs', '--scale', '0.01', '--manifest', join(dir, 'm.json')], { cwd: ROOT, encoding: 'utf8' });
  const a = gen(), b = gen();
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout, b.stdout);
  const emails = [...a.stdout.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+/g)].map((m) => m[0]);
  assert.equal(new Set(emails.filter((e) => e.startsWith('p'))).size, 60);
  assert.ok(emails.every((e) => e.endsWith('@example.test')), emails.find((e) => !e.endsWith('@example.test')));
  assert.ok(!a.stdout.includes(PROD));
  assert.match(a.stdout, /crypt\(current_setting\('argo\.seed_pw'\), gen_salt\('bf'\)\)/); // 비밀번호는 세션 설정에서만
  const ids = [...a.stdout.matchAll(/'([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12})'/g)].map((m) => m[1]);
  assert.ok(ids.length > 100 && ids.every((x) => x.startsWith('c9') || x === '00000000-0000-0000-0000-000000000000'), ids.find((x) => !x.startsWith('c9')));
  const m = JSON.parse(readFileSync(join(dir, 'm.json'), 'utf8'));
  assert.ok(m.length >= 1 && m.every((x) => x.bucket === 'msgr' && /^(c902[0-9a-f-]+\/c905[0-9a-f-]+|p\/c905[0-9a-f-]+)\/f\d+\.txt$/.test(x.path)));
});
