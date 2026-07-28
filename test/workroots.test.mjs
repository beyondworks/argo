// 외부 작업 폴더(work roots) 회귀 테스트 — 실사용 신고 최다 클러스터(홈 밖 경로 차단, 11건/7명,
// 2026-07-26~27) 해소의 보안 경계 고정:
//  ① 등록 검증 — 금지 구역(앱 코드·~/.argo·WS_ROOT)·루트 전체·심링크 우회를 거부한다
//  ② 게이트 — 지정 폴더는 fs 능력 없이 책상이 되고, 금지 구역 하드 차단은 지정보다 항상 앞선다
//  ③ codex 매핑 — writable_roots에 지정 폴더가 실리되 fs 꺼짐이면 홈은 안 실린다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 임시 ARGO_ROOT + 임시 HOME/USERPROFILE — 격리(win homedir()=USERPROFILE — CI 실측 2026-07-27)
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-wr-'));
// HOME은 canonical(realpath)로 — 맥 tmpdir은 /var→/private/var 심링크라, 렉시컬 폴백 경로(/var/...)와
// canonical 비교 기준(/private/var/...)의 접두가 어긋나 케이스 폴딩 테스트가 폴딩과 무관한 이유로
// 통과/실패했다(분리 검수: 순서 의존 플레이크 + #141 canonDeep 병합 시 오작동). canonical이면 조건 독립.
const { realpath: realpathFs } = await import('node:fs/promises');
process.env.HOME = process.env.USERPROFILE = await realpathFs(await mkdtemp(join(tmpdir(), 'argo-wrhome-')));
const { validateWorkRoot, updateWorkRoots, loadWorkRoots, loadActiveWorkRoots, MAX_WORK_ROOTS } = await import('../src/workroots.mjs');
const { makePermissionGate, makeInWorkRoots, makeIsForbidden } = await import('../src/permission-gate.mjs');
const { codexSandboxArgs, writeCodexTurnConfig } = await import('../src/runners.mjs');
const { readFile } = await import('node:fs/promises');

const WS_ROOT = process.env.ARGO_ROOT;
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wsRoot = join(WS_ROOT, 'wr-co');
await mkdir(join(wsRoot, 'vault'), { recursive: true });
const outside = await mkdtemp(join(tmpdir(), 'argo-wr-out-')); // 홈 밖(맥 tmp는 /var/… — 홈 아님) 실폴더
await writeFile(join(outside, 'doc.md'), '# 외부 문서\n');

test('케이스 변형 + 미존재 하위 경로가 하드 차단을 빠져나가지 못한다 (렉시컬 폴백 폴딩)', async (tc) => {
  // 실제 우회 지점(분리 검수 격리 재현 2026-07-28): 대상·부모 모두 미존재면 permission-gate의
  // real이 렉시컬 폴백(입력 케이스 보존)이 되어, 폴딩 없인 ~/.ARGO/NS/DEEP 케이스 변형이
  // canonical 하드 루트와 문자열 불일치 → isForbidden=false → 보호 구역 안 새 하위 트리 생성 허용.
  // 뮤테이션 검증: insideFold를 정확 비교로 되돌리면 이 테스트가 실패해야 한다(트립와이어).
  // 전제: HOME이 canonical(위 realpath) — 아니면 ~/.argo 단언이 접두 아티팩트로 폴딩과 무관하게 뒤집힌다.
  if (process.platform !== 'win32' && process.platform !== 'darwin') return tc.skip('대소문자 구분 FS');
  const flip = (p) => p.split('').map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
  const isForbidden = makeIsForbidden(wsRoot);
  assert.equal(await isForbidden(join(flip(join(homedir(), '.argo')), 'NS', 'DEEP', 'x.json')), true);
  assert.equal(await isForbidden(join(flip(APP_ROOT), 'NS', 'DEEP', 'x.mjs')), true);
});

test('validateWorkRoot: 케이스 변형 보호 구역 등록 거부 — 심층 방어 문서화', async (tc) => {
  // 주의: 이 테스트는 폴딩의 트립와이어가 아니다 — fs/promises.realpath가 케이스를 정규화해
  // 폴딩 없이도 protected가 걸린다(뮤테이션 생존 실측). realpath 정규화 성질 자체가 회귀하면
  // 잡는 문서화 테스트로 남긴다. 폴딩의 실제 트립와이어는 위 렉시컬 폴백 테스트다.
  if (process.platform !== 'win32' && process.platform !== 'darwin') return tc.skip('대소문자 구분 FS');
  const flipped = APP_ROOT.split('').map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
  await assert.rejects(() => validateWorkRoot(flipped), (e) => ['protected', 'not-found'].includes(e.code));
});

test('validateWorkRoot: 정상 외부 폴더는 canonical로 통과', async () => {
  const real = await validateWorkRoot(outside);
  assert.equal(typeof real, 'string');
  assert.ok((await import('node:path')).isAbsolute(real));
});

test('validateWorkRoot: 상대경로·미존재·파일·루트 전체는 코드로 거부', async () => {
  await assert.rejects(() => validateWorkRoot('relative/path'), (e) => e.code === 'not-absolute');
  await assert.rejects(() => validateWorkRoot(join(outside, 'no-such-dir')), (e) => e.code === 'not-found');
  await assert.rejects(() => validateWorkRoot(join(outside, 'doc.md')), (e) => e.code === 'not-dir');
  if (process.platform !== 'win32') {
    await assert.rejects(() => validateWorkRoot('/'), (e) => e.code === 'too-broad', '"/"는 2026-07-22 크리티컬의 재연');
  }
});

test('validateWorkRoot: 금지 구역(앱 코드·~/.argo·WS_ROOT와 그 안)은 등록 거부', async () => {
  await assert.rejects(() => validateWorkRoot(APP_ROOT), (e) => e.code === 'protected', '앱 코드 루트');
  await assert.rejects(() => validateWorkRoot(join(APP_ROOT, 'src')), (e) => e.code === 'protected', '앱 코드 안');
  const argoHome = join(homedir(), '.argo', 'codex-home-x');
  await mkdir(argoHome, { recursive: true });
  await assert.rejects(() => validateWorkRoot(argoHome), (e) => e.code === 'protected', '격리 홈·자격');
  await assert.rejects(() => validateWorkRoot(WS_ROOT), (e) => e.code === 'protected', '전 회사 데이터 루트');
  await assert.rejects(() => validateWorkRoot(wsRoot), (e) => e.code === 'protected', '워크스페이스 자신도 등록 불필요·거부');
});

test('validateWorkRoot: 심링크로 금지 구역을 등록하지 못한다(realpath 봉인)', async () => {
  const link = join(outside, 'applink');
  await symlink(APP_ROOT, link).catch(() => {});
  await assert.rejects(() => validateWorkRoot(link), (e) => e.code === 'protected');
});

test('validateWorkRoot: 앱 코드 루트의 조상 폴더도 등록 거부(분리 검수 HIGH-1 — 2026-07-22 크리티컬의 조상 변종)', async () => {
  // APP_ROOT를 '포함'하는 폴더가 codex writable_roots에 실리면 fs 꺼짐에도 앱 본체 쓰기가 열린다
  await assert.rejects(() => validateWorkRoot(dirname(APP_ROOT)), (e) => e.code === 'protected', 'APP_ROOT 부모');
  await assert.rejects(() => validateWorkRoot(dirname(dirname(APP_ROOT))), (e) => e.code === 'protected', 'APP_ROOT 조부모');
});

test('loadActiveWorkRoots: 등록 후 보호 구역 심링크로 교체된 루트는 주입에서 빠진다(TOCTOU — 분리 검수 MED-2)', async () => {
  const ws = 'wr-toctou';
  await mkdir(join(WS_ROOT, ws), { recursive: true });
  const swap = await mkdtemp(join(tmpdir(), 'argo-wr-swap-'));
  await updateWorkRoots(ws, { add: swap });
  assert.deepEqual(await loadActiveWorkRoots(ws), [await validateWorkRoot(swap)], '교체 전엔 주입');
  await rm(swap, { recursive: true, force: true });
  await symlink(APP_ROOT, swap); // 등록된 경로가 이제 앱 코드를 가리킨다
  assert.deepEqual(await loadActiveWorkRoots(ws), [], '교체 후 재검증이 걸러낸다 — codex writable_roots 오염 차단');
});

test('updateWorkRoots: 추가/중복/상한/삭제 + loadActiveWorkRoots는 존재하는 폴더만', async () => {
  const ws = 'wr-co';
  assert.deepEqual(await loadWorkRoots(ws), []);
  const after = await updateWorkRoots(ws, { add: outside });
  assert.equal(after.length, 1);
  await assert.rejects(() => updateWorkRoots(ws, { add: outside }), (e) => e.code === 'duplicate');
  // 사라진 폴더(분리된 외장 디스크 모사)는 active에서 조용히 빠지고 목록에는 남는다
  const gone = await mkdtemp(join(tmpdir(), 'argo-wr-gone-'));
  await updateWorkRoots(ws, { add: gone });
  await rm(gone, { recursive: true, force: true });
  assert.equal((await loadWorkRoots(ws)).length, 2, '목록 보존(재연결 대비)');
  assert.deepEqual(await loadActiveWorkRoots(ws), [after[0]], '턴 주입은 존재분만');
  await updateWorkRoots(ws, { remove: (await loadWorkRoots(ws))[1] });
  assert.equal((await loadWorkRoots(ws)).length, 1);
  // 상한
  for (let i = (await loadWorkRoots(ws)).length; i < MAX_WORK_ROOTS; i++) {
    await updateWorkRoots(ws, { add: await mkdtemp(join(tmpdir(), `argo-wr-fill${i}-`)) });
  }
  const over = await mkdtemp(join(tmpdir(), 'argo-wr-over-'));
  await assert.rejects(() => updateWorkRoots(ws, { add: over }), (e) => e.code === 'limit');
});

test('makeInWorkRoots: 절대경로만 판정 — 상대경로는 워크스페이스(cwd) 몫', async () => {
  const inWr = makeInWorkRoots([outside]);
  assert.equal(await inWr(join(outside, 'doc.md')), true);
  assert.equal(await inWr(join(outside, 'sub', 'new.md')), true, '미존재 하위도 렉시컬 통과(쓰기 전 판정)');
  assert.equal(await inWr('doc.md'), false, '상대경로는 지정 폴더 판정 대상 아님');
  assert.equal(await inWr(`${outside}-sibling/x`), false, '접두 오탐 없음');
  assert.equal(await makeInWorkRoots([])('x'), false, '빈 목록은 항상 false');
});

test('게이트: 지정 폴더는 fs 능력 꺼짐에도 읽기·쓰기 책상이다', async () => {
  const caps = { fs: false, browser: false, shell: false, bypass: false };
  const gate = makePermissionGate('wr-co', 'crew-a', caps, wsRoot, null, 'ko', [outside]);
  assert.equal((await gate('Read', { file_path: join(outside, 'doc.md') })).behavior, 'allow', '지정 폴더 읽기');
  assert.equal((await gate('Write', { file_path: join(outside, 'new.md'), content: 'x' })).behavior, 'allow', '지정 폴더 쓰기');
  assert.equal((await gate('Read', { file_path: join(tmpdir(), 'not-assigned.md') })).behavior, 'deny', '지정 밖은 여전히 fs 능력 필요');
});

test('게이트: 지정 폴더가 보호 구역을 포함해도 금지 구역 선차단이 이긴다', async () => {
  // 홈 전체를 지정(포함 등록은 허용 — workroots.mjs 주석) — 그 안의 ~/.argo는 여전히 하드 차단
  const caps = { fs: false, browser: false, shell: false, bypass: false };
  const gate = makePermissionGate('wr-co', 'crew-a', caps, wsRoot, null, 'ko', [homedir()]);
  const denied = await gate('Write', { file_path: join(homedir(), '.argo', 'codex-home-x', 'auth.json'), content: 'x' });
  assert.equal(denied.behavior, 'deny', '~/.argo는 지정 폴더 안이어도 금지');
  assert.equal((await gate('Read', { file_path: join(homedir(), 'normal.txt') })).behavior, 'allow', '보호 구역 밖 홈 파일은 책상');
});

test('codexSandboxArgs: fs 꺼짐 + 지정 폴더 = 지정 폴더만, fs 켜짐 = 홈 + 지정 폴더', () => {
  assert.deepEqual(codexSandboxArgs({ fs: false }, []), [], '기존 동작 불변');
  const onlyRoots = codexSandboxArgs({ fs: false }, [outside]).join(' ');
  assert.ok(onlyRoots.includes(`writable_roots=[${JSON.stringify(outside)}]`), 'fs 꺼짐 — 홈은 안 열린다');
  assert.ok(!onlyRoots.includes(JSON.stringify(homedir())), 'fs 꺼짐이면 홈 미포함');
  const both = codexSandboxArgs({ fs: true }, [outside]).join(' ');
  assert.ok(both.includes(JSON.stringify(homedir())) && both.includes(JSON.stringify(outside)), 'fs 켜짐 — 홈+지정');
});

test('writeCodexTurnConfig: 지정 폴더가 config.toml writable_roots에 실린다(fs 무관)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'argo-wr-ch-'));
  await writeCodexTurnConfig(home, { fs: false, browser: false }, [outside]);
  const c = await readFile(join(home, 'config.toml'), 'utf8');
  assert.ok(c.includes('[sandbox_workspace_write]'));
  assert.ok(c.includes(`writable_roots = [${JSON.stringify(outside)}]`));
  // 지정 폴더 없음 + 능력 꺼짐 = 섹션 없음(기존 계약 유지)
  const home2 = await mkdtemp(join(tmpdir(), 'argo-wr-ch2-'));
  await writeCodexTurnConfig(home2, { fs: false, browser: false }, []);
  assert.ok(!(await readFile(join(home2, 'config.toml'), 'utf8')).includes('[sandbox_workspace_write]'));
});
