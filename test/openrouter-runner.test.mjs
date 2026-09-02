// OpenRouter 러너(BYOK 계열 일반화, 설계 2026-07-27) 배선 가드.
// 핵심 불변식: ① SDK 계열(sdk-compat) — CLI 래핑 금지 ② BYOK apikey 단일 ③ 카탈로그 규칙 —
// 정적 모델 목록·기본 모델에는 스모크(scripts/openrouter-smoke.mjs) **전수 통과** id만
// ④ 402(선불 크레딧 소진)는 성공으로 삼키지 않는다 ⑤ 금액은 미기록(SDK 단가 오액 — 설계 §4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-or-'));
const { paths } = await import('../src/workspace.mjs');
const { RUNNERS, RUNNER_AUTH, OPENROUTER_DEFAULT_MODEL, OPENROUTER_ONBOARD_MODEL, isOpenRouterCreditError, isOpenRouterCreditReply, saveRunnerCred, runnerCredEnv, isBilledRunner } = await import('../src/runners.mjs');

test('등록: sdk-compat 계열 + BYOK apikey 단일 (CLI 래핑 금지)', () => {
  assert.equal(RUNNERS.openrouter?.kind, 'sdk-compat', 'CLI 래핑이면 러너 차등이 되살아난다 — BYOK 계열 원칙');
  assert.deepEqual(RUNNER_AUTH.openrouter?.methods, ['apikey'], 'OAuth·크레딧 대행 안 함(설계 YAGNI)');
  assert.ok(RUNNER_AUTH.openrouter?.keyUrl?.includes('openrouter.ai'));
});

test('카탈로그: 스모크 전수 통과 11종 + 기본 모델 포함 + 첫 항목=기본(러너 전환 관례)', () => {
  const ids = (RUNNERS.openrouter.models ?? []).map((m) => m.id);
  // 유료 = 2026-07-27 스모크 8/8 + 2026-09-01 스모크 3/3(x-ai/grok-4.6·z-ai/glm-5.3·google/gemini-3.7-flash).
  // 이 수를 올리려면 scripts/openrouter-smoke.mjs 실키 통과가 선행돼야 한다(같은 날 anthropic/claude-fable-5.1은
  // 402 잔액으로 미등재 — 통과 전엔 세지 않는다).
  assert.equal(ids.filter((i) => !i.endsWith(':free')).length, 11, '유료 11종 — 스모크 확정본(8/8 + 3/3)');
  assert.equal(ids.filter((i) => i.endsWith(':free')).length, 3, '무료 3종 — 크레딧 0 체험 진입로(2026-09-02 재스모크: ling 404·laguna 429 3/3 제거, minimax-m3(온보딩 기본)·m2.7 편입)');
  // 스모크 스크립트의 기본 후보 목록이 카탈로그와 어긋나면 "인자 없이 돌린 스모크 통과"가 거짓 안심이 된다(검수 MEDIUM-3)
  const smoke = readFileSync(new URL('../scripts/openrouter-smoke.mjs', import.meta.url), 'utf8');
  for (const id of ids) assert.ok(smoke.includes(`'${id}'`), `스모크 CANDIDATES에 카탈로그 id 누락: ${id}`);
  // 검수 CRITICAL(2026-07-27): 모델 미지정 호출(영입·기억정리·루틴 초안)이 전부 기본 모델로 오므로
  // 유료가 기본이면 잔액 0 신규 키는 첫 영입부터 402 — 첫 항목은 반드시 무료(잔액 무관 실행 가능).
  // 라벨에 한국어 하드코딩 금지 — 배지는 free 플래그 + i18n 사전(gated 관례, 다국어 상시 규칙)
  for (const m of RUNNERS.openrouter.models) {
    assert.doesNotMatch(m.label, /[가-힣]/, `라벨은 고유명사만: ${m.label}`);
    // 양방향 — 무료인데 플래그 누락(배지 소실 = 한도 고지 소실)도, 유료인데 무료 표기(거짓)도 막는다
    assert.equal(!!m.free, m.id.endsWith(':free'), `free 플래그와 :free 접미가 어긋남: ${m.id}`);
  }
  assert.ok(ids.includes(OPENROUTER_DEFAULT_MODEL), '기본 모델은 반드시 검증된 목록 안에서');
  assert.ok(ids.includes(OPENROUTER_ONBOARD_MODEL), '온보딩 기본도 검증된 목록 안에서');
  // 두 기본값은 **역할이 다르다**(2R 검수 H1) — 하나로 합치면 한쪽이 반드시 깨진다.
  //  · models[0] = 사용자가 UI에서 러너를 고를 때 선택되는 값 → 잔액 0에서도 돌아야(무료), 보이고 바꿀 수 있다
  //  · ONBOARD = 자동 호출(영입·기억정리·루틴 초안)의 기본 → 모델 선택 화면이 없으므로 무료
  //  · DEFAULT = 크루 카드에 model이 없을 때의 채팅 기본 → 잔액 있는 사용자의 품질을 지켜야(유료)
  assert.ok(ids[0].endsWith(':free'), 'UI 기본 선택은 잔액 0에서도 도는 모델(gemini 카탈로그 선례)');
  assert.ok(OPENROUTER_ONBOARD_MODEL.endsWith(':free'), '자동 호출 기본은 무료 — 신규 키 첫 영입이 402로 막히면 안 된다');
  assert.ok(!OPENROUTER_DEFAULT_MODEL.endsWith(':free'), '채팅 기본을 무료로 두면 잔액 있는 사용자의 모든 크루가 무료로 내려간다(H1)');
});

test('runnerCredEnv: GLM·Kimi와 동일한 Anthropic 호환 env 패턴 + 토큰 위생 + 상한 미선언', async () => {
  // env 격리 — 개발자 셸의 OPENROUTER_* 오버라이드가 단언을 흔들지 않게(검수 LOW)
  const saved = {};
  for (const k of ['OPENROUTER_BASE_URL', 'OPENROUTER_MAX_OUTPUT_TOKENS']) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    const ws = 'or-env';
    await mkdir(paths(ws).root, { recursive: true });
    await saveRunnerCred(ws, 'openrouter', 'apikey', 'sk-or-test-123');
    const cred = await runnerCredEnv(ws, 'openrouter');
    assert.equal(cred.env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api');
    assert.equal(cred.env.ANTHROPIC_AUTH_TOKEN, 'sk-or-test-123');
    assert.equal(cred.env.ANTHROPIC_API_KEY, '', 'Anthropic 키 잔존 금지');
    assert.equal(cred.env.CLAUDE_CODE_OAUTH_TOKEN, '', '구독 토큰이 제3자 향 턴에 남으면 안 된다(감사 2026-07-20 대칭)');
    // 출력 상한은 기본 미선언(검수 MEDIUM-2: 러너 차등 + 긴 답변 절단) — env 옵트인 시에만
    assert.equal(cred.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined);
    process.env.OPENROUTER_MAX_OUTPUT_TOKENS = '4096';
    assert.equal((await runnerCredEnv(ws, 'openrouter')).env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '4096', '운영자 env 옵트인은 반영');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('billing: openrouter apikey = 청구 러너 (단일 판정 합류)', async () => {
  const ws = 'or-bill';
  await mkdir(paths(ws).root, { recursive: true });
  assert.equal(await isBilledRunner(ws, 'openrouter'), false, '미연결 = 비청구(env 폴백 없음)');
  await saveRunnerCred(ws, 'openrouter', 'apikey', 'sk-or-test-123');
  assert.equal(await isBilledRunner(ws, 'openrouter'), true);
});

test('isOpenRouterCreditError(느슨판, oneshot용): 첫 줄/마지막 줄 402만 — 인용·설명 답변 오탐 금지 (2R N4)', () => {
  assert.equal(isOpenRouterCreditError('API Error: 402 This request requires more credits, or fewer max_tokens.'), true);
  assert.equal(isOpenRouterCreditError('  API Error: 402 …'), true);
  assert.equal(isOpenRouterCreditError('알겠습니다.\n\nAPI Error: 402 This request requires more credits'), true, '서두 문장 뒤 에러(마지막 줄) — 미탐이면 402가 기억에 저장된다');
  assert.equal(isOpenRouterCreditError('api error: 402 …'), true, '대소문자 무시');
  assert.equal(isOpenRouterCreditError('OpenRouter에서 "API Error: 402"가 나오면 크레딧을 충전하세요.'), false, '산문 중간 인용은 오탐 금지');
  assert.equal(isOpenRouterCreditError('첫 줄 설명입니다. API Error: 402 언급.\n마지막 줄은 정상 결론입니다.'), false, '중간 언급 + 정상 결론 = 오탐 금지');
  assert.equal(isOpenRouterCreditError(''), false);
});

test('isOpenRouterCreditReply(엄격판, chat용): 답변≈에러 원문일 때만 — 인용·해설 턴은 일지 유지 (3R F1)', () => {
  const ERR = 'API Error: 402 This request requires more credits, or fewer max_tokens.'; // 실측 원문
  // 진짜 402(실측 원문 그대로 / 짧은 서두 뒤 에러) — 안내 + 일지 제외가 발동해야 한다
  assert.equal(isOpenRouterCreditReply(ERR), true, '실측 원문 = 답변 전체가 에러');
  assert.equal(isOpenRouterCreditReply(`알겠습니다.\n${ERR}`), true, '짧은 서두 + 에러(2R N4 변형) — 잔여량이 상한 이내');
  // 경계 스냅샷(검수 LOW) — 임계는 "비에러 잔여 ≤ 60자". 나중에 상한을 바꾸면 여기서 드러난다.
  assert.equal(isOpenRouterCreditReply(`${'x'.repeat(60)}\n${ERR}`), true, '잔여 60자 = 경계 안(진짜 402로 판정)');
  assert.equal(isOpenRouterCreditReply(`${'x'.repeat(61)}\n${ERR}`), false, '잔여 61자부터 정상 턴(일지 유지)');
  // 잔여량 절대 상한이라 402 문구가 짧아져도 판정 특성이 안 움직인다(검수 MEDIUM — 비율 기준의 함정)
  assert.equal(isOpenRouterCreditReply('짧은 서두.\nAPI Error: 402 Insufficient credits.'), true, '짧은 402 변형에서도 동일 경계');
  // 3R 오탐 2케이스 — 사장이 402 원문을 붙여넣고 물었을 때의 정상 답변. 느슨판은 true지만
  // 엄격판은 false여야 한다(true면 사실 아닌 충전 안내 + 그 턴 일지가 무증상 누락).
  const quoteFirst = 'API Error: 402 This request requires more credits, or fewer max_tokens.\n말씀하신 이 오류는 OpenRouter 선불 크레딧이 부족할 때 나옵니다. 대시보드에서 잔액을 확인하고 충전하시거나, max_tokens를 낮춰 다시 시도해 보세요.';
  assert.equal(isOpenRouterCreditError(quoteFirst), true, '전제: 느슨판은 이 케이스를 잡는다(첫 줄)');
  assert.equal(isOpenRouterCreditReply(quoteFirst), false, '서두 인용 + 본문 해설 = 정상 턴(일지 유지)');
  const quoteLast = '크레딧 부족 오류입니다. OpenRouter는 선불제라 잔액이 0이면 모든 요청이 거부됩니다. 충전 후 재시도하면 해결됩니다. 참고로 원문은 다음과 같습니다.\nAPI Error: 402 This request requires more credits, or fewer max_tokens.';
  assert.equal(isOpenRouterCreditError(quoteLast), true, '전제: 느슨판은 이 케이스를 잡는다(마지막 줄)');
  assert.equal(isOpenRouterCreditReply(quoteLast), false, '본문 해설 + 말미 인용 = 정상 턴(일지 유지)');
  assert.equal(isOpenRouterCreditReply('완전히 무관한 정상 답변입니다.'), false);
  assert.equal(isOpenRouterCreditReply(''), false);
});

test('배선: chat.mjs — 402 안내는 success/else 쌍 밖 + costUsd 미기록 (제어흐름 트립와이어)', async () => {
  const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  // CRITICAL 재발 방지(검수 실증): 402 블록이 success-if와 else 사이에 끼면 else가 402-if에 붙어
  // **전 러너 성공 턴이 throw**된다. success-if와 else의 인접(붙어 있음)을 문자 그대로 잠근다.
  // 본문은 is_error·api_error_status 포착까지 확장(P0 2026-08-31 — SDK 삼킴 게이트의 원천)하되, 인접 불변은 그대로 잠근다.
  assert.match(src, /if \(msg\.subtype === 'success'\) \{ reply = msg\.result; resultIsError = !!msg\.is_error; resultApiErrStatus = Number\(msg\.api_error_status\) \|\| 0; \}\n      else \{/, 'success/else 쌍은 인접 불변 — 사이에 코드 삽입 금지');
  // 3R F1: chat은 엄격판이어야 한다 — 느슨판을 배선하면 402 인용 답변의 일지가 무증상 누락된다
  assert.match(src, /runner === 'openrouter' && isOpenRouterCreditReply\(reply\)/, '402 안내 배선(엄격판)');
  assert.doesNotMatch(src, /isOpenRouterCreditError/, 'chat에 느슨판 유입 금지 — 임계 분리(3R F1)');
  assert.match(src, /costUsd: runner === 'openrouter' \? null : msg\.total_cost_usd/, '설계 §4 — SDK 금액은 Anthropic 단가라 openrouter에선 오액(미기록)');
  assert.match(src, /creditTurn \? null : await saveHandover/, '402 턴은 일지 기록 제외 — 오류 원문이 기억으로 정제되지 않게(2R N3)');
});

test('배선: oneshot.mjs — 402는 성공이 아니라 실패로 승격(크루 카드·기억 오염 방지) + costUsd 미기록', async () => {
  const src = await readFile(new URL('../src/oneshot.mjs', import.meta.url), 'utf8');
  assert.match(src, /runner === 'openrouter' && isOpenRouterCreditError\(text\)/, '402 텍스트가 성공으로 반환되면 크루 카드에 영구 저장된다(검수 HIGH-1)');
  assert.match(src, /costUsd: runner === 'openrouter' \? null : costUsd/);
  // 2R H1: 호출자 모델을 카탈로그 검증 없이 넘기면 consolidate의 claude-haiku 하드코딩이 400으로 전멸
  assert.match(src, /RUNNERS\.openrouter\.models\.some\(\(m\) => m\.id === model\)/, 'openrouter 원샷은 카탈로그 밖 id를 기본 모델로 강등해야 한다');
  // 외부 CLI 경로(externalExec)에 openrouter 분기가 생기면 BYOK 원칙 위반
  const runners = await readFile(new URL('../src/runners.mjs', import.meta.url), 'utf8');
  const external = runners.split('export async function externalExec')[1]?.split('\n}')[0] ?? '';
  assert.doesNotMatch(external, /openrouter/, 'openrouter는 SDK 계열 — externalExec(CLI) 분기 금지');
});

test('429(요청 한도)는 402와 대칭 — 느슨판/엄격판 양쪽 (검수 F2)', async () => {
  const { isOpenRouterLimitError, isOpenRouterLimitReply } = await import('../src/runners.mjs');
  assert.equal(isOpenRouterLimitError('API Error: 429 Rate limit exceeded'), true);
  assert.equal(isOpenRouterLimitReply('API Error: 429 Rate limit exceeded'), true);
  assert.equal(isOpenRouterLimitError('API Error: 402 …'), false, '402와 429는 서로 오인하지 않는다');
  assert.equal(isOpenRouterCreditError('API Error: 429 …'), false);
  // 엄격판 — 실질 답변이 있는 인용 턴은 일지를 잃지 않는다(3R F1과 동일 임계)
  assert.equal(isOpenRouterLimitReply('API Error: 429 Rate limit exceeded\n' + '해설'.repeat(40)), false);
});

test('배선: chat·oneshot이 429를 402와 대칭으로 태운다', async () => {
  const chat = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  const oneshot = await readFile(new URL('../src/oneshot.mjs', import.meta.url), 'utf8');
  assert.match(chat, /isOpenRouterLimitReply\(reply\)/, 'chat: 429 안내 + 일지 제외');
  assert.match(oneshot, /isOpenRouterLimitError\(text\)/, 'oneshot: 429 실패 승격(크루 카드·기억 오염 방지)');
  assert.match(oneshot, /openrouter-limit/, '429 전용 안내 분기');
  // M2: 429도 일지 제외여야 한다 — 402만 잠겨 있어 429 분기의 creditTurn 삭제가 안 잡혔다(2R 변이 실증)
  const limitBlock = chat.split('isOpenRouterLimitReply(reply)')[1]?.slice(0, 400) ?? '';
  assert.match(limitBlock, /creditTurn = true/, '429 턴도 일지 제외 — 오류 원문이 기억으로 정제되면 안 된다');
  // L1: 두 분기는 상호배타(else if) — 앞 분기가 reply를 바꾼 뒤 뒤 분기가 그걸 판정하면 원인이 삼켜진다
  assert.match(chat, /\}\s*\n\s*(?:\/\/[^\n]*\n\s*)*else if \(runner === 'openrouter' && isOpenRouterCreditReply/);
  // M1: 429는 자가치유 금지 — 일시적 한도인데 다른 벤더(실과금)로 조용히 갈아타면 안 된다.
  // 앵커는 자가치유의 러너 재해석 호출(누적 제외 도입으로 __exclude 가드 문자열이 사라짐, 2026-07-30).
  const healIdx = oneshot.indexOf('resolveRunner(wsId, null, { exclude: tried })');
  assert.ok(healIdx > 0, '자가치유 재해석 호출이 있어야 한다');
  assert.ok(oneshot.indexOf('openrouter-limit', oneshot.indexOf('catch (e)')) < healIdx, '429 분기가 자가치유보다 앞서야 한다');
});

test('배선: free 배지가 모델 선택 UI 4곳에 모두 걸려 있다 (배지 소실 = 한도 고지 소실)', async () => {
  const files = ['../app/c/[ws]/crew-edit.jsx', '../app/c/[ws]/crew/[slug]/page.jsx', '../app/c/[ws]/compete/page.jsx']; // 데크 크루 편집 모달 → crew-edit.jsx(2026-08-21)
  const srcs = await Promise.all(files.map((f) => readFile(new URL(f, import.meta.url), 'utf8')));
  for (const [i, src] of srcs.entries()) {
    assert.match(src, /runner\.freeBadge/, `free 배지 미배선: ${files[i]}`);
  }
  // 크루 페이지는 두 곳(카드 배지 + option) — gated와 같은 수만큼
  const crew = srcs[1];
  assert.equal((crew.match(/runner\.freeBadge/g) ?? []).length, (crew.match(/runner\.gatedBadge/g) ?? []).length, 'gated와 free 배지 배선 지점 수가 같아야 한다');
});

test('배선: PICK_ORDER ↔ RUNNER_AUTH 동기화 (다음 러너 추가 때 또 깨질 자리 — 불변식 수색)', async () => {
  const { PICK_ORDER } = await import('../app/runner-usable.mjs');
  assert.deepEqual([...PICK_ORDER].sort(), Object.keys(RUNNER_AUTH).sort(), 'PICK_ORDER에 빠진 러너는 명판·가용 판정에서 유령이 된다');
});
