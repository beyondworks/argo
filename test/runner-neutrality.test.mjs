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
// codex writable_roots 대조 테스트는 삭제됐다 — codex는 danger-full-access(샌드박스 없음,
// 유건 지시 2026-08-21)라 반경 개념이 없다. 반경을 강제하는 러너는 gemini(includeDirectories)·
// agy(--add-dir)뿐이고 그 계산이 openRoots 하나임은 아래 두 테스트가 계속 잠근다.

test('pickRunner — exclude 목록을 받아 남은 러너를 고른다(자가치유 누적 제외)', () => {
  const on = { company: { connected: true, invalid: false } };
  const st = { claude: on, codex: on, gemini: on, antigravity: on };
  // 라이브 재현 시나리오(2026-07-30): claude OAuth 만료 → codex 402. 이전엔 재시도가 1회뿐이라
  // 멀쩡한 gemini·antigravity가 시도조차 못 받고 영입이 통째로 실패했다.
  // gemini는 숨김(카탈로그 hidden, 2026-09-03) — 자동 폴백은 건너뛰고 antigravity가 시도를 받는다. 명시 지정은 별도 테스트(runner-hidden)
  assert.equal(pickRunner(st, null, ['claude', 'codex']).runner, 'antigravity');
  assert.equal(pickRunner(st, null, ['claude', 'codex', 'gemini']).runner, 'antigravity');
  assert.equal(pickRunner(st, null, ['claude', 'codex', 'gemini', 'antigravity']).available, false);
  assert.equal(pickRunner(st, null, 'claude').runner, 'codex'); // 문자열 단수도 하위호환
  assert.equal(pickRunner(st, null, null).available, true);
});

// HIGH-1(분리 검수 실증): 반경 인자 세 줄을 지워도 전 게이트가 초록이었다 — 표제 변경의 본체에
// 게이트가 없던 것. 행동(파일에 실제로 실리는 값) + 배선(호출부) 양쪽을 잠근다.
test('gemini settings.json이 openRoots를 context.includeDirectories로 싣는다(반경 게이트)', async () => {
  const { writeGeminiTurnSettings } = await import('../src/runners/gemini.mjs');
  const { mkdir, readFile } = await import('node:fs/promises');
  const { mkdtemp } = await import('./helpers/tmp.mjs');
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
  // caps → effCaps(readOnly면 무력화, 기본은 caps 그대로 — readOnly 도입 2026-08-29). 배선 존재만 잠근다.
  assert.match(src, /writeGeminiTurnSettings\(cred\.home, cred\.authType, effCaps, workRoots(, mcpServers)?\)/, 'gemini 반경 배선');
  assert.match(src, /\.\.\.agyDirArgs\(effCaps, workRoots\)/, 'antigravity 반경 배선');
});

test('pickRunner — 선호(want)도 exclude 목록에 걸리면 건너뛴다', () => {
  const on = { company: { connected: true, invalid: false } };
  const st = { claude: on, antigravity: on };
  assert.equal(pickRunner(st, 'claude', ['claude']).runner, 'antigravity');
  assert.equal(pickRunner(st, 'claude', []).runner, 'claude');
});

/* ── 채팅 경로(chat.mjs)의 인증 자가치유 — #192가 oneshot만 목록화해서, **트래픽이 더 많은** 채팅은
   단수 제외 + 재귀 1회로 남아 있었다(분리 검수 MEDIUM-4). claude 401 → codex 실패 → 3번째 시도 없음. ── */

test('excludeWith — 단수·목록·null 어느 이전값이든 누적 목록을 만든다(pickRunner exclude 계약)', () => {
  assert.deepEqual(excludeWith(null, 'claude'), ['claude']);
  assert.deepEqual(excludeWith('claude', 'codex'), ['claude', 'codex']); // 단수 하위호환(옛 프레임)
  assert.deepEqual(excludeWith(['claude', 'codex'], 'gemini'), ['claude', 'codex', 'gemini']);
  assert.deepEqual(excludeWith([], 'claude'), ['claude']);
});

// 이 이관의 **유일한 이득**이 "생산자(excludeWith)와 소비자(pickRunner)가 같은 정규화를 본다"인데,
// 갈라놔도 **동작은 같아서** 행동 테스트가 못 잡는다(분리 검수 LOW-1). 다음 사람이 조용히 되돌리면
// 순이득이 0이 되므로 배선으로 잠근다. 단, 호출부를 문자 그대로 앵커링하면 안 된다 — 그러면 소비자
// 방향만 잠기고(생산자 재인라인은 그대로 초록) 지역변수 추출·파라미터 개명·헬퍼 개명 같은 **정당한
// 리팩터에 거짓 red**를 낸다(2R 실증 4종). 이 파일 위쪽 AUTH_ERR_RE 골격 비교와 같은 교훈이다.
// 그래서 불변식을 직접 센다: **정규화 표현은 이 파일에 한 벌만 존재한다**. 역참조(\1)라 변수명이
// 바뀌어도 따라오고, 어느 쪽이든 재인라인하면 2벌이 되어 잡힌다.
test('배선: exclude 정규화 표현이 catalog에 한 벌만 — 생산자·소비자 어느 쪽 재분기도 차단', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/runners/catalog.mjs', import.meta.url), 'utf8');
  const inline = [...src.matchAll(/Array\.isArray\((\w+)\) \? \1 : \1 \? \[\1\] : \[\]/g)];
  assert.equal(inline.length, 1, 'exclude 정규화는 한 벌만(asList 정의) — 재인라인하면 2벌, 정규화가 깨지면 0벌');
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
  assert.deepEqual(chain, ['claude', 'codex', 'antigravity']); // gemini 숨김 — 자동 사슬에서 제외
  // 전부 소진되면 자가치유가 멈춘다 — 재귀는 러너 수로 자연 종료(무한 루프 없음).
  assert.equal(pickRunner(st, null, tried).available, false);
  // 크루 지정 러너(want)가 있어도 같다 — 지정 러너가 죽으면 남은 러너를 다 시도한다.
  assert.equal(pickRunner(st, 'claude', excludeWith('claude', 'codex')).runner, 'antigravity');
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
  // 2026-08-25: 골격 비교(괄호 제거)는 승인된 OR 합류(도구 잠김 lockupAction)까지 지워 분별력을 잃는다
  // → **승인 목록 비교**로 전환: 발동 조건의 정규화 원문이 아래 목록과 일치해야 한다. 조건을 바꾸려면
  // 이 목록을 의도적으로 갱신해야 하며(변경 통제), 무단 OR 확대·가드 삭제·제3 사이트는 전부 red다.
  // lockupAction은 toolLockup 마커 + 재조달 재시도 소진 후에만 'switch'라 "아무 실패로 갈아타기"는 여전히 차단된다.
  // 2026-09-05 #432 HIGH-1: 발동 조건이 순수 함수 shouldSelfHeal(필드 authExpired 우선 → AUTH_ERR_RE → 잠김 교체)로
  // 모였다. 승인 목록은 두 층이다 — ① if 줄 호출부(갈래 수·가드), ② 함수 본체(OR 확대·필드 삭제·정규식 확대).
  // 한 층만 잠그면 다른 층에서 "아무 실패로 갈아타기"가 되살아난다(호출부만 세면 본체에 `|| /rate limit/`가 초록).
  const norm = (c) => c.replace(/\s+/g, ' ').trim();
  const healConds = [...src.matchAll(/if \(([^\n]*shouldSelfHeal\([^\n]*)\) \{/g)].map((m) => m[1]);
  assert.deepEqual(healConds.map(norm).sort(), [
    "!aborted && !retriedDown && shouldSelfHeal(e, { lockup: false })", // SDK 갈래 — 잠김 교체 없음(종전 계약)
    "!aborted && shouldSelfHeal(e, { retried: __lockupRetry })", // CLI 갈래(잠김 합류 승인분)
  ].sort(), '자가치유 발동 호출부 승인 목록 — 가드 삭제·제3 사이트 차단');
  const healBody = src.split('export function shouldSelfHeal(e, { retried = false, lockup = true } = {}) {')[1]?.split('\n}')[0] ?? '';
  assert.equal(norm(healBody), "if (e?.authExpired) return true; if (AUTH_ERR_RE.test(String(e?.message || e))) return true; return lockup && lockupAction(e, { retried }) === 'switch';", '자가치유 판정 본체 승인 — 무단 OR 확대(일시 실패로 실과금 벤더 전환)·필드 판정 삭제(HIGH-1 회귀) 차단');
  assert.doesNotMatch(src, /if \([^\n]*AUTH_ERR_RE\.test\(String\(e\.message \|\| e\)\)/, '옛 문자열 판정 호출부 잔존 금지(제3 사이트)');
  // 도구 잠김(L2) 배선 불변식 — 재조달 분기 1곳·재시도 마커 1곳·재조달 호출 1곳(무한 재시도 금지 골격)
  // 2026-09-05 #432 HIGH-1: 교체 자리는 shouldSelfHeal 본체(lockupAction(e, { retried }))로 이관 — 호출부가 __lockupRetry를 넘긴다
  assert.equal((src.match(/lockupAction\(e, \{ retried: __lockupRetry \}\)/g) ?? []).length, 1, '잠김 판정 분기(재조달) 한 자리');
  assert.equal((src.match(/lockupAction\(e, \{ retried \}\) === 'switch'/g) ?? []).length, 1, '잠김 교체 판정은 shouldSelfHeal 본체 한 자리');
  assert.equal((src.match(/shouldSelfHeal\(e, \{ retried: __lockupRetry \}\)/g) ?? []).length, 1, 'CLI 갈래가 재시도 마커를 판정에 넘긴다(안 넘기면 잠김 무한 교체)');
  assert.equal((src.match(/__lockupRetry: true/g) ?? []).length, 1, '재조달 재시도는 1회 한정');
  assert.equal((src.match(/reprovisionRunner\(runner\)/g) ?? []).length, 1, '재조달 호출은 잠김 분기 한 자리');
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

// 샌드박스 제거 게이트(2026-08-21) — codex는 test/codex-caps-config가 잠그지만 gemini 쪽은
// 게이트가 없어 조용히 auto_edit·셸 제외로 되돌아가도 전 스위트가 초록이었다(분리 검수 MED-5).
test('gemini: yolo 승인 모드 유지 + 셸 도구가 전권 caps에서 열린다', async () => {
  const { readFile: rf, mkdir } = await import('node:fs/promises');
  const { mkdtemp } = await import('./helpers/tmp.mjs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const src = await rf(new URL('../src/runners.mjs', import.meta.url), 'utf8');
  assert.match(src, /'--approval-mode', 'yolo'/, 'yolo가 사라졌다 — 셸이 비대화에서 다시 실행 불가가 된다');
  assert.doesNotMatch(src, /'--approval-mode', 'auto_edit'/, 'auto_edit 복귀 — codex는 되는 지시가 gemini만 막힌다');
  const { writeGeminiTurnSettings } = await import('../src/runners/gemini.mjs');
  const home = await mkdtemp(join(tmpdir(), 'argo-gyolo-'));
  await mkdir(join(home, '.gemini'), { recursive: true });
  await writeGeminiTurnSettings(home, 'oauth-personal', { fs: true, browser: true, shell: true }, []);
  const j = JSON.parse(await rf(join(home, '.gemini', 'settings.json'), 'utf8'));
  assert.ok(!(j.tools?.exclude ?? []).includes('run_shell_command'), '전권인데 셸 도구가 감춰져 있다');
  // fail-closed 대칭(MED-2): caps 미전달(내부 프로브)은 셸을 감춘다 — agy --sandbox와 같은 방향
  await writeGeminiTurnSettings(home, 'oauth-personal', null, []);
  const j2 = JSON.parse(await rf(join(home, '.gemini', 'settings.json'), 'utf8'));
  assert.ok((j2.tools?.exclude ?? []).includes('run_shell_command'), 'caps 미전달은 닫혀야 한다(fail-closed)');
});
