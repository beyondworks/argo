# 002_DeepSeek_러너_식별자_대소문자_오류_수정

## 1. 개요
사용자가 `deepseeklocal` (이전 `deepseekLocal`) 러너를 선택하고 대화를 시도했을 때, "지정 러너 deepseeklocal가 이 기기에 연결돼 있지 않아 Claude Code(으)로 대체 실행됐습니다"라는 에러 다이얼로그가 발생하는 문제를 분석하고 조치한 내용입니다.

## 2. 현상 및 원인 분석

### 2.1 현상
- 사용자가 DeepSeek 로컬 서버 연동을 설정한 뒤 채팅을 전송하면, 턴 처리가 실패하며 다음과 같은 오류 메시지가 출력됩니다.
  > 턴 실패: 지정 러너 deepseeklocal가 이 기기에 연결돼 있지 않아 Claude Code(으)로 대체 실행됐습니...

### 2.2 원인
- **식별자 대소문자 불일치:**
  Argo의 채팅 실행 로직(`src/chat.mjs`)에서는 클라이언트로부터 전달받은 러너 식별자를 다음과 같이 일괄 소문자화하여 사용합니다.
  ```javascript
  const wantRunner = ((runnerOverride || meta.runner || '')).toLowerCase() || null;
  ```
- 이로 인해, 프론트엔드와 백엔드(`catalog.mjs`, `creds.mjs` 등) 전반에 걸쳐 `deepseekLocal` (대문자 L 포함)로 등록되어 있던 러너가 `chat.mjs`로 진입할 때는 `deepseeklocal`로 변환되었습니다.
- `RUNNER_AUTH`나 상태(`st`) 맵에는 `deepseekLocal` 키로 존재하므로, `st['deepseeklocal']`은 undefined가 되어 러너가 "가용하지 않음(not usable)"으로 판정되었습니다.
- 그 결과 지정한 러너가 연결되지 않았다고 인식되어 Fallback (Claude 등 다른 러너로 대체 실행 시도) 동작이 발생하며 오류가 표출되었습니다. (어제 해결했던 `Gemini` 지정 시 오류와 유사한 자가치유 파생 오류입니다.)

## 3. 조치 사항
1. **식별자 일괄 치환 (deepseekLocal -> deepseeklocal):**
   - 하위 호환성 및 채팅 엔진의 강제 `.toLowerCase()` 변환 구조를 고려하여, 러너의 식별자를 전역에서 모두 소문자로 통일했습니다.
   - **프론트엔드:** `app/runner-connect.jsx`, `app/runner-usable.mjs`, `app/i18n.jsx` (`deepseeklocalHelp`, `deepseeklocalPh` 등으로 i18n 키까지 갱신)
   - **백엔드:** `src/runners/catalog.mjs`, `src/runners/creds.mjs`, `src/runners/exec.mjs`, `src/runners/shared.mjs`, `src/runners.mjs`
2. **패치 파일 갱신:**
   - 위의 전체 변경 사항을 반영하여 로컬 패치 파일(`patches/deepseek-and-claude-local.patch`)을 다시 생성했습니다.
   - 추후 `apply-local-patch.sh`를 통해 업데이트 후에도 원클릭으로 일관되게 수정 사항을 유지할 수 있습니다.
3. **`authed` 속성 참(true)으로 수정:**
   - `src/runners/exec.mjs`의 `detectRunners` 캐시에서 `deepseeklocal`의 `authed` 값이 `false`로 하드코딩되어 있어, 설정창에서 옵트인을 해도 백엔드 검증(`runnerStatus`)에서 항상 `invalid: true`가 떨어지는 문제를 확인했습니다.
   - 이를 `deepseeklocal: { installed: true, authed: true }`로 수정하여 옵트인 시 유효한 인증으로 통과되도록 조치하고 패치 파일에 추가 반영했습니다.
4. **API Key 인가 헤더 및 동적 모델 변경 지원 추가:**
   - 로컬 서버(`100.103.65.62:8080`)의 `/v1/chat/completions` 호출 시 API Key 인가(`401 Invalid API Key`)가 요구되는 환경을 지원하기 위해, `deepseekLocalCall` 및 `creds.mjs`에 `Authorization: Bearer <key>` 헤더 주입 및 `DEEPSEEK_LOCAL_API_KEY` 환경변수/`URL|apiKey` 파싱 지원을 추가했습니다.
   - `catalog.mjs`에 현재 로컬 서버 모델(`qwen3.6-27b-q4`)을 등록하여, 모델 변경 시에도 서버가 제공하는 정확한 모델 ID로 정상 연동되도록 고쳤습니다.

## 4. 향후 안내 사항
- 브라우저를 새로고침(F5)하여 프론트엔드의 최신 코드가 반영되도록 해주세요.
- 로컬 서버에 API 키 인가가 걸려있는 경우, 설정창에 `http://100.103.65.62:8080|YOUR_API_KEY` 형태로 입력하시거나 `DEEPSEEK_LOCAL_API_KEY` 환경변수를 지정하시면 401 오류 없이 정상 응답을 받으실 수 있습니다.
