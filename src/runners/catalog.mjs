// 러너 카탈로그 — RUNNERS·RUNNER_AUTH·모델 상수·순수 판정 유틸(pickRunner 등).
// (runners.mjs 관심사 분리 2026-07-28 — 의존 0: 다른 모듈을 임포트하지 않는다)

/** 러너별 모델 카탈로그 — id '' = 그 러너의 기본 모델. 라벨은 고유명사라 언어 공통. */
export const RUNNERS = {
  claude: {
    // 표시명은 'Claude' — Agent SDK 브랜딩 지침(code.claude.com/docs/en/agent-sdk/overview)이 서드파티 제품에
    // "Claude Code"·"Claude Code Agent" 사용을 금지한다(허용: "Claude Agent"·"Claude"). 실행 경로는 그대로 SDK다.
    name: 'Claude', kind: 'sdk',
    models: [
      { id: 'claude-fable-5', label: 'Fable 5' },
      { id: 'claude-opus-5', label: 'Opus 5' }, // 실턴 통과 2026-07-25 (runOneShot 'ok' — 카탈로그 규칙: 실행 경로 검증 후에만 추가)
      // [1m] = 1M 컨텍스트 변형(Claude Code CLI --model 접미 규약). 실턴 통과 2026-08-06
      // (SDK 경로 wolff 크루 실챗 왕복 — 두 변형 모두 정상 응답, 4.8[1m]은 모델 자기보고까지 확인).
      { id: 'claude-opus-5[1m]', label: 'Opus 5 (1M)' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M)' },
      // Opus 4.7·4.6 — 이전 세대 Opus(활성). id는 claude-api 모델 카탈로그 정본 표기 그대로(날짜 접미 금지).
      { id: 'claude-opus-4-7', label: 'Opus 4.7' },
      { id: 'claude-opus-4-6', label: 'Opus 4.6' },
      { id: 'claude-opus-4-6[1m]', label: 'Opus 4.6 (1M)' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    ],
  },
  codex: {
    // mcp: 이 러너가 **실제로 MCP 서버를 받는가**. kind로 갈음하면 안 된다 — codex는 CLI지만
    // v0.1.41부터 config.toml(sandbox 설정과 같은 파일)로 MCP를 실제로 받는다. gemini는 settings.json으로
    // 받는다(2026-08-21). antigravity는 설정이 호스트 HOME 전용이라 회사별 주입을 하지 않는다. 화면 경고가 kind만 보면 codex 크루에게
    // "어차피 안 돈다"는 거짓을 말하게 된다(분리 검수 2026-08-19 MED-C).
    name: 'Codex', kind: 'cli', mcp: true,
    models: [
      // GPT-5.6 패밀리(2026-07-09) — Sol(플래그십)·Terra(중간)·Luna(경량). sol id는 로컬 codex 설정으로 실증
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
      { id: 'gpt-5.5', label: 'GPT-5.5' },
    ],
  },
  gemini: {
    name: 'Gemini', kind: 'cli', mcp: true, // settings.json mcpServers 주입(0.21.2 mcp list 실프로브 2026-08-21)
    models: [
      // 실측(2026-07-19): OAuth(Code Assist) 경로 실턴 통과 = 2.5 Pro/Flash. 3.x id는 실존하나
      // (gemini-cli 공식 문서 get-started/gemini-3) Google AI Ultra 구독·유료 계정에만 개방 —
      // 무료 로그인 계정은 "Requested entity was not found"로 턴이 죽는다(실사용 신고 재현·원인 확정).
      // 카탈로그 규칙: 실행 경로 실턴 통과 id만 — 문서만 보고 추가 금지. 단, 접근권 게이트 모델은
      // gated:true(모델 메뉴 배지 표시) + 채팅 런타임 강등 가드(chat.mjs GATED_MODEL_ERR_RE —
      // 기본 모델 1회 자동 재시도) 전제로 허용한다. 첫 항목은 무권한 계정도 도는 모델일 것
      // (러너 전환 시 models[0]이 기본 선택되므로 게이트 모델을 앞에 두면 무료 계정이 이유 없이 죽는다).
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', gated: true },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', gated: true },
    ],
  },
  antigravity: {
    name: 'Antigravity', kind: 'cli',
    // BYOA 2호(2026-07-27) — 구글이 개인용 Gemini Code Assist OAuth를 폐기하고 Antigravity로 이전
    // (피드백 38e5281d가 규명). Gemini **구독** 사용자의 유일한 경로라 CLI(agy) 래핑으로 태운다.
    // 자격은 OS 키링(파일 아님) — 호스트 로그인 옵트인 전용, 붙여넣기·API키 없음(GEMINI_API_KEY 무시 실측).
    // 모델 목록 = `agy models` 실측(agy 1.1.7, 2026-07-27). ⚠ 실계정 실턴은 미검증(이 맥에 agy 로그인
    // 없음 — 카탈로그 규칙의 예외로 두되, 베타 확인 후 이 표기를 지울 것). 첫 항목이 러너 전환 기본값.
    models: [
      { id: 'gemini-3.6-flash-medium', label: 'Gemini 3.6 Flash' },
      { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash High' },
      { id: 'gemini-3.6-flash-low', label: 'Gemini 3.6 Flash Low' },
      { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro High' },
      { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro Low' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Antigravity)' },
      { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 Thinking (Antigravity)' },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Antigravity)' },
    ],
  },
  kimi: {
    name: 'Kimi', kind: 'sdk-compat',
    models: [
      // platform.kimi.ai 모델 문서(2026-07 확인) — K3가 플래그십(1M 컨텍스트), K2.7-code는 코딩 특화
      { id: 'kimi-k3', label: 'Kimi K3' },
      { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' },
      { id: 'kimi-k2.6', label: 'Kimi K2.6' },
    ],
  },
  openrouter: {
    name: 'OpenRouter', kind: 'sdk-compat',
    // BYOK 계열 일반화(설계 2026-07-27) — 키 하나로 수백 모델. 카탈로그 규칙: 이 목록에는
    // **실키 tool_use 스모크(scripts/openrouter-smoke.mjs)를 통과한 id만** 넣는다.
    // 아래 8종 = 2026-07-27 스모크 8/8 통과 실측(일반 응답 + tool_use 왕복).
    // 첫 항목이 러너 전환 시 기본 선택 — 저비용·도구 신뢰성 기준(gemini 카탈로그 관례와 동일).
    // 카탈로그 밖 id는 크루 카드에 넣어도 chat이 기본 모델로 강등한다 — 추가는 스모크 통과 후 여기로만.
    models: [
      // ── 무료 모델(:free) 우선 — **첫 항목은 잔액 0 계정에서도 도는 모델이어야 한다**(gemini
      // 카탈로그와 같은 원칙: models[0]이 러너 전환·모델 미지정의 기본값이라, 유료 모델을 앞에
      // 두면 신규 키($0이 기본)의 영입·기억정리가 전부 402로 죽는다 — 검수 CRITICAL 2026-07-27).
      // 스모크 3/3 통과 실측(유료와 같은 tool_use 왕복 게이트). 무료 티어는 요청 한도(20/분,
      // 누적 구매 $10 미만이면 50/일)와 제공사 용량 편차가 있어 free 플래그로 UI에 배지 표시.
      { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super 120B', free: true },
      { id: 'inclusionai/ling-3.0-flash:free', label: 'Ling 3.0 Flash', free: true },
      { id: 'poolside/laguna-s-2.1:free', label: 'Laguna S 2.1', free: true },
      // ── 유료 — 잔액이 있는 사용자가 명시 선택(품질·속도 우위)
      { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' },
      { id: 'openai/gpt-5.5', label: 'GPT-5.5' },
      { id: 'x-ai/grok-4.5', label: 'Grok 4.5' },
      { id: 'minimax/minimax-m3', label: 'MiniMax M3' },
      { id: 'qwen/qwen3.7-max', label: 'Qwen3.7 Max' },
      { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { id: 'moonshotai/kimi-k3', label: 'Kimi K3 (OpenRouter)' }, // 직접 연결(kimi 러너)이 더 저렴 — 단일 키 사용자용
      { id: 'z-ai/glm-5.2', label: 'GLM-5.2 (OpenRouter)' },       // 동일 — 직접 연결(glm 러너) 우선 권장
    ],
  },
  grok: {
    name: 'Grok', kind: 'sdk-compat',
    // xAI는 Anthropic 호환 `/v1/messages`를 연다 — 무자격 프로브 실측(2026-08-03):
    // 가짜 키 → 400 `Incorrect API key`(본문이 파싱돼 인증 단계까지 갔다) / 없는 경로 → 404(대조군).
    // 그래서 GLM·Kimi와 같은 sdk-compat 배관을 그대로 쓴다(새 SDK·새 의존성 0).
    //
    // **카탈로그 규칙(실턴 스모크 통과분만 등재)을 아직 못 지킨 상태다 — 이 기기에 xAI 자격이 없다.**
    // 두 id의 근거는 각각 다르고, 직접 연결 스모크는 미실시다:
    //   grok-4.5·grok-4.3  **존재 실측 확정**(2026-08-26 차등 프로브 — xAI는 모델을 키보다 먼저
    //             검사한다: fake key + 없는 모델 → 400 "Model not found", fake key + 이 두 id →
    //             400 "Incorrect API key"로 인증 단계까지 감 = 모델은 실재). 실턴(응답 품질·도구 왕복)은 여전히 미검증.
    // 발행 전에 실키 왕복으로 확정할 것.
    models: [
      { id: 'grok-4.5', label: 'Grok 4.5' },
      { id: 'grok-4.3', label: 'Grok 4.3' },
    ],
  },
  glm: {
    name: 'GLM', kind: 'sdk-compat',
    models: [
      // docs.z.ai(2026-06-13 출시) — 5.2가 플래그십(1M 컨텍스트)
      { id: 'glm-5.2', label: 'GLM-5.2' },
      { id: 'glm-5.1', label: 'GLM-5.1' },
      { id: 'glm-4.6', label: 'GLM-4.6' },
      { id: 'glm-4.5-air', label: 'GLM-4.5 Air' },
    ],
  },
};

/** "이 컴퓨터 로그인 사용" 옵트인 허용 여부 — runnerStatus·저장(PUT) 라우트가 공유(단일 판정).
    codex/gemini(파일 자격)는 환경 무관. claude(키체인)는 SDK가 키체인을 열 수 있는 non-standalone에서만
    — 데스크톱 번들(ARGO_STANDALONE)은 재서명 node가 키체인에 막혀 회귀를 내므로 제외(setup-token이 정식). */
export const hostOptInAllowed = (runner) =>
  !!RUNNER_AUTH[runner]?.hostUsable
  && !process.env.ARGO_TENANT_OWNER // 다중테넌트 호스팅에선 운영자 CLI 로그인을 테넌트가 빌리지 못하게(setupOneClick과 대칭, 검수 LOW)
  && (runner !== 'claude' || process.env.ARGO_STANDALONE !== '1');

/** 외부 CLI 러너 판정 — 디스패치(chat/oneshot)의 단일 진실. 하드코딩 열거('codex'||'gemini')는
    러너 추가 때마다 배선 누락을 만든다(#119 전수 수색의 교훈) — kind가 카탈로그에 있으니 그걸 쓴다. */
export const isCliRunner = (r) => RUNNERS[r]?.kind === 'cli';

export const GLM_DEFAULT_MODEL = 'glm-5.2';

const OPENROUTER_402_RE = /^API Error:\s*402\b/i; // 느슨판·엄격판 공용 — 한쪽만 고치면 두 임계가 갈라진다(검수 LOW)
// 429 = 요청 한도(무료 티어 20/분·50~1000/일, 공식 문서 2026-07-27). 402와 같은 표면으로
// 도착하므로 같은 임계 구조를 대칭 적용한다 — 미대응이면 429 원문이 일지→기억으로 정제된다.
const OPENROUTER_429_RE = /^API Error:\s*429\b/i;
const firstOrLast = (s, re) => {
  const lines = String(s ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  return !!lines.length && (re.test(lines[0]) || re.test(lines[lines.length - 1]));
};
const strictReply = (s, re) => firstOrLast(s, re)
  && String(s ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !re.test(l)).join('').length <= 60;

/** OpenRouter 402(크레딧 소진) 판정 — CLI가 402를 "성공 텍스트"로 삼킨 결과물(실측). 첫 줄 또는
    마지막 비공백 줄이 402 에러로 시작할 때만 — 서두 문장 뒤에 에러가 붙는 변형(2R N4)은 잡되,
    산문 중간 인용("…'API Error: 402'가 나오면…")은 배제. **oneshot(실패 승격) 전용** —
    미탐이면 402 원문이 크루 카드·기억에 저장되므로 느슨한 쪽이 맞다. chat은 아래 strict를 쓴다(3R F1). */
export const isOpenRouterCreditError = (s) => firstOrLast(s, OPENROUTER_402_RE);

/** chat용 엄격 판정 — 답변이 사실상 402 원문일 때만(에러 줄을 뺀 잔여 텍스트 ≤ 60자).
    chat에서 오탐은 사실 아닌 충전 안내 + **그 턴 일지의 무증상 누락**(creditTurn, 3R F1 실측:
    사장이 402 원문을 붙여넣고 물으면 크루가 그 줄로 답을 시작/끝냄)이라, 서두 인용·해설처럼
    실질 답변이 있는 턴은 통과시킨다. 실측 402는 에러 한 줄 그 자체(±짧은 CLI 서두)다.
    비율 기준이 아니라 **잔여량 절대 상한**인 이유(검수 권고): 비율은 402 문구 길이에 종속돼
    OpenRouter가 문구를 바꾸면 경계가 조용히 이동하고, 긴 서두 변형의 미탐(2R N3 재발)도 빨라진다. */
export const isOpenRouterCreditReply = (s) => strictReply(s, OPENROUTER_402_RE);

/** 429(요청 한도) — 402와 대칭. oneshot=느슨판(실패 승격), chat=엄격판(안내+일지 제외). */
export const isOpenRouterLimitError = (s) => firstOrLast(s, OPENROUTER_429_RE);
export const isOpenRouterLimitReply = (s) => strictReply(s, OPENROUTER_429_RE);

/** SDK가 벤더 API 오류를 "성공 답변 텍스트"로 삼킨 결과물 판정 — OpenRouter 402 선례의 일반형.
    실측(2026-08-31, 가짜 grok 자격 + 실배관): xAI 400에서 SDK result가 subtype 'success' +
    is_error true + result 전체가 `API Error: 400 {"code":"invalid-argument",...}`. 이대로 두면
    오류 원문이 크루 답변으로 채택돼 AUTH_ERR_RE 자가치유·번역이 전부 미발동한다(유건 제보의 실체).
    엄격판: **trim한 답변이 오류 원문으로 시작**할 때만 — 호출부는 result.is_error와 이중 게이트로
    쓴다(오류를 인용·해설하는 정상 답변 보호, openrouter 3R F1과 같은 원칙). */
export const isSdkErrorReply = (s) => /^API Error:\s*\d{3}\b/.test(String(s ?? '').trim());

/** SDK 삼킴 **종합** 판정(순수) — result가 "성공"으로 포장된 벤더 오류인가. 두 신호의 합집합:
    ① result.api_error_status ≥ 400 (실측 2026-08-31: 가짜 grok 자격 실배관에서 400이 실린다 —
       SDK 소스도 is_error+subtype success의 result를 오류 텍스트로 해석) — 'API Error:' 문구
       형식을 SDK가 보장하지 않으므로 형식이 다른 삼킴까지 이 신호가 잡는다(#372 검수 NIT).
    ② 문구 엄격판(isSdkErrorReply) — status 필드가 없는 구버전 SDK 폴백.
    is_error가 거짓이면 항상 거짓 — 오류를 인용하는 정상 답변 보호(이중 게이트 유지). */
export const isSwallowedSdkError = (isError, apiErrorStatus, reply) =>
  !!isError && (Number(apiErrorStatus) >= 400 || isSdkErrorReply(reply));

/** 러너 인증 실패의 사용자 안내 — "API Error: 400" 원문만으론 사용자가 할 일을 모른다(유건 제보).
    문구 위치는 grokCreditNotice(grok.mjs)와 같은 서버측 이중언어 계약. 원문 대체가 아니라
    **원문 뒤에 붙이는 행동 안내**로도 쓰인다(정직 오류 원칙 — 벤더 상세 보존). */
export const runnerAuthNotice = (lang, runner) => {
  const name = RUNNERS[runner]?.name ?? runner;
  return lang === 'en'
    ? `${name} sign-in looks expired or invalid — reconnect it in Settings → AI connections, then try again. (If this keeps happening, remove and re-add the connection.)`
    : `${name} 로그인이 만료됐거나 유효하지 않은 것으로 보입니다 — 설정 → AI 연결에서 ${name}을(를) 다시 연결한 뒤 시도해 주세요. (반복되면 연결을 지우고 새로 추가해 주세요.)`;
};

// 채팅 기본 — 품질 우선(유료). 잔액 0이면 402가 뜨지만 안내문이 무료 모델 선택을 짚어 준다.
// ⚠ 이 상수를 무료로 바꾸면 **잔액이 충분한 사용자의 모든 크루 채팅**까지 무료 모델로 내려간다
//   (크루 카드는 model을 기록하지 않아 매 턴 이 기본값을 탄다 — 2R 검수 H1 실증). 온보딩 문제는
//   아래 ONBOARD 상수로 분리해 푼다.
export const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-haiku-4.5';
// 온보딩·자동 실행 기본(runOneShot) — **잔액 0에서도 도는 무료 모델**. 영입·기억정리·루틴 초안은
// 사용자가 모델을 고를 화면이 없는 자동 호출이라, 유료를 기본으로 두면 신규 키($0이 기본)가
// 연결 직후 첫 영입부터 402로 막힌다(검수 CRITICAL 2026-07-27). 카탈로그 선두와 일치.
export const OPENROUTER_ONBOARD_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
export const KIMI_DEFAULT_MODEL = 'kimi-k3';
/** Grok 기본 모델 — 카탈로그 첫 항목과 같아야 한다(러너 전환·모델 미지정의 기본값). */
export const GROK_DEFAULT_MODEL = 'grok-4.5';

// 러너별 지원 인증 방식. apikey=붙여넣기(4러너 공통), oauth=붙여넣기 토큰(claude) 또는 호스트 로그인(codex/gemini).
// glm은 Anthropic 호환 토큰(사실상 apikey)만.
// connect: 벤더 CLI의 브라우저 로그인을 서버가 대신 실행할 수 있는 러너(로컬/데스크톱 전용).
//   bin/loginArgs=로그인 실행, statusArgs=읽기전용 상태확인, ok=로그인됨 판정 정규식.
//   codex만 spawn 가능한 login이 있다. claude는 이 CLI에 login 서브커맨드가 없어(구독은 키체인)
//   oauthPasteable 토큰 붙여넣기로, gemini는 CLI 설치 후 로그인 안내로 대체한다.
export const RUNNER_AUTH = {
  // claude 웹 브리지(webConnect)는 철회(2026-07-18) — 구세대 엔드포인트 교환이 러너가 거절하는
  // 비 oat01 토큰을 저장해 "연결됨인데 전 턴 401"을 만들었다(실측). CLAUDE_CODE_OAUTH_TOKEN은
  // 공식 규격상 `claude setup-token`으로만 발급 — UI는 붙여넣기 안내로 일원화(WEB_OAUTH 주석 참조).
  // claude hostUsable: "이 컴퓨터 로그인 사용" 옵트인 지원. 단 codex/gemini(파일 자격)와 달리 claude는
  // 키체인 보관이라, SDK가 그 키체인을 열 수 있는 환경에서만 유효하다 — 일반 node(상주/웹/dev)에서는
  // SDK query()가 호스트 Claude Code 로그인으로 인증됨을 실측(2026-07-19). 데스크톱 번들(ARGO_STANDALONE)의
  // 재서명 node는 키체인 ACL이 막아 "Not logged in" 회귀를 낸 전례가 있어, claude host는 non-standalone에서만
  // 노출한다(claudeHostAllowed). 데스크톱은 setup-token 원클릭이 정식 경로.
  claude: { methods: ['apikey', 'oauth'], apikeyPrefix: 'sk-ant-', oauthPrefix: 'sk-ant-oat01-', oauthPasteable: true, oauthEnv: 'CLAUDE_CODE_OAUTH_TOKEN', hostUsable: true, keyUrl: 'https://console.anthropic.com/settings/keys' },
  codex: { methods: ['apikey', 'oauth'], apikeyPrefix: 'sk-', oauthPasteable: false, webConnect: true, hostUsable: true, keyUrl: 'https://platform.openai.com/api-keys', connect: { bin: 'codex', loginArgs: ['login'], statusArgs: ['login', 'status'], ok: /Logged in/i } },
  gemini: { methods: ['apikey', 'oauth'], apikeyPrefix: '', oauthPasteable: false, webConnect: true, hostUsable: true, keyUrl: 'https://aistudio.google.com/apikey' },
  glm: { methods: ['apikey'], apikeyPrefix: '', oauthPasteable: false, keyUrl: 'https://z.ai/manage-apikey/apikey-list' },
  kimi: { methods: ['apikey'], apikeyPrefix: '', oauthPasteable: false, keyUrl: 'https://platform.moonshot.ai/console/api-keys' }, // 접두사 무차단(GLM 관례) — 리전·미래 키 형식 변화에 저장이 막히지 않게, 판정은 verifyRunnerCred가
  openrouter: { methods: ['apikey'], apikeyPrefix: '', oauthPasteable: false, keyUrl: 'https://openrouter.ai/keys' }, // BYOK 단일(설계 2026-07-27) — OAuth·크레딧 대행 안 함
  // Grok — BYOK(키)와 BYOA(계정 로그인) 둘 다. 계정 로그인은 **기기 코드**라 콜백 리스너가 없다:
  // 상주(launchd 백그라운드)·헤드리스 VPS·포트 선점 환경에서 루프백 도달성 문제 자체가 안 생긴다
  // (v0.1.38에서 겪은 그 문제 — #223). webConnect를 켜 기존 "버튼 → 링크 → 폴링" UI를 그대로 쓰고,
  // deviceCode 플래그로 라우트가 기기 코드 분기를 탄다. 붙여넣을 코드가 없으니 oauthPasteable은 false.
  // 접두사는 걸지 않는다(GLM·Kimi 관례) — 키 형식이 바뀌면 저장부터 막혀 사용자가 손 쓸 데가 없다. 판정은 verifyRunnerCred가.
  grok: { methods: ['apikey', 'oauth'], apikeyPrefix: '', oauthPasteable: false, webConnect: true, deviceCode: true, keyUrl: 'https://console.x.ai' },
  // antigravity: 자격이 OS 키링(파일 아님)이라 붙여넣기·API키·웹 브리지 전부 불가 — 호스트 로그인
  // 옵트인이 유일한 경로다(agy가 GEMINI_API_KEY를 무시함은 공식 문서 확인). keyUrl은 설치·로그인 안내.
  // **정의 순 = pickRunner 자동 선택 순 — 반드시 맨 끝**: 키링이라 로그인 여부를 파일로 판정할 수 없는
  // 유일한 러너로 authed가 낙관값이다. 검증된 자격보다 앞에 두면 미로그인 antigravity가 동작하는
  // 러너를 선점해 러너 미지정 크루의 전 턴이 타임아웃으로 죽는다(분리 검수 H1 실증 2026-07-27).
  antigravity: { methods: ['oauth'], apikeyPrefix: '', oauthPasteable: false, hostUsable: true, keyUrl: 'https://antigravity.google/docs/cli/install' },
};

/** exclude 정규화(내부) — 문자열 하나·목록·null을 전부 목록으로. exclude 계약(무엇이 유효한 제외
    입력인가)이 이 한 줄에 산다 — 소비자마다 따로 강제 조정하면 갈라진다(이 레포 전례: 위 공유 판정의
    소비자별 임계 분리 사고). 생산자(excludeWith)와 소비자(pickRunner)가 같은 정의를 본다. */
const asList = (exclude) => (Array.isArray(exclude) ? exclude : exclude ? [exclude] : []);

/** 자가치유 누적 제외 목록 — 방금 죽은 러너를 이전 제외 목록에 더한다(pickRunner exclude 계약의 생산자).
    목록이 재시도마다 1개씩 늘어 러너 수(≤7)로 자연 종료되므로, 자가치유의 **종료성이 이 함수에 걸려
    있다**: 받은 목록을 버리고 [runner]로 좁히면 프레임마다 앞의 실패를 잊어 무한 핑퐁이 된다.
    단수 1회 제한이던 시절엔 claude 401 → codex 실패에서 끝나 멀쩡한 3번째 러너가 시도조차 못 받았다
    (oneshot=#192, 트래픽이 더 많은 chat=#197). 두 경로가 이 함수를 공유한다. (export: 회귀 테스트용) */
export function excludeWith(prev, runner) {
  return [...asList(prev), runner];
}

/** 러너 선택(순수) — st = runnerStatus 결과. 반환 { runner, fellBack, available, credButNoCli? }.
    가용 = **사장이 명시적으로 연결한 자격(유효)뿐** — 호스트 로그인 흔적의 자동 사용(스캐빈징)은
    하지 않는다(유건 지시 2026-07-19: 감지는 안내로만, 연결은 사장이. 실사용: 스테일/키체인 접근 불가
    호스트 흔적이 '연결중'으로 오표시되고 유효한 Codex를 밀어내 턴 사망). 호스트 로그인을 쓰려면
    "이 컴퓨터 로그인 사용" 옵트인(host 타입 자격)으로 연결한다 — 그때부터 connected로 잡힌다.
    무효(invalid) 자격은 가용이 아니다(게이트 anyRunnerUsable과 판정 일치).
    want = 크루 지정 러너(null이면 무선호 — 첫 연결 러너를 대체 고지 없이 쓴다).
    exclude = 방금 인증 실패한 러너(자가 치유 재시도 시 제외). (export: 회귀 테스트용) */
export function pickRunner(st, want, exclude = null, { defaultRunner = null } = {}) {
  const skip = new Set(asList(exclude));
  const usable = (id) => !!st[id]?.company.connected && !st[id]?.company.invalid && !skip.has(id);
  if (want && usable(want)) return { runner: want, fellBack: false, available: true };
  // ponytail: 회사 기본 러너 — "자동일 때 이 러너부터"(K1 해소, 유건 제보 2026-08-08: Grok만
  // 연결했는데 하드코딩 순서가 claude를 먼저 잡는다). 가용하면 우선, 아니면 기존 순서 폴백.
  if (defaultRunner && usable(defaultRunner)) return { runner: defaultRunner, fellBack: !!want, available: true };
  const ids = Object.keys(RUNNER_AUTH);
  const next = ids.find(usable);
  if (next) return { runner: next, fellBack: !!want, available: true }; // 무선호(want=null)는 대체가 아니다
  // 아무 러너도 없음 — 호출부가 안내 에러를 만든다(원래 러너 반환은 에러 문구용).
  // credButNoCli — 자동 조달 도입으로 "자격은 있는데 CLI가 없어 차단"이 사라져 항상 빈 배열이다.
  // 필드는 소비처(chat/oneshot의 안내 분기) 호환으로 유지 — 미래에 조달 불가 플랫폼이 생기면 되살린다.
  return { runner: want ?? 'claude', fellBack: false, available: false, credButNoCli: [] };
}

/** 자동(카드에 러너 미지정) 크루가 실제로 받을 러너 id — 턴과 같은 판정(pickRunner, 폴백 순서 포함).
    /api/runners가 이 값을 autoRunnerId로 내려주고 크루 카드가 CLI 경고 판정에 쓴다(검수 PR #209 L4:
    클라가 폴백 순서를 복제하면 갈라진다). 라우트가 아니라 코어에 두는 이유: 라우트 파일은 auth 계층
    (next/headers)에 묶여 Next 밖 단위 테스트가 열 수 없다 — 판정은 코어, 라우트는 배선만.
    (export: 회귀 테스트용) */
export function autoRunnerOf(company) {
  const auto = company ? pickRunner(company, null) : null;
  return auto?.available ? auto.runner : null;
}

/** claude OAuth 토큰 형식 안내(순수) — 형식이 다른 값(웹 브리지 교환 산출물·setup-token 중간 인증
    코드 오입력)이 저장을 통과한 뒤 모든 턴이 401로만 드러나던 것을 저장 시점에 잡는다
    (실측 2026-07-18: 92자 비접두사 값 저장 → 전 턴 "401 Invalid authentication credentials").
    반환: null(정상) | 사용자 안내 문자열. (export: 회귀 테스트용) */
/** 자가치유가 인증 실패 러너를 전부 제외해 실행할 곳이 없을 때의 정직한 문구.
    기존 "하나도 연결돼 있지 않습니다"는 방금 연결한 사용자에게 거짓이 된다 — Grok 실사용 제보
    (2026-08-06): 연결 직후 401(토큰 만료·갱신 실패 등)로 제외되자 '러너 없음'을 받았다.
    chat·oneshot 두 갈래가 같은 문구를 쓴다(#855604d "실행 갈래가 둘이면 갈래마다 세라").
    (export: 회귀 테스트용 — 순수 함수) */
export function authExcludedNoRunnerMsg(excluded, lang = 'ko') {
  const names = (excluded ?? []).map((id) => RUNNERS[id]?.name ?? id).join('/');
  return lang === 'en'
    ? `${names} is connected but hit an authentication error this turn, and no other runner is connected. Check ${names} in Settings → AI connections (reconnect if it keeps happening), or connect another runner.`
    : `${names} 러너가 연결돼 있지만 인증 오류로 이번 턴에서 제외됐고, 연결된 다른 러너가 없습니다. 설정 → AI 연결에서 ${names} 상태를 확인하고(반복되면 다시 연결) 또는 다른 러너를 연결해 주세요.`;
}

export function oauthFormatError(runner, value, lang = 'ko') {
  const prefix = RUNNER_AUTH[runner]?.oauthPrefix;
  if (!prefix || String(value ?? '').trim().startsWith(prefix)) return null;
  return lang === 'en'
    ? `That value isn't a Claude OAuth token. Run claude setup-token in your terminal and paste the token it prints at the end — it starts with ${prefix}. (The code shown in the browser is an intermediate value you paste into the terminal, not here.)`
    : `이 값은 Claude OAuth 토큰이 아닙니다. 터미널에서 claude setup-token 을 실행해 마지막에 출력되는 ${prefix} 로 시작하는 토큰을 붙여넣어 주세요. (브라우저에 표시되는 인증 코드는 터미널에 넣는 중간 단계 값이지, 여기 넣는 값이 아닙니다.)`;
}
