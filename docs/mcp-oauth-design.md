# MCP OAuth 커넥터 설계 — "로그인만으로" 외부 서비스 연동 (2026-07-31)

> **North Star**: 사용자가 설정에서 "연결" 버튼을 누르고 브라우저 로그인 동의만 하면, 그 서비스
> (Gmail·Drive·Calendar·Notion·Linear …)를 **모든 러너의 크루가** 읽고 쓴다.
>
> **절대 조건(유건 지시 2026-07-31, 위반 금지)**: 러너·모델 무관 전부 동작. "codex 러너로는 되고
> Claude로는 안 되고" 류의 편차 금지 — 러너 중립성 원칙([[argo-runner-neutrality]])의 커넥터 판.

## 0. 왜 이 구조인가 — Hermes 실측에서 배운 것

유건이 Hermes Agent에서 "메일 확인해줘·드라이브에서 받아줘"가 러너 무관으로 되는 기전을
실코드로 확인했다(2026-07-30):

- 무거운 부분(구글 OAuth 앱 소유·심사·토큰 보관)은 **플랫폼 커넥터**(OpenAI codex 앱 커넥터,
  `~/.codex/plugins/cache/openai-curated/*` — manifest는 connector id 참조 + SKILL.md뿐)가 진다.
- Hermes는 그 커넥터를 **러너 밖 자기 도구 계층**으로 흡수한다 — 그래서 위에 얹는 추론
  모델이 뭐든 무관하다.
- Hermes에는 MCP 표준 OAuth 2.1 클라이언트 글루(`tools/mcp_oauth.py`: 토큰 영속·localhost
  콜백 서버·SDK 위임)가 별도로 있다.

**교훈 = 러너에게 클라이언트를 맡기지 마라.** Argo의 러너별 MCP 지형은 이미 편차가 있다
(SDK 러너만 회사 MCP 배선, CLI 러너는 미배선 — 중립성 감사 M4). 러너의 MCP 지원에 기대는 순간
절대 조건이 깨진다. 따라서:

> **MCP 클라이언트는 Argo 코어가 실행한다.** 러너는 "코어에게 도구 호출을 부탁"할 뿐이다.

## 1. 아키텍처

```
[설정 UI] --연결(OAuth)--> [코어 connectors.mjs]
                              │  MCP JS SDK client/auth (이미 의존성: @modelcontextprotocol/sdk ≥1.30)
                              │  - discovery(/.well-known) → 동적 클라이언트 등록 → PKCE
                              │  - localhost 콜백(임시 http 서버) → 토큰 교환
                              │  - 토큰 영속: 회사 secretbox(.secrets.json 계열 — sync 제외 기존 계약)
                              │  - 자동 갱신(UnauthorizedError → auth() 재수행)
                              ▼
                    [원격 MCP 서버] (gmail 커넥터 등 — 카탈로그 등재)
                              ▲
        ┌─────────────────────┴──────────────────────┐
 SDK 러너(claude/glm/kimi/openrouter)        CLI 러너(codex/gemini/antigravity)
 mcp__crew 도구 `use_connector`               ```argo {"action":"tool", ...}``` 지시 블록
 (기존 크루 MCP 서버에 동적 등재)              (schedule·mail·approval과 같은 자리·같은 계약)
```

- **단일 실행 경로**: 두 표면 모두 코어의 같은 함수(`callConnectorTool(wsId, server, tool, args)`)로
  수렴한다. 러너는 표면만 다르고 능력은 동일 — 중립성 감사 기준("같은 지시가 러너에 따라 되고
  안 되고가 갈리면 안 된다")을 구조로 담보.
- **왜 crew-MCP 동적 등재인가(SDK)**: SDK 턴에 원격 서버를 직결하면 토큰 갱신·OAuth 챌린지가
  러너 프로세스 안에서 터져 코어가 개입할 수 없다. 코어 프록시(mcp__crew 경유)면 갱신·오류
  안내·사용량 기록을 한 곳에서 한다.
- **왜 지시 블록인가(CLI)**: S3에서 검증된 패턴(파서·실행·결과 덧붙임·실패 정직 보고가 이미
  있다). 블록 실행 결과가 답변에 붙으므로 "했다고 말만 하는" 클래스가 원리적으로 막힌다.
  다중 왕복(도구 결과를 보고 다음 판단)은 1차에서 **후속 턴 자동 1회**(결과를 컨텍스트로 재턴)로
  근사하고, 부족 실측이 쌓이면 루프 상한을 올린다.

## 2. 구성요소별 계약

### 2-1. `src/connectors.mjs` (신설 — 코어 클라이언트)

- `listConnectors(wsId)` — 카탈로그(정의) × 회사 연결 상태(토큰 유무·만료) 병합.
- `startConnect(wsId, connectorId)` — OAuth 시작: SDK `auth(provider, …)` + localhost 콜백
  임시 서버(포트 0 임의 배정, state 검증, 120s 타임아웃). 반환 = 브라우저로 열 URL.
  데스크톱은 시스템 브라우저(기존 opener 경로), 호스팅 웹은 1차 미지원 **정직 표기**
  (콜백이 사용자 기기로 못 돌아온다 — 후속: 서버 리다이렉트 방식).
- `OAuthClientProvider` 구현(Hermes `HermesTokenStorage` 상당): `clientInformation`/`tokens`/
  `saveTokens` 등을 회사 secretbox에 영속. **토큰은 기기·회사 스코프**(자격 계열 — 동기화 제외,
  기존 `.secrets.json` 계약과 동일. 다른 기기는 그 기기에서 다시 연결 — workroots와 같은 원칙).
- `callConnectorTool(wsId, server, tool, args)` — SDK Client로 접속(연결 풀: 회사×서버당 1,
  유휴 타임아웃), `tools/list` 캐시, 호출 결과를 `{ ok, content, isError }`로 정규화.
  401/UnauthorizedError → 토큰 갱신 1회 → 실패면 "재연결 필요" 상태로 강등 + 정직 오류.
- 사용 기록: 호출마다 `appendEvent(type:'connector', server, tool)` — 활동 화면 가시화.

### 2-2. 크루 표면

- **SDK**: `makeCrewServer`에 `use_connector` 도구 추가 — 입력 `{ server, tool, args }`,
  설명에 연결된 서버·도구 목록 요약 주입(턴 시작 시 listConnectors 1회). 연결 0이면 도구
  자체를 등재하지 않는다(없는 능력 광고 금지).
- **CLI**: `cli-directives`에 `tool` 액션 — `{"action":"tool","server":"gmail","tool":"search_threads","args":{…}}`.
  실행 결과(정규화 요약, 상한 절단)를 기존 계약대로 답변에 덧붙이고, 결과가 필요한 지시였으면
  **자동 후속 턴 1회**(결과를 시스템 주입으로 재턴 — routines의 chat 재사용). 프롬프트 문법
  안내(schedule·mail·approval 소개부)에 병기.
- 프롬프트: `commonDirectives` MCP 절을 커넥터 포함으로 갱신 — "연결된 외부 서비스는 러너와
  무관하게 쓸 수 있다"로 서술이 사실과 일치하게(현재의 "SDK 턴에서 실행된다" 단서는 커넥터에
  한해 사라진다).

### 2-3. 카탈로그·UI

- `market.mjs` 카탈로그에 `kind:'connector'` 항목(US-2 확정 스키마):
  `{ id, name, url, scopes?, note, oauth?: { client_id, client_secret? }, dangerous?: [] }`.
  스킬·MCP 카탈로그와 **같은 자리·같은 문법**(ko/en 미러 + `connectorCatalogFor(lang)`)이고, 연결/해제도
  같은 마켓 라우트를 탄다(`POST {kind:'connector', id}` → `{authUrl}` / `DELETE ?kind=connector&id=`).
- **디스커버리 2모드**(`connectorMode`) — 분기는 카탈로그 한 곳에만 있고 코어는 모드를 모른다:
  ① **표준** = `oauth` 없음 → SDK가 PRM(RFC 9728) + DCR(RFC 7591) 자동. ② **고정** = `oauth.client_id`
  기입 → SDK가 DCR을 건너뛴다(DCR 미지원 서버 — 구글 실측). 두 모드는 `connectorServerDef`(순수 변환)를
  거쳐 **같은 `startConnect`로 수렴**한다. 행동 증거 = 테스트 AS의 DCR 카운터 1 vs 0(`test/connector-catalog.test.mjs`).
  `scopes`는 **연결 1회에 동의받을 합집합**이다(도구별 scope 재동의 방지 — 스파이크 §② 특이점 2).
  스파이크가 예비했던 `oauth.authorization_server`는 **넣지 않았다** — 코어가 소비하지 않는 죽은 필드이고
  (AS는 SDK가 PRM에서 찾는다), PRM 미발행 서버를 등재할 때 코어 지원과 함께 추가한다.
- 1차 등재는 **실턴 통과 검증분만**(기존 카탈로그 원칙) → **P1 등재 0**. 구글 3종은 GCP OAuth 클라이언트
  생성이 선행되어야 실턴이 돌기 때문에 US-8에서 등재한다. "등재 0"도 테스트가 잠근다(누가 실으면 red —
  그때 사람이 실턴 통과를 확인하고 항목 검증 테스트로 갈아끼운다).
- 해제(`disconnectConnector`) = 저장소 레코드(토큰·refresh·클라이언트 자격) 삭제 **후** 풀 정리 순서다
  (반대면 닫은 직후 다른 호출이 살아있는 레코드로 풀을 다시 연다). 원격 서버측 revocation은 지원이
  서버마다 갈려 하지 않는다 — "이 기기에서 자격이 사라진다"로 정직 표기.
- 카탈로그에서 내려간 뒤에도 토큰이 남은 연결은 **orphan 행**으로 계속 노출한다(`mergeConnectorStatus`) —
  안 그리면 살아 있는 토큰을 화면에서 해제할 방법이 사라진다.
- 설정 → 스킬·도구: 커넥터 카드(연결/해제 버튼, 연결 계정 표시, 재연결 필요 배지).
  i18n ko/en 필수(상시 규칙).

### 2-4. 보안·경계

- 토큰 저장 = **회사 루트 직속 도트파일 `.connector-secrets.json`(0600) + 동기화 제외**로, 러너 자격
  (`.secrets.json`)과 같은 보관 등급이다. "secretbox"라고 적었던 초안 문구는 정확하지 않다 — 이 레포의
  secretbox는 **동기화 봉투** 암호화이고, 동기화하지 않는 파일은 디스크에 평문 0600으로 둔다(러너 자격도
  동일). 크루 파일 도구·MCP 인자는 하드라인이 막고, **셸은 리터럴 1차 방어**(BASH_GUARDED 명시 등재),
  **CLI 러너는 게이트 밖**이다(`docs/runner-isolation-limits.md`) — 표면별 한계가 다르다. 평문 로그 금지.
- 커넥터 서버 URL은 **loopback 외 https 강제**(OAuth 2.1). 인가 콜백은 **loopback 바인드 + 고정 경로
  `/callback` + state + 120초**이며, 바인드 주소는 실측 검증해 loopback이 아니면 연결을 중단한다(fail-closed).
  경로를 시도마다 난수화하지 **않는다** — `redirect_uri`는 DCR 등록·콘솔 사전 등록으로 영속되는데
  RFC 8252는 loopback의 **포트만** 완화하고 경로는 정확 일치를 요구해서, 난수 경로는 재연결과 사전 등록
  client를 통째로 깨뜨린다(실측 400 `Unregistered redirect_uri`). 대신 **state 불일치 콜백은 거부하되
  시도를 종료하지 않는다** — 종료시키면 로컬 포트를 훑는 아무 웹페이지나 진행 중 인가를 끊을 수 있고,
  코드 배달은 정상 state로만 가능하므로 무시해도 보안 등급은 같다.
- 커넥터 도구 호출은 **회사 밖으로 나가는 행동을 포함할 수 있다**(메일 발송 등) → 위험 도구는
  결재 대상: 1차 규칙 = 쓰기 계열 도구(send/create/delete/update 네이밍 + 카탈로그별 명시
  목록)는 `request_approval`/`approval` 블록 경유를 프롬프트로 강제하고, 읽기 계열은 자유.
  (도구 단위 하드 게이트는 2차 — 카탈로그에 `dangerous:[…]` 선언 추가.)
- 콜백 서버는 loopback 전용·state 필수·고정 경로(위 단락의 예외 규칙 참조 — state 불일치는 거부하되
  시도를 끝내지 않는다). 동적 클라이언트 등록 실패 서버는 카탈로그에
  사전 등록 client_id를 실을 수 있게(`oauth.client_id` 선택 필드 — Hermes config와 동형).

## 3. 러너 중립 검증 기준 (출하 게이트)

- 같은 지시("최근 메일 3개 요약해줘")를 **연결된 러너 전부**(SDK 1종 + CLI 1종 이상)로 실행해
  같은 커넥터 호출이 일어나는지 부작용(활동 이벤트)으로 대조 — `e2e-runner-parity.mjs` 확장.
- 미연결 상태 문구·오류 안내가 러너별 동등한지(안내 품질 패리티).
- 변이: 코어 함수 제거 시 양 표면 테스트가 전부 red.

## 4. 남은 조사(스파이크 — 구현 1주차)

1. **구글 3종 원격 MCP 서버 선정**: 후보 = 구글 공식(존재 여부 확인), 신뢰 가능한 호스팅
   (운영 주체·데이터 정책 심사), 자체 호스팅(오픈소스 gmail MCP를 Argo 인프라에). 선정 기준 =
   토큰이 어디를 경유하는가(제3자 서버 경유 최소화) + OAuth 스펙 준수 + 무료/과금.
2. MCP JS SDK 1.30의 `client/auth` 실플로우 검증(디스커버리·동적 등록·refresh) — 테스트
   OAuth 서버(SDK examples의 simpleStreamableHttp --oauth)로 로컬 왕복 실증.
3. CLI 자동 후속 턴의 비용·루프 상한 실측.

## 5. 단계 나누기

- **P1(다음 배치)**: connectors.mjs + OAuth 왕복(로컬 테스트 서버 실증) + SDK `use_connector`
  + CLI `tool` 블록 + 설정 카드 + 카탈로그 1종(스파이크 결과) + 패리티 E2E.
- **P2**: 구글 3종 등재(스파이크 §4-1 결론), 위험 도구 하드 게이트(`dangerous` 선언), 호스팅
  웹 콜백(서버 리다이렉트), 커넥터 사용량·비용 가시화.
- **명시적 비목표**: Argo 자체 구글 OAuth 앱(후순위 — 외부 경유를 원치 않는 사용자 수요가
  실증되면), codex 커넥터 반입(러너 편향이라 본선 제외 — 유건 판정 2026-07-31).
