# OpenRouter 러너 — API 계열 1호 설계

> 2026-07-27 유건 승인. 이 파일이 정본이다.

## North Star (사용자 결과 한 문장)

> 사용자가 OpenRouter 키 하나로 342개 모델 중 아무거나 크루의 두뇌로 꽂아도, 권한·결재·능력·기억·MCP가 Claude 러너와 **완전히 동일하게** 동작한다.

## 왜 이 트랙인가 (코어 이슈의 첫 해소)

`runners.mjs` 단일 파일 커밋 52개의 구조 원인 = "러너 = 외부 에이전트 CLI 통째"(codex·gemini).
CLI마다 자기 인증·샌드박스·설정·버전 드리프트가 딸려 와 접합부 수리가 끝나지 않는다.
Hermes·opencode에 러너 차등이 없는 이유는 **러너 = 모델 API, 도구·권한 = 하네스 하나**이기 때문.

Argo에는 이미 그 계열이 있다 — GLM·Kimi는 `ANTHROPIC_BASE_URL` 치환만으로 SDK 루프를 탄다
(`glmEnv`/`kimiEnv`, runners.mjs:213-226). OpenRouter는 이 계열의 일반화다: 한 번 붙이면
342개 모델(2026-07-27 실측)이 같은 길로 들어오고, 이후 신모델은 코드 0줄로 추가된다.

## 실측 근거 (2026-07-27)

- `GET https://openrouter.ai/api/v1/models` → 200, **342 models** (공개, 무키)
- `POST https://openrouter.ai/api/v1/messages` (Anthropic 호환 Messages) → 무키 **401**
  = 엔드포인트 실존, 인증만 요구. **[구현 첫 게이트] 실키로 1콜 검증** — tool_use 블록까지
  왕복 확인. 여기서 실패하면 이 설계 전체를 재검토(호환 셰임 레이어는 별도 결정).

## 설계

### 1. 실행 — SDK 계열 (신규 코드 최소)

```js
// runners.mjs — glmEnv와 동일 패턴
export const openrouterEnv = (key) => ({
  ...scrubServerSecrets(process.env, 'openrouter'),
  ANTHROPIC_BASE_URL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api',
  ANTHROPIC_AUTH_TOKEN: key,
  ANTHROPIC_API_KEY: '',
  CLAUDE_CODE_OAUTH_TOKEN: '', // 감사 2026-07-20 대칭 — 제3자 향 턴에 Anthropic 토큰 잔존 금지
});
```

- 권한 게이트(permission-gate)·능력 토글·request_capability 카드·MCP·기억·결재 — **전부 SDK
  경로 그대로 자동 상속.** 이 트랙의 존재 이유. runner-denial(외부 CLI용) 같은 사후 보정 불요.
- 베이스 URL 경로는 구현 시 실키로 확정(`/api` vs `/api/v1` — SDK가 `/v1/messages`를 덧붙이는
  규약 대조). GLM·Kimi 선례상 리스크 낮음.

### 2. 자격 — BYOK apikey 단일 (구독 없음)

- `RUNNER_AUTH.openrouter = { methods: ['apikey'], apikeyPrefix: 'sk-or-', keyUrl: 'https://openrouter.ai/keys' }`
- 저장 전 실검증(기존 관문): `GET /api/v1/key` (잔액·한도 응답)로 유효성 프로브 — 거짓 '연결됨' 금지.
- billing: `rowBilled` 판정에서 apikey → 청구 ✓ (#118의 단일 진실에 그대로 합류. 신규 배선 0)

### 3. 모델 카탈로그 — 동적 + 추천 셋 (하드코딩 금지)

- 342개를 드롭다운에 다 못 넣는다. **추천 셋(6~8개, tool-use 검증 통과 모델만) + 검색 자유 입력.**
- `/api/v1/models`를 서버가 6h 캐시(파일) — 목록 API 장애 시 캐시 폴백(외부 API 의존 규칙).
- **tool 지원 필터**: 응답의 `supported_parameters`에 `tools` 없는 모델은 숨기지 않되
  "도구 미지원 — 크루가 손발 없이 답만 한다" 배지(정직 표기, MCP 경계 원칙과 동일).
- 크루 카드의 model 필드 형식: `openrouter:{vendor/model}` (기존 `runner:model` 규약 그대로).

### 4. 사용액 — 정확할 때만 돈을 말한다 (신고 계열 재발 방지)

- SDK가 리포트하는 `total_cost_usd`는 **Anthropic 단가 계산이라 OpenRouter 모델에선 오액**.
  틀린 금액 표시는 이번에 죽인 신고 계열의 재발이다 → **P1: openrouter 턴은 `costUsd: null`**
  (턴수만 집계 — hasCost를 만들지 않는다).
- P2: OpenRouter `GET /api/v1/generation?id=` 의 실비(`total_cost`)를 턴 후 비동기 기록.
  그때부터 금액 표시·예산 게이트에 합류.

### 5. 범위 밖 (YAGNI)

- OpenRouter OAuth/크레딧 구매 대행 — 안 한다(BYOK만).
- codex·gemini의 SDK 계열 이관 — 별도 트랙(구독 BYOA는 CLI 유지 + "근사 권한" 정직 표기).
- 폴백 라우팅(모델 장애 시 자동 전환) — OpenRouter 자체 기능으로 충분, Argo가 안 만든다.

## 검증 계획 (출하 관문 4 + 관문 0.5)

1. 단위: openrouterEnv 순수 함수(스크럽·토큰 소거), 카탈로그 캐시 폴백, 자격 프로브 게이트.
2. 격리 E2E(임시 ARGO_ROOT + 별도 포트 + 실키): 연결 → 크루 영입 → ①일반 답변 ②도구 턴
   (파일 쓰기 → 능력 OFF 카드 발화 확인 — **러너 차등 0의 실증**) ③MCP 턴. 추천 셋 전 모델 스모크.
3. 규모 질문(관문 0.5): 모델 342개 → 카탈로그 UI가 검색형이라 무영향. 캐시 파일 1개.
   회사 100개 → 캐시는 전역 1개(모델 목록은 회사 무관). 문제 없음.
4. 분리 검수 → :3001 실검증 → 발행.

## 리스크

| 리스크 | 대응 |
|---|---|
| Anthropic 호환이 tool_use에서 불완전 | 구현 첫 게이트에서 실키 검증 — 실패 시 설계 재검토(셰임 금지) |
| 저품질 모델로 크루 품질 저하 신고 | 추천 셋 = tool-use 스모크 통과 모델만, 나머지는 검색 + 배지 |
| 키 잔액 소진 시 전 턴 실패 | 402/잔액 오류를 러너 자격 오류로 매핑 — 기존 인증 자가치유 안내 재사용 |
