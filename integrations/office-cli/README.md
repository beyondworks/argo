# 아르고 오피스 CLI·MCP — Claude Code·Codex·아르고에서 오피스 읽고 쓰기

`argo office <영역> <동작>`(셸 명령)과 `argo office mcp`(MCP 서버)로 아르고 오피스의 할 일·페이지, 거래처·거래, 일정, 회사 정보·직원·평가, 문서함·드라이브, 메일, 브리핑을 읽고 씁니다.
도구 정의와 처리기는 아르고 본체 에이전트가 쓰는 것과 같습니다(`src/gateway/office-tools.mjs`). 그래서 권한·규칙도 같습니다.

- 권한은 서버 함수가 로그인한 사람의 권한 그대로 판정합니다(관리자만 되는 쓰기는 관리자 계정에서만).
- 메일·메모·페이지 본문처럼 사람들이 쓴 글은 "바깥 글" 경계 안에 담겨 나옵니다 — 에이전트가 그 안의 요청을 지시로 따르지 않게.
- 할 일은 주인(로그인한 사람)이 맡은 일만 바꿉니다. 메일은 초안·별표까지이고 보내지 않습니다.
- **되돌릴 수 없는 동작은 열지 않습니다**: 일정 영구 삭제(`calendar delete`)는 CLI·MCP에 없습니다. 아르고 오피스 화면에서 합니다.
- CLI·MCP로 만든 할 일은 출처가 '세션'으로 남아, 업무 현황에서 그 세션 이름의 카드에 묶입니다(`--source-name`, MCP는 붙은 클라이언트 이름 — Claude Code·Codex).

## 준비

저장소 체크아웃(루트에서 `npm ci`)이 필요합니다. 아래 `<argo>`는 저장소 경로입니다(예: `~/lean-projects/saas/argo`).

1. 로그인(한 번) — 오피스 전용 폴더 `~/.argo/office-hook` 하나를 Claude Code 훅·CLI·MCP가 같이 씁니다. 같은 폴더를 여러 프로그램이 동시에 써도 토큰 갱신은 잠금 안에서 한 번만 합니다.
   ```bash
   ARGO_ROOT=~/.argo/office-hook node <argo>/bin/argo.mjs login
   ```
   공개 설정이 없어 `Missing Supabase public config`가 나오면 [Claude Code 훅 안내](../claude-code/README.md)의 0단계를 봅니다.
2. 기본 조직(선택) — `~/.argo/office-hook/config.json`에 `{ "org": "<조직 id>" }`. 없으면 명령마다 `--org`를 줍니다.
   ```bash
   node <argo>/bin/argo.mjs office orgs      # 내 조직(이름·slug·역할·id)
   ```

## 셸 명령

```bash
node <argo>/bin/argo.mjs office tools                         # 영역·동작 목록 (--json: 인자 형식 JSON 스키마)
node <argo>/bin/argo.mjs office work --help                   # 한 영역의 옵션

node <argo>/bin/argo.mjs office work tasks --status doing --org lean-ax
node <argo>/bin/argo.mjs office work task_add --title "견적 회신" --due-on 2026-10-12 --priority high --source-name "Claude Code"
node <argo>/bin/argo.mjs office work task_set --id <할 일 id> --status done
node <argo>/bin/argo.mjs office work page_add --title "회의록" --text "# 10월 회의\n- 견적 정리"
node <argo>/bin/argo.mjs office deals customers --q 한빛
node <argo>/bin/argo.mjs office deals deal_add --customer-id <id> --title "촬영" --lines '[{"item":"촬영","unit_price":1000000}]'
node <argo>/bin/argo.mjs office calendar list --from 2026-10-10 --to 2026-10-17
node <argo>/bin/argo.mjs office mail mails --folder unread
node <argo>/bin/argo.mjs office briefing brief_add --title "오늘 브리핑" --body "…"
```

| 영역 | 동작 |
|---|---|
| work | tasks · task_add · task_set · categories · pages · page_read · page_add · page_edit |
| deals | customers · customer_add · customer_set · deals · deal_add · deal_next · deal_due |
| calendar | list · create · update |
| company | company · company_set · people · evals · eval_add |
| files | files · file_read · attach · drive · drive_import · drive_mkdir · drive_export |
| mail | mails · mail_read · mail_draft · mail_star |
| briefing | brief_add · briefs · brief_read |

- 옵션 이름은 `--due-on`처럼 kebab-case로 써도 됩니다(도구 인자 `due_on`). 불리언은 `--overdue`처럼 붙이기만, 배열은 JSON 글자로.
- 공통 옵션: `--org <id|slug|이름>`, `--source-name <이름>`(기본 `CLI` 또는 환경변수 `ARGO_OFFICE_SOURCE`), `--json`(`{ area, tool, action, org, text }`), `--lang ko|en`.
- 조직은 `--org`나 기본 조직(config.json)을 씁니다. 둘 다 없으면 일정·메일·브리핑만 개인 공간으로 쓸 수 있고, 나머지는 조직이 필요합니다.
- `files attach --path`는 지금 작업 폴더 안의 보통 파일만 올립니다. 홈 폴더(또는 그 위)에서 실행하면 거절하고, 경로 어느 자리든 점으로 시작하는 이름(`.env`·`.ssh`·`.git` 등)과 비밀 파일 이름(`id_*`·`*.pem`·`*.key`·`credentials*` 등)은 올리지 않습니다.
- 종료 코드: 0 성공(서버·처리기의 거절도 글로 나옵니다), 1 입력 오류, 2 로그인 필요.

## MCP 서버로 붙이기

Claude Code:
```bash
claude mcp add argo-office -- node <argo>/bin/argo.mjs office mcp
```

Codex(`~/.codex/config.toml`):
```toml
[mcp_servers.argo-office]
command = "node"
args = ["<argo>/bin/argo.mjs", "office", "mcp"]
```

도구는 `calendar`·`office`(회사)·`office_files`·`office_work`·`office_deals`·`office_mail`·`office_briefing`과 `office_orgs`(내 조직 목록)입니다. 도구마다 선택 인자 `org`가 있고, 비우면 기본 조직입니다(기본 조직도 없으면 일정·메일·브리핑만 개인 공간으로).
아르고 본체 에이전트는 같은 도구를 이미 안에서 씁니다(메신저 조직 채널·주인 1:1 대화 — 방을 누가 보는지에 맞춰 판정). 그래서 아르고 에이전트 턴 안에서는 이 CLI·MCP를 쓰지 않습니다: 에이전트 셸·MCP 자식에는 `ARGO_AGENT_TURN` 표지가 붙고, CLI·MCP는 자기 환경과 조상 프로세스(러너·서버)의 표지를 보고 거절합니다(셸에서 표지를 지워도 조상의 표지는 남습니다). 에이전트 셸의 `argo office …` 명령은 권한 게이트가 막고, Claude Code MCP 가져오기는 이 서버를 가져오지 않습니다.
이것은 같은 OS 계정 안의 방지턱이지 경계가 아닙니다. 아르고 에이전트 셸은 지금도 따옴표로 쪼갠 경로로 이 컴퓨터의 아르고 기기 세션 파일에 닿을 수 있어서, CLI 쪽 판정만으로는 막을 수 없습니다. 지금 막지 못하는 경우:
- 조상 사슬을 끊는 한 줄(`( 명령 & )`, 별도 tmux, `launchctl submit` 등)
- 네이티브 러너(openrouter·glm·kimi·grok·Gemini 네이티브)의 셸 — macOS에서 서버가 띄운 `/bin/sh`의 환경이 보이지 않습니다
- Windows(조상 판정 없음)

근본 대책은 에이전트 셸의 OS 샌드박스입니다(후속). 반대로 사람이 쓰는 샌드박스 셸(Codex 샌드박스 등)에서는 `ps`를 실행할 수 없어 CLI가 "확인하지 못해 거절"합니다. 그때는 MCP로 붙이세요(MCP 서버는 샌드박스 밖에서 실행됩니다).

## 부하

명령·도구 호출 한 번에 서버 함수 1~3건(조직을 이름으로 고르면 조직 목록 1건 더). 주기 호출은 없습니다.
