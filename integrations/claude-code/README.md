# Claude Code ↔ 아르고 오피스 업무 현황

맥에서 쓰는 Claude Code 세션이 아르고 오피스의 **업무 현황** 화면에 나오게 하는 훅 두 개입니다.

- `argo-office-hook.mjs` (Stop·UserPromptSubmit·PostToolUse — 같은 파일을 세 이벤트에 등록): 이 세션의 제목·프로젝트 폴더 이름·마지막 활동 시각·맡은 할 일 id를 오피스에 알립니다. 답이 끝날 때만이 아니라 프롬프트를 보낼 때·도구를 쓸 때도 실행되므로, 한 턴이 15분 넘게 이어져도 '연결됨'으로 보입니다.
- `argo-office-hold-hook.mjs` (UserPromptSubmit): "보류하자", "나중에 하자", "이것부터" 같은 말을 하면, 미루는 일을 오피스에 보류로 남기는 `argo office hold` 명령을 Claude에게 안내합니다. 서버는 부르지 않습니다.

대화 내용과 프롬프트는 오피스로 보내지 않습니다. 보내는 것은 세션 id, 세션 제목(대화 기록의 마지막 제목), 폴더 이름, 할 일 id뿐입니다.

**이름을 붙인 세션만 보고합니다.** 대화 기록에 세션 제목(custom-title 줄)이 없는 세션 — 헤드리스 자동 실행(`claude -p`) 등 — 은 아무것도 보내지 않습니다(이 맥에서 하루 200개 넘게 생깁니다). 업무 현황에 나오게 하려면 세션에 이름을 붙입니다(예: "맥가이버 - 정비사").

## 설치

저장소 체크아웃(루트에서 `npm ci`를 마친 상태)이 필요합니다. 훅이 저장소의 `src/office-cli.mjs`와 `@supabase/supabase-js`를 씁니다.
아래에서 `<argo>`는 저장소 경로입니다(예: `~/lean-projects/saas/argo`). `argo` 명령이 설치돼 있지 않으면 `node <argo>/bin/argo.mjs`로 바꿔 쓰면 됩니다.

### 1. 훅 전용 폴더로 로그인

```bash
ARGO_ROOT=~/.argo/office-hook argo login
```

훅은 `~/.argo/office-hook`의 기기 로그인만 씁니다. Argo 앱·상주 서버·`argo` 대화 화면의 로그인과 따로 두는 것이 중요합니다 — 같은 로그인을 두 프로그램이 나눠 쓰면 토큰 갱신이 겹쳐 로그인이 풀립니다.

`argo`를 "이 컴퓨터에서만 쓰기"(로그인 없음) 모드로 쓰고 있었다면, 이 로그인(`argo login`)이 `~/.argo/cli.json`의 모드를 계정 모드로 바꿉니다. 대화 화면을 다시 로그인 없이 쓰려면 `cli.json`의 `"mode"`를 `"local"`로 한 번 되돌리면 됩니다. `argo office …` 명령과 훅은 `cli.json` 모드를 읽지도 바꾸지도 않으므로, 되돌린 값은 그대로 유지됩니다.

`argo office …`에 `ARGO_ROOT`를 주지 않으면 훅 폴더(`~/.argo/office-hook`)를 씁니다. 앱·대화 화면 폴더의 로그인은 쓰지 않습니다.

### 2. 조직 지정

`~/.argo/office-hook/config.json`:

```json
{ "org": "<조직 id>" }
```

조직 id는 오피스 조직(예: Lean-AX)의 uuid입니다. 세션 보고와 `argo office hold`·`argo office tasks`가 `--org`를 주지 않으면 이 값을 씁니다. 이 파일이 없으면 Stop 훅은 아무것도 보내지 않습니다.

### 3. Claude Code 설정에 훅 등록

`~/.claude/settings.json`의 `hooks`에 추가합니다(이미 다른 훅이 있으면 배열에 항목을 더합니다):

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node <argo>/integrations/claude-code/argo-office-hook.mjs", "timeout": 15 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [
        { "type": "command", "command": "node <argo>/integrations/claude-code/argo-office-hook.mjs", "timeout": 15 },
        { "type": "command", "command": "node <argo>/integrations/claude-code/argo-office-hold-hook.mjs", "timeout": 5 }
      ] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node <argo>/integrations/claude-code/argo-office-hook.mjs", "timeout": 15 }] }
    ]
  }
}
```

`<argo>`는 실제 절대 경로로 바꿉니다. 보고 훅(`argo-office-hook.mjs`)은 세 이벤트 어디에서 불려도 같은 일을 하고, UserPromptSubmit에서도 아무것도 출력하지 않습니다(출력하면 대화에 들어가기 때문입니다). 서버 호출은 3초 제한이지만, 로그인 토큰을 갱신하는 동안(1시간에 한 번)에는 끊지 않습니다 — 갱신 응답을 받기 전에 끊으면 로그인이 풀리기 때문입니다. `timeout`을 15초로 두는 이유입니다.

### 4. 확인

```bash
ARGO_ROOT=~/.argo/office-hook argo office tasks
```

끝내지 않은 일 목록이 나오면 로그인과 조직 설정이 맞습니다. 로그인이 안 돼 있으면 안내 한 줄과 함께 종료 코드 2로 끝납니다.

## 명령

```bash
# 세션 상태를 직접 보고(훅이 하는 일) — 맡은 할 일을 정하면 이후 훅이 그 id를 이어 보낸다
ARGO_ROOT=~/.argo/office-hook argo office report --org <조직 id> --id <세션 id> --name "<제목>" [--project <폴더>] [--task <할 일 id>]

# 미루는 일을 새 보류 일로 남기기(담당 = 로그인한 사람, 출처 = 이 세션). --source-name(세션 제목)은 꼭 넣는다 — 없으면 종료 코드 1
ARGO_ROOT=~/.argo/office-hook argo office hold "<제목>" --reason "<보류 사유>" --source-name "<세션 제목>" [--org <조직 id>]

# 오피스에 이미 있는 일을 보류로(이미 보류인 일이면 보류한 날은 두고 사유만 바꾼다)
ARGO_ROOT=~/.argo/office-hook argo office hold --task <할 일 id> --reason "<보류 사유>" [--org <조직 id>]

# 끝내지 않은 일 보기
ARGO_ROOT=~/.argo/office-hook argo office tasks [--org <조직 id>] [--json]
```

"이것부터"처럼 먼저 할 일을 정했다면, 그 대상은 미루는 일의 보류 사유에 적습니다.

## 동작

- 업무 현황은 이름의 " - " 앞부분이 같으면 한 사람으로 묶습니다. 세션 제목을 "맥가이버 - 정비사"처럼 지으면 같은 이름의 아르고 에이전트·VPS 봇과 한 줄에 나옵니다.
- 훅은 Stop·UserPromptSubmit·PostToolUse마다 실행되지만, 서버 호출은 값이 바뀌었거나 4분이 지났을 때만 합니다. 마지막으로 보낸 값과 시각은 `~/.argo/office-hook/sessions.json`에 남고(8일 지난 기록은 버립니다), 같은 값이면 서버를 부르지 않습니다. 그래서 이벤트를 셋으로 늘려도 호출 수는 그대로입니다: 세션 10개면 분당 약 2.5회(세션당 4분에 1번), 서버 쓰기도 같거나 적습니다(서버도 같은 값·4분 안이면 다시 쓰지 않습니다). 부르지 않는 실행은 이 맥에서 node 시작을 포함해 한 번에 약 50~65ms(빈 node 시작이 약 37ms, 10회 평균)이고, 서버 호출이 있는 실행(세션당 4분에 1번)은 응답을 기다리는 동안(보통 1초 안, 최대 3.5초) 그 이벤트가 기다립니다.
- 이 파일은 여러 세션의 훅과 `argo office report`가 같이 씁니다. 쓸 때마다 잠금(`sessions.json.lockd`) 안에서 다시 읽고 자기 세션 항목만 바꿉니다.
- 서버 오류·연결 실패·로그인 만료가 나도 훅은 항상 종료 코드 0이고 아무것도 출력하지 않습니다. 연결 실패·로그인 실패 뒤 1분은 다시 부르지 않고, 다시 불러도 같은 답인 거절(권한 없음·한도·입력 오류)은 보낼 값(조직 포함)이 바뀌거나 6시간이 지날 때까지 다시 부르지 않습니다.
- 대화 기록은 지난번에 읽은 곳부터만 읽습니다(64KB가 넘는 줄은 건너뜁니다). 기록 파일이 다시 쓰였으면 처음부터 읽습니다.
- 보류 안내 훅은 프롬프트에 붙어 오는 알림 블록(`<task-notification>`, `<system-reminder>`, `<cross-session-message>` 등)을 걷어 낸 뒤 사람이 쓴 글에서만 보류 표현을 찾습니다. 평범한 입력에는 아무것도 출력하지 않습니다.

## 끄기

`settings.json`에서 위 항목들을 지우거나, `~/.argo/office-hook/config.json`을 지우면 보고 훅은 아무것도 보내지 않습니다.
