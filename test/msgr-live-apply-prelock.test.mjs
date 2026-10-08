// 라이브 적용 선잠금·재시도(2026-10-08) — 운영 Supabase의 supautils가 트리거·정책 DDL 순간 auth·storage·realtime 표 23개를
// ACCESS EXCLUSIVE로 잠가, 메신저·동기화 조회와 교착이 났다(0.1.99 적용 세 번 연속). 정책·트리거 삭제가 든 파일은 그 표들을
// NOWAIT로 먼저 잠그고, 못 얻으면 되돌린 뒤 다시 한다. 가짜 psql로 스크립트를 끝까지 돌려 본다(실제 DB·접속 정보 없음).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync, readdirSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const skip = process.platform === 'win32' && '라이브 적용은 맥 운영 전용 bash 스크립트';
const SCRIPT = fileURLToPath(new URL('../scripts/msgr-live-apply.sh', import.meta.url));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString();
const commit = (cwd, msg) => git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg);

// 가짜 psql — 적용 호출(-f)은 넘겨받은 파일을 log/wrap-N.sql로 남기고 FAIL_TIMES번은 FAIL_MSG로 실패한다.
const FAKE_PSQL = `#!/usr/bin/env bash
LOG="$FAKE_LOG"; mkdir -p "$LOG"
args="$*"
if [[ " $* " == *" -f "* ]]; then
  prev=""; for a in "$@"; do if [ "$prev" = "-f" ]; then src="$a"; fi; prev="$a"; done
  n=$(ls "$LOG" | grep -c '^wrap-' || true); cp "$src" "$LOG/wrap-$n.sql"
  if [ "$n" -lt "\${FAIL_TIMES:-0}" ]; then echo "psql:x.sql:3: ERROR:  \${FAIL_MSG:-could not obtain lock on relation \\"objects\\"}" >&2; exit 3; fi
  exit 0
fi
case "$args" in
  *"insert into supabase_migrations"*) echo insert >> "$LOG/inserts"; exit 0;;
  *"schema_migrations where version"*) echo 0; exit 0;;
esac
cat > /dev/null; exit 0
`;

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'argo-apply-prelock-'));
  const seed = join(root, 'seed'), origin = join(root, 'origin.git'), work = join(root, 'work'), bin = join(root, 'bin'), log = join(root, 'log');
  mkdirSync(join(seed, 'scripts'), { recursive: true }); mkdirSync(join(seed, 'supabase/migrations'), { recursive: true }); mkdirSync(bin);
  copyFileSync(SCRIPT, join(seed, 'scripts/msgr-live-apply.sh'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(seed, `supabase/migrations/${name}.sql`), sql);
  git(seed, 'init', '-q', '-b', 'main'); git(seed, 'add', '.'); commit(seed, 'seed');
  git(root, 'clone', '-q', '--bare', seed, origin); git(root, 'clone', '-q', origin, work);
  writeFileSync(join(work, '.env.local'), 'NEXT_PUBLIC_SUPABASE_URL=https://fixtureref.supabase.co\nSUPABASE_DB_PASSWORD=fixture-only\n'); // 테스트 전용 가짜 값
  writeFileSync(join(bin, 'psql'), FAKE_PSQL); chmodSync(join(bin, 'psql'), 0o755);
  const run = (args, env = {}) => {
    const r = spawnSync('bash', ['scripts/msgr-live-apply.sh', ...args], { cwd: work, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, ...env } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const wraps = () => (existsSync(log) ? readdirSync(log).filter((n) => n.startsWith('wrap-')).sort().map((n) => readFileSync(join(log, n), 'utf8')) : []);
  const inserts = () => (existsSync(join(log, 'inserts')) ? readFileSync(join(log, 'inserts'), 'utf8').trim().split('\n').length : 0);
  return { root, run, wraps, inserts };
}

const POLICY = '20990101000000_policy';
const FN = '20990102000000_fn';
const files = {
  [POLICY]: 'drop policy if exists p on public.t;\ncreate policy p on public.t for select using (true);\n',
  [FN]: 'create or replace function public.f() returns int language sql as $$ select 1 $$;\n',
};

test('정책 DDL 파일은 선잠금(NOWAIT) 뒤 파일을 한 트랜잭션으로, 잠금 실패는 되돌리고 다시 해서 성공하면 한 번만 기록한다', { skip }, () => {
  const f = fixture(files);
  try {
    const r = f.run([POLICY], { FAIL_TIMES: '2' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /잠금 대기 — 1회째/); assert.match(r.out, /잠금 대기 — 2회째/); assert.match(r.out, new RegExp(`OK    ${POLICY}`));
    const w = f.wraps();
    assert.equal(w.length, 3, '두 번 실패 + 성공 한 번');
    assert.match(w[2], /lock table ' \|\| t \|\| ' in access exclusive mode nowait/);
    assert.match(w[2], /'auth\.users'/); assert.match(w[2], /'storage\.objects'/);
    assert.ok(w[2].indexOf('lock table') < w[2].indexOf(`\\i supabase/migrations/${POLICY}.sql`), '선잠금이 파일보다 먼저');
    assert.equal(f.inserts(), 1, '성공한 뒤 한 번만 기록');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('교착(deadlock detected)도 되돌리고 다시 한다', { skip }, () => {
  const f = fixture(files);
  try {
    const r = f.run([POLICY], { FAIL_TIMES: '1', FAIL_MSG: 'deadlock detected' });
    assert.equal(r.code, 0, r.out); assert.match(r.out, /잠금 대기 — 1회째/); assert.equal(f.inserts(), 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('함수만 바꾸는 파일은 선잠금하지 않는다(로그인·파일 요청을 막지 않게)', { skip }, () => {
  const f = fixture(files);
  try {
    const r = f.run([FN]);
    assert.equal(r.code, 0, r.out);
    const [w] = f.wraps();
    assert.doesNotMatch(w, /lock table/); assert.match(w, new RegExp(`\\\\i supabase/migrations/${FN}\\.sql`));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('잠금이 아닌 오류는 다시 하지 않고 멈추며 기록하지 않는다', { skip }, () => {
  const f = fixture(files);
  try {
    const r = f.run([POLICY], { FAIL_TIMES: '5', FAIL_MSG: 'syntax error at or near "x"' });
    assert.equal(r.code, 1, r.out); assert.match(r.out, /syntax error/); assert.doesNotMatch(r.out, /잠금 대기/);
    assert.equal(f.wraps().length, 1); assert.equal(f.inserts(), 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('횟수를 다 쓰면 멈추고 기록하지 않는다', { skip }, () => {
  const f = fixture(files);
  try {
    const r = f.run([POLICY], { FAIL_TIMES: '9', ARGO_APPLY_TRIES: '3' });
    assert.equal(r.code, 1, r.out); assert.equal(f.wraps().length, 3); assert.equal(f.inserts(), 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
