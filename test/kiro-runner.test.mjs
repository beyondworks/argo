// Kiro 러너(BYOA 3호) — 카탈로그·인증 방식·디스패치·답변 추출·경계 집행 회귀 테스트.
//
// 배경: kiro-cli(AWS Kiro CLI)는 IAM Identity Center / Builder ID 로그인을 쓰고 붙여넣을 API 키
// 표면이 없다 — codex·antigravity와 같은 CLI 래핑 + host 옵트인 전용. antigravity와 갈리는 두 점을
// 이 파일이 잠근다: ① 자격을 `whoami`로 **실측**하므로 낙관 authed(authUnknown)가 아니다
// ② 파일 반경을 강제할 수단이 없어 집행이 **불변 경계 deny**뿐이다(정직 표기 대상).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, access, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RUNNERS, RUNNER_AUTH, isCliRunner, apiError,
  kiroScrub, kiroTools, kiroEffortArgs, kiroDeniedPaths, writeKiroTurnAgent, removeKiroTurnAgent,
} from '../src/runners.mjs';
import { PICK_ORDER } from '../app/runner-usable.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const exists = (p) => access(p).then(() => true, () => false);

test('카탈로그 — kiro는 kind cli, 첫 모델은 계정 무관 기본값(auto)', () => {
  const r = RUNNERS.kiro;
  assert.ok(r, 'RUNNERS.kiro가 없다');
  assert.equal(r.kind, 'cli');
  assert.equal(r.name, 'Kiro');
  assert.ok(r.models.length >= 5, '--list-models 실측 목록이 비었다');
  // models[0]은 러너 전환·모델 미지정의 기본값 — 권한·잔액에 의존하는 모델을 앞에 두면 신규
  // 계정의 영입·기억정리가 이유 없이 죽는다(gemini gated·openrouter 402 선례와 같은 원칙).
  assert.equal(r.models[0].id, 'auto', 'kiro-cli 자신의 기본값(auto)이 첫 항목이어야 한다');
  assert.ok(!r.models.some((m) => m.gated), '게이트 모델은 등재하지 않았다(실턴 통과분만)');
});

test('인증 방식 — 호스트 로그인 옵트인 전용(붙여넣을 키 표면이 없다)', () => {
  const a = RUNNER_AUTH.kiro;
  assert.deepEqual(a.methods, ['oauth']);
  assert.equal(a.oauthPasteable, false, 'CLI 로그인 자격은 붙여넣을 수 없다');
  assert.ok(a.hostUsable, '호스트 옵트인이 유일한 연결 경로다');
  assert.ok(!a.webConnect, '웹 브리지는 아직 없다 — 생기면 webauth 배관과 함께 검토');
  // connect(로그인 대행)를 두지 않은 이유: `kiro-cli login`이 라이선스·IdP를 되묻는 대화형일 수
  // 있어(미검증) detached spawn이 조용히 멈춘다. 붙이려면 statusArgs의 ok 정규식이 반드시
  // 줄머리 앵커여야 한다 — 아래 테스트가 그 함정을 잠근다.
  assert.ok(!a.connect, 'connect를 붙였다면 whoami 오판정 테스트를 함께 갱신해야 한다');
});

test('자격 판정 함정 — /Logged in/i는 "Not logged in"에도 매칭된다(줄머리 앵커 필수)', () => {
  // 실측 2026-08-12: 미로그인 whoami stdout = "Not logged in". codex가 쓰는 느슨한 정규식을
  // 그대로 재사용하면 **미로그인을 연결됨으로 뒤집는다** — 한 글자(^) 차이가 보안 표면이다.
  assert.match('Not logged in', /Logged in/i, '느슨판은 미로그인도 통과한다(이게 함정의 실체)');
  assert.doesNotMatch('Not logged in', /^Logged in/im, '앵커판은 미로그인을 걸러낸다');
  assert.match('Logged in with IAM Identity Center (https://example.awsapps.com/start/)', /^Logged in/im);
  // 배선 — 감지 코드가 앵커판을 쓰는지 소스로 잠근다(순수 함수가 맞아도 호출부가 느슨하면 무의미).
  assert.match(read('src/runners/exec.mjs'), /\/\^Logged in\/im\.test/, 'detectRunners가 앵커판을 쓰지 않는다');
});

test('디스패치 — isCliRunner가 카탈로그 kind 기준으로 kiro를 CLI로 본다', () => {
  assert.equal(isCliRunner('kiro'), true);
  assert.equal(isCliRunner('claude'), false);
});

test('자동 선택 순서 — PICK_ORDER는 RUNNER_AUTH 정의 순과 일치한다', () => {
  assert.deepEqual(PICK_ORDER, Object.keys(RUNNER_AUTH));
});

test('연결 UI — RUNNER_ORDER·RUNNER_NAMES에 kiro가 있다', () => {
  const src = read('app/runner-connect.jsx');
  assert.match(src.match(/RUNNER_ORDER = \[([^\]]*)\]/)[1], /'kiro'/);
  assert.match(src, /kiro: 'Kiro'/);
});

test('감지 — kiro는 낙관 authed가 아니다(authUnknown 미사용)', () => {
  // antigravity는 키링이라 authed=installed(낙관)이고 UI가 '확인 불가'를 그린다. kiro는 whoami로
  // 실측하므로 그 완충이 필요 없다 — 낙관값이 아니라는 사실이 RUNNER_AUTH 배치(맨 끝 아님)의 근거다.
  const src = read('src/runners/exec.mjs');
  const line = src.split('\n').find((l) => /^\s*kiro: \{ installed:/.test(l));
  assert.ok(line, 'detectRunners에 kiro 항목이 없다');
  assert.doesNotMatch(line, /authUnknown/, 'kiro에 authUnknown이 붙었다 — 실측 authed와 모순');
  assert.match(line, /&& kiroAuth/, 'authed가 whoami 결과를 요구하지 않는다(설치만으로 연결됨이 된다)');
});

test('에러 매핑 — 미로그인 OAuth 타임아웃이 로그인 안내로 번역된다(kiro 한정)', () => {
  // 격리 HOME 실측 2026-08-12: 비대화에서도 브라우저를 열려 시도하고 아무도 승인하지 않아
  // stderr `error: OAuth error: Auth portal timed out`(exit 1). stdout엔 스피너만.
  const e = Object.assign(new Error('cmd failed'), { stdout: 'Opening browser...', stderr: 'error: OAuth error: Auth portal timed out', code: 1 });
  const mapped = apiError(e, 'kiro');
  assert.match(mapped.message, /kiro-cli login/, '로그인 처방이 없다');
  // AUTH_ERR_RE(chat.mjs) 계약 — 이 표현이 자가치유(남은 가용 러너 순차 폴백)를 발화시킨다.
  assert.match(mapped.message, /not logged in/i, 'AUTH_ERR_RE가 잡을 표현이 없다 — 자가치유 소실');
});

test('에러 매핑 — 같은 문구라도 다른 러너(stdout 오염)는 오분류하지 않는다', () => {
  // 크루가 셸로 실행한 명령 출력에 같은 문구가 섞인 codex 실패 — 벤더 원인이 보존돼야 한다
  // (antigravity M1과 같은 클래스의 방어).
  const e = Object.assign(new Error('x'), {
    stdout: '$ some-tool\nerror: OAuth error: Auth portal timed out\n', stderr: '{"message":"invalid api key"}', code: 1,
  });
  const mapped = apiError(e, 'codex');
  assert.doesNotMatch(mapped.message, /kiro-cli login/, 'codex 실패가 Kiro 문구로 오분류됐다');
  assert.match(mapped.message, /invalid api key/i, '벤더 원인이 지워졌다 — 자가치유 소실');
});

test('답변 추출 — 도구 추적을 걷고 마지막 어시스턴트 블록만 남긴다', () => {
  // kiro-cli는 어시스턴트 메시지 **첫 줄에만** '> '를 붙인다(도구 추적 줄은 무접두사) — 실측 형상.
  const out = [
    '\u001B[m> \u001B[0mI\u2019ll create the file.',
    'I\u2019ll create the following file: ./note.txt (using tool: write)',
    '+    1: HELLO',
    'Creating: ./note.txt',
    ' - Completed in 0.0s',
    '',
    '> FILE: note.txt',
    'CONTENT: HELLO',
    'STATUS: DONE',
  ].join('\n');
  assert.equal(kiroScrub(out), 'FILE: note.txt\nCONTENT: HELLO\nSTATUS: DONE');
});

test('답변 추출 — 마크다운 인용은 접두사와 충돌하지 않는다(렌더러가 │ 로 그린다)', () => {
  // 실측: 모델이 '> quoted'를 내면 렌더 결과는 '│ quoted'다. 그래서 인용이 있는 답변이
  // 인용 줄에서 절단되지 않는다 — 이 계약이 깨지면(렌더러 변경) 답변 앞부분이 조용히 사라진다.
  assert.equal(kiroScrub('> Intro line.\n\u2502 quoted one\n\u2502 quoted two\nEnd line.'),
    'Intro line.\n\u2502 quoted one\n\u2502 quoted two\nEnd line.');
});

test('답변 추출 — 접두사가 없으면 전문을 반환한다(조용한 빈 답변 금지)', () => {
  // 미래 렌더러 변경·예상 외 형식에서 통삭제로 정상 응답을 지우는 방향(gemini 스크럽 선례)을 막는다.
  assert.equal(kiroScrub('plain answer\nsecond line'), 'plain answer\nsecond line');
  assert.equal(kiroScrub(''), '');
  assert.equal(kiroScrub(null), '');
});

test('추론 강도 — 아는 값만 넘긴다(미지값은 인자 오류로 턴을 죽인다)', () => {
  assert.deepEqual(kiroEffortArgs('high'), ['--effort', 'high']);
  assert.deepEqual(kiroEffortArgs('max'), ['--effort', 'max']);
  assert.deepEqual(kiroEffortArgs(''), []);
  assert.deepEqual(kiroEffortArgs('turbo'), []);
  assert.deepEqual(kiroEffortArgs(undefined), []);
});

test('능력 게이트 fail-closed — caps 미전달이면 셸·브라우저가 꺼진다', () => {
  // oneshot(영입·기억 정리)은 caps를 전달하지 않는다 — fail-open이면 그 경로만 셸 무제한이 된다
  // (codex 상시 샌드박스·antigravity --sandbox와 같은 방향).
  assert.deepEqual(kiroTools(null).tools, ['read', 'write', 'grep', 'glob']);
  assert.ok(!kiroTools(null).tools.includes('shell'));
  assert.ok(kiroTools({ shell: true }).tools.includes('shell'));
  assert.ok(kiroTools({ browser: true }).tools.includes('web_fetch'));
  // 비대화에서는 포괄 신뢰가 없으면 도구 호출이 전부 거부된다(실측) — allowedTools는 tools와 같아야 한다.
  const t = kiroTools({ shell: true, browser: true });
  assert.deepEqual(t.allowedTools, t.tools, 'allowedTools가 tools와 다르면 비대화 턴에서 도구가 거부된다');
});

test('불변 경계 — 앱 루트·홈 자격·형제 회사·직속 도트·회사 금고가 deniedPaths에 실린다', async () => {
  // CLI 러너는 프로세스 단위라 도구 게이트(permission-gate)를 지나지 않는다. kiro는 반경 화이트리스트를
  // 표현할 수 없어(실측) **불변 경계 deny**가 집행의 전부다 — 그래서 이 목록이 곧 보안 경계다.
  const wsRoot = await mkdtemp(join(tmpdir(), 'argo-kiro-ws-'));
  const mine = join(wsRoot, 'acme');
  const other = join(wsRoot, 'other-co');
  await mkdir(mine, { recursive: true });
  await mkdir(other, { recursive: true });
  const appRoot = join(wsRoot, 'fake-app-root');
  const { read, write } = await kiroDeniedPaths(mine, appRoot);

  assert.ok(read.includes(`${appRoot}/**`), '실행 중인 Argo 코드 루트가 열려 있다');
  assert.ok(read.includes(`${other}/**`), '다른 회사 데이터가 열려 있다(교차 테넌트)');
  assert.ok(read.includes(join(mine, '.*')), '회사 금고 직속 도트(자가 승격 경로)가 열려 있다');
  assert.ok(read.includes(join(wsRoot, '.*')), 'WS_ROOT 직속 도트(계정 시크릿)가 열려 있다');
  // 자기 회사 폴더 자체는 막지 않는다 — 크루의 책상이다(WS_ROOT를 통째로 deny하면 여기가 죽는다).
  assert.ok(!read.includes(`${mine}/**`), '자기 회사 폴더가 deny에 들어갔다 — 크루가 일할 곳이 없다');
});

test('불변 경계 — permission-gate의 하드 차단 목록과 정합한다(도구별 판정 갈림 방지)', async () => {
  // 같은 파일을 SDK 러너는 deny하고 kiro는 allow하면 러너에 따라 자격 유출 여부가 갈린다.
  // permission-gate.mjs의 상수를 소스에서 읽어 대조한다 — 한쪽만 늘어나면 이 테스트가 잡는다.
  const gate = read('src/permission-gate.mjs');
  const hardBlock = (gate.match(/const HARD_HOME_PATHS = \[([\s\S]*?)^\];/m) ?? [])[1] ?? '';
  const fileBlock = (gate.match(/const HARD_HOME_FILE_PREFIXES = \[([^\]]*)\]/) ?? [])[1] ?? '';
  const hardHome = [...`${hardBlock}${fileBlock}`.matchAll(/'(\.[^']+)'/g)].map((m) => m[1]);
  const ctlFiles = (gate.match(/const WS_CONTROL_FILES = new Set\(\[([\s\S]*?)\]\)/) ?? [])[1] ?? '';
  const ctlDirs = (gate.match(/const WS_CONTROL_DIRS = new Set\(\[([^\]]*)\]\)/) ?? [])[1] ?? '';
  const ledgers = (gate.match(/const WS_LEDGER_FILES = new Set\(\[([\s\S]*?)\]\)/) ?? [])[1] ?? '';

  const wsRoot = await mkdtemp(join(tmpdir(), 'argo-kiro-gate-'));
  const cwd = join(wsRoot, 'acme');
  await mkdir(cwd, { recursive: true });
  const { read: rd, write: wr } = await kiroDeniedPaths(cwd, join(wsRoot, 'app'));

  assert.ok(hardHome.length >= 4, `permission-gate 하드 홈 목록 파싱 실패(${hardHome.length}건)`);
  for (const d of hardHome) {
    assert.ok(rd.some((p) => p.endsWith(d)), `홈 자격 ${d}가 kiro deny에 없다 — 러너별 판정 갈림`);
  }
  for (const m of ctlFiles.matchAll(/'([^']+)'/g)) {
    assert.ok(rd.some((p) => p.endsWith(m[1])), `회사 금고 ${m[1]}가 kiro deny에 없다`);
  }
  for (const m of ctlDirs.matchAll(/'([^']+)'/g)) {
    assert.ok(rd.some((p) => p.endsWith(m[1])), `금고 디렉터리 ${m[1]}가 kiro deny에 없다`);
  }
  // 원장은 **쓰기만** 막는다 — permission-gate와 같은 근거(사용액 조회 기능을 죽이지 않는다).
  for (const m of ledgers.matchAll(/'([^']+)'/g)) {
    assert.ok(wr.some((p) => p.endsWith(m[1])), `원장 ${m[1]}가 write deny에 없다`);
    assert.ok(!rd.some((p) => p.endsWith(m[1])), `원장 ${m[1]}가 read까지 막혔다 — 사용액 조회 기능 후퇴`);
  }
});

test('불변 경계 — raw·canonical 두 형태를 모두 싣는다(심링크 ARGO_ROOT 우회 차단)', async () => {
  // 분리 검수 CRITICAL 실증(2026-08-12): kiro-cli는 canonical 경로로 deny를 판정한다. raw만 실으면
  // 심링크 경유 ARGO_ROOT(맥의 /tmp·/var, 외장 볼륨·동기화 폴더가 흔하다)에서 경계가 통째로 열렸다 —
  // 형제 회사 파일과 WS_ROOT 직속 도트를 둘 다 읽는 것이 재현됐다. 공격이 아니라 **설정만으로** 열린다.
  const real = await mkdtemp(join(tmpdir(), 'argo-kiro-real-'));
  await mkdir(join(real, 'acme'), { recursive: true });
  await mkdir(join(real, 'other-co'), { recursive: true });
  const link = `${real}-link`;
  await symlink(real, link);
  const { read: rd } = await kiroDeniedPaths(join(link, 'acme'), join(real, 'app'));
  // 맥 tmpdir(/var/folders)는 그 자체가 /private/var 심링크다 — 기대값도 realpath로 계산한다.
  const canonReal = await realpath(real);

  assert.ok(rd.some((p) => p.startsWith(link) && p.includes('other-co')), '심링크 형태 형제 deny 누락');
  assert.ok(rd.some((p) => p.startsWith(canonReal) && !p.startsWith(link) && p.includes('other-co')),
    'canonical 형태 형제 deny 누락 — 심링크 ARGO_ROOT에서 경계가 조용히 열린다');
  assert.ok(rd.some((p) => p === join(link, '.*')) && rd.some((p) => p === join(canonReal, '.*')),
    'WS_ROOT 직속 도트가 두 형태로 실리지 않았다');
});

test('불변 경계 — WS_ROOT를 못 읽어도 앱 루트·도트 방어는 남는다(fail-safe 방향)', async () => {
  const gone = join(tmpdir(), 'argo-kiro-nonexistent', 'acme');
  const { read: rd } = await kiroDeniedPaths(gone, '/tmp/app');
  assert.ok(rd.includes('/tmp/app/**'), '형제 열거 실패가 다른 방어까지 지웠다');
  assert.ok(rd.includes(join(gone, '.*')));
});

test('턴별 에이전트 설정 — 경계·격리가 실제로 파일에 실리고 턴 뒤 지워진다', async () => {
  const wsRoot = await mkdtemp(join(tmpdir(), 'argo-kiro-turn-'));
  const cwd = join(wsRoot, 'acme');
  await mkdir(cwd, { recursive: true });
  const name = 'argo-test01';
  await writeKiroTurnAgent(cwd, { caps: { fs: true, shell: false }, name });
  const file = join(cwd, '.kiro', 'agents', `${name}.json`);
  const cfg = JSON.parse(await readFile(file, 'utf8'));

  assert.equal(cfg.name, name);
  assert.ok(!cfg.tools.includes('shell'), '셸 능력이 꺼졌는데 도구가 실렸다');
  assert.deepEqual(cfg.allowedTools, cfg.tools);
  assert.ok(cfg.toolsSettings.read.deniedPaths.length, 'read 경계가 비었다');
  assert.ok(cfg.toolsSettings.write.deniedPaths.length, 'write 경계가 비었다');
  // 원장은 쓰기만 추가로 막힌다 — write 목록이 read보다 커야 한다(permission-gate와 같은 근거).
  assert.ok(cfg.toolsSettings.write.deniedPaths.length > cfg.toolsSettings.read.deniedPaths.length,
    'write 경계가 read와 같다 — 원장 쓰기 차단이 빠졌다');
  // 전역 설정 격리 — 사용자 MCP 서버가 매 턴 로드되며 크루에게 의도 밖 도구를 준다(실측: 경고 발생).
  assert.deepEqual(cfg.mcpServers, {}, '전역 MCP 격리가 풀렸다');
  assert.equal(cfg.useLegacyMcpJson, false, '레거시 MCP json 상속이 열렸다');

  await removeKiroTurnAgent(cwd, name);
  assert.equal(await exists(file), false, '턴 잔재가 회사 금고에 남았다');
});

test('배선 — externalExec가 턴별 설정을 쓰고 finally에서 지운다', () => {
  // 순수 함수가 맞아도 호출부가 빠지면 경계는 안 실린다(러너 중립성 HIGH-1의 교훈).
  // 고유 이름도 함께 잠근다: 고정 이름이면 같은 회사 동시 턴에서 한쪽 finally가 다른 쪽 설정을 지운다.
  const src = read('src/runners.mjs');
  assert.match(src, /await writeKiroTurnAgent\(cwd, \{ caps, name \}\)/, 'kiro 턴별 설정 배선이 없다');
  assert.match(src, /randomUUID\(\)\.slice\(0, 8\)/, '턴 고유 이름이 아니다 — 동시 턴 경합');
  assert.match(src, /finally \{\s*\n\s*await removeKiroTurnAgent\(cwd, name\)/, 'finally 정리 배선이 없다');
  assert.match(src, /return kiroScrub\(stdout\)/, '최종 답변 추출이 배선되지 않았다');
});

test('러너 열거 안내 문구에 Kiro가 빠지지 않았다(전수 수색 규칙)', () => {
  for (const f of ['src/chat.mjs', 'src/oneshot.mjs', 'src/trial.mjs', 'src/persona.mjs']) {
    const src = read(f);
    for (const m of src.matchAll(/Claude[·, ]+Codex[·, ]+Gemini[^)\n']*/g)) {
      assert.ok(m[0].includes('Kiro'), `${f}의 러너 열거에 Kiro 누락: "${m[0].slice(0, 80)}"`);
    }
  }
});

test('정직 표기 — 폴더 안내가 kiro의 반경 미강제를 ko·en 양쪽에 명시한다', () => {
  // 이 러너만 지정 폴더가 반경으로 적용되지 않는다(실측: allowedPaths는 비대화에서 효력 0,
  // denyByDefault는 write 미지원, deny 글롭 부정 패턴 미지원). 화면이 이걸 말하지 않으면
  // 사장은 폴더를 좁게 지정하고 안전하다고 믿는다 — 거짓 유효 표기 금지 원칙(H1c 계열).
  const src = read('app/i18n.jsx');
  const line = src.split('\n').find((l) => l.includes("'settings.workroots.runnerNote'"));
  assert.ok(line, 'workroots 러너 안내 문자열이 없다');
  assert.match(line, /Kiro 크루는 예외/, '한국어 안내에 kiro 한계 표기가 없다');
  assert.match(line, /Kiro is the exception/, '영어 안내에 kiro 한계 표기가 없다');
});

test('격리 — 턴별 설정이 회사 금고 직속 도트라 크루가 스스로 못 고친다(자가 승격 차단)', async () => {
  // 크루가 `<cwd>/.kiro/agents/*.json`을 고쳐 다음 턴의 deniedPaths를 지우는 승격 경로를 막는다.
  const wsRoot = await mkdtemp(join(tmpdir(), 'argo-kiro-esc-'));
  const cwd = join(wsRoot, 'acme');
  await mkdir(cwd, { recursive: true });
  await writeFile(join(wsRoot, 'sentinel'), 'x');
  const { read: denied } = await kiroDeniedPaths(cwd, join(wsRoot, 'app'));
  const dotGlobs = denied.filter((p) => p.startsWith(join(cwd, '.*')));
  assert.ok(dotGlobs.length >= 2, '직속 도트 항목이 파일·하위 both로 막혀 있지 않다(.kiro/agents 하위가 열린다)');
});
