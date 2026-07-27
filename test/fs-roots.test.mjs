// 허용 폴더(fsRoots) — P0-1 (B) 갈래의 검증·직렬화·저장 행위 테스트.
// 배경: codex writable_roots가 홈 하드코딩이라 fs 능력을 켜도 홈 밖(C:\services·D:\·외장 SSD)이
// 구조적으로 차단(피드백 11건·막힌 사용자 7명). 하드코딩의 취지(앱 본체 보호)는 validateFsRoot의
// 하드존 거부가 이어받는다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let caps; let runners; let paths; let WS;

before(async () => {
  process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-fsroots-'));
  ({ paths } = await import('../src/workspace.mjs'));
  caps = await import('../src/capabilities.mjs');
  runners = await import('../src/runners.mjs');
  WS = 'lean-test-roots';
  await mkdir(paths(WS).root, { recursive: true });
  await writeFile(paths(WS).company, JSON.stringify({ id: WS, name: '테스트' }));
});
after(async () => { await rm(process.env.ARGO_ROOT, { recursive: true, force: true }).catch(() => {}); });

test('validateFsRoot — 절대경로만, 드라이브 전체·상대경로 거부', () => {
  assert.equal(caps.validateFsRoot('/Users/someone/work'), resolve('/Users/someone/work'));
  assert.throws(() => caps.validateFsRoot('work/relative'), /절대 경로/);
  assert.throws(() => caps.validateFsRoot(''), /절대 경로/);
  assert.throws(() => caps.validateFsRoot(sep), /드라이브 전체/);
});

test('validateFsRoot — 하드존(앱 루트·~/.argo)과 그 상위·하위 거부', () => {
  assert.throws(() => caps.validateFsRoot(appRoot), /지정할 수 없습니다/);
  assert.throws(() => caps.validateFsRoot(join(appRoot, 'src')), /지정할 수 없습니다/, '하드존 하위');
  assert.throws(() => caps.validateFsRoot(dirname(appRoot)), /지정할 수 없습니다/, '하드존 상위 — 안에 하드존이 포함된다');
  assert.throws(() => caps.validateFsRoot(join(homedir(), '.argo')), /지정할 수 없습니다/);
  assert.throws(() => caps.validateFsRoot(join(homedir(), '.argo', 'workspaces')), /지정할 수 없습니다/);
});

test('updateCapabilities — fsRoots 전체 교체·중복 제거·상한, 무효 항목은 통째 거절', async () => {
  const a = join(tmpdir(), 'proj-a'); const b = join(tmpdir(), 'proj-b');
  const r1 = await caps.updateCapabilities(WS, { fsRoots: [a, b, a] });
  assert.deepEqual(r1.fsRoots, [resolve(a), resolve(b)]);
  // 무효 1건이 섞이면 전체 거절 — 일부만 조용히 수용 금지(루틴 시각과 동일 원칙)
  await assert.rejects(() => caps.updateCapabilities(WS, { fsRoots: [a, 'not-absolute'] }), /절대 경로/);
  const kept = await caps.loadCapabilities(WS);
  assert.deepEqual(kept.fsRoots, [resolve(a), resolve(b)], '거절된 갱신이 기존 목록을 훼손했다');
  await assert.rejects(() => caps.updateCapabilities(WS, { fsRoots: Array.from({ length: 9 }, (_, i) => join(tmpdir(), `r${i}`)) }), /8개/);
});

test('loadCapabilities — fsRoots 오염(비배열·비문자열) 흡수', async () => {
  const { writeJsonAtomic } = await import('../src/jsonstore.mjs');
  await writeJsonAtomic(paths(WS).capabilities, { fs: true, fsRoots: ['/ok', 42, null, '  '] });
  const c = await caps.loadCapabilities(WS);
  assert.deepEqual(c.fsRoots, ['/ok']);
  await writeJsonAtomic(paths(WS).capabilities, { fs: true, fsRoots: 'corrupt' });
  assert.deepEqual((await caps.loadCapabilities(WS)).fsRoots, []);
});

test('codexWritableRoots — 홈 + fsRoots 직렬화(중복 제거·오염 안전·JSON 이스케이프)', () => {
  const home = JSON.stringify(homedir());
  assert.equal(runners.codexWritableRoots(null), `[${home}]`);
  assert.equal(runners.codexWritableRoots({ fsRoots: 'x' }), `[${home}]`);
  const out = runners.codexWritableRoots({ fsRoots: ['/tmp/한글 폴더', homedir(), '/tmp/한글 폴더'] });
  assert.equal(out, `[${home}, ${JSON.stringify('/tmp/한글 폴더')}]`);
});

test('배선 — writable_roots 두 곳(-c·config.toml) 모두 codexWritableRoots를 쓴다', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(appRoot, 'src', 'runners.mjs'), 'utf8');
  const hits = [...src.matchAll(/writable_roots.?=.?\$\{codexWritableRoots\(caps\)\}/g)].length;
  assert.equal(hits, 2, '한쪽만 반영되면 codex 버전에 따라 허용 폴더가 무시된다(-c/config.toml 이중 전달 구조)');
  assert.ok(!/writable_roots.?=.?\[\$\{JSON\.stringify\(homedir\(\)\)\}\]/.test(src), '홈 하드코딩 직렬화가 되살아났다');
});
