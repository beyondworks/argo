# DeepSeek Local Runner 추가

## 개요
Argo 프로젝트에 DeepSeek Local (OpenAI 호환 API) 러너를 추가하였습니다. SDK나 CLI를 사용하지 않고 직접 `fetch`를 이용하여 `/v1/chat/completions` 엔드포인트를 호출하는 구조입니다.

## 변경 내역 (Diff)
1. **`src/runners/deepseek-local.mjs` 신규 생성**
   - `deepseekLocalCall`: `fetch` 기반 통신 (system, user 메시지 처리)
   - `verifyDeepseekLocal`: `/v1/models`를 호출하여 서버 연결 상태 확인

2. **`src/runners/catalog.mjs` 수정**
   - `RUNNERS`에 `deepseekLocal` (kind: 'openai-compat') 추가
   - `isOpenAICompatRunner` 함수 추가
   - `DEEPSEEK_LOCAL_DEFAULT_MODEL` 상수 추가
   - `RUNNER_AUTH`에 `deepseekLocal` 인증 정보(서버 주소 자체를 자격 값으로 사용) 추가 (`antigravity` 직전)

3. **`src/runners/creds.mjs` 수정**
   - `runnerCredEnv` 함수에 `deepseekLocal`을 위한 환경변수 `DEEPSEEK_LOCAL_BASE_URL` 설정 분기 추가
   - `verifyRunnerCred` 함수에 `/v1/models` 검증 분기 추가

4. **`src/runners/exec.mjs` 수정**
   - `detectRunners()`에 `deepseekLocal` 캐시 초기값(`installed: true`, `authed: false`) 추가

5. **`src/runners/shared.mjs` 수정**
   - `PROVIDER_AUTH_OWNERS`에 `DEEPSEEK_LOCAL_BASE_URL` 할당

## 관련 파일
- [src/runners/deepseek-local.mjs](file:///home/bhlee/services/argo_agent/argo/src/runners/deepseek-local.mjs)
- [src/runners/catalog.mjs](file:///home/bhlee/services/argo_agent/argo/src/runners/catalog.mjs)
- [src/runners/creds.mjs](file:///home/bhlee/services/argo_agent/argo/src/runners/creds.mjs)
- [src/runners/exec.mjs](file:///home/bhlee/services/argo_agent/argo/src/runners/exec.mjs)
- [src/runners/shared.mjs](file:///home/bhlee/services/argo_agent/argo/src/runners/shared.mjs)
