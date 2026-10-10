# 발행 전 로컬 검수 스택

발행하기 전에 바뀐 코드를 이 맥에서 직접 써 보는 시험 서버다. 본체와 메신저 웹을 이 맥의 로컬 Supabase에 붙여 띄운다.
운영 DB, 실제 계정, 상주 서버(:3001), 실제 데이터(`~/.argo`)는 쓰지 않는다. 에이전트는 이 맥에 로그인된 Claude Code·Codex로 실제로 답한다.

| 무엇 | 주소 |
|---|---|
| 본체 | http://localhost:3500 |
| 메신저 웹 | http://127.0.0.1:5191 |
| 로컬 Supabase | http://127.0.0.1:56321 (DB :56322) |

## 명령

```bash
bash scripts/review-stack.sh up [커밋|브랜치]   # 기본 origin/main. 처음이면 예시 데이터도 넣는다
bash scripts/review-stack.sh status            # 주소·프로세스·나간 연결 요약
bash scripts/review-stack.sh login             # 본체 로그인 링크(한 번 쓰임)를 기본 브라우저로 연다
bash scripts/review-stack.sh event 25 "미팅"    # 25분 뒤 시작하는 일정 하나(하트비트 '곧 시작' 확인용)
bash scripts/review-stack.sh reset             # DB와 검수 데이터 폴더를 비우고 예시 데이터를 다시 넣는다
bash scripts/review-stack.sh down              # 이 스택이 띄운 것만 끈다. 데이터는 남긴다
```

`up 브랜치이름`은 `origin/브랜치이름`이 있으면 그것을 쓴다. 코드는 `_worktrees/argo-review`에 받아 개발 서버(`next dev`)로 띄우므로,
그 폴더에서 파일을 고치면 화면에 바로 반영된다. 다른 커밋으로 바꾸려면 고친 파일을 커밋하거나 되돌린 뒤 다시 `up`한다.

## 로그인

- 시험 계정: `yugeon-review@argo.test`. 비밀번호는 `~/.argo-review/secrets/review-account.secret`(600)에만 있다.
- 본체: `login` 명령이 여는 링크로 들어간다(본체 화면에는 소셜 로그인만 있고, 로컬 Supabase에는 소셜 로그인이 없다).
- 메신저 웹: 로그인 화면 아래 "개발용" 칸에 이메일·비밀번호를 넣는다.
- 메신저가 "연결을 기다리는 중"에서 멈추면, 그 브라우저에 예전 로컬 스택의 "회사 서버" 설정이 남아 있는 것이다
  (`127.0.0.1:5191`의 localStorage `argo-msgr-server`). 로그인 화면의 회사 서버 칸을 비우거나, 그 값을 지우고 새로고침한다.

## 예시 데이터

- 회사 "검수 상사", 에이전트 4명: 하람(비서·일정 담당), 도윤(리서처), 세온(퍼포먼스 마케터), 지호(운영 매니저)
- 러너: Claude·Codex 모두 "이 컴퓨터 로그인 사용"(자격 파일은 복사하지 않는다)
- 계정은 Pro(동기화·리스가 돌게), 메신저 개인 공간 프로필 있음
- 개인 일정: 20분 뒤 1개, 3시간 뒤 1개, 내일 10:00·15:00
- 하트비트는 꺼져 있다. 하람 카드 → 하트비트 탭에서 켠다. `REVIEW_HEARTBEAT=1 bash scripts/review-stack.sh seed`로 켜 둘 수도 있다.

## 확인할 수 있는 것

- 본체에서 에이전트 1:1 대화(실제 Claude·Codex 답)
- 하트비트: 켜면 30분 안에 시작하는 일정이 메신저 개인 공간의 그 에이전트 1:1 방에 바로 올라온다.
  켠 뒤에 넣은 일정은 다음 일정 확인(15분 간격) 때 잡힌다(실측: 12:44에 넣은 일정이 12:54 확인 때 "15분 뒤 시작"으로 왔다).
  그래서 `event`는 20분 이상으로 넣는다.
- 메신저 웹에서 에이전트에게 말 걸기 → 본체 게이트웨이가 받아 답한다
- 동기화·첨부(로컬 storage 있음), 실시간 반영(realtime 있음)

## 안 되는 것

- 푸시 알림, 텔레그램 봇 중계, 링크 미리보기: 엣지 함수를 띄우지 않는다(`push_url` 설정도 없다)
- 소셜 로그인(Google·GitHub·Apple), 결제(Lemon Squeezy)
- 메일 하트비트: 오피스 메일함 연결(Google OAuth)이 없다

## 나간 연결 확인

본체 서버에는 나가는 연결의 호스트·포트만 적는 기록기(`scripts/review-stack-egress.mjs`)를 건다(`~/.argo-review/logs/egress.log`).
`status`가 운영 Supabase(`*.supabase.co`)로 나간 연결 수를 보여 준다. 러너가 띄우는 Claude Code 실행 파일의 연결은 이 기록에 들어가지 않는다.

## 폴더

`~/.argo-review/` — `data`(본체 ARGO_ROOT), `supabase-project`(로컬 Supabase 설정·마이그레이션 사본), `logs`, `run`(pid), `secrets`.
경로는 `ARGO_REVIEW_HOME`, `ARGO_REVIEW_WT`, `ARGO_REVIEW_SECRETS`로 바꿀 수 있다.
