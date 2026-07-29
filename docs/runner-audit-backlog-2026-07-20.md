# Argo 러너 서브시스템 감사 백로그 — 2026-07-20

> 기준 코드 = main v0.1.15(`6e8709c`) + PR #49(`c767249`). 31 에이전트(알려진 백로그 4그룹 검증 + 4렌즈 발굴 + 발견 전건 적대 검증) — 신규 23건 전부 반증 실패(생존), 기각 0.
> CONFIRMED = 코드로 인과 사슬 완전 확인 / 일부 항목은 라이브 재현 미실시(정적 분석) 명기.
> 제외: MCP 마켓 정직성(동시 세션 `fix/mcp-oneclick-honest` 수리 중) · PR #49가 이미 닫은 갭.

## P0 — 보안 (즉시)

- [x] **PKCE code_verifier를 `state` 파라미터로 인증 URL에 노출** · `src/runners.mjs:596` · **HIGH CONFIRMED** → **PR #50** (state 별도 난수+제출 대조, 분리 보안검수 APPROVE)
  붙여넣기 폴백 경로에서 사용자가 복사·공유하는 리다이렉트 주소에 code+state(=verifier)가 모두 실림 → 그 주소만 있으면 제3자가 어디서든 토큰 교환 완료(ChatGPT/Google OAuth 토큰 탈취). PKCE가 막으려던 코드 탈취를 state 설계가 도로 개방. codex/gemini는 submit 시 state 검증도 부재(:636은 claude 전용 죽은 분기).
  수정: state = verifier와 무관한 별도 난수 + submitRunnerWebAuth에서 대조, verifier는 서버 메모리에만.

## P1 — "연결됨인데 안 됨" 클래스 (제품 핵심 약속 위반) → **4건 전부 PR #52** (분리 검수 APPROVE)

- [x] **웹 브리지 재연결 불가 — 기존 자격 존재를 '새 연결 완료'로 오판, 2초 만에 거짓 '연결됨'** · `app/api/companies/[ws]/keys/connect/route.js:46`(account 동형 :49) · MED CONFIRMED (2렌즈 중복 확인)
  API키→OAuth 전환·invalid 재연결 모두 OAuth 승인 전에 성공 선언. 수정: 폴링 판정을 '이번 브리지 세션 시작 이후 저장됨'으로.
- [x] **재연결한 OAuth 자격이 다른 기기에 영영 미적용** · `src/runners.mjs:432`(codex)·`:450`(gemini) · MED CONFIRMED → PR #52 (seedAuthFile 원본 해시 마커 — CLI 갱신 보존 + adopt 마이그레이션)
- [x] **gemini host 옵트인이 호스트 로그인 1회 스냅샷 후 동결** · `src/runners.mjs:456-463` · MED CONFIRMED → PR #52 (호스트 해시 추종 adopt=false, 기존 동결 즉시 해동)
- [x] **detectRunners 60초 캐시가 host 옵트인 클릭을 오거절** · `app/api/companies/[ws]/keys/route.js:30`(account :36) · MED CONFIRMED → PR #52 (옵트인 PUT만 force)

## P1 — env·시크릿 위생 → **3건 PR #53** (분리 보안검수 APPROVE)

- [x] **실행 러너 외 제공사 키 전부가 모든 턴 자식 프로세스에 상속** · MED CONFIRMED → PR #53 (PROVIDER_AUTH_OWNERS 소유권 맵 + scrubServerSecrets(env, runner))
- [x] **glm/kimi 분기가 CLAUDE_CODE_OAUTH_TOKEN 미소거** · MED CONFIRMED → PR #53 (명시 소거 벨트 + scrub)
- [x] **외부 CLI 실패 경로(apiError) 시크릿 마스킹 부재** · MED CONFIRMED → PR #53 (maskKeyLike 공용 유틸 — chat.mjs clean()과 통일)
- [ ] (검수 후속 권고, 비차단) 부가 자격 env(`GOOGLE_APPLICATION_CREDENTIALS`·`AWS_*` 등) allowlist 전환 · claude cred 분기 `ANTHROPIC_BASE_URL`/`AUTH_TOKEN` 정규화
- [ ] **AUTH_ON 다중 사용자(비TENANT) 배포에서 host 옵트인 인가 게이트 부재** · `src/runners.mjs:150-153` · MED CONFIRMED
  아무 로그인 사용자나 서버 운영자 CLI 구독으로 과금 가능(#26과 같은 토폴로지). 비기본 배포 조건이라 MED.

## P2 — 실행·경쟁·상태 표시

- [ ] **경쟁 동시 턴이 같은 slug 키 공유 — 정지가 마지막 entrant만 중단** · `src/turn-abort.mjs:9` · MED CONFIRMED. 먼저 끝난 시안이 상태 파일 삭제 → 도는 턴이 유휴로 오표시.
- [ ] **러너 전환·자가치유 후 낡은 SDK sessionId resume — CLI 시절 대화 누락 맥락으로 답변** · `src/chat.mjs:644`·`src/thread.mjs:26-31` · MED CONFIRMED ('끊김 없는 기억' 위반, 라이브 재현 미실시)
- [ ] **경쟁 폴백 시 entrant 라벨이 요청값 그대로 — 실행 엔진 오표시** · `src/compete.mjs:88-109` · MED CONFIRMED. chat()이 실행 러너를 반환하지 않는 구조 문제.
- [ ] **외부 CLI 턴 상태 1회 기록 → 2분 스테일 판정에 진행 표시 소멸** · `src/chat.mjs:576` · MED CONFIRMED. 재전송 유도→중복 턴·이중 과금(동시 턴 잠금도 없음). 수정: 하트비트.
- [ ] **월 예산이 runOneShot 경로 미차단** · `src/oneshot.mjs:11`·`src/scheduler.mjs:58-67` · MED CONFIRMED. 한도 초과 후에도 매일 기억 정리가 유료 호출(소액이라 MED).
- [ ] **경쟁 턴이 cc 공유 노트 소비** · `src/chat.mjs:564` · MED CONFIRMED. 격리 시안이 대기 맥락을 먹어 실대화 턴에 미주입. 수정: source='compete'면 peek만.

## P2 — 표면 정직성·UX (알려진 백로그 재확인 포함)

- [ ] K1 **회사 기본 러너 설정 부재**(하드코딩 순서) · `src/runners.mjs:734-746` · MED STILL_OPEN
- [ ] K2 **엔진 미지정 '자동' 라벨 부재 + UI가 'Claude Code'로 오표시** · `app/c/[ws]/crew/[slug]/page.jsx:208·806` · MED STILL_OPEN (실행은 첫 연결 러너인데 표시는 Claude, 고지 0)
- [ ] K6 **host 마커 과금 주체 안내 부재** · i18n 전반 · MED STILL_OPEN
- [ ] K8 **크루 러너/모델 저장 실패 무감지**(낙관 반영, res.ok 미확인) · `crew/[slug]/page.jsx:191-200` · MED STILL_OPEN
- [ ] K9 **설정 연결 폴링 2분 타임아웃 무안내** · `app/runner-connect.jsx:181-196` · MED STILL_OPEN
- [ ] K7 **keys 라우트 오류 한국어 하드코딩**(Claude OAuth 형식 오류만 i18n됨) · 두 keys 라우트 십수 개 throw · MED PARTIAL
- [ ] **host 해제 후 method='host' 잔존 — 키 붙여넣기 저장이 무음 no-op** · `app/runner-connect.jsx:224` · MED CONFIRMED
- [ ] **크루 수정 모달이 '터미널 로그인' 거짓 처방**(명시 연결 정본과 모순, 화면 간 라벨 불일치) · `app/c/[ws]/page.jsx:573·637` · MED CONFIRMED
- [ ] **회사 자격 성공 메시지가 '(이 컴퓨터 로그인)' 스코프 거짓 표기** · `app/i18n.jsx:274` · LOW CONFIRMED
- [ ] **host 무효를 '토큰 형식 오류'로 오진 표시** · `app/runner-connect.jsx:288` · LOW CONFIRMED
- [ ] **채팅바 엔진 라벨 카탈로그 실패 시 'Claude Code' 폴백** · `crew/[slug]/page.jsx:806` · LOW CONFIRMED

## P3 — LOW·플랫폼

- [ ] K3 다중 러너 치유 체인(깊이 1 고정) · `src/chat.mjs:638·849` · LOW
- [ ] K4 연결 해제 후 격리 홈 OAuth 토큰 파일 잔존(0600이나 유효 refresh 토큰) · `src/runners.mjs:373-378` · MED
- [ ] K5 OAuth 마스킹 JSON 조각(`{"OPEN***`) · `src/runners.mjs:396` · LOW
- [ ] K10 구독형 러너 예산 미집계 + compete.mjs:81 한국어+$ 잔존 · PARTIAL
- [ ] K11 remote-market explainItem Claude 직호출 + env 미세척(P1-6) · `src/remote-market.mjs:252-283` · MED (동시 세션 인접 — 조율 후)
- [ ] Windows 원클릭(PTY: script(1) 부재)·서명 · 플랫폼 작업
- [ ] 데스크톱 원클릭 실기기 완주 확인 · 유건 몫 (v0.1.14 dmg)

## 해결 확인

- [x] K12 러너 폴백 미고지 — fallbackDirective(성공)+fallbackErrorPrefix(실패)+fellBackFrom 이벤트로 커버(성공 경로는 프롬프트 이행 의존 한계만 잔존)
- [x] 자격 실검증 게이트(gemini 400·GLM 200바디) + AUTH_ERR_RE — PR #49 (병합 대기)
- [~] MCP 마켓 정직성 — 동시 세션 `fix/mcp-oneclick-honest` 진행 중
