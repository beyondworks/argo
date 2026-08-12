# 003_DeepSeek_러너_API_Key_연결_이슈_해결

## 1. 개요
사용자가 `deepseeklocal` 러너에 모델 정보를 변경/입력했을 때 계속 연결이 안 되고 401 오류(또는 타임아웃)가 발생하는 문제를 분석하고 해결한 내용입니다.

## 2. 현상 및 원인 분석

### 2.1 현상
- `.secrets.json` 파일에 `"deepseeklocal": { "type": "host", "value": "host" }`라는 잘못된 설정이 저장되어 있었습니다.
- 백엔드는 이를 '호스트 인증'으로 인식하여 API Key와 Base URL을 주입하지 않고 기본 URL(`http://100.103.65.62:8080`)로 키 없이 요청을 시도했고, 그 결과 서버에서 `401 Invalid API Key` 오류를 반환했습니다.
- 오류 발생 시 러너가 Fallback 동작(Claude 등으로 재시도)을 수행하려다 무한 대기에 빠지는 부작용도 있었습니다.

### 2.2 원인
1. **잘못된 UI 옵션 (`hostUsable: true`)**:
   - 이전 작업에서 `deepseeklocal` 러너에 `hostUsable: true` 속성을 추가하면서 UI에 "이 컴퓨터 로그인 사용" 버튼이 노출되었습니다.
   - 사용자가 이 버튼을 클릭하면 `.secrets.json`에 `type: host`로 저장되어, 정상적인 API Key 입력이 무시되는 상태(함정)에 빠졌습니다.
2. **API Key 파싱 로직의 경직성**:
   - 설정 창에서 API Key만 입력(`jini88**`)한 경우, 파서가 이를 URL로 잘못 인식하여 `jini88**/v1/models`로 요청을 보내 연결 검증에 실패했습니다.

## 3. 조치 사항

1. **`catalog.mjs` 수정**:
   - `deepseeklocal` 러너의 `hostUsable: true` 속성을 제거하여, UI에서 "이 컴퓨터 로그인 사용" 버튼이 노출되지 않도록 했습니다.
2. **`creds.mjs` 파싱 로직 강화**:
   - API Key 입력값을 더 똑똑하게 파싱하도록 수정했습니다.
   - `URL|APIKey` 형식: 기존대로 처리
   - `http://` 또는 `https://`로 시작: URL로 인식
   - 그 외: API Key로 인식하고 기본 URL(`http://100.103.65.62:8080`) 적용
3. **손상된 `.secrets.json` 자동 복구**:
   - `type: host`로 잘못 저장된 항목을 제거하고, 원래 사용자가 입력했던 API Key를 복구했습니다.

## 4. 확인 결과
- API Key(`jini88**`)가 로컬 서버(`http://100.103.65.62:8080`)로 정상적으로 전달됨을 확인했습니다.
- 만약 아직도 `401 Invalid API Key` 오류가 발생한다면, 이는 입력하신 `jini88**` 키가 해당 서버(llamacpp/vLLM)에 설정된 키와 일치하지 않기 때문일 수 있습니다. 서버의 API Key 설정을 다시 한 번 확인해 주세요.
