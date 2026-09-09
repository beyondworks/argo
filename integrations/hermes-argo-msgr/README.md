# Hermes ↔ Argo Messenger (platform plugin)

헤르메스(Hermes Agent)를 아르고 메신저에 **봇**으로 연결하는 플랫폼 플러그인입니다. 텔레그램·슬랙에 붙이는 것과 같은 자리이며, 헤르메스 코어 수정은 없습니다.

## 설치 (한 번)

```bash
mkdir -p ~/.hermes/plugins/argo-msgr
cp integrations/hermes-argo-msgr/{__init__.py,adapter.py,plugin.yaml} ~/.hermes/plugins/argo-msgr/
hermes plugins enable argo-msgr-platform --no-allow-tool-override
```

## 연결 (원클릭)

1. 아르고 메신저 → 설정 → **크루와 서버** → **외부 에이전트** → [헤르메스 연결하기].
2. 화면에 한 번만 보이는 두 줄을 복사해 `~/.hermes/.env`에 붙여 넣습니다.
   ```
   ARGO_MSGR_URL=https://<프로젝트>.supabase.co/functions/v1/msgr-bot
   ARGO_MSGR_BOT_TOKEN=argo_bot_…
   ```
3. `hermes gateway run`(또는 `hermes gateway restart`). 메신저 카드가 "헤르메스 에이전트 연결됨 · 시각"으로 바뀝니다.
4. 봇을 채널에 넣으려면 채널 "+ 추가 → 크루"에서 고릅니다. 이후 그 채널에서 `@헤르메스 …` 멘션·DM·봇 글에 대한 답글에만 반응합니다.

## 동작

- `getUpdates` 롱폴(offset = ack) → 헤르메스 세션 → `sendMessage`(원글에 대한 답글). 누가 봇에게 일을 시킬 수 있는지, 어떤 채널을 읽는지, 채널 정책은 전부 아르고 서버가 판정합니다(답글마다 재판정). 그래서 이 플러그인에는 사용자 허용 목록이 없습니다(`role_authorized`).
- 토큰이 폐기·회전되면(401) 폴링을 멈추고 로그에 남깁니다. 메신저에서 토큰을 다시 만들어 `.env`를 갱신하세요.
- 연결 해제 = 메신저 카드의 [연결 해제](토큰 회수). 종료·재시작 버튼은 없습니다.
- 처음 연결하면 아직 응답하지 않은 멘션(커서 이후 전부)에 답합니다.

## 검증 기록 (2026-09-08)

로컬 Supabase 스택(edge-runtime 1.71) + `hermes gateway run`(전경) — 멘션 삽입 → 헤르메스 답글이 `reply:<crew>:<msg>` 행으로 착지, 메신저 카드 "연결됨". 실 Supabase(argo 프로젝트)에는 마이그레이션·엣지 펑션 미배포.
