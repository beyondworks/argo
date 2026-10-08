// 라이브 적용 검문(2026-09-24, 유건 "안전한 방향으로 개선해줘") — main에 병합된 것과 똑같은 파일만 라이브에 적용한다.
// 9/23 사고: 옛 적용 스크립트가 옛 파일을 다시 돌려 라이브 함수·정책을 덮었다. 9/24: 기본 체크아웃에 그 옛 스크립트가 남아 있던 것을 발견.
// 임시 git 저장소(가짜 origin)에서 스크립트를 돌려 거부 사유와 통과를 본다. 접속 정보 파일은 만들지 않는다 — 통과하면 그 단계에서 멈춘다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const skip = process.platform === 'win32' && '라이브 적용은 맥 운영 전용 bash 스크립트(윈도우 CI의 bash·git 경로가 달라 픽스처가 성립하지 않는다)';
const SCRIPT = fileURLToPath(new URL('../scripts/msgr-live-apply.sh', import.meta.url));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'argo-apply-guard-'));
  const seed = join(root, 'seed'), origin = join(root, 'origin.git'), work = join(root, 'work');
  mkdirSync(join(seed, 'scripts'), { recursive: true }); mkdirSync(join(seed, 'supabase/migrations'), { recursive: true });
  copyFileSync(SCRIPT, join(seed, 'scripts/msgr-live-apply.sh'));
  writeFileSync(join(seed, 'supabase/migrations/20990101000000_merged.sql'), 'select 1;\n');
  git(seed, 'init', '-q', '-b', 'main'); git(seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'); git(seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed');
  git(root, 'clone', '-q', '--bare', seed, origin); git(root, 'clone', '-q', origin, work);
  const run = (...args) => { const r = spawnSync('bash', ['scripts/msgr-live-apply.sh', ...args], { cwd: work, encoding: 'utf8' }); return { code: r.status, out: `${r.stdout}${r.stderr}` }; };
  return { root, work, run };
}

test('main에 없는 마이그레이션은 거부', { skip }, () => {
  const f = fixture();
  try {
    writeFileSync(join(f.work, 'supabase/migrations/20990102000000_local.sql'), 'select 2;\n');
    const r = f.run('20990102000000_local');
    assert.equal(r.code, 4); assert.match(r.out, /main에 병합되지 않은 파일/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('main 병합본과 내용이 다르면 거부(수정 중·옛 브랜치 사본)', { skip }, () => {
  const f = fixture();
  try {
    writeFileSync(join(f.work, 'supabase/migrations/20990101000000_merged.sql'), 'select 1; -- 고친 줄\n');
    const r = f.run('20990101000000_merged');
    assert.equal(r.code, 4); assert.match(r.out, /main 병합본과 내용이 다릅니다/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('적용 스크립트 자체가 main과 다르면 거부(옛 체크아웃의 옛 스크립트)', { skip }, () => {
  const f = fixture();
  try {
    writeFileSync(join(f.work, 'scripts/msgr-live-apply.sh'), `${readScript(f.work)}\n# 옛 사본\n`);
    const r = f.run('20990101000000_merged');
    assert.equal(r.code, 4); assert.match(r.out, /적용 스크립트가 main 최신과 다릅니다/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('main과 똑같은 파일은 검문을 통과한다(다음 단계인 접속 정보 읽기에서 멈춤)', { skip }, () => {
  const f = fixture();
  try {
    const r = f.run('20990101000000_merged');
    assert.notEqual(r.code, 4); assert.doesNotMatch(r.out, /거부/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('main이 앞서 나간 뒤(스크립트가 main 최신과 다름) 옛 사본은 거부 — fetch로 최신 main과 비교한다(재검수 M2)', { skip }, () => {
  const f = fixture();
  try {
    const seed = join(f.root, 'seed');
    writeFileSync(join(seed, 'scripts/msgr-live-apply.sh'), `${readScript(seed)}\n# main에 들어온 새 검문\n`);
    git(seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'newer'); git(seed, 'push', '-q', join(f.root, 'origin.git'), 'main');
    const r = f.run('20990101000000_merged');
    assert.equal(r.code, 4); assert.match(r.out, /적용 스크립트가 main 최신과 다릅니다/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('main을 못 가져오면 거부(재검수 M2)', { skip }, () => {
  const f = fixture();
  try {
    git(f.work, 'remote', 'set-url', 'origin', join(f.root, 'no-such.git'));
    const r = f.run('20990101000000_merged');
    assert.equal(r.code, 4); assert.match(r.out, /origin\/main을 가져오지 못했습니다/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('확장자를 붙여도 같은 파일로 본다(재검수 L3)', { skip }, () => {
  const f = fixture();
  try { const r = f.run('20990101000000_merged.sql'); assert.notEqual(r.code, 4); assert.doesNotMatch(r.out, /거부/); }
  finally { rmSync(f.root, { recursive: true, force: true }); }
});

function readScript(dir) { return execFileSync('cat', [join(dir, 'scripts/msgr-live-apply.sh')]).toString(); }

// 2026-10-06(#846 검수): 마이그레이션 적용에 잠금 대기 제한을 건다. 2026-10-08: 종전 PGOPTIONS 방식은 Supavisor 풀러가 시작 옵션을 버려
// 운영에서 lock_timeout=0·client_min_messages=notice 그대로였다(show로 관찰) — 그래서 적용 트랜잭션(-1) 첫 문장 set local로 건다.
// 가짜 psql(PATH 앞)이 -f로 받은 파일 내용을 기록한다. 접속 정보는 가짜 값(.env.local)이고 네트워크에 나가지 않는다.
test('적용 트랜잭션은 첫 문장에서 lock_timeout(기본 5초·ARGO_APPLY_LOCK_TIMEOUT)과 경고 수준을 set local로 건다 — 선잠금보다 먼저', { skip }, () => {
  const f = fixture();
  try {
    const seed = join(f.root, 'seed');
    writeFileSync(join(seed, 'supabase/migrations/20990103000000_policy.sql'), 'drop policy if exists p on public.t;\n');
    git(seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'); git(seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'policy');
    git(seed, 'push', '-q', join(f.root, 'origin.git'), 'main'); git(f.work, 'pull', '-q');
    const bin = join(f.root, 'bin'); mkdirSync(bin);
    const log = join(f.root, 'psql.log');
    // set local은 -1 트랜잭션 안에서만 듣는다 — 적용 호출에 -1이 있었는지도 기록하고, 성공한 호출의 경고가 사용자에게 보이는지 보려고 경고 한 줄을 낸다
    writeFileSync(join(bin, 'psql'), `#!/bin/sh\ncase "$*" in *"count(*)"*) echo 0 ;; esac\none=0; for a in "$@"; do [ "$a" = -1 ] && one=1; done\nwhile [ $# -gt 0 ]; do if [ "$1" = -f ]; then { echo "-1=$one"; cat "$2"; echo '--end'; } >> ${JSON.stringify(log)}; echo 'psql:w.sql:1: WARNING:  fixture-warning' >&2; fi; shift; done\nexit 0\n`, { mode: 0o755 });
    writeFileSync(join(f.work, '.env.local'), 'NEXT_PUBLIC_SUPABASE_URL=https://fixtureref.supabase.co\nSUPABASE_DB_PASSWORD=fixture\n');
    const run = (env, ...m) => spawnSync('bash', ['scripts/msgr-live-apply.sh', ...m], { cwd: f.work, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env } });
    let r = run({}, '20990101000000_merged', '20990103000000_policy'); assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /fixture-warning/, '성공한 적용의 경고도 보인다(set local이 트랜잭션 밖이 되면 경고로만 드러난다)');
    r = run({ ARGO_APPLY_LOCK_TIMEOUT: '2s' }, '20990101000000_merged'); assert.equal(r.status, 0, r.stdout + r.stderr);
    const [plain, policy, custom] = readFileSync(log, 'utf8').split('--end\n');
    const head = (t) => "-1=1\nset local lock_timeout = '" + t + "';\nset local client_min_messages = warning;\n";
    assert.equal(plain, head('5s') + '\\i supabase/migrations/20990101000000_merged.sql\n');
    assert.ok(policy.startsWith(head('5s') + 'do $prelock$'), `선잠금 파일도 set local이 맨 앞(선잠금 블록이 덮어쓰지 않는다):\n${policy}`);
    assert.equal(custom, head('2s') + '\\i supabase/migrations/20990101000000_merged.sql\n');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('ARGO_APPLY_LOCK_TIMEOUT은 시간 형식만 받는다(SQL에 그대로 들어간다) — 접속 전에 거부', { skip }, () => {
  const f = fixture();
  try {
    for (const bad of ["5s'; select 1; --", '5 s', 'abc', '']) {
      const r = spawnSync('bash', ['scripts/msgr-live-apply.sh', '20990101000000_merged'], { cwd: f.work, encoding: 'utf8', env: { ...process.env, ARGO_APPLY_LOCK_TIMEOUT: bad } });
      if (bad === '') { assert.notEqual(r.status, 2, '빈 값은 기본 5초로 본다'); continue; }
      assert.equal(r.status, 2, `${bad}: ${r.stdout}${r.stderr}`); assert.match(r.stdout, /ARGO_APPLY_LOCK_TIMEOUT 형식이 아닙니다/);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
