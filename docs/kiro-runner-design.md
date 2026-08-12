# Kiro 러너 — BYOA 3호 설계 (2026-08-12)

## 왜

Kiro CLI(`kiro-cli`)는 **AWS 계정 하나로 여러 벤더 모델을 함께 쓴다** — 실측 카탈로그에 Claude
(Opus 5·Sonnet 5·Haiku 4.5), GPT-5.6(Sol·Terra·Luna), GLM-5, DeepSeek V3.2, MiniMax M2.5,
Qwen3 Coder Next가 한 자격 아래 있다. 지금 Argo에서 같은 폭을 얻으려면 러너를 여럿 연결해야 하고,
회사 구독으로 Kiro를 쓰는 사용자는 그 구독을 Argo에 태울 경로가 아예 없다.

목적: **IAM Identity Center / Builder ID 구독 사용자가 자기 자격으로 Argo를 쓰게 한다.**

## 분류 — BYOA (CLI 래핑 + 권한 근사 정직 표기)

러너 구조 이원화 규칙 그대로다. 구독을 태우는 길은 CLI 래핑뿐이고, 세 번째 배관을 만들지 않는다.
`kiro-cli`의 자격은 CLI 로그인이고 토큰은 로컬 데이터 저장소(macOS
`~/Library/Application Support/kiro-cli`)에 있어 붙여넣을 API 키 표면이 없다 — codex·antigravity와
같은 **host 옵트인 전용**이다.

## 실측 기반 (kiro-cli 2.17.0, macOS 26, 2026-08-12)

| 항목 | 실측 | 함의 |
|---|---|---|
| 원샷 | `chat --no-interactive [--model] [--effort] --wrap never -- <prompt>` exit 0 | codex/gemini 선례 그대로 래핑. `--`가 있어 `---`로 시작하는 카드 frontmatter 안전 |
| 데몬 스폰 | TTY 없음 · stdin 닫힘 · 최소 env에서도 exit 0 | 상주(launchd)·헤드리스 경로에서 동작 |
| 모델 | `chat --list-models --format json` → 19종. 그중 10종 원샷 왕복 **10/10 통과** | 카탈로그 규칙("실행 경로 실턴 통과 id만") 충족 |
| 추론 강도 | `--effort low\|medium\|high\|xhigh\|max` | Argo `effort`와 1:1 — codex와 같은 자리 |
| 자격 판정 | `whoami` → 로그인 `Logged in with IAM Identity Center`(exit 0) / 미로그인 `Not logged in`(exit 1) | **파일이 아니라 CLI에 직접 묻는다** → antigravity와 달리 낙관 authed가 아니다 |
| 미로그인 턴 | 비대화에서도 브라우저를 열려 시도 → `error: OAuth error: Auth portal timed out`(exit 1) | apiError 매핑으로 로그인 안내 번역(+ AUTH_ERR_RE 계약) |
| 설정 격리 | `<cwd>/.kiro/agents/<name>.json` + `--agent <name>`. `mcpServers:{}` + `useLegacyMcpJson:false` | 사용자 전역 MCP 서버 경고·의도 밖 도구 소멸(실측) |
| 최종 답변 | 어시스턴트 메시지 **첫 줄에만** `> ` 접두사. 도구 추적은 무접두사 | 마지막 `> ` 블록 = codex `--output-last-message` 등가 |
| 마크다운 인용 | 모델이 `> quoted`를 내면 렌더 결과는 `│ quoted` | 접두사와 충돌하지 않는다 |

### 파일 반경 강제 — 네 수단 중 하나만 산다

`toolsSettings`에 경로 규칙이 있다는 공식 문서를 그대로 믿지 않고 넷을 다 돌렸다(레포 규칙:
문서만 보고 추가 금지). 비대화(`--no-interactive`) 기준 실측이다.

| 수단 | 실측 결과 |
|---|---|
| `tools` 목록에서 제외 | **하드** — 도구 자체가 없다 |
| `allowedTools` | 포괄 자동 승인. 비대화에서 **필수** — 없으면 반경 안쪽 쓰기까지 전부 거부됐다 |
| `toolsSettings.*.allowedPaths` | **효력 없음** — 자동 승인을 주지 못해 안쪽까지 거부. `allowedTools`를 함께 주면 포괄 신뢰가 경로 규칙을 덮는다(문서 신뢰 우선순위 4 > 5와 일치) |
| `toolsSettings.*.denyByDefault` | **무시됨**(shell 전용). write/read에 넣어도 반경 밖 쓰기가 성공 |
| deny 글롭 부정 패턴(`!`) | **미지원** — `["$HOME/**", "!<work>/**"]`은 carve-out 없이 전부 차단 |
| `toolsSettings.*.deniedPaths` | **하드 차단. `allowedTools`보다 우선**(파일 미생성 + 크루가 "blocked by safety constraints" 보고) |

결론: **화이트리스트 의미를 표현할 수 없다.** `openRoots`(홈+지정 폴더)를 인자로 실을 자리가 없다.

## 구현 결정

- **집행 = 불변 경계 deny.** `openRoots`를 흉내내지 않고, "지정으로도 열리지 않는 금지 구역"
  (`workroots.mjs` 보안 경계)만 `deniedPaths`로 옮긴다 — APP_ROOT · `~/.argo` ·
  WS_ROOT의 **형제 회사**(교차 테넌트) · 직속 도트 항목(회사 금고 `.workroots.json`·계정 시크릿).
  경계는 `cwd`에서 도출한다(`dirname(cwd)` = WS_ROOT — permission-gate와 같은 계산, 새 임포트 0).
  WS_ROOT를 통째로 deny하면 자기 회사(크루 책상)까지 막히므로 형제만 열거한다(readdir 1회).
- **`caps.fs` 반경 차이는 UI 정직 표기.** 지정 폴더가 반경으로 적용되지 않는다는 사실을
  `i18n settings.workroots.runnerNote`가 ko·en 양쪽에 명시하고, `test/kiro-runner.test.mjs`가
  그 표기를 잠근다. 러너별 집행 강도 차이를 화면이 정직하게 말하는 방식은 이 레포가 이미 채택했다
  (`workroots.mjs` 러너별 집행 절 — 그 주석에 kiro 항목을 추가했다).
- **`allowedTools` = `tools`.** 비대화에서 포괄 신뢰가 없으면 도구가 전부 거부되므로 선택이 아니다.
  대신 능력(caps)이 `tools` 자체를 깎는다: 셸 OFF면 `shell`이 없고, 브라우저 OFF면 `web_fetch`가 없다.
  **fail-closed** — caps 미전달(oneshot 영입·기억정리)이면 둘 다 끈다.
- **턴별 에이전트 설정 + 고유 이름.** `<cwd>/.kiro/agents/argo-<uuid8>.json`을 매 턴 쓰고
  `finally`에서 지운다. 고정 이름이면 같은 회사에서 두 크루가 동시에 답할 때 한쪽 `finally`가
  다른 쪽의 실행 중 설정을 지운다. 이 경로 자체도 deny 목록에 들어가 크루가 자기 권한 설정을
  고쳐 다음 턴을 승격시키는 길을 막는다.
- **감지는 `whoami`.** 파일 존재로는 판정할 수 없다(토큰이 데이터 저장소·OS 보관).
  ⚠ 정규식은 **줄머리 앵커가 필수**다: codex가 쓰는 `/Logged in/i`는 `"Not logged in"`에도
  매칭돼 미로그인을 '연결됨'으로 뒤집는다. `/^Logged in/im`을 쓴다(테스트가 이 함정을 잠근다).
  비용 ~1.3초지만 `detectRunners`의 `Promise.all` 안이고 상위 캐시가 10분이라 체감 없다.
- **`connect`(로그인 대행) 미배선.** `kiro-cli login`이 라이선스 종류(free/pro)·IdP URL을 되묻는
  대화형일 수 있어(미검증) detached spawn이 조용히 멈출 위험이 있다 — 터미널 로그인 안내가 정직하다.
- **자동 조달 없음.** 공식 인스톨러가 셸 프로파일을 수정하고 데스크톱 앱까지 함께 설치한다
  (antigravity와 같은 판단). PATH 설치본 → `~/.local/bin/kiro-cli` 폴백까지만.
- **RUNNER_AUTH 배치는 grok 뒤 · antigravity 앞.** antigravity가 맨 끝인 이유는 낙관 authed가
  검증된 자격을 선점하지 못하게 하는 것인데(분리 검수 H1a), kiro는 authed가 실측값이라 그 문제가 없다.

## 검증 (실측 — 라이브)

- **게이트**: `npm run lint` 통과. `npm test` **904 tests / 899 pass / 0 fail / 5 skipped**
  (기존 883에서 +21 — `test/kiro-runner.test.mjs`).
- **E2E**(`node scripts/e2e-kiro.mjs`, 격리 `ARGO_ROOT` + 포트 3164 + Supabase env 제거):
  카탈로그(kind=cli·10모델·installed) → 상태(`hostAuthed=true` 실측·`cli=true`·`authUnknown` 없음)
  → host 옵트인 → 회사 생성 → **크루 영입 턴**(실 LLM) → **채팅 턴**(`kiro-ok`) →
  **턴 잔재 0** → **경계 집행**까지 전부 통과.
- **경계 집행은 실측이다**: 크루에게 WS_ROOT 직속 도트(계정 시크릿 모의 파일)를 읽으라고 지시했고
  크루가 `BLOCKED`으로 답했으며 내용이 유출되지 않았다.
- 모델 10종 원샷 왕복 10/10(위 표).

## 미검증 · 알려진 한계 (정직 표기 — 발행 전 확인 항목)

1. **답변 절단(실증된 결함).** 최종 답변 **2행 이후**의 코드블록에 `> `로 시작하는 줄이 있으면
   그 줄을 새 메시지 시작으로 오인해 앞부분이 절단된다(재현: `Here is the snippet:` +
   ```` ``` ````/`> git status` → 앞 문장 유실). 렌더 결과에 코드펜스가 남지 않아 "코드블록 안"을
   판별할 수단이 없다. 셸 프롬프트·git 출력·마크다운 예시가 답변에 섞이는 코딩 맥락에서 발현한다.
   → **근본 해법은 `kiro-cli acp`**(Agent Client Protocol, JSON-RPC over stdio): 메시지가 구조화돼
   파싱이 사라지고, 도구 호출을 우리가 승인·거절하므로 아래 2·3번도 함께 닫힌다. 별도 PR 권장.
2. **`caps.fs` 반경 미강제**(설계상 수용 + UI 표기). 사장이 지정 폴더를 좁게 걸어도 이 러너에서는
   반경이 되지 않는다. 불변 경계 밖의 이 컴퓨터 파일은 크루가 열 수 있다.
3. **셸 능력 ON 시 명령 경계 없음.** `shell.allowedCommands`/`deniedCommands`/`denyByDefault`가
   문서에 있으나 **미검증**이라 쓰지 않았다. 읽기·쓰기와 집행 강도가 갈리는 자리 —
   `deniedCommands`가 실제로 하드 차단이면 금지 구역 리터럴 방어(permission-gate `bashHardLiterals`)를
   그대로 옮길 수 있다. 후속 실측 항목.
4. **전역 기본 리소스 상속.** 커스텀 에이전트는 전역/워크스페이스 steering·skills·`AGENTS.md`를
   자동 상속한다(공식 문서). 끄는 스위치가 전역 설정(`chat.disableInheritingDefaultResources`)뿐이라
   에이전트 설정으로는 막을 수 없다. 즉 **사용자 개인 kiro 설정이 크루 턴 맥락에 섞일 수 있다**.
   보안 경계 문제는 아니지만(같은 사용자) 크루 행동이 기기마다 달라질 수 있다 — 미실측.
5. **Windows 전반.** `%LOCALAPPDATA%\kiro-cli\bin\kiro-cli.exe` 경로 후보는 실기기 미검증이고,
   `deniedPaths` 글롭이 백슬래시 경로에서 매칭되는지도 미검증이다. 후자가 실패하면 경계가 조용히
   열린다 — Windows 실기기 확인 전에는 그 환경 발행을 보류할 것.
6. **상주(launchd)·데스크톱 번들에서 자격 접근.** 데몬 유사 환경(TTY·stdin·최소 env)은 실측했으나,
   실제 launchd 서비스와 Tauri 사이드카에서 `kiro-cli`가 자기 토큰 저장소를 여는지는 미확인
   (claude 재서명 node 키체인 차단 전례가 있는 클래스).
7. **형제 회사 열거 TOCTOU.** 설정을 쓴 뒤 그 턴 중에 새 회사가 생기면 그 폴더는 이 턴에 deny되지
   않는다. 회사 생성은 사장의 UI 행위라 턴 중 발생이 비현실적이고 다음 턴엔 잡힌다 — 수용.
8. **`login --use-device-flow`.** 존재는 확인했으나 배관은 붙이지 않았다. grok의 `deviceCode`
   패턴을 그대로 쓸 수 있어(상주·헤드리스에서 루프백 리스너 없이 로그인) 후속 후보.
9. **비용 표면.** kiro-cli는 턴마다 크레딧을 소비한다(실측: 한 줄 응답 ≈ 0.02~0.03). 자격 타입이
   `host`라 Argo 청구 판정은 "구독 안"으로 잡히는데(`billedByType`) 이는 API 키 과금이 아니라는
   뜻이지 무료라는 뜻이 아니다. 크레딧 잔량 소진 시그니처는 미실측 — OpenRouter 402·Grok 크레딧
   처럼 별도 안내가 필요할 수 있다.
