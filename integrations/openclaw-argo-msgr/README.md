# OpenClaw ↔ Argo Messenger (channel plugin)

오픈클로(OpenClaw)를 아르고 메신저에 **봇**으로 연결하는 채널 플러그인입니다. 텔레그램·슬랙 채널과 같은 자리이며, 오픈클로 코어 수정은 없습니다(플러그인 SDK만 사용).

## 설치 (한 번)

```bash
mkdir -p ~/.openclaw/extensions
cp -R integrations/openclaw-argo-msgr ~/.openclaw/extensions/openclaw-argo-msgr
```

(디렉터리 이름은 플러그인 id `openclaw-argo-msgr`와 같아야 합니다. 오픈클로가 둘을 대조합니다.)

## 연결 (원클릭)

1. 아르고 메신저 → 설정 → **크루와 서버** → **외부 에이전트** → [오픈클로 연결하기].
2. 한 번만 보이는 두 줄을 복사해 `~/.openclaw/.env`(또는 게이트웨이 환경)에 넣거나, `openclaw.json`에 적습니다.
   ```json5
   { channels: { "argo-msgr": { accounts: { default: { url: "https://<프로젝트>.supabase.co/functions/v1/msgr-bot", token: "argo_bot_…", enabled: true } } } } }
   ```
   env만 쓸 때는 `ARGO_MSGR_URL` / `ARGO_MSGR_BOT_TOKEN` (기본 계정에 적용).
3. `openclaw gateway` 재시작 → 로그에 `Argo Messenger: connected as 오픈클로 (openclaw) in org …`, 메신저 카드가 "오픈클로 에이전트 연결됨 · 시각".
4. 봇을 채널에 넣으려면 채널 "+ 추가 → 크루". 이후 `@오픈클로 …` 멘션·DM·봇 글에 대한 답글에만 반응합니다.

## 동작

- `getUpdates` 롱폴(offset = ack) → 오픈클로 에이전트 세션 → `sendMessage`(원글 답글, 원글당 하나). 접근 판정(누가 시킬 수 있는지, 채널 정책)은 전부 아르고 서버라 여기엔 허용 목록·페어링이 없습니다(dmPolicy open).
- 토큰이 폐기·회전되면(401) 채널이 멈추고 오류를 남깁니다. 메신저에서 토큰을 다시 만들어 설정을 갱신하세요.
- `startAccount`는 중지 신호까지 대기합니다(이 오픈클로 버전은 프로미스가 끝나면 계정을 재시작합니다).

## 검증 기록 (2026-09-08, openclaw 2026.2.23)

로컬 Supabase 스택 + 임시 `OPENCLAW_CONFIG_PATH`/`OPENCLAW_STATE_DIR`로 게이트웨이 기동 — 플러그인 적재, getMe 접속, 폴링(카드 "연결됨"), 멘션 → 에이전트 → 원글 답글까지 통과. 임시 상태에는 모델 제공자 키가 없어 답 내용은 오류문(`No API key found for provider "anthropic"`)이었습니다. 실제 답변은 오픈클로에 모델 제공자를 설정한 뒤 같은 경로로 나옵니다.
