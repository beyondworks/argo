// 라이브 적용 검문(2026-09-24, 유건 "안전한 방향으로 개선해줘") — main에 병합된 것과 똑같은 파일만 라이브에 적용한다.
// 9/23 사고: 옛 적용 스크립트가 옛 파일을 다시 돌려 라이브 함수·정책을 덮었다. 9/24: 기본 체크아웃에 그 옛 스크립트가 남아 있던 것을 발견.
// 임시 git 저장소(가짜 origin)에서 스크립트를 돌려 거부 사유와 통과를 본다. 접속 정보 파일은 만들지 않는다 — 통과하면 그 단계에서 멈춘다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
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
