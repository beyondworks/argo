# DeepSeek Local 백엔드 통합 모듈 추가

## 변경 내역 (Diff)

Argo 프로젝트에 DeepSeek Local 러너를 추가하기 위해 백엔드 통합 모듈(`runners.mjs`, `chat.mjs`, `oneshot.mjs`)을 수정했습니다.

### 1. `src/runners.mjs` 수정
- `catalog.mjs` re-export 블록에 `isOpenAICompatRunner`, `DEEPSEEK_LOCAL_DEFAULT_MODEL` 추가
- `deepseek-local.mjs`의 `deepseekLocalCall`, `DEEPSEEK_LOCAL_DEFAULT_BASE` re-export 추가
- `billedByType` 함수에 `deepseekLocal` 러너 추가하여 과금 없음(false) 처리

### 2. `src/chat.mjs` 수정
- `runners.mjs` import 목록에 `isOpenAICompatRunner`, `DEEPSEEK_LOCAL_DEFAULT_MODEL` 추가
- `deepseek-local.mjs` import 추가 (`deepseekLocalCall`, `DEEPSEEK_LOCAL_DEFAULT_BASE`)
- `colleagues` 변수 조건에서 OpenAI 호환 러너(`isOpenAICompatRunner`)일 경우 동료 목록을 가져오지 않도록 수정
- CLI 러너 블록 종료 직후에 `isOpenAICompatRunner` 전용 실행 분기 추가 (도구·MCP 없이 텍스트 응답만 처리하는 구조)
  - `loadCapabilities(wsId)` 호출 추가로 `caps` 변수 스코프 문제 방지
  - `deepseekLocalCall` 함수를 통해 직접 엔드포인트 호출

### 3. `src/oneshot.mjs` 수정
- `runners.mjs` 및 `deepseek-local.mjs` import 갱신
- 러너 미연결 에러 메시지(한국어 및 영어)에 `DeepSeek Local` 항목 추가
- CLI 러너 블록 바로 뒤에 `isOpenAICompatRunner` 단발 호출 분기 추가

## 구문 검사
수정 후 `node --check src/runners.mjs && node --check src/chat.mjs && node --check src/oneshot.mjs` 실행 완료. 에러 없음.
