# 안정화 프로그램 후속 백로그 — 2026-07-28 (G001~G007 검수 이월분)

> 각 PR의 분리 검수가 "비차단"으로 판정한 항목의 집결. 근본 수정이 아니라 잊지 않기 위한 장부다.

## 러너 계열 (#147 분리·#151 타임아웃 검수)
- [ ] **6시간 잡의 maxBuffer 32MB** — 장시간 codex 잡의 실효 상한이 stdout 32MB가 되고 그때 문구는
      ERR_CHILD_PROCESS_STDIO_MAXBUFFER 위장 잔존 (#151 M5). 잡 kind면 maxBuffer 상향 또는 스트림 소비 검토
- [ ] **앱 종료 시 CLI 자식 정리 훅 부재** — 고아 창이 5분→6시간으로 확대(#151 M5). SIGTERM 핸들러에서
      진행 중 externalExec 자식 kill + 임시 CODEX_HOME 정리(recoverCodexAuth 회수 포함)
- [ ] **위임 하위 턴이 source 미상속** — 잡 안에서 delegate된 하위 턴은 여전히 5분 상한(#151 L1)
- [ ] **oneshot 실패 문구 이중 처방** — oneshot 래퍼 + cliTurnFailure 안내가 모순 조합 가능(#151 L3)
- [ ] **ARGO_CLI_TURN_TIMEOUT_MS 전역 영향** — 300s↑면 chat 라우트 maxDuration=300과 충돌, 900s↑면
      crewmail CLAIM_STALE_MS 산출 근거 붕괴(#151 L2). 노브 문서화 + 클램프 검토
- [ ] **antigravity 잡 경로 --print-timeout 21570s 수용 여부 미검증** (#151 M5 부속)
- [ ] 트립와이어 3종 모듈 인지형 완화(완전 thin facade), GLM/Kimi BASE_URL 기본값 중복 2쌍,
      webauth jsonBody 죽은 분기, pickRunner credButNoCli 잔재, detectRunners 캐시 변수명 (#147 INFO)

## 게이트웨이 (#150 검수)
- [ ] **큐 워커 틱(1s) 주입 불가** — 큐 테스트 2건이 벽시계 결합, CI 플레이크 시 interval 주입이 수정점(L6)
- [ ] 슬랙 핸들러 nullish 가드(L2 — 현 동작이 더 안전해 의도적 미반영, 기록만)

## 경로·내보내기 (#137·#142 검수)
- [ ] **0600이 win32에서 전면 무효(5곳)** — ARGO_ROOT가 임의 경로면 BUILTIN\Users 읽기 열림. 스킵 문구에
      이슈 포인터 추가 (#127 검수 이월과 동일 건)
- [ ] 홈 아래 설치(dev·Win LOCALAPPDATA)에서 홈 등록 거부 문구가 원인 특정 안 됨 (#137 2R 관찰)
- [ ] workroots/export 카드 오류 문구가 언어 전환 시 이전 언어 잔존 (#137 2R 관찰)
- [ ] 내보내기 파일 선택 다이얼로그 부재(절대경로 타이핑 + 폴더 사전 존재 요구) — A갈래 신고자 실성공률
      가를 지점 (#142 관찰). tauri-plugin-dialog 도입 검토
- [ ] export 고지 오해 여지 — "자격 제외"를 "사본에 비밀 없음"으로 읽을 수 있음(대화·vault는 평문) (#142 2R)

## 릴리스·CI (Phase0·#152 검수)
- [ ] **hooks.nsh가 .gitattributes로 LF 체크아웃** — 다음 Windows 릴리스 드릴에서 설치 전 훅(고아 node 종료)
      실동작 확인 (Phase0 LOW, 미검증)
- [ ] macos-15-intel 레그의 npm test는 다음 태그가 첫 실행 (Phase0 LOW)
- [ ] latest.json 전부-또는-없음 분기·MANIFEST-INCOMPLETE.txt는 다음 릴리스 드릴이 첫 라이브 실행 (#152)
- [ ] **매니페스트 안전장치는 태그 경로만 커버** — 실제 최근 4회 발행(v0.1.24~27)은 전부 workflow_dispatch
      경로(release 잡 스킵, latest.json 수제)였다(#152 2R 명시 요구). gen-updater-manifest.mjs 공용 추출로
      워크플로·드릴이 같은 코드를 쓰게 하는 것이 근본 해소(#152 권고 4)
- [x] argo-release 드릴 스킬 §1을 bump 스크립트 표준 경로로 갱신 (#152 권고 5 — 2026-07-28 완료)

## 데이터 보관 위치 (G002 A갈래 잔여 — 후순위 트랙)
- [ ] ARGO_ROOT 위치 변경 UI — Rust lib.rs 포인터(app_local_data_dir/data-root.json) + ARGO_APP_DATA env
      + relaunch. launchd/서비스 모드 별도. (2026-07-28 유건 판단: Export 선행 완료, 이건 대기)
