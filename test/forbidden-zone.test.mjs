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

test('permissionGate: 하드 구역의 조상을 검색 루트로 줘도 재귀가 자격을 훑지 못한다', async () => {
  // #207 분리 검수 HIGH: Grep{path:~/.claude}는 deny인데 Grep{path:~}·{path:/}는 allow였다 —
  // 루트 "자체"만 isForbidden에 태우고 그 아래 재귀를 안 봐서, 묻는 방식에 따라 판정이 갈리고
  // ~/.claude.json(MCP env 토큰)의 내용이 검색 결과로 유출됐다. coversControl(회사 금고)과 같은
  // 조상 검사를 하드 구역에도 적용한다(isForbidden mode='sweep').
  const gate = makePermissionGate('my-co', 'crew-a', wsRoot);
  assert.equal((await gate('Grep', { pattern: 'sk-', path: homedir() })).behavior, 'deny', '홈 루트 재귀 = 자격 파일 조상');
  assert.equal((await gate('Grep', { pattern: 'sk-', path: '~' })).behavior, 'deny', '~ 리터럴 — coversControl은 틸드 미확장이라 못 잡던 형태');
  assert.equal((await gate('Grep', { pattern: 'sk-', path: '/' })).behavior, 'deny', "디스크 루트 — `${root}${sep}`='//' 합성으로 접두 비교가 불발되던 형태");
  assert.equal((await gate('Glob', { path: homedir(), pattern: '**/*.json' })).behavior, 'deny', 'Glob path 축도 동일(패턴 축은 아래 별도 테스트)');
  assert.equal((await gate('Grep', { pattern: 'x', path: dirname(APP_ROOT) })).behavior, 'deny', '앱 코드 루트의 조상');
  // 과차단 금지 — 하드 구역을 품지 않는 좁은 루트와 단일 파일 읽기는 그대로 열려 있다.
  // (재귀 루트만 조상 판정을 받는다 — Read까지 sweep을 태우면 홈의 정당한 문서 읽기가 죽는다.)
  assert.equal((await gate('Grep', { pattern: 'x', path: join(homedir(), 'Documents') })).behavior, 'allow', '홈 하위 구체 폴더 검색은 유지');
  assert.equal((await gate('Read', { file_path: join(homedir(), 'notes.txt') })).behavior, 'allow', '홈 직속 일반 파일 단일 읽기는 유지');
});

test('permissionGate: Glob 절대 패턴은 path를 무시하고 재루팅된다 — 열거 베이스도 루트와 같은 판정', async () => {
  // 벤더 실독(claude-agent-sdk 0.3.206에 임베디드된 Claude Code 2.1.206): 절대 패턴이면 {baseDir, relativePattern}으로 갈라
  // baseDir로 재루팅 + 기본 --hidden|--no-ignore. path가 안전해도 패턴만으로 하드존 도트파일 "이름"
  // 열거가 실재한다(#207 후속 검수 MEDIUM-1 — 내용은 Read/Grep 하드라인이 막고 있어 이름 축).
  const gate = makePermissionGate('my-co', 'crew-a', wsRoot);
  const vault = join(wsRoot, 'vault');
  assert.equal((await gate('Glob', { path: vault, pattern: join(homedir(), '**', '*.json') })).behavior, 'deny', '홈 재귀 패턴');
  assert.equal((await gate('Glob', { path: vault, pattern: join(homedir(), '.claude*') })).behavior, 'deny', '하드존 형제 접두 와일드카드 — insideFold·homeVariant 다 못 잡던 형태');
  assert.equal((await gate('Glob', { path: vault, pattern: '/**/*.json' })).behavior, 'deny', '디스크 루트 베이스');
  assert.equal((await gate('Glob', { path: vault, pattern: join(WS_ROOT, '*', '**') })).behavior, 'deny', 'WS_ROOT 베이스 — 타사 이름 열거');
  const out = await mkdtemp(join(tmpdir(), 'argo-gp-'));
  assert.equal((await gate('Glob', { path: out, pattern: join(wsRoot, '**') })).behavior, 'deny', '밖 path + 워크스페이스 재귀 패턴 — denyScope의 패턴 우회 봉인');
  // 과차단 금지 — 좁은 베이스·상대 패턴·매직 없는 점조회는 유지
  assert.equal((await gate('Glob', { path: vault, pattern: join(homedir(), 'Documents', '**', '*.md') })).behavior, 'allow', '홈 하위 구체 베이스');
  assert.equal((await gate('Glob', { path: vault, pattern: '**/*.md' })).behavior, 'allow', '상대 패턴은 path 루트가 지배(재루팅 없음)');
  assert.equal((await gate('Glob', { path: vault, pattern: join(homedir(), 'Documents', 'a.md') })).behavior, 'allow', '매직 없어도 베이스가 좁으면 허용 — 과차단 아님');
  // 매직 없는 절대 패턴도 베이스를 태운다. "출력 1건 점조회"는 틀린 모델이었다(후속 검수 HIGH-2):
  // rg의 gitignore 의미상 구분자 없는 글롭은 임의 깊이 basename에 매치해 베이스 아래를 통째로 걷는다
  // (가짜 홈 실측: cwd=홈 + `--glob auth.json` → `.codex/auth.json`). 홈 순회는 Read 한 파일과 다른 급이다.
  assert.equal((await gate('Glob', { path: vault, pattern: join(homedir(), 'notes.txt') })).behavior, 'deny', '매직 없는 절대 패턴 = dirname 재루팅 → 홈 전체 순회');
  assert.equal((await gate('Glob', { path: vault, pattern: join(homedir(), 'auth.json') })).behavior, 'deny', '무구분자 basename 글롭이 하드존 내부(.codex/auth.json)를 반환하던 형태');
  // 백슬래시는 POSIX 구분자가 아니라 rg globset의 이스케이프 — 절단점을 '\\'로 잡으면 벤더 baseDir(홈)과
  // 어긋나 하드존이 통째로 빠져나갔다(후속 검수 HIGH-1, 실측 `--glob '.cla\ude*'` → `.claude.json`).
  assert.equal((await gate('Glob', { path: vault, pattern: `${homedir()}/.cla\\ude*` })).behavior, 'deny', '이스케이프로 절단점을 옮기는 우회');
  // 매직이 다음 구분자보다 앞에 오는 형태라야 베이스가 홈에 남는다(`.co\dex/*`처럼 매직 뒤에 오면
  // 벤더도 존재하지 않는 `.co\dex`로 재루팅돼 무해 — 벤더 분할과 어긋난 단언은 두지 않는다).
  assert.equal((await gate('Glob', { path: vault, pattern: `${homedir()}/.co\\dex*/**` })).behavior, 'deny', '이스케이프 + 하위 열거');
  assert.equal((await gate('Glob', { path: vault, pattern: ` ${homedir()}/**` })).behavior, 'deny', '선행 공백 — 루트와 같은 trim 기준');
});

test('isForbidden: sweep 모드만 조상을 금지한다 — read 판정은 넓어지지 않는다', async () => {
  // 방향이 둘인 불변식을 직접 고정: (a) sweep은 보호 구역의 조상이면 deny, (b) 같은 경로가
  // read로는 여전히 allow(홈이 금지 구역이 되는 게 아니다 — 재귀 "루트"로서만 막힌다).
  const f = makeIsForbidden(wsRoot);
  for (const root of [homedir(), '/', dirname(APP_ROOT)]) {
    assert.equal(await f(root, 'sweep'), true, `sweep: ${root}`);
  }
  assert.equal(await f(homedir()), false, 'read: 홈 경로 자체는 금지 구역이 아니다');
  assert.equal(await f(join(homedir(), 'Documents'), 'sweep'), false, 'sweep: 보호 구역을 품지 않는 루트는 통과');
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

/* ── 분리 검수 2026-07-30 반영 — 전부 행동 단언(게이트를 실제 실행해 판정을 본다) ── */

test('벤더 자격 하드라인: Read·Write·MCP·Bash 전부 같은 판정(deny) — 절대경로·틸드 양형태 정합', async () => {
  const gate = makePermissionGate('my-co', 'crew-a', wsRoot);
  for (const dir of ['.codex', '.claude', '.gemini']) {
    // 절대경로와 틸드 두 형태 모두 — 절대경로만 단언하면 "정합 달성"이 거짓 확신이 된다(재검수 HIGH:
    // ~ 미확장으로 `~/.codex/...`가 워크스페이스 상대경로로 오해석돼 4경로 전부 allow였다).
    for (const p of [join(homedir(), dir, 'auth.json'), `~/${dir}/auth.json`]) {
      assert.equal((await gate('Read', { file_path: p })).behavior, 'deny', `Read ${p}`);
      assert.equal((await gate('Write', { file_path: p, content: 'x' })).behavior, 'deny', `Write ${p}`);
      assert.equal((await gate('mcp__fs__read', { path: p })).behavior, 'deny', `MCP ${p}`);
      assert.equal((await gate('Bash', { command: `cat ${p}` })).behavior, 'deny', `Bash ${p}`);
    }
  }
});

test('홈 직속 자격 파일 하드라인: ~/.claude.json·~/.mcp.json도 4경로 전부 deny(디렉터리 접두 비교의 사각)', async () => {
  // 실측(#191 분리 검수 INFO): 하드라인이 디렉터리 접두 비교라 `~/.claude/.credentials.json`은 deny인데
  // 홈 **직속** `~/.claude.json`은 ALLOW였다 — Read/Write/MCP allow, Bash만 deny(`.claude` 부분문자열
  // 우연)로 도구별 판정이 갈렸다. 이 파일은 호스트 MCP 서버 정의를 env(토큰)까지 담는 자격이다.
  const gate = makePermissionGate('my-co', 'crew-a', wsRoot);
  const f = makeIsForbidden(wsRoot);
  for (const base of ['.claude.json', '.mcp.json']) {
    // 절대경로·틸드 두 형태 모두 — 한쪽만 단언하면 "정합 달성"이 거짓 확신이 된다(#192 교훈)
    for (const p of [join(homedir(), base), `~/${base}`]) {
      assert.equal((await gate('Read', { file_path: p })).behavior, 'deny', `Read ${p}`);
      assert.equal((await gate('Write', { file_path: p, content: 'x' })).behavior, 'deny', `Write ${p}`);
      assert.equal((await gate('mcp__fs__read', { path: p })).behavior, 'deny', `MCP ${p}`);
      assert.equal((await gate('Bash', { command: `cat ${p}` })).behavior, 'deny', `Bash ${p}`);
    }
    assert.equal(await f(join(homedir(), base)), true, `isForbidden ${base}`);
  }
  // 무관 파일로 번지지 않는다 — 하드라인은 이 두 파일과 그 접미 변종(.backup 등, 아래 테스트)이지
  // `~/.claude*` 통글롭이 아니다. `.claude-other.json`은 `.claude.json` 접두가 아니라서 판정 밖이다.
  // (Bash는 `.claude` 리터럴 부분문자열로 여전히 과차단 — 셸 1차 방어의 기존 fail-closed 성질이다.)
  assert.equal((await gate('Read', { file_path: join(homedir(), '.claude-other.json') })).behavior, 'allow',
    '이름이 비슷한 무관한 홈 파일은 그대로 허용(과차단 회귀 방지)');
});

test('홈 직속 자격 파일의 접미 변종도 하드라인: .claude.json.backup·.mcp.json.bak 전 도구 deny', async () => {
  // #196 통합 검수 실측: 이 맥 홈에 ~/.claude.json.backup이 실재(본체와 거의 같은 크기 = 같은 MCP
  // env 토큰)한데, insideFold(정확 일치/하위 접두)라 별개 형제 경로인 변종은 Read/Write/MCP allow —
  // Bash만 `.claude` 부분문자열로 우연히 deny로, "같은 파일을 도구별로 다르게 판정"(#196 HIGH)이
  // 이 파일에 잔존하던 사각. basename 접두 매칭(HARD_HOME_FILE_PREFIXES)으로 닫는다.
  const gate = makePermissionGate('my-co', 'crew-a', wsRoot);
  const f = makeIsForbidden(wsRoot);
  for (const name of ['.claude.json.backup', '.mcp.json.bak']) {
    // 절대경로·틸드 두 형태 모두 — 한쪽만 단언하면 "정합 달성"이 거짓 확신이 된다(#192 교훈)
    for (const p of [join(homedir(), name), `~/${name}`]) {
      assert.equal((await gate('Read', { file_path: p })).behavior, 'deny', `Read ${p}`);
      assert.equal((await gate('Write', { file_path: p, content: 'x' })).behavior, 'deny', `Write ${p}`);
      assert.equal((await gate('mcp__fs__read', { path: p })).behavior, 'deny', `MCP ${p}`);
      assert.equal((await gate('Bash', { command: `cat ${p}` })).behavior, 'deny', `Bash ${p}`);
    }
    assert.equal(await f(join(homedir(), name)), true, `isForbidden ${name}`);
  }
  // 과차단 경계 둘: ① 접두가 아닌 무관 홈 파일은 그대로 allow ② 홈 "직속"만 — 하위 디렉터리의
  // 유사명 파일까지 넓히지 않는다(백업 폴더 등 정당한 사용자 데이터).
  assert.equal((await gate('Read', { file_path: join(homedir(), '.claude-other.json') })).behavior, 'allow',
    '접두 불일치 홈 파일은 허용 유지(과차단 회귀 방지)');
  assert.equal(await f(join(homedir(), 'argo-fz-subdir', '.claude.json.backup')), false,
    '홈 직속이 아닌 하위 디렉터리 유사명은 판정 밖(과차단 금지)');
});

test('chats/ Bash: 토큰 시작 경계에서만 deny — URL·하위 데이터 경로는 오차단하지 않는다(재검수 MEDIUM)', async () => {
  const gate = makePermissionGate('my-co', 'crew-a', wsRoot);
  assert.equal((await gate('Bash', { command: 'cat chats/crew-a.json' })).behavior, 'deny');
  assert.equal((await gate('Bash', { command: 'cat ./chats/crew-a.json' })).behavior, 'deny', './ 접두 우회');
  assert.equal((await gate('Bash', { command: `echo '{"who":"user"}' >> chats/beast.json` })).behavior, 'deny',
    'who:user 주입 = 결재 없는 동료 지시 + 사장 이력 위조(파일 헤더 주석의 위협 그대로)');
  // 공백 없는 리다이렉트 — 위조 명령의 가장 자연스러운 형태(재검수 3R: 경계 클래스에 <>, 누락)
  assert.equal((await gate('Bash', { command: `echo '{"who":"user"}' >chats/beast.json` })).behavior, 'deny', '>chats/ 리다이렉트');
  assert.equal((await gate('Bash', { command: 'cat <chats/beast.json' })).behavior, 'deny', '<chats/ 입력 리다이렉트');
  // 오차단이던 정상 명령 — 크루가 "API 호출이 보호 구역에 막혔다"는 거짓 설명을 하게 됐다
  assert.equal((await gate('Bash', { command: 'curl -s https://api.example.com/v1/chats/123' })).behavior, 'allow', 'URL 경로');
  assert.equal((await gate('Bash', { command: 'ls vault/chats/' })).behavior, 'allow', '책상 하위 데이터');
  assert.equal((await gate('Bash', { command: 'npx playwright test tests/agents/spec.ts' })).behavior, 'allow', '하위 디렉토리 경로');
});

test('보호구역 안→밖 심링크: canonical이 밖을 가리켜도 렉시컬 fail-closed로 deny', async () => {
  // 조달이 만드는 ~/.argo/codex-home/auth.json → ~/.codex/auth.json 계열. appRoot를 주입해 재현한다.
  const hardTmp = await mkdtemp(join(tmpdir(), 'argo-hardroot-'));
  const outside = await mkdtemp(join(tmpdir(), 'argo-linktarget-'));
  await writeFile(join(outside, 'secret.txt'), 's');
  await symlink(join(outside, 'secret.txt'), join(hardTmp, 'link.txt')).catch(() => {});
  const { makeIsForbidden: mk } = await import('../src/permission-gate.mjs');
  const f = mk(wsRoot, hardTmp);
  assert.equal(await f(join(hardTmp, 'link.txt')), true, '안→밖 심링크 — canonical만 보면 빠져나간다');
  assert.equal(await f(join(hardTmp, 'no-such.txt')), true, '미존재 하위도 렉시컬로 deny');
});

test('MCP 단일 토큰 인자: 키∪값 합집합 — 일반 단어만 통과, 금고 특정 값은 키와 무관하게 판정(재검수 3R)', async () => {
  const gate = makePermissionGate('my-co', 'crew-a', wsRoot);
  // 오차단이던 무해 인자 — "agents"는 태그·채널명·검색어로 흔하다(비경로 키 + 제어 "디렉터리" 단어)
  assert.equal((await gate('mcp__x__y', { note: 'agents' })).behavior, 'allow');
  assert.equal((await gate('mcp__notion__q', { query: 'usage' })).behavior, 'allow');
  assert.equal((await gate('mcp__x__y', { note: 'capabilities.json 이 뭔가요?' })).behavior, 'allow', '문장은 정확 일치가 아니다');
  // 값 기준(제어·원장 파일명·도트 접두)은 **키와 무관** — 키만 보면 {to:'mcp.json'}(mcp__fs__move의
  // {from,to} 시그니처)로 MCP 정의 덮어쓰기 = 임의 command가 열린다(재검수 3R 실측 12케이스).
  assert.equal((await gate('mcp__x__y', { to: 'mcp.json' })).behavior, 'deny', '비경로 키 + 제어 파일명');
  assert.equal((await gate('mcp__x__y', { key: 'company.json' })).behavior, 'deny', '키 이름과 무관 — 값이 제어 파일명이면 막는다');
  assert.equal((await gate('mcp__x__y', { p: '.secrets.json' })).behavior, 'deny', '도트 접두는 키와 무관');
  // 경로형 키의 단일 토큰은 제어 디렉터리까지 판정({path:'agents'}로 agents "파일"을 만들면
  // 스캐폴드 전 회사의 크루 카드 디렉터리 생성이 막힌다)
  assert.equal((await gate('mcp__x__y', { path: 'capabilities.json' })).behavior, 'deny');
  assert.equal((await gate('mcp__x__y', { path: 'agents' })).behavior, 'deny', '제어 디렉터리 — 경로형 키');
  assert.equal((await gate('mcp__x__y', { target: 'chats' })).behavior, 'deny');
  assert.equal((await gate('MultiEdit', { file_path: 'agents', edits: [] })).behavior, 'deny', '미분류 도구도 동일');
  // 구분자·틸드 동반 값은 키와 무관하게 전체 판정
  assert.equal((await gate('mcp__x__y', { p: 'agents/crew-a.md' })).behavior, 'deny', '구분자 동반은 전체 판정');
  assert.equal((await gate('mcp__x__y', { paths: ['capabilities.json'] })).behavior, 'deny', '배열 원소는 배열 키를 상속');
  assert.equal((await gate('mcp__x__y', { path: 'capabilities.json\n' })).behavior, 'deny', '앞뒤 개행은 trim 후 판정(검수 LOW)');
});

test('SDK allowedTools 불변식: bare mcp__는 자체 크루 서버뿐 + 동결(런타임 오염 차단)', async () => {
  // SDK는 bare `mcp__<서버>` 항목을 canUseTool 상담 전에 자동 승인한다(벤더 계약,
  // CLAUDE_SDK_CAN_USE_TOOL_SHADOWED). 외부 MCP가 여기 실리면 위 argPathsForbidden 방어가 통째로
  // 도달 불가가 된다 — mcpAllow 죽은 변수를 되살리는 회귀를 이 단언이 잡는다(검수 MEDIUM).
  const { SDK_ALLOWED_TOOLS } = await import('../src/chat.mjs');
  const bare = SDK_ALLOWED_TOOLS.filter((t) => /^mcp__/.test(t));
  assert.deepEqual(bare, ['mcp__crew'], `외부 MCP가 allowedTools에 실렸다: ${bare.join(', ')}`);
  // 동결 — 모듈 공유 배열이라 push 한 번의 오염이 프로세스 수명 내내 전 회사·전 턴에 번진다(재검수)
  assert.equal(Object.isFrozen(SDK_ALLOWED_TOOLS), true, 'CAPABILITIES와 같은 동결 계약');
  assert.throws(() => { SDK_ALLOWED_TOOLS.push('mcp__evil'); }, /frozen|read only|not extensible|Cannot add/i);
});

// ── nft 홈 글롭 트립와이어(v0.1.35 릴리스 CI 실측) ─────────────────────────────────
// permission-gate가 node:os를 임포트해 homedir()를 동적 join에 쓰면 Next 추적기가 홈 루트를
// 통글롭해 Windows 릴리스 빌드가 죽는다(WindowsApps EACCES — v0.1.30 chat.mjs 불변식과 동일).
// 홈은 env(HOME/USERPROFILE)로만. 이 단언은 임포트 자체를 금지한다(코멘트 언급은 무해).
test('트립와이어: permission-gate는 node:os를 임포트하지 않는다(nft 홈 글롭 방지)', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/permission-gate.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from 'node:os'/, 'env 홈(homeDir)만 허용 — 되돌리면 Windows 릴리스 빌드가 깨진다');
});

test('env 홈 부재 시 틸드 경로는 fail-closed(deny) — 확장 불가 = 판정 불가', async () => {
  const wsRoot = await mkdtemp(join(tmpdir(), 'argo-fz-home-'));
  const H = process.env.HOME, U = process.env.USERPROFILE;
  delete process.env.HOME; delete process.env.USERPROFILE;
  try {
    const f = makeIsForbidden(wsRoot);
    assert.equal(await f('~/.codex/auth.json'), true, '홈 미상 틸드는 deny');
    assert.equal(await f('~'), true);
    assert.equal(await f(join(wsRoot, 'vault', 'note.md')), false, '일반 경로 판정은 유지');
  } finally {
    if (H !== undefined) process.env.HOME = H;
    if (U !== undefined) process.env.USERPROFILE = U;
  }
});
