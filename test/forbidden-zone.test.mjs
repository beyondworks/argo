// 금지 구역(하드 차단) 회귀 테스트 — 실사용 크리티컬(2026-07-22) 고정:
// 크루가 실행 중인 Argo 앱 코드·~/.argo·타사 워크스페이스·자격 파일을 만지지 못한다.
// bypass/fs 능력이 켜져 있어도 열리지 않는 것이 계약이다(permission-gate.mjs makeIsForbidden).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-forbid-'));
const { makeIsForbidden, makePermissionGate } = await import('../src/permission-gate.mjs');

const WS_ROOT = process.env.ARGO_ROOT;
const wsRoot = join(WS_ROOT, 'my-co');
await mkdir(join(wsRoot, 'vault', 'notes'), { recursive: true });
await mkdir(join(WS_ROOT, 'other-co'), { recursive: true });
await writeFile(join(wsRoot, '.secrets.json'), '{}');
await writeFile(join(WS_ROOT, '.account-secrets-local.json'), '{}');

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // 이 레포 = 실행 중인 Argo 코드 루트

test('isForbidden: 실행 중인 Argo 코드 루트는 금지(앱 본체 수정 차단의 본체)', async () => {
  const f = makeIsForbidden(wsRoot);
  assert.equal(await f(join(APP_ROOT, 'src', 'chat.mjs')), true, '서버 코드');
  assert.equal(await f(join(APP_ROOT, 'app', 'globals.css')), true, '앱 UI 코드');
});

test('isForbidden: ~/.argo(격리 홈·자격)와 타사 워크스페이스·계정 시크릿은 금지', async () => {
  const f = makeIsForbidden(wsRoot);
  assert.equal(await f(join(homedir(), '.argo', 'codex-home-x', 'auth.json')), true);
  assert.equal(await f(join(WS_ROOT, 'other-co', 'company.json')), true, '교차 테넌트');
  assert.equal(await f(join(WS_ROOT, '.account-secrets-local.json')), true, '계정 시크릿');
});

test('isForbidden: 자기 워크스페이스 일반 파일은 허용, 직속 도트파일(.secrets.json)만 금지', async () => {
  const f = makeIsForbidden(wsRoot);
  assert.equal(await f(join(wsRoot, 'vault', 'notes', 'memo.md')), false, '크루의 책상');
  assert.equal(await f('vault/notes/memo.md'), false, '상대경로도 워크스페이스 기준');
  assert.equal(await f(join(wsRoot, '.secrets.json')), true, '회사 자격 파일');
  await mkdir(join(wsRoot, 'vault', '.trash'), { recursive: true });
  assert.equal(await f(join(wsRoot, 'vault', '.trash', 'old.md')), false, '한 단계 아래 도트 디렉토리는 정상 데이터');
});

test('isForbidden: 워크스페이스 안 심링크로 금지 구역을 우회하지 못한다', async () => {
  const f = makeIsForbidden(wsRoot);
  await symlink(APP_ROOT, join(wsRoot, 'vault', 'applink')).catch(() => {});
  assert.equal(await f(join(wsRoot, 'vault', 'applink', 'src', 'chat.mjs')), true, '심링크 canonical 판정');
});

test('permissionGate: bypass가 켜져 있어도 금지 구역 Write/Edit/Read는 deny', async () => {
  const caps = { fs: true, browser: true, shell: true, bypass: true };
  const gate = makePermissionGate('my-co', 'crew-a', wsRoot);
  const w = await gate('Write', { file_path: join(APP_ROOT, 'app', 'ui.jsx'), content: 'x' });
  assert.equal(w.behavior, 'deny', 'bypass는 결재 생략이지 보호 구역 해제가 아니다');
  const r = await gate('Read', { file_path: join(wsRoot, '.secrets.json') });
  assert.equal(r.behavior, 'deny', '자격 파일 읽기 차단(유출 방지)');
  const ok = await gate('Write', { file_path: join(wsRoot, 'vault', 'notes', 'draft.md'), content: 'x' });
  assert.equal(ok.behavior, 'allow', '워크스페이스 일반 파일은 그대로 허용(회귀 없음)');
  const bash = await gate('Bash', { command: `sed -i '' 's/a/b/' ${join(APP_ROOT, 'src', 'chat.mjs')}` });
  assert.equal(bash.behavior, 'deny', '금지 구역 리터럴 경로가 든 셸 명령 1차 방어');
});

/* ─── 회사 금고(워크스페이스 직속 제어 파일·크루 카드) — 2026-07-27 실측 재현 고정 ───
   능력이 전부 꺼진 크루가 Write로 capabilities.json을 고쳐 다음 턴에 셸·바이패스를 획득했다.
   턴마다 능력을 다시 읽는 구조(chat.mjs) 때문에 파일 쓰기 한 번이 곧 자가 승격이었다. */
const CONTROL_FILES = [
  'capabilities.json', 'mcp.json', 'connections.json', 'company.json',
  'routines.json', 'approvals.json', 'gw-cursor-slack.json',
];
const LEDGER_FILES = ['usage.jsonl', 'events.jsonl']; // 쓰기만 금지 — 읽기는 열려 있다

test('isForbidden: 원장은 쓰기만 금지하고 읽기는 연다(대체 조회 수단이 없다)', async () => {
  const f = makeIsForbidden(wsRoot);
  for (const name of LEDGER_FILES) {
    assert.equal(await f(join(wsRoot, name), 'write'), true, `${name} 쓰기`);
    assert.equal(await f(join(wsRoot, name)), false, `${name} 읽기는 허용`);
  }
  // 자격·설정은 읽기도 금지 — 원장과 구분된다
  assert.equal(await f(join(wsRoot, 'connections.json')), true, '러너 자격은 읽기도 금지');
});

test('permissionGate: 혼합 인자로 안쪽 금지 대상을 우회하지 못한다', async () => {
  // 인자 하나가 워크스페이스 밖이면 안쪽 대상의 금지 검사가 통째로 건너뛰어지던 구멍
  // (분리 검수 HIGH, 실행 재현). 한 인자의 판정이 다른 인자의 검사를 건너뛰게 하면 안 된다.
  const out = await mkdtemp(join(tmpdir(), 'argo-mixed-'));
  for (const caps of [{ fs: true, browser: false, shell: false, bypass: false },
    { fs: false, browser: false, shell: false, bypass: true }]) {
    const gate = makePermissionGate('my-co', 'crew-a', wsRoot);
    const label = caps.fs ? 'fs ON' : 'bypass ON';
    const g = await gate('Glob', { path: out, pattern: join(wsRoot, 'connections.json') });
    assert.equal(g.behavior, 'deny', `${label}: 밖 path + 안쪽 자격 pattern`);
    const g2 = await gate('Glob', { path: out, pattern: join(wsRoot, '.secrets.json') });
    assert.equal(g2.behavior, 'deny', `${label}: 밖 path + 회사 자격 pattern`);
    const g3 = await gate('Glob', { path: out, pattern: join(wsRoot, 'agents', 'crew-a.md') });
    assert.equal(g3.behavior, 'deny', `${label}: 밖 path + 크루 카드 pattern`);
    const ok = await gate('Glob', { path: out, pattern: join(out, '*.md') });
    assert.equal(ok.behavior, 'allow', `${label}: 밖 일반 경로는 그대로 허용(회귀 없음)`);
  }
});

test('permissionGate: 재귀 검색이 금고를 훑지 못한다 — 읽기 차단은 Read 한 곳이 아니다', async () => {
  // rg는 준 경로 아래를 재귀한다. 워크스페이스 루트 검색은 경로 자체가 금지가 아니라 통과했고,
  // connections.json의 봇 토큰이 평문으로 나왔다(분리 검수 HIGH, 실행 재현).
  const gate = makePermissionGate('my-co', 'crew-a', wsRoot);
  assert.equal((await gate('Grep', { pattern: 'token', path: wsRoot })).behavior, 'deny', '루트 재귀 검색');
  assert.equal((await gate('Grep', { pattern: 'token' })).behavior, 'deny', 'path 생략 = cwd = 루트');
  assert.equal((await gate('Glob', { path: wsRoot, pattern: '**/*.json' })).behavior, 'deny', '루트 glob');
  // 구체적 폴더 지정은 그대로 열려 있다 — 크루의 검색 자체를 막는 게 아니다
  assert.equal((await gate('Grep', { pattern: 'token', path: join(wsRoot, 'vault') })).behavior, 'allow', 'vault 검색');
  assert.equal((await gate('Glob', { path: join(wsRoot, 'vault'), pattern: '**/*.md' })).behavior, 'allow', 'vault glob');
});

test('permissionGate: 넓은 작업 폴더를 등록해도 재귀 검색이 금고를 훑지 못한다', async () => {
  // workRoots(#137)에 워크스페이스의 조상을 등록하면 그 폴더는 확장 책상이 되지만, 재귀 검색은
  // 그 안의 워크스페이스 금고까지 닿는다. 검색 루트가 워크스페이스를 품으면 막아야 한다.
  const ancestor = dirname(dirname(wsRoot)); // WS_ROOT의 부모 — 워크스페이스를 품는 넓은 폴더
  const caps = { fs: false, browser: false, shell: false, bypass: false };
  const gate = makePermissionGate('my-co', 'crew-a', wsRoot, null, 'ko', [ancestor]);
  assert.equal((await gate('Grep', { pattern: 'token', path: ancestor })).behavior, 'deny', '조상 폴더 재귀');
  // 작업 폴더 자체의 정상 사용(워크스페이스를 품지 않는 폴더)은 그대로 열려 있다
  const side = await mkdtemp(join(tmpdir(), 'argo-work-'));
  const g2 = makePermissionGate('my-co', 'crew-a', wsRoot, null, 'ko', [side]);
  assert.equal((await g2('Grep', { pattern: 'x', path: side })).behavior, 'allow', '지정 작업 폴더 검색');
  assert.equal((await g2('Write', { file_path: join(side, 'a.md'), content: 'x' })).behavior, 'allow', '작업 폴더 쓰기');
});

test('permissionGate: 외부 MCP·미분류 도구도 금고 경로는 막힌다', async () => {
  const gate = makePermissionGate('my-co', 'crew-a', wsRoot);
  const caps = join(wsRoot, 'capabilities.json');
  assert.equal((await gate('mcp__filesystem__write_file', { path: caps, contents: '{}' })).behavior, 'deny', '외부 MCP 파일 쓰기');
  assert.equal((await gate('MultiEdit', { file_path: caps, edits: [] })).behavior, 'deny', '미분류 쓰기 도구');
  assert.equal((await gate('SomeFutureTool', { target_file: caps })).behavior, 'deny', '이름 모르는 도구');
  // 자체 크루 서버와 무관한 인자는 그대로 통과 — 회귀 없음
  assert.equal((await gate('mcp__crew__request_capability', { cap: 'fs', why: 'x' })).behavior, 'allow', '크루 도구');
  assert.equal((await gate('mcp__filesystem__write_file', { path: join(wsRoot, 'vault', 'a.md') })).behavior, 'allow', '책상 경로');
  assert.equal((await gate('TodoWrite', { todos: [] })).behavior, 'allow', '경로 없는 도구');
});

test('permissionGate: shell 능력이 켜져도 셸 리터럴로 금고를 만지지 못한다(1차 방어)', async () => {
  const gate = makePermissionGate('my-co', 'crew-a', wsRoot);
  for (const cmd of ['echo \'{"bypass":true}\' > capabilities.json', 'cat connections.json',
    'python3 -c "open(\'capabilities.json\',\'w\')"', 'vi agents/crew-a.md']) {
    assert.equal((await gate('Bash', { command: cmd })).behavior, 'deny', cmd);
  }
  assert.equal((await gate('Bash', { command: 'ls vault/notes' })).behavior, 'allow', '무관한 명령은 통과');
});

test('isForbidden: 워크스페이스 직속 제어 파일은 금지 — 파일이 이미 있든 없든 동일', async () => {
  const f = makeIsForbidden(wsRoot);
  for (const name of CONTROL_FILES) {
    assert.equal(await f(join(wsRoot, name)), true, `${name} (미존재)`);
    await writeFile(join(wsRoot, name), '{}');
    assert.equal(await f(join(wsRoot, name)), true, `${name} (존재)`);
  }
  assert.equal(await f('capabilities.json'), true, '상대경로도 워크스페이스 기준');
  assert.equal(await f(join(wsRoot, 'vault', '..', 'capabilities.json')), true, '../ 정규화 후 직속');
});

test('isForbidden: 아직 없는 직속 도트파일도 금지 — 부모로 대체돼 검사가 불발되던 구멍', async () => {
  // 기존 테스트는 .secrets.json을 미리 만들고 검사해 이 경로를 못 봤다. 미존재 시 real이
  // 워크스페이스 루트 자체가 되어 "직속 파일" 판정이 통째로 건너뛰어졌다(자격 파일 심기 가능).
  const f = makeIsForbidden(wsRoot);
  assert.equal(await f(join(wsRoot, '.not-created-yet.json')), true, '미존재 도트파일');
  assert.equal(await f(join(APP_ROOT, 'src', 'no-such-file.mjs')), true, '미존재 앱 코드도 여전히 금지');
});

test('isForbidden: 크루 카드(agents/**)는 하위까지 금지 — update_profile 결재 우회 차단', async () => {
  const f = makeIsForbidden(wsRoot);
  assert.equal(await f(join(wsRoot, 'agents', 'crew-a.md')), true, '자기/동료 카드');
  assert.equal(await f(join(wsRoot, 'agents', 'sub', 'x.md')), true, '하위 경로도');
});

test('isForbidden: 직속 도트 "디렉토리" 하위도 금지 — 게이트웨이 큐 주입 차단', async () => {
  // 파일만 막으면 .gw-queue-*/ 하위가 빠져나가 드레이너가 크루가 넣은 항목을 그대로 처리한다.
  const f = makeIsForbidden(wsRoot);
  assert.equal(await f(join(wsRoot, '.gw-queue-tg', 'item.json')), true, '게이트웨이 큐 항목');
  assert.equal(await f(join(wsRoot, '.index.sqlite')), true, '기억 인덱스 DB');
  assert.equal(await f(join(wsRoot, '.sync-state.json')), true, '동기화 상태');
});

test('isForbidden: 파일시스템이 손질하는 이름 변형으로 우회하지 못한다', async () => {
  // Win32는 후행 점·공백을 잘라내고 NTFS는 ::$DATA를 본체에 쓴다 — 표기만 바꾼 이름이 같은 파일을
  // 덮는다. 대소문자 무시 FS도 마찬가지(미존재 파일은 realpath 정규화가 안 걸린다).
  const f = makeIsForbidden(wsRoot);
  for (const name of ['capabilities.json.', 'capabilities.json ', 'capabilities.json::$DATA',
    'CAPABILITIES.JSON', 'Mcp.Json', 'agents.']) {
    assert.equal(await f(join(wsRoot, name)), true, name);
  }
  assert.equal(await f(join(wsRoot, 'AGENTS.', 'x.md')), true, '제어 디렉토리 변형 하위');
  assert.equal(await f(join(wsRoot, 'vault', 'capabilities.json')), false, 'vault 안 동명 파일은 크루 것');
});

test('isForbidden: 크루의 책상은 그대로 열려 있다(회귀 없음)', async () => {
  const f = makeIsForbidden(wsRoot);
  for (const rel of [['vault', 'notes', 'memo.md'], ['skills', 'weekly.md'],
    ['vault', 'projects', 'a.md'], ['inbox', 'x.txt'], ['competitions', 'c1.json']]) {
    assert.equal(await f(join(wsRoot, ...rel)), false, rel.join('/'));
  }
  // chats/는 책상이 아니다 — 대화 정본이고 그 안의 user 항목이 다음 턴 컨텍스트로 재생된다
  assert.equal(await f(join(wsRoot, 'chats', 's1.json')), true, 'chats는 금고(가짜 사장 발화 주입 차단)');
  assert.equal(await f(wsRoot), false, '워크스페이스 루트 자체');
});

test('isForbidden: 워크스페이스 안 심링크로 제어 파일을 우회하지 못한다', async () => {
  const f = makeIsForbidden(wsRoot);
  await writeFile(join(wsRoot, 'capabilities.json'), '{}').catch(() => {});
  await symlink(join(wsRoot, 'capabilities.json'), join(wsRoot, 'vault', 'caps-link')).catch(() => {});
  assert.equal(await f(join(wsRoot, 'vault', 'caps-link')), true, '심링크 canonical 판정');
});

test('permissionGate: 능력 0인 크루가 제어 파일로 자가 승격하지 못한다(Write·Edit·Read 전부)', async () => {
  const caps = { fs: false, browser: false, shell: false, bypass: false };
  const gate = makePermissionGate('my-co', 'crew-a', wsRoot);
  const w = await gate('Write', { file_path: join(wsRoot, 'capabilities.json'), content: '{"shell":true,"bypass":true}' });
  assert.equal(w.behavior, 'deny', '능력 토글 자가 승격 — 이 게이트의 존재 이유');
  const e = await gate('Edit', { file_path: join(wsRoot, 'mcp.json'), old_string: 'a', new_string: 'b' });
  assert.equal(e.behavior, 'deny', 'MCP 서버 정의 = 임의 command 실행');
  const r = await gate('Read', { file_path: join(wsRoot, 'connections.json') });
  assert.equal(r.behavior, 'deny', '러너 자격 열람');
  const card = await gate('Write', { file_path: join(wsRoot, 'agents', 'crew-a.md'), content: '---\nname: x\n---\n' });
  assert.equal(card.behavior, 'deny', '카드 직접 수정 = 결재 우회');
  const desk = await gate('Write', { file_path: join(wsRoot, 'skills', 'note.md'), content: 'x' });
  assert.equal(desk.behavior, 'allow', '스킬 남기기는 설계된 기능 — 막으면 안 된다');
});

test('permissionGate: bypass가 켜져 있어도 제어 파일은 열리지 않는다', async () => {
  const caps = { fs: true, browser: true, shell: true, bypass: true };
  const gate = makePermissionGate('my-co', 'crew-a', wsRoot);
  const w = await gate('Write', { file_path: join(wsRoot, 'capabilities.json'), content: '{}' });
  assert.equal(w.behavior, 'deny', 'bypass = 결재 생략이지 회사 금고 해제가 아니다');
  const g = await gate('Glob', { path: wsRoot, pattern: join(wsRoot, 'approvals.json') });
  assert.equal(g.behavior, 'deny', 'Glob 패턴 경유 열람도 차단');
});

test('permissionGate: fs 능력이 켜져도 금지 구역 밖 일반 외부 경로는 기존대로 허용(회귀 없음)', async () => {
  const caps = { fs: true, browser: false, shell: false, bypass: false };
  const gate = makePermissionGate('my-co', 'crew-a', wsRoot);
  const outside = await mkdtemp(join(tmpdir(), 'argo-outside-'));
  const r = await gate('Write', { file_path: join(outside, 'report.md'), content: 'x' });
  assert.equal(r.behavior, 'allow', 'fs 능력의 목적(사용자 문서 접근)은 유지');
});
