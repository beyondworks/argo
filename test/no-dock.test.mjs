// macOS Dock 아이콘 억제 — 행동 테스트(실 fs·실 자식 프로세스).
// 제보 2026-09-10: "크루들이 답변할 때 node 아이콘이 엄청 생성된다".
// 원인은 자식이 process.title을 설정할 때 macOS가 프로세스를 Launch Services에 등록하는 것이라,
// 핀은 **자식의 제목이 실제로 바뀌지 않는가**로 잡는다(등록 여부는 GUI 세션이 없는 CI에서 재현되지 않는다).
// 실제 홈은 건드리지 않는다 — 모든 테스트가 임시 경로를 주입한다(분리 검수 LOW-3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { ensureNoDockShim, noDockShimPath, probeNodeOptions, setupNoDock, withNoDock } from '../src/no-dock.mjs';

const isMac = process.platform === 'darwin';
const tmpShim = async () => join(await mkdtemp(join(tmpdir(), 'argo-nodock-')), 'no-dock.cjs');

/** 자식을 띄워 "제목 대입이 먹히는가"를 본다 — 프리로드가 걸리면 옛 값이 그대로 나온다. */
const childTitleAfterSet = (env) => new Promise((resolve, reject) => {
  const code = `process.title = 'argo-nodock-probe'; process.stdout.write(process.title);`;
  const c = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let out = ''; let err = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { err += d; });
  c.on('error', reject);
  c.on('close', (code2) => (code2 === 0 ? resolve(out) : reject(new Error(`exit ${code2}: ${err}`))));
});

test('withNoDock — 기존 NODE_OPTIONS 보존·같은 경로 중복 부착 금지·공백 경로 따옴표(순수)', () => {
  assert.equal(withNoDock('', '/a/no-dock.cjs'), '--require /a/no-dock.cjs');
  assert.equal(withNoDock(undefined, '/a/no-dock.cjs'), '--require /a/no-dock.cjs');
  assert.equal(withNoDock('--max-old-space-size=4096', '/a/no-dock.cjs'),
    '--require /a/no-dock.cjs --max-old-space-size=4096', '사용자 옵션을 잃지 않는다');
  assert.equal(withNoDock('--require /a/no-dock.cjs --trace-warnings', '/a/no-dock.cjs'),
    '--require /a/no-dock.cjs --trace-warnings', '같은 경로가 이미 있으면 그대로(재부팅·중첩 실행)');
  assert.equal(withNoDock('--require /other/home/no-dock.cjs', '/a/no-dock.cjs'),
    '--require /a/no-dock.cjs --require /other/home/no-dock.cjs',
    '다른 경로의 동명 파일은 내 것이 아니다 — 파일명만 보면 오인한다(검수 LOW-2)');
  assert.equal(withNoDock('', '/Users/kim lee/.argo/tools/no-dock.cjs'),
    '--require "/Users/kim lee/.argo/tools/no-dock.cjs"', '공백 경로는 따옴표 — 없으면 node가 토큰을 갈라 전부 실패한다');
});

test('setupNoDock — darwin에서만 env를 건드리고, 그 외 OS는 무접촉', async () => {
  const linux = { NODE_OPTIONS: '--trace-warnings' };
  assert.equal(await setupNoDock({ env: linux, platform: 'linux' }), null);
  assert.equal(linux.NODE_OPTIONS, '--trace-warnings', 'Dock이 없는 OS에서는 손대지 않는다');
  const win = {};
  assert.equal(await setupNoDock({ env: win, platform: 'win32' }), null);
  assert.equal(win.NODE_OPTIONS, undefined);
});

test('ensureNoDockShim — 프리로드 파일을 원자적으로 만들고(0600) 제목 setter만 무력화한다(읽기는 보존)', async () => {
  const p = await tmpShim();
  try {
    assert.equal(await ensureNoDockShim(p), p, '없던 디렉터리도 만든다');
    const st = await stat(p);
    assert.ok(st.isFile());
    assert.equal(st.mode & 0o777, 0o600, '~/.argo 산출물 관례(검수 MEDIUM-4)');
    const src = await readFile(p, 'utf8');
    assert.match(src, /platform === 'darwin'/, 'darwin 밖에서는 no-op');
    assert.match(src, /defineProperty\(process, 'title'/);
    assert.match(src, /get: function/, '읽기는 남긴다 — ps·진단 표시가 변하면 안 된다');
    await ensureNoDockShim(p); // 멱등
    assert.equal(await readFile(p, 'utf8'), src);
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual((await readdir(join(p, '..'))).filter((f) => f.includes('.tmp-')), [], 'tmp 잔재를 남기지 않는다');
  } finally { await rm(join(p, '..'), { recursive: true, force: true }); }
});

test('setupNoDock — 프로브가 실패하면 env를 건드리지 않는다(NODE_OPTIONS가 깨지면 모든 node 자식이 죽는다)', async () => {
  const p = await tmpShim();
  try {
    const env = { NODE_OPTIONS: '--trace-warnings' };
    const path = await setupNoDock({ env, platform: 'darwin', path: p, probe: async () => false });
    assert.equal(path, null, '미채택이면 null');
    assert.equal(env.NODE_OPTIONS, '--trace-warnings', '원래 값 그대로 — 파일 부재·따옴표 파손·권한 실패의 공통 방어선(검수 MEDIUM-2·3)');
  } finally { await rm(join(p, '..'), { recursive: true, force: true }); }
});

test('setupNoDock — 파일 준비가 실패해도 env를 건드리지 않고 부팅을 막지 않는다', async () => {
  const env = { NODE_OPTIONS: '--trace-warnings' };
  // 파일로 존재하는 경로의 하위를 요구하면 mkdir가 ENOTDIR로 실패한다
  const dir = await mkdtemp(join(tmpdir(), 'argo-nodock-'));
  const blocker = join(dir, 'blocker');
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(blocker, 'x');
    const path = await setupNoDock({ env, platform: 'darwin', path: join(blocker, 'sub', 'no-dock.cjs') });
    assert.equal(path, null);
    assert.equal(env.NODE_OPTIONS, '--trace-warnings');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('probeNodeOptions — 깨진 NODE_OPTIONS는 거절하고 정상 값은 통과시킨다', { skip: !isMac && 'macOS 전용 처방' }, async () => {
  const p = await tmpShim();
  try {
    await ensureNoDockShim(p);
    assert.equal(await probeNodeOptions({}, `--require ${p}`), true);
    assert.equal(await probeNodeOptions({}, '--require /없는/경로/no-dock.cjs'), false, '파일이 사라진 경우');
    assert.equal(await probeNodeOptions({}, '--totally-unknown-flag-xyz'), false, 'node가 거절하는 값');
  } finally { await rm(join(p, '..'), { recursive: true, force: true }); }
});

test('행동 — 프리로드를 건 자식은 제목 대입이 먹지 않는다(= Launch Services 등록·Dock 아이콘 없음)', { skip: !isMac && 'macOS 전용 처방' }, async () => {
  const p = await tmpShim();
  try {
    const base = { ...process.env };
    delete base.NODE_OPTIONS;
    assert.equal(await childTitleAfterSet(base), 'argo-nodock-probe', '기준: 프리로드가 없으면 제목이 바뀐다(이때 Dock 아이콘이 생긴다)');

    const env = { ...base };
    const path = await setupNoDock({ env, platform: 'darwin', path: p });
    assert.equal(path, p, '채택되면 건 경로를 돌려준다');
    assert.match(env.NODE_OPTIONS, /--require/);
    const titled = await childTitleAfterSet(env);
    assert.notEqual(titled, 'argo-nodock-probe', '제목 대입이 먹으면 그 자식은 Dock에 등록된다');
  } finally { await rm(join(p, '..'), { recursive: true, force: true }); }
});

test('행동 — 프리로드가 걸려도 자식이 정상 실행된다(NODE_OPTIONS가 자식을 죽이지 않는다)', { skip: !isMac && 'macOS 전용 처방' }, async () => {
  const p = await tmpShim();
  try {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    await setupNoDock({ env, platform: 'darwin', path: p });
    const out = await new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ['-e', 'process.stdout.write(String(1 + 1))'], { stdio: ['ignore', 'pipe', 'pipe'], env });
      let s = ''; let e = '';
      c.stdout.on('data', (d) => { s += d; });
      c.stderr.on('data', (d) => { e += d; });
      c.on('close', (code) => (code === 0 ? resolve(s) : reject(new Error(`exit ${code}: ${e}`))));
    });
    assert.equal(out, '2', '프리로드 파일이 없거나 경로가 깨지면 여기서 죽는다 — 크루가 돌리는 모든 node 명령이 같은 운명');
  } finally { await rm(join(p, '..'), { recursive: true, force: true }); }
});

test('기본 경로는 ~/.argo/tools/no-dock.cjs — codex 조달과 같은 도구 디렉터리(회사 데이터와 분리)', () => {
  assert.match(noDockShimPath(), /\.argo\/tools\/no-dock\.cjs$/);
});

test('배선 — 서버 부팅 훅이 스케줄러보다 먼저 setupNoDock을 부른다(첫 배달 턴의 자식부터 덮이게)', async () => {
  const src = await readFile(new URL('../instrumentation-node.mjs', import.meta.url), 'utf8');
  assert.match(src, /await setupNoDock\(\)/, '부팅 시 1회 호출');
  assert.ok(src.indexOf('await setupNoDock()') < src.indexOf('ensureScheduler()'), '스케줄러(쪽지 배달)보다 앞');
});
