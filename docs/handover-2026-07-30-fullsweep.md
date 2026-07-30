# 인수인계 — 메인 앱 전수검사 + 전권 전환 (2026-07-30)

> 브랜치 `feat/bypass-default` · 워크트리 `~/lean-projects/_worktrees/argo-bypass` · 베이스 `origin/main` 09d3683(v0.1.34)
> 상태: **커밋 4개 전부 그린** — 테스트 586개 중 582 통과·0 실패(스킵 4 = PG 드릴, main 기준선과 동일)·`next build` 통과.
> 안전하게 중단 가능한 지점이다. 다음 세션은 아래 "남은 일"부터 이어받으면 된다.

## 이 세션이 한 일

1. `origin/main` 정본을 별도 워크트리에 뽑아 **메인 앱 전수 리뷰**(7레인 병렬: 러너·대화코어·게이트웨이·결제·API 52라우트·UI+i18n·architect)
2. 유건 지시로 **로컬 능력 전권 전환**(Hermes YOLO 설계 이식)
3. 리뷰에서 확정된 결함 2건 수정

## 커밋

| 커밋 | 내용 |
|---|---|
| `bf567af` | feat(caps): 설치 시점부터 전권 — 능력 토글 제거, 하드라인만 남김 |
| `ca6bc6a` | test(caps): 전권 계약으로 테스트 재작성 — 동결 불변식 추가 |
| `bb430f3` | fix(gateway): `listAgents` 임포트 누락 — 크루 쪽지 브리핑 100% 무동작 |
| `270f94e` | fix(crewmail): CLI 지시 경로 hop 리셋·자기수신 |

## 전권 전환 — 설계 근거 (되돌리기 전에 반드시 읽을 것)

QA 최다 클러스터가 "권한 때문에 막힌다"였다(41건 중 11건·제보자 7명, `docs/qa-feedback-backlog-2026-07-27.md` P0-1). v0.1.34 발행 **후에도** 같은 제보가 계속 들어왔다 — "Codex가 항상 read-only", "설정에 켤 항목이 없다", "저장이 안 되고 읽기만 된다".

Hermes Agent(`~/.hermes/hermes-agent/tools/approval.py`) YOLO 설계를 이식했다:

1. **하드라인이 전권보다 먼저 판정된다.** Hermes 주석 그대로 — "yolo를 켠다는 건 파일과 서비스를 맡긴다는 뜻이지 디스크를 밀거나 전원을 내려도 된다는 뜻이 아니다". Argo의 하드라인 = `permission-gate.mjs`의 금지 구역.
2. **전권 플래그를 상수로 동결.** Hermes는 YOLO를 import 시점에 얼리고 이유를 "프로세스 안 스킬이 env를 세팅해 즉시 우회(프롬프트 인젝션 승격 경로)"라고 적었다. Argo가 정확히 그 사고를 겪었다(2026-07-27 `capabilities.json` 자가 승격). **파일에서 읽지 않으면 그 경로 자체가 사라진다.**

### 실제 기전 — 왜 codex가 read-only였나

`src/runners/codex.mjs:115,175`의 `writable_roots`가 `caps.fs`에 걸려 있었다. `--sandbox workspace-write`는 이미 켜져 있었고 **쓰기 루트만 비어** 있었다. fs를 못 켠 사용자는 워크스페이스 밖 전부가 read-only. 전권이 되면 `homedir()`가 들어가 `C:\Users\USER\Desktop\점검폴더`가 쓰기 가능해진다.

### 같이 닫은 것 — 게이트가 유일한 방어선이 됐으므로 필수였다

- `allowedTools`에서 bare `mcp__<서버>` 제거. SDK가 괄호 없는 bare 항목을 **콜백 상담 전에 자동 승인**한다(벤더 코드 `sdk.mjs`가 직접 그렇게 쓰고 `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` 경고를 낸다). 이게 있는 동안 게이트의 MCP 분기는 프로덕션에서 **도달 불가**였고, 파일 쓰기형 MCP를 연결하면 자가 승격 경로가 다시 열렸다.
- 벤더 자격(`~/.codex`·`~/.claude`·`~/.gemini`)을 하드라인에 추가.
- 심링크 우회 차단 — 하드 구역을 렉시컬(`abs`)·canonical(`real`) **양쪽 fail-closed**로. 조달이 만드는 `~/.argo/codex-home/auth.json → ~/.codex/auth.json`이 canonical만 보면 빠져나갔다.
- `argPathsForbidden`을 배열·중첩 객체·상대경로까지 검사(길이·개행 컷으로 비용 방어).
- `request_capability` 도구와 **"설정 → 로컬 능력에서 켜세요" 안내 문구 제거** — 없는 메뉴로 사장을 보내던 게 "설정에 못 찾겠어요"의 원인이었다. ko/en 양쪽. 재작성한 테스트가 실제로 잔여 1건을 잡았다(한국어 결재 규칙에 하나 더 남아 있었음).

### 새로 잠근 불변식

- `capabilities.json`에 무엇을 써도(위조·손상 포함) 런타임 권한이 안 바뀐다 + `Object.isFrozen(CAPABILITIES)` → 자가 승격 경로 소멸을 테스트가 보증
- ko/en 양쪽에서 **없는 메뉴·없는 도구 안내 시 테스트 실패**

## 전수 리뷰 결과 — 남아 있는 확정 결함

### 미수정 (다음 세션 우선순위)

| # | 위치 | 내용 | 검증 상태 |
|---|---|---|---|
| 1 | `app/api/companies/[ws]/chat/route.js:34` | `appendTurn`이 `chat()` 성공 후에만 호출 → 실패·중단 턴의 사장 지시문·부분 응답이 서버에 안 남는다. 비용은 지출됨 | 코드 확인 |
| 2 | 없음(도입 과제) | **eslint `no-undef` 부재가 구조적 원인.** 오늘 잡은 `listAgents` 결함이 그 규칙 하나로 잡혔을 종류다 | — |
| 3 | `src/chat.mjs:565` ↔ `src/routines.mjs:4` | 유일한 정적-정적 순환. 톱레벨 부작용이 추가되면 TDZ `ReferenceError` → Next 라우트 500 | architect 2차 보고 |
| 4 | `src/gateway.mjs` cfg/큐 키 | `globalThis.__argoGwCfg` 문자열 키 9지점 + `qkey.slice(3)` 변환. 키가 어긋나면 잡이 **무로그 폐기**된다 | architect 2차 보고 |
| 5 | `supabase` `is_pro()` | `ends_at`이 판정에 안 들어간다 → 만료 웹훅 1건 유실 = 영구 무료 Pro. 대사는 승격 전용 | 결제 레인 2차 보고 |
| 6 | `src/sync.mjs` | free 플랜에서 삭제 전파는 성공·업로드는 RLS 거부 → 클라우드 사본 단조 감소 | 결제 레인 2차 보고 |

### CSRF — 등급을 낮춘 근거 (재조사 시 참고)

리뷰 에이전트가 CRITICAL로 올렸으나 **직접 라이브 재현해 범위를 좁혔다**:

```
무인증 로컬 모드  교차출처 POST /api/companies → 200, 회사 생성
                  교차출처 POST .../capabilities → shell·bypass 켜짐(당시 코드)
인증 on 모드      같은 요청 → 401 (미들웨어가 라우트 앞에서 차단)
```

출하 데스크톱은 `release.yml`이 `NEXT_PUBLIC_SUPABASE_URL`을 빌드에 인라인해 인증 on이고, 교차출처 POST는 SameSite=Lax로 쿠키가 안 실려 미들웨어에서 막힌다. **출하본은 뚫리지 않는다.** 남는 것은 소스 실행·Supabase env 없는 자체 호스팅의 실제 노출 + `csrfDenied`가 상태변경 핸들러 61개 중 7개에만 걸린 심층방어 부채. 미들웨어 일괄 게이트(`sec-fetch-site`)로 닫는 것이 권고안이며 웹훅만 예외.

### architect 판정: WATCH

가장 강한 반대 논거 — **새 아키텍처를 지키는 테스트가 구조가 아니라 소스 텍스트를 정규식으로 잠근다.** `test/runners-facade.test.mjs:46`, `test/billing-gate.test.mjs:152`, `test/antigravity-runner.test.mjs:47` 등이 `src.includes('export async function externalExec')` 식이라 **올바른 리팩터에 빨간불이 뜬다**. 그리고 `scripts/e2e-*.mjs` 5개가 어떤 워크플로에도 배선되지 않았다(`npm test`·CI 모두 미포함).

## 남은 일 (순서 권고)

1. 위 표 #1(턴 기록 유실) → #2(eslint) → #3·#4(구조)
2. **전수 `/simplify`** — 이번엔 권한 축 하나만 정리(233줄 삭제/125줄 추가). 미착수: 대형 파일 분해(`crew/[slug]/page.jsx`의 `CrewChat` 1105줄·useState 42 / `chat()` 약 500줄), 소스텍스트 트립와이어 → 행동 단언, 게이트웨이 키 단일화
   - **순서 주의(architect)**: `CrewChat` 분해 전에 UI 회귀를 잡을 수단을 먼저 만들 것. 현재 `app/**` 12.9k줄에 렌더 테스트가 0이다. `chat()`의 CLI/SDK 분기 추출이 더 안전한 선착수 대상
3. `npm run e2e` 스크립트 + CI 별도 잡 배선
4. **`/code-review ultra`는 유건님이 직접 실행** — 에이전트가 트리거할 수 없는 유료 클라우드 리뷰다
5. 릴리스 드릴: 버전 4파일 범프(Cargo.lock 크레이트명 = `app`) → CI 수동 실행 → 공증 검증(실리콘·인텔 각각) → 인텔 dmg 존재 게이트 → `latest.json` 수제 → argo-agent 발행 → 엔드포인트 `curl` 검증

## 미검증 — 정직 표기

- **Windows 실기기에서 codex 크루가 `Desktop\점검폴더`에 실제로 쓰는지 확인 못 했다.** 코드 경로 근거이며 실기기가 필요하다. 이번 변경의 핵심 사용자 가치라 발행 전 실기기 확인을 권한다.
- 표 #3~#6은 **서브에이전트 2차 보고**이고 원문 대조를 하지 않았다. 착수 전 재실측할 것.
- 리뷰에서 나온 러너 레인 지적 중 심링크 우회는 수정했으나, ReDoS(`runner-denial.mjs` 정규식 백트래킹 256KB→18.4초 주장)는 **미검증·미수정**이다.

## 이 세션에서 얻은 교훈

- **소스 문자열 대조 테스트는 "분기 존재"만 보고 "분기가 도는지"를 못 본다.** `listAgents` 결함이 그렇게 통과했다. 배선 검증은 실행 또는 최소한 임포트까지 단언해야 한다 — 그리고 그 단언이 진짜 게이트인지 되돌려서 확인할 것(이번에 확인함).
- **다른 레포의 "발견"을 그대로 이식하지 말 것.** argo-next의 Claude OAuth 발견 3건 중 2건은 Argo에 이미 있었고(`webauth.mjs:20-21`), Bearer 버그는 argo-next 고유였다(`creds.mjs:264`가 이미 올바름). 진짜 차이는 **토큰 소비 경로**였다 — argo-next는 API 직접 호출(Bearer OK), Argo는 Claude Code SDK(`sk-ant-oat01` 필수). 교체하면 "연결됨인데 전 턴 401" 미궁이 재발한다. 미탐색 실마리는 `api.anthropic.com/api/oauth/claude_cli/create_api_key`(교환 후 후속 발급 단계)뿐이다.
- **stale 문서를 근거로 고치지 말 것.** QA 백로그 P0-1(11건)은 v0.1.30 기준이라 이미 workroots로 해소돼 있었다. 현행 코드 대조가 먼저다.
