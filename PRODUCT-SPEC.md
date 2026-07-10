# crewbase (가칭) — 개인용 AI 회사 SaaS 설계서

> 2026-07-10 유건 지시로 개설. 제품명 미정 — `crewbase`는 작업 코드네임.
> 기업용 lean-crew(LAN 커맨더·거버넌스형)와 **별개 제품 라인** — 그쪽은 그대로 유지한다.

## North Star

**일반 사용자가 가입해서, 프롬프트 한 줄로 전문 AI 직원을 만들고, 회사(워크스페이스)가
폴더 단위 기억으로 맥락을 쌓아가며 일해주는 제품.** Paperclip/Matrix(flowith)의 "회사를
만든다" 경험 + Hermes/OpenClaw급 개인 에이전트 완성도.

## 4대 기둥 (요구사항 → 구현 원칙)

| # | 기둥 | 구현 원칙 |
|---|---|---|
| 1 | **회사 생성** | 워크스페이스 = 격리된 폴더 트리(회사 정의 + 직원 카드 + vault). 가입 즉시 "1인 회사" 시작, 직원을 늘려간다 |
| 2 | **한 줄 → 전문 에이전트** | 한 줄 프롬프트 → 페르소나 카드(md frontmatter: 이름·역할·전문성·톤·도구·스킬) 자동 생성. 카드가 곧 시스템 프롬프트 — 사용자가 언제든 열어 고침(투명성) |
| 3 | **스킬·플러그인** | 스킬 = 지시형 md(기존 lean-crew `_skills` 규약 재사용, 유통 단위). 플러그인 = MCP 커넥터(Agent SDK가 네이티브 지원). 마켓은 후속 |
| 4 | **폴더 단위 기억 + 자동 링크** | 워크스페이스 vault(md 폴더)가 회사의 뇌. 매 작업 후 핸드오버가 vault에 쌓이고, **유사 문서끼리 자동 [[링크]]**(위키 그래프). 에이전트는 매 턴 vault를 도구로 탐색 — "md 한 장"이 아니라 폴더 전체가 컨텍스트 |

## 아키텍처 결정

### 실행 코어: Claude Agent SDK (결정)

- 엔진(agent-org)의 검증된 철학 유지 — **에이전트 루프를 직접 만들지 않는다**.
  bus-daemon이 claude CLI를 스폰했듯, SaaS는 그 SDK판인 **Claude Agent SDK**를 쓴다:
  파일 도구(Read/Write/Glob/Grep)·세션 resume·MCP·훅·권한이 기본 제공.
- **BYOK(구독 OAuth 포함) — 결정(2026-07-10 유건).** Agent SDK는 Claude Code 인증 체계를
  그대로 쓰므로 사용자의 ①API 키 또는 ②Claude 구독 OAuth 토큰(`CLAUDE_CODE_OAUTH_TOKEN`)
  둘 다 수용. 비용 리스크 0으로 제품 검증, 과금은 기능 구독.
  ※ 리스크 표기: 제3자 서비스에서 구독 OAuth 사용은 Anthropic 약관 확인 필요(미검증) —
  API 키 경로를 항상 병행 지원해 의존하지 않는다.
- 기각한 대안: Managed Agents(호스팅 매력적이나 구독 OAuth 불가·조직 API키 종속),
  자체 루프(재구현 금지 원칙 위반).

### 계층

```
[Next.js 웹] ── Supabase(인증·DB·과금) ── [워커: 워크스페이스별 컨테이너]
                                             └ Claude Agent SDK 세션
                                             └ 워크스페이스 폴더 (아래)
workspaces/<id>/
├── company.json          # 회사 정의(이름·소유자·설정)
├── agents/<slug>.md      # 페르소나 카드(frontmatter: name/role/model/tools + 본문)
├── skills/               # 지시형 md (lean-crew _skills 규약)
└── vault/                # 회사의 뇌 (기둥 4)
    ├── conversations/    # 턴별 핸드오버(자동 축적)
    ├── notes/            # 에이전트가 스스로 쓰는 지식
    └── _index.md         # 자동 생성 인덱스(링크 그래프 진입점)
```

### 기억 설계 (차별점의 핵심)

1. **쓰기**: 매 대화 턴 종료 시 핸드오버 md가 `vault/conversations/`에 자동 축적.
   에이전트도 작업 중 `vault/notes/`에 스스로 기록(Agent SDK 파일 도구).
2. **자동 링크**: 새 문서 저장 시 기존 vault 전체와 유사도 비교 → 상위 유사 문서에
   양방향 `[[링크]]` 삽입 + `_index.md` 갱신. (스파이크=TF-IDF 코사인, 프로덕션=pgvector 임베딩)
   — agent-org의 wiki-link.py 개념을 제품 코어로 승격.
3. **읽기**: 에이전트 시스템 프롬프트에 vault 사용법 주입 — 새 작업 시작 시 `_index.md`와
   관련 링크를 따라 필요한 만큼만 읽는다(폴더 전체가 잠재 컨텍스트, 링크가 탐색 경로).

## 단계

- **P0 스파이크 (이번 세션)**: 코어 수직 슬라이스 — 회사 생성 → 한 줄로 에이전트 생성 →
  대화(Agent SDK) → vault 축적 → 자동 링크. CLI 데모로 실증. 웹/DB 없음.
- **P1 MVP**: Next.js+Supabase 가입/로그인, 회사·직원 UI, 채팅, BYOK 등록(암호화 저장),
  워커 1대(Fly.io/Railway), 루틴(cron), 스킬 편집.
- **P2**: 스킬/MCP 마켓, 텔레그램 채널, 팀 초대·공유, 과금(Stripe), vault 그래프 뷰.

## 범위 제외 (YAGNI)

- 멀티모델 러너(claude만 — codex/gemini는 기업 라인의 것), 자체 에이전트 루프,
  실시간 협업 편집, 모바일 앱. P0에서 웹 UI·DB·인증 없음(코어 실증이 목적).

## 검증 기준 (P0)

- 데모 1회 실행으로: ① 한 줄 → 페르소나 카드 md 생성 ② 대화 응답 ③ 턴 핸드오버가
  vault에 저장 ④ 2번째 문서 저장 시 1번째와 자동 [[링크]] ⑤ 다음 턴 에이전트가
  vault 링크를 따라 이전 맥락을 실제로 인용 — 전부 실측.
