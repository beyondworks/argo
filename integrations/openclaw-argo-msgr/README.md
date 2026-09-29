# OpenClaw ↔ Argo Messenger (channel plugin)

오픈클로(OpenClaw)를 아르고 메신저에 **봇**으로 연결하는 채널 플러그인입니다. 텔레그램·슬랙 채널과 같은 자리이며, 오픈클로 코어 수정은 없습니다(플러그인 SDK만 사용).

**필요한 OpenClaw 버전: 2026.8.1 이상.** 2026.8.1부터 루트 `openclaw/plugin-sdk`가 없어지고 기능별 하위 경로(`plugin-sdk/channel-core`·`channel-inbound`…)만 남았습니다. 이 플러그인은 하위 경로와 `runtime.channel.inbound.buildContext`/`dispatch`를 쓰므로 그보다 낮은 버전에서는 불러오지 못합니다. 서버 연결 스크립트는 버전을 먼저 확인해 낮으면 "OpenClaw를 업데이트하세요"로 멈추고, 설치 뒤에는 `openclaw plugins inspect openclaw-argo-msgr --runtime --json`으로 실제 로드를 확인합니다(`plugins enable`·`plugins list`는 로드 실패여도 성공·enabled로 보입니다).

## 앱에서 연결 · 업데이트

아르고 메신저 → 설정 → 크루와 서버 → 외부 에이전트에서 [오픈클로 연결하기]를 사용합니다. 네이티브 앱이 함께 배포된 플러그인(0.2.0)을 설치하고 연결 설정을 반영합니다. 기존 연결도 이 화면에서 다시 연결하면 포함된 최신 플러그인으로 갱신됩니다. 실행 중인 모든 외부 런타임에 조용히 배포하는 방식은 아닙니다.

## 수동 설치 (개발 · 자체 호스팅)

```bash
mkdir -p ~/.openclaw/extensions
cp -R integrations/openclaw-argo-msgr ~/.openclaw/extensions/openclaw-argo-msgr
```

(디렉터리 이름은 플러그인 id `openclaw-argo-msgr`와 같아야 합니다. 오픈클로가 둘을 대조합니다.)

## 수동 연결 설정 (개발 · 자체 호스팅)

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

## 크루 계약 1-a — 자동화·결재 (2026-09-29)

Argo 크루와 같은 계약으로 메신저 "업무 > 자동화"와 결재 카드를 씁니다. Hermes 어댑터와 같은 규칙이며, 판정(권한·위험 등급·재개 자격)은 전부 아르고 서버가 합니다.

- **예약 작업 미러**: 60초마다 이 OpenClaw의 예약 작업을 읽어, 결과를 이 봇 계정의 메신저로 보내는 작업(`delivery.channel = "argo-msgr"`, `delivery.accountId`가 이 계정이거나 비었고 이 계정이 기본·유일 계정)만 `setRoutines`로 올립니다. 스냅샷이 바뀌었을 때만 보내고 1시간마다 한 번 재확인하며, 서버 행 수(`total`)가 보낸 수와 다르면 다음 주기에 다시 보냅니다. 읽기에 실패하면 빈 스냅샷을 보내지 않습니다. `ARGO_MSGR_MIRROR_ALL=1`이면 모든 작업을 보이되 메신저 전달 작업이 아니면 고칠 수 없습니다(`editable: false`).
- 예약 작업은 OpenClaw가 게이트웨이 서비스에 주는 스케줄러 핸들(`api.registerService` → `ctx.getCron()`의 `list`/`update`/`remove`)로만 읽고 고칩니다. 저장소 파일을 직접 고치지 않습니다. 이 핸들을 주지 않는 호스트면 `setRoutines {unsupported: 사유}`를 사유가 바뀔 때만 한 번 보냅니다.
- 일정은 메신저 형식(`daily`·`weekly`·`interval`·`once`)으로 바꾸고, 표현 못 하는 식(범위·간격 cron, 분 단위가 아닌 `every`, `on-exit`·`stream`)은 `raw`로 보내 화면에서 일정만 읽기 전용입니다. 시간대가 없는 cron은 게이트웨이 호스트 시간대로 표시합니다(OpenClaw와 같다).
- `updated_at`은 사람이 바꾸는 필드(이름·설명·켜짐·일정·지시·전달)의 지문이 바뀐 것을 처음 본 시각이고, `~/.argo-msgr/routines-<서버·토큰 해시>.json`(토큰 없음, 0600)에 남아 재시작 뒤에도 유지됩니다. 실행 상태(`last_run_at`·`last_status`)는 처음 생긴 기록은 바로, 이후엔 10분에 한 번만 갱신합니다.
- **편집 반영**: `getUpdates {events: 1}`의 `routine_edit` 이벤트를 받아 Argo와 같이 판정(작업 없음 = `routine_not_found`, 메신저 전달 작업 아님 = `not_editable`, 편집 뒤 사람이 고쳤으면 `superseded`)한 뒤 스케줄러 `update`(이름·지시·일정·켜기/끄기 한 번에) 또는 `remove`로 반영하고 `routineEditDone` → 바로 다시 미러합니다. 여러 시각은 분이 같을 때만(cron 한 줄) 반영하고, `once` 일정으로 바꾸는 편집은 실패로 닫습니다.
- **위험 작업 결재**: 채널 네이티브 승인(`approvalCapability.native` + `nativeRuntime`)으로 이 메신저 대화에서 시작된 exec·plugin 승인 요청을 결재 카드로 올립니다(`requestApproval` — 그 채팅에서 아직 답하지 않은 실행 중 원문의 `execution_attempt`). 메신저에서 결정되면(`approval_decided`) 먼저 `ackApproval`로 선점하고 `claimed: true`일 때만 `resolveApprovalOverGateway`로 OpenClaw에 돌려줍니다(승인 + `resume: true`면 `allow-once`, 그 밖은 `deny`). OpenClaw 쪽 대기가 시간 초과로 끝나거나 다른 화면에서 결정되면 열린 카드를 `expireApproval`로 닫습니다. 카드를 못 만들면 OpenClaw 기존 경로(운영자 화면·CLI `openclaw approvals resolve`)가 그대로 남습니다. `system-agent`(게이트웨이 설정 변경) 승인은 카드로 올리지 않습니다.
- 실행 지시는 폴 루프를 막지 않고 돌립니다(승인 대기 중에도 결정 이벤트를 받아야 하므로). 서버는 한 번 준 원문을 실행 기록으로 다시 주지 않으므로 offset은 바로 올립니다. CC 수신 확인은 지금처럼 저장이 끝난 뒤 offset을 올립니다.

## 검증 기록 (2026-09-29, openclaw 2026.9.6)

크루 계약 1-a: 같은 격리 설치에 계약 메서드를 받는 가짜 봇 API를 붙여 확인했습니다. ① `argo-msgr`로 결과를 보내는 작업과 `--no-deliver` 작업, 코어 관리 작업(heartbeat·memory 등)이 있을 때 `setRoutines`에는 앞의 것만 실렸고, 바뀐 게 없으면 다시 보내지 않았습니다. ② `routine_edit`(끄기 + 매일 07:15) 이벤트 → `openclaw automations get`에서 `enabled: false`, `15 7 * * *`로 바뀌고 `routineEditDone applied` → 즉시 미러. ③ 가짜 모델의 exec 도구 호출(`tools.exec.mode: "ask"`) → `requestApproval`(실행 시도 일치) → 승인 이벤트 → `ackApproval` → 명령 실행. 거절 이벤트 → "Exec denied (user-denied)"가 최종 답으로. CLI로 다른 곳에서 거절 → `expireApproval`.

격리 설치(`HOME`·`OPENCLAW_HOME`·`OPENCLAW_STATE_DIR`·`OPENCLAW_CONFIG_PATH`를 임시 폴더로, bonjour 끔) + 가짜 봇 API + 가짜 OpenAI 호환 모델 서버로 게이트웨이 기동 — 플러그인 로드, getMe 접속, getUpdates 롱폴, 채널 멘션·DM 수신 → 라우팅(DM은 `…:argo-dm:<채널>:conversation` 세션) → 모델 → `sendMessage`(실행권·`MSGR: handoff` 판정·멘션 포함)까지, 그리고 `openclaw message send`로 보내기까지 통과했습니다. 모델 요청 기록으로 스레드 맥락·넘김 규칙이 모델 본문(`BodyForAgent`)에 실리는 것을 확인했습니다. 이전 받기 경로(`finalizeInboundContext`)로는 2026.9.6에서 모델이 원문 한 줄만 받아 넘김 규칙을 몰랐습니다.

## 이전 검증 기록 (2026-09-08, openclaw 2026.2.23 — 0.1.x 플러그인)

로컬 Supabase 스택 + 임시 `OPENCLAW_CONFIG_PATH`/`OPENCLAW_STATE_DIR`로 게이트웨이 기동 — 플러그인 적재, getMe 접속, 폴링(카드 "연결됨"), 멘션 → 에이전트 → 원글 답글까지 통과. 임시 상태에는 모델 제공자 키가 없어 답 내용은 오류문(`No API key found for provider "anthropic"`)이었습니다. 실제 답변은 오픈클로에 모델 제공자를 설정한 뒤 같은 경로로 나옵니다.

## 같은 채널의 크루 넘김 프로토콜 (2026-09-09)

`getUpdates`는 허용된 요청에만 영구 실행권(`execution_attempt`)을 발급합니다. 같은 봇의 폴러를 두 개 띄워도 한 요청은 한 폴러에게만 전달되며, 중단된 실행을 시간 만료로 다른 기기에 재할당하지 않습니다. 실행 중 프로세스가 종료되면 사용자가 새 요청을 보내야 합니다.

이 버전의 어댑터는 같은 채널의 크루 발화도 원래 사용자·스레드와 함께 받고, 답변의 마지막 독립 줄 `MSGR: handoff`와 명확한 `@이름`으로 남은 일을 넘깁니다. `MSGR: done` 또는 판정이 없는 답변은 다른 크루를 깨우지 않습니다. 서버가 원래 사용자의 권한과 현재 채널 정책을 다시 확인하며, 원래 채널과 스레드를 응답에 직접 지정합니다. 텔레그램 전송 경로는 사용하지 않습니다.

기존 어댑터의 답글 API도 이미 발급된 실행권으로 일반 답변을 마칠 수 있습니다. 크루 넘김 기능을 쓰려면 최신 Argo Messenger에서 다시 연결해 포함된 어댑터(0.1.2 이상)를 설치하거나, 수동 설치를 갱신해야 합니다. 연결 동작 없이 백그라운드에서 설치된 플러그인을 교체하지 않습니다. 어댑터 검사는 모의 런타임 인터페이스 기반이며, 실제 설치 버전의 Hermes/OpenClaw 모델·도구 실행은 별도 검수 대상입니다.

완성된 답변은 전송 전에 사용자 홈의 `.argo-msgr/outbox`에 보존하며, 서버 주소와 봇 자격의 해시로 분리합니다. 봇 토큰은 파일에 저장하지 않습니다. 통신 오류 뒤에는 저장된 답변만 재전송하고 모델을 다시 실행하지 않습니다. 영구적인 400/403/409 거부는 `failed/`로 보존하고 새 지시를 계속 받으며, 401은 인증 갱신까지 중지하고 408/429·서버 오류는 재시도합니다. 외부 실행권이 10분 이상 미완료이면 이후 봇 폴링 시 채널에 상태 미확인 안내를 한 번 표시합니다.

다중 멘션은 허용된 선행 크루의 답변을 기다린 뒤 진행합니다. 오래된 대기 요청이 offset 때문에 사라지지 않도록 뒤 요청도 최대 10분간 함께 대기할 수 있습니다. 이전 크루의 넘김이 이미 최초 요청 문맥에 포함되면 별도 중복 실행하지 않습니다.


## DM 수신·참조 (어댑터 0.1.2)

1:1 DM에서도 수신(To) 에이전트에게 일을 맡길 수 있습니다. 원래 DM 상대와 대화 이름은 유지되며, 위임받은 에이전트는 해당 요청과 이어지는 답변만 봅니다. 원래 DM 상대는 같은 DM의 대화 맥락을 이어갑니다. 다른 DM이나 일반 대화의 모델 세션을 재사용하지 않습니다.

참조(CC) 에이전트는 요청을 수신하지만 모델 실행·답변·재위임을 하지 않습니다. 에이전트 답변에서 `CC: @이름`을 독립 줄로 쓰고 마지막 줄을 `MSGR: handoff`로 지정하면 참조로 전달합니다. 인용·코드 안의 멘션은 실행하지 않으며 `MSGR: done`은 모든 넘김을 취소합니다.

새 어댑터는 `getUpdates`에 `delivery_protocol: 1`을 신고합니다. 구형 어댑터는 기존 채널·자기 DM의 응답을 유지하며, 다른 DM의 위임이나 수동 실행 없는 CC 전달은 받지 않습니다. 메신저에 업데이트 필요로 표시되면 연결 화면에서 플러그인을 갱신하고 런타임을 다시 시작하세요. CC 수신 확인은 `.argo-msgr/outbox/receipts`에 계정별 최신 메시지 ID·채널·요청 ID만 저장하며, 본문·토큰을 공유 기억에 복사하지 않습니다.
