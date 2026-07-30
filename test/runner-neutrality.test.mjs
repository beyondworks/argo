// 러너 중립성 계약 — 유건 원칙(2026-07-30): 어떤 러너·모델을 쓰든 Argo 환경 사용에 편파·제약이
// 없어야 한다(모델 성능 차이만 예외). 여기서 잠그는 것은 **편향이 되살아나는 두 자리**다:
//  ① 파일 반경이 러너마다 갈리는 것(openRoots 단일 계산을 codex·gemini·antigravity가 공유)
//  ② 한 벤더가 죽으면 회사가 서는 것(자가치유가 죽은 러너를 누적 제외하며 남은 러너를 다 시도)
import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { openRoots } from '../src/workroots.mjs';
// 생산자(excludeWith)와 소비자(pickRunner)가 같은 모듈에 산다 — exclude 계약의 주인이 catalog다.
// (이전엔 excludeWith가 chat.mjs에 있어, 1줄 순수 함수를 쓰려고 에이전트 SDK 임포트 그래프를 통째로 끌었다)
import { excludeWith, pickRunner } from '../src/runners/catalog.mjs';

test('openRoots — 홈(fs 능력) + 지정 작업 폴더를 이 순서로 연다', () => {
  assert.deepEqual(openRoots({ fs: true }, ['/w1', '/w2']), [homedir(), '/w1', '/w2']);
  assert.deepEqual(openRoots({ fs: false }, ['/w1']), ['/w1']); // 지정 폴더는 fs 능력과 독립
  assert.deepEqual(openRoots({ fs: false }, []), []);
  assert.deepEqual(openRoots(null), []); // caps 미전달(oneshot 등)도 안전
});

// 세 CLI 러너가 **같은 계산**을 쓴다는 계약. 이게 갈리면 같은 지시가 러너에 따라 되고 안 되고가
// 갈린다(실사고 2026-07-30: gemini에 인자를 안 넘겨 크루 책상이 회사 폴더 하나로 쪼그라들었고,
// "이 컴퓨터 어디든 쓸 수 있다"는 프롬프트가 거짓이 됐다).
test('codex writable_roots가 openRoots와 같은 목록을 싣는다', async () => {
  const { codexSandboxArgs } = await import('../src/runners/codex.mjs');
  const args = codexSandboxArgs({ fs: true }, ['/w1']);
  const roots = openRoots({ fs: true }, ['/w1']);
  const line = args.find((a) => String(a).startsWith('sandbox_workspace_write.writable_roots'));
  assert.ok(line, 'writable_roots 인자가 있어야 한다');
  for (const r of roots) assert.ok(line.includes(JSON.stringify(r)), `${r}가 writable_roots에 있어야 한다`);
});

test('pickRunner — exclude 목록을 받아 남은 러너를 고른다(자가치유 누적 제외)', () => {
  const on = { company: { connected: true, invalid: false } };
  const st = { claude: on, codex: on, gemini: on, antigravity: on };
  // 라이브 재현 시나리오(2026-07-30): claude OAuth 만료 → codex 402. 이전엔 재시도가 1회뿐이라
  // 멀쩡한 gemini·antigravity가 시도조차 못 받고 영입이 통째로 실패했다.
  assert.equal(pickRunner(st, null, ['claude', 'codex']).runner, 'gemini');
  assert.equal(pickRunner(st, null, ['claude', 'codex', 'gemini']).runner, 'antigravity');
  assert.equal(pickRunner(st, null, ['claude', 'codex', 'gemini', 'antigravity']).available, false);
  assert.equal(pickRunner(st, null, 'claude').runner, 'codex'); // 문자열 단수도 하위호환
  assert.equal(pickRunner(st, null, null).available, true);
});

// HIGH-1(분리 검수 실증): 반경 인자 세 줄을 지워도 전 게이트가 초록이었다 — 표제 변경의 본체에
// 게이트가 없던 것. 행동(파일에 실제로 실리는 값) + 배선(호출부) 양쪽을 잠근다.
test('gemini settings.json이 openRoots를 context.includeDirectories로 싣는다(반경 게이트)', async () => {
  const { writeGeminiTurnSettings } = await import('../src/runners/gemini.mjs');
  const { mkdtemp, mkdir, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = await mkdtemp(join(tmpdir(), 'argo-gset-'));
  await mkdir(join(home, '.gemini'), { recursive: true });
  await writeGeminiTurnSettings(home, 'oauth-personal', { fs: true }, ['/w1']);
  const j = JSON.parse(await readFile(join(home, '.gemini', 'settings.json'), 'utf8'));
  assert.deepEqual(j.context?.includeDirectories, openRoots({ fs: true }, ['/w1']));
  await writeGeminiTurnSettings(home, 'oauth-personal', null, []);
  const j2 = JSON.parse(await readFile(join(home, '.gemini', 'settings.json'), 'utf8'));
  assert.equal(j2.context, undefined); // caps=null(oneshot) → 반경 키 부재가 안전 기본
});

test('antigravity 반경 인자 = openRoots(반복형 --add-dir)', async () => {
  const { agyDirArgs } = await import('../src/runners.mjs');
  assert.deepEqual(agyDirArgs({ fs: true }, ['/w1']), ['--add-dir', homedir(), '--add-dir', '/w1']);
  assert.deepEqual(agyDirArgs(null, []), []);
});

// 배선 트립와이어 — 순수 함수가 맞아도 호출부가 빠지면 반경은 안 실린다(HIGH-1의 나머지 절반).
// 소스 스캔은 이 레포 선례(no-hardcoded-runner-label)대로 "배선 존재"만 잠근다.
test('배선: externalExec가 gemini settings·agy 인자에 workRoots를 실제로 넘긴다', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/runners.mjs', import.meta.url), 'utf8');
  assert.match(src, /writeGeminiTurnSettings\(cred\.home, cred\.authType, caps, workRoots\)/, 'gemini 반경 배선');
  assert.match(src, /\.\.\.agyDirArgs\(caps, workRoots\)/, 'antigravity 반경 배선');
});

test('pickRunner — 선호(want)도 exclude 목록에 걸리면 건너뛴다', () => {
  const on = { company: { connected: true, invalid: false } };
  const st = { claude: on, gemini: on };
  assert.equal(pickRunner(st, 'claude', ['claude']).runner, 'gemini');
  assert.equal(pickRunner(st, 'claude', []).runner, 'claude');
});

/* ── 채팅 경로(chat.mjs)의 인증 자가치유 — #192가 oneshot만 목록화해서, **트래픽이 더 많은** 채팅은
   단수 제외 + 재귀 1회로 남아 있었다(분리 검수 MEDIUM-4). claude 401 → codex 실패 → 3번째 시도 없음. ── */

test('excludeWith — 단수·목록·null 어느 이전값이든 누적 목록을 만든다(pickRunner exclude 계약)', async () => {
  assert.deepEqual(excludeWith(null, 'claude'), ['claude']);
  assert.deepEqual(excludeWith('claude', 'codex'), ['claude', 'codex']); // 단수 하위호환(옛 프레임)
  assert.deepEqual(excludeWith(['claude', 'codex'], 'gemini'), ['claude', 'codex', 'gemini']);
  assert.deepEqual(excludeWith([], 'claude'), ['claude']);
  // 생산자(excludeWith)와 소비자(pickRunner)가 **같은 정규화**를 봐야 한다. 이 통합의 유일한 이득이
  // 그건데, 정규화를 다시 갈라놔도 동작은 같아서 전 스위트가 초록이다(분리 검수 LOW-1 실증) — 즉
  // 다음 사람이 조용히 되돌리면 이 PR의 순이득이 0이 된다. 동작으로 못 잡으니 배선으로 잠근다.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/runners/catalog.mjs', import.meta.url), 'utf8');
  assert.match(src, /const skip = new Set\(asList\(exclude\)\)/, 'pickRunner도 asList를 써야 한다 — 재분기는 동작이 같아 행동 테스트로 안 잡힌다');
});

test('채팅 자가치유 3러너 연쇄 — claude 401 → codex 401 → gemini가 시도를 받는다', () => {
  const on = { company: { connected: true, invalid: false } };
  const st = { claude: on, codex: on, gemini: on, antigravity: on };
  // chat()이 매 프레임에서 하는 결정을 그대로 재생한다: pickRunner(want, 누적제외) → 실패 → excludeWith.
  let tried = null; // 1차 프레임의 __excludeRunners
  const chain = [];
  for (let i = 0; i < 4; i++) {
    const pick = pickRunner(st, null, tried);
    if (!pick.available) break;
    chain.push(pick.runner);
    tried = excludeWith(tried, pick.runner); // 이 러너가 401 — 누적 제외하고 다음 프레임
  }
  // 핵심 회귀: 3·4번째 러너가 시도를 받아야 한다. 단수 제외 시절엔 chain이 ['claude','codex']에서 끝났다.
  assert.deepEqual(chain, ['claude', 'codex', 'gemini', 'antigravity']);
  // 전부 소진되면 자가치유가 멈춘다 — 재귀는 러너 수로 자연 종료(무한 루프 없음).
  assert.equal(pickRunner(st, null, tried).available, false);
  // 크루 지정 러너(want)가 있어도 같다 — 지정 러너가 죽으면 남은 러너를 다 시도한다.
  assert.equal(pickRunner(st, 'claude', excludeWith('claude', 'codex')).runner, 'gemini');
});

// 배선 트립와이어 — 순수 함수가 맞아도 두 catch가 목록을 안 쓰면 3번째 시도는 없다(HIGH-1과 같은 계열:
// 표제만 바뀌고 본체에 게이트가 없던 실패). 소스 스캔은 이 레포 선례(no-hardcoded-runner-label)를 따른다.
test('배선: chat.mjs 두 실행 경로(CLI·SDK)의 자가치유가 누적 목록을 쓴다 — 단수 회귀 차단', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  const count = (re) => (src.match(re) ?? []).length;
  // 누적의 출처 — **받은 목록 + 이번 러너**여야 한다. [runner]로 좁히면 아래 배선이 다 맞아도
  // 프레임마다 앞의 실패를 잊어 claude→codex→claude 무한 핑퐁이 된다(변이 M4 실증: 원래 버그보다 나쁘다).
  assert.match(src, /const tried = excludeWith\(__excludeRunners, runner\)/, '누적 출처가 받은 목록이어야 한다');
  // 진입 재해석이 제외 목록을 존중하는 것이 **종료성의 근거**다 — 이 PR이 재귀 1회 가드를 지웠으므로
  // 여기서 exclude가 유실되면 매 프레임이 같은 죽은 러너를 다시 뽑아 tried가 중복으로만 늘고
  // (['claude','claude',…]) alt는 매번 새 러너라 사전 확인을 통과해 **무한 재귀 + 무한 벤더 턴**이 된다.
  // 구독(OAuth) 턴은 monthCost를 갉지 않아 예산 상한도 못 막는다(분리 검수 MEDIUM-1 변이 실증:
  // 이 줄의 exclude를 지우면 40프레임까지 claude 반복인데 전 테스트가 초록이었다).
  assert.match(src, /resolveRunner\(wsId, wantRunner, \{ exclude: __excludeRunners \}\)/, '진입 재해석이 제외 목록을 존중해야 한다 = 종료성의 근거');
  assert.equal(count(/resolveRunner\(wsId, wantRunner, \{ exclude: tried \}\)/g), 2, '두 갈래가 누적 목록으로 러너를 재해석해야 한다');
  assert.equal(count(/__excludeRunners: tried/g), 2, '두 갈래가 누적 목록을 재귀로 넘겨야 한다');
  assert.equal(count(/!tried\.includes\(alt\.runner\)/g), 2, '이미 시도한 러너 재선택 차단 = 재귀 종료 보장');
  // 단수 회귀 차단 — 이 형태가 되살아나면 앞의 둘이 죽었을 때 멀쩡한 나머지가 시도조차 못 받는다.
  assert.doesNotMatch(src, /exclude: runner \}/, '단수 제외 회귀');
  assert.doesNotMatch(src, /__excludeRunners: runner\b/, '단수 제외 회귀(재귀 인자)');
  assert.doesNotMatch(src, /!__excludeRunners &&/, '재귀 1회 제한 가드 재유입 금지 — 목록 누적이 종료를 맡는다');
  // AUTH_ERR_RE 한정 유지 — oneshot(어떤 실패든 갈아탐)과 달리 이 경로는 **인증 오류에만** 갈아탄다.
  // 이 한정이 빠지면 일시적 실패로 사용자 고지 없이 실과금 벤더로 넘어간다(범위 확대 금지).
  // 발동 조건은 **골격**으로 비교한다. 개수만 세면(count(AUTH_ERR_RE.test)===2) `|| /rate limit/`를
  // 덧붙여 한정을 깨도 초록이고(2R MEDIUM-2 실증), 줄을 문자 그대로 앵커링하면 String(e.message || e)를
  // const로 빼는 **정당한 리팩터**에 거짓 red를 낸다(2R 실증). 인자 속 괄호를 걷어낸 골격은 변수명·인자
  // 형태에 둔감하면서, OR 확대·가드 삭제·제3 사이트 추가는 전부 골격을 바꾼다.
  // ⚠ 인자 속 `||`를 걷어내는 것이 핵심이다 — String(e.message || e)의 ||는 조건 OR가 아니다(이 단언의
  // 1차 작성이 그걸 구분 못 해 출하본에서 거짓 red를 냈고, 변이 배터리 전체가 무효가 됐다).
  const skeleton = (c) => { let s = c, prev; do { prev = s; s = s.replace(/\([^()]*\)/g, ''); } while (s !== prev); return s.trim(); };
  const healConds = [...src.matchAll(/if \(([^\n]*AUTH_ERR_RE\.test\([^\n]*)\) \{/g)].map((m) => m[1]);
  // retriedDown은 이 PR이 !__excludeRunner(독립적 두 번째 브레이크)를 지운 뒤로 fresh-retry 프레임의
  // 이중 치유(중복 실행·이중 과금)를 막는 **유일한** 브레이크다. 골격 비교가 그 존재를 잠근다.
  assert.deepEqual(healConds.map(skeleton).sort(), [
    '!aborted && !retriedDown && AUTH_ERR_RE.test', // SDK 갈래
    '!aborted && AUTH_ERR_RE.test',                 // CLI 갈래
  ].sort(), '자가치유 발동 조건 골격 — OR 확대·abort/retriedDown 가드 삭제·제3 사이트를 함께 차단');
  // 읽는 자리(위)와 **쓰는 자리**를 함께 잠근다 — 대입만 지워도 가드는 항상 참이 되는데 읽는 자리
  // 단언은 그대로 통과한다(3R MEDIUM-3 실증: 초록). 그 경로: P(claude)가 fresh-retry F를 띄움 →
  // F가 401로 codex까지 치유·실패 → P가 **다시** 치유해 codex를 두 번 실행한다(P의 tried엔 codex가
  // 없어 사전 확인을 통과한다) = 중복 실행·이중 과금.
  assert.match(src, /e = e2; retriedDown = true;/, 'fresh-retry 소진 표시 = 이중 치유 유일 브레이크의 쓰는 자리');
  // 세션 부재 재시도(fresh-retry)는 러너 잘못이 아니다 — 받은 목록을 그대로 넘겨 같은 러너로 재시도한다.
  assert.match(src, /__freshRetry: true, __seedNotes: sharedNotes, __excludeRunners \}/, 'fresh-retry는 제외 목록을 누적하지 않는다');
});

// 형제 경로 — #192가 oneshot의 재귀 1회 가드도 지웠으므로 종료성이 진입 exclude 한 줄에 걸려 있는데
// 게이트가 없었다(3R MEDIUM-4 실증: 지워도 초록). chat에 방금 잠근 것과 **완전히 같은 불변식**이라
// 같은 커밋에서 닫는다 — "같은 계열 갭은 한 라운드 더 돌아 닫는다"(레포 규칙).
test('배선: oneshot 자가치유도 진입에서 제외 목록을 존중한다 = 종료성의 근거', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/oneshot.mjs', import.meta.url), 'utf8');
  assert.match(src, /resolveRunner\(wsId, null, \{ exclude: __exclude \}\)/, '진입 재해석이 제외 목록을 존중해야 한다');
  assert.match(src, /resolveRunner\(wsId, null, \{ exclude: tried \}\)/, '치유 재해석은 누적 목록으로');
  assert.match(src, /!tried\.includes\(alt\.runner\)/, '이미 시도한 러너 재선택 차단 = 재귀 종료 보장');
  // 누적 출처 — chat 쪽에 있던 단언의 형제. 인라인 재구현이던 시절엔 이 자리가 무게이트였다(공유 함수로
  // 바뀌며 chat과 같은 형태로 잠근다). [runner]로 좁히면 프레임마다 앞의 실패를 잊어 무한 핑퐁.
  assert.match(src, /const tried = excludeWith\(__exclude, runner\)/, '누적 출처가 받은 목록이어야 한다');
});
