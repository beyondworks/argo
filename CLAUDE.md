# Argo — saas 프로젝트 (구 코드네임 crewbase)

> 생성일 2026-07-10. 이 파일은 루트 `lean-projects/CLAUDE.md`와 글로벌 `~/.claude/CLAUDE.md`를
> 상속한다. 아래 도메인 에이전트 세트가 기본 라우팅이며, 프로젝트 고유 규칙이 그 위에 우선한다.

## North Star (사용자 결과 한 문장 — 고정값)

> 일반 사용자가 가입해 프롬프트 한 줄로 AI 직원 회사를 만들고, 폴더 단위 기억으로 일 시키는 SaaS

- 작업 내내 이 문장을 최상단 고정값으로 둔다.
- **파일 3개/단계 1개마다** 자문: "방금 만든 게 North Star에 직접 기여하나? 곁가지로 샜나?"
- 표류 감지 시 한 걸음도 더 가지 말고 정지 → 재정렬.

## Metric Lock (성공 지표)

- (측정 가능한 성공 기준을 여기에. 미정 시 기본 규칙: "요청 변경 구현 + 무관 영역 미파손 + lint/test 통과")

## 프로젝트 고유 규칙 (도메인 기본을 덮어씀)

- 스택: Next.js(App Router, JS) + Claude Agent SDK 코어(`src/*.mjs`) — P1에서 Supabase 인증·DB 합류
- 배포처: 로컬 dev(현 단계) → Fly.io/Railway 워커 (P1)
- 외부 통합: Claude Agent SDK(BYOK — API 키/구독 OAuth 환경변수), MCP(후속)
- 주의사항: 워크스페이스 루트 env `ARGO_ROOT`(구 `CREWBASE_ROOT` 병행 수용). `workspaces/`는 gitignore — 사용자 데이터 커밋 금지
- 네이밍: **Argo** = 아르고호(전문 영웅들이 한 배로 황금양털 항해). 디자인 모티프 = 밤바다 네이비 + 황금양털 골드

## 검증

- 완료 선언 전: North Star ↔ 완성물 역대조. 빌드 통과 ≠ 목적 달성.
- 검수는 구현과 다른 컨텍스트의 에이전트가 (자기 승인 금지).

---

## 도메인: saas (SaaS)

> 웹/앱 제품 개발, 풀스택, 배포. 사용자 결과 = **동작하는 제품 기능**.

### 표준 파이프라인

탐색(explore) → 계획(plan) → 구현 → 코드/보안 리뷰 → 동작 검증 → 배포

### 추천 에이전트 세트 (1단 기본 라우팅)

| 단계 | 우선 사용 | 비고 |
|---|---|---|
| 설계 | `system-architect`, `backend-architect`, `api-designer` | 구조 먼저 |
| 프론트 | `frontend-architect`, `react-specialist`, `nextjs-developer` | UI 구현 |
| 풀스택 구현 | `fullstack-developer`, `typescript-pro` | 경계 통합 |
| 배포 | `deployment-engineer`, `devops-engineer` | Vercel/systemd |
| 검수(분리) | `code-reviewer` + `security-engineer` + `test-automator` | 자기 승인 금지 |

### 추천 스킬 (작업 종류별)

- 제품 골격: `/saas-platform-builder`, `vercel:bootstrap`, `vercel:nextjs`
- 프론트 디자인: `/frontend-design`, `/ui-ux-pro-max`, `shadcn-ui` MCP
- 규율: `superpowers:test-driven-development`, `superpowers:systematic-debugging`
- 리뷰/배포: `/code-review`, `/verify`, `vercel:deploy`, `vercel:env`

### 도메인 검증 기준 (절대)

- **빌드 성공 ≠ 기능 동작.** UI 변경은 dev 서버 + 브라우저(playwright/ui-inspector) 시각 확인 후 완료.
- 배포 직후 엔드포인트 `curl` 응답 검증.
- 비동기 상태 변경은 렌더링 타이밍까지 확인.
- 시크릿 평문 금지(글로벌 보안 규칙). `.env`는 이름·위치만 기록.

## 다국어 상시 규칙 (2026-07-10 유건 지시 — 위반 금지)

- **모든 UI 문자열은 `app/i18n.jsx`의 사전(t)을 통해서만** 넣는다. 새 기능·페이지 추가 시 지시 없어도 ko/en 두 언어 모두 등록.
- 한국어 모드 = 고유명사(Argo, Claude 등) 제외 전부 한글. 마이크로라벨도 한글.
- 월 지출 한도는 한국어 모드에서 원화(₩, `fmtMoney` 고정 환산율) 표기.
- 언어 전환 단축키 `cmd+/` (i18n Provider가 처리). 언어 상태는 localStorage `argo-lang`.

## 삭제류 액션 규칙

- 크루 해고·회사 보관 등 파괴적 액션은 `ui.jsx`의 `DangerModal`(깃헙식 — 이름 입력 + 확인 문구) 사용. window.confirm/prompt 금지.
