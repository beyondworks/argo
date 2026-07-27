# Antigravity 러너 — BYOA 2호 설계 (2026-07-27)

## 왜

구글이 **개인용 Gemini Code Assist OAuth를 폐기**하고 Antigravity로 이전했다(피드백 `38e5281d`가
환경·재현·기대·실제를 갖춰 규명 — Gemini CLI 0.52.0 `This client is no longer supported`, 브라우저
OAuth `400 invalid_grant`). 즉 **Google 구독으로 Argo를 쓰는 유일한 경로가 Antigravity CLI(`agy`)**다.
목적: 구글 구독 사용자도 Argo를 쓰게 한다(P0-2 종결 트랙).

## 분류 — BYOA (CLI 래핑 + 권한 근사 정직 표기)

러너 구조 정리(2026-07-27)의 이원화 규칙 그대로: 구독을 태우는 길은 CLI 래핑뿐이다.
세 번째 배관을 만들지 않는다. **서드파티 API 우회(opencode-antigravity-auth류)는 Google ToS 위반 +
계정 밴 보고가 있어 절대 쓰지 않는다** — 공식 CLI만.

## 실측 기반 (agy 1.1.7, 이 맥, 2026-07-27)

| 항목 | 실측 | 함의 |
|---|---|---|
| 원샷 | `-p/--print` + `--model` + `--print-timeout` | codex/gemini 선례 그대로 래핑 |
| 자격 | OS 키링(맥 Keychain/Win Credential Manager). `GEMINI_API_KEY` 무시(공식 문서) | 파일 감지·붙여넣기·웹 브리지 전부 불가 → **host 옵트인 전용** |
| 미로그인 + `-p` | 로그인 플로우를 못 열고 `Error: timeout waiting for response`(exit 1)만 | apiError 매핑으로 로그인 안내 번역(장시간 초과와 문구 동일 — 두 원인 병기) |
| `agy models` | 로그인 없이도 출력(11종) | 카탈로그 재료. 단 **실계정 실턴은 미검증** |
| 권한 | `--mode accept-edits`(편집만 자동 승인) · `--sandbox`(터미널 제한) | accept-edits 상시 + 셸 능력 OFF면 `--sandbox` — 근사 적용 |

## 구현 결정

- **디스패치 일반화**: `isCliRunner(r) = RUNNERS[r].kind === 'cli'` 신설, chat/oneshot의
  `'codex' || 'gemini'` 하드코딩 제거 — 다음 CLI 러너부터 배선 누락이 구조적으로 사라진다.
- **감지**: `authed = installed`(낙관). 키링은 파일로 판정 불가 — "감지 단계에서 유효성까지는
  판정하지 않는다"(2026-07-19 원칙)에 따르고, 미로그인은 첫 턴 에러 매핑이 잡는다.
  이 값이 없으면 host 마커가 저장 즉시 invalid로 오표시된다(runnerStatus 1253행 게이트).
- **자동 조달 없음**: 인스톨러가 셸 프로파일을 수정한다 — 사용자 홈 부작용이 있어 설치 안내가 정직하다
  (gemini의 번들 조달과 다른 판단, agyCmd 주석에 명시).
- **Gemini 실패 안내 연결**: `IneligibleTierError` 매핑에 "Antigravity 러너 연결" 대안 추가 —
  구독 사용자가 API 키 발급으로 우회하지 않아도 되게.

## 미검증 (정직 표기 — 발행 전 확인 항목)

1. **실계정 실턴 0회** — 이 맥에 agy 로그인이 없다. 유건 로그인 또는 제보자(`38e5281d`) 베타 확인이 관문.
2. 상주(launchd)·데스크톱 번들에서 spawn된 agy의 **키링 접근** — agy 자체 서명 바이너리라 되리라 추론
   (claude 재서명 node 키체인 차단과 다른 구조)이나 실측 아님.
3. `--sandbox`의 정확한 제한 범위 — "terminal restrictions"라는 도움말 문구뿐.
4. Windows 경로 폴백 — `%LOCALAPPDATA%\agy\bin\agy.exe` 후보를 추가했으나 실기기 미검증.
5. 성공 턴의 glog 실형식 — 스크럽 정규식은 표준 glog(시각 필드 포함)를 전제(재검 N2). 시각 필드
   없는 로그면 답변에 새어들 수 있다(옛 통삭제보다는 가벼운 실패 방향).
6. agy `--sandbox` 거부의 능력 카드 승격(검수 L2) — codex는 거부를 능력 카드로 승격(#113)하는데
   antigravity는 아직 안 한다. 같은 "권한 켰는데 차단" 신고가 재발하면 이 자리부터.

## 분리 검수 반영(2026-07-27, REJECT → 수정)

- H1a: RUNNER_AUTH·PICK_ORDER에서 antigravity를 **맨 끝**으로 — 낙관 authed 러너가 검증 러너를 선점 금지.
- H1b: 타임아웃 매핑 문구에 "not logged in" 포함 — AUTH_ERR_RE 자가치유(1회 폴백) 계약.
- H1c: `authUnknown` 플래그 — UI가 "로그인됨" 단정 대신 "확인 불가"를 그림(거짓 유효 표기 금지).
- H2: `--sandbox` fail-closed(caps 미전달=제한 켬). M1: apiError(e, runner) 게이트(stdout 오염 오분류 차단).
- M2: glog 스크럽에 시각 필드 요구. M3: 마진 30s 미달 시 --print-timeout 생략(플로어 폐지).
