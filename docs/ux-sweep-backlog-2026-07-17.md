# Argo UX 스윕 백로그 — 2026-07-17 (87건 확정)

> 16개 표면 병렬 리뷰→적대검증 통과 87건(high 3·medium 34·low 50). `[x]`=이번 폴스 배치에서 수정, `[ ]`=후속 백로그.


## HIGH (3)

- [x] **결재·권한** · `src/approval-actions.mjs` — kind:'tool' 결재는 대기 턴이 죽으면 고아가 되어, 나중에 승인해도 아무것도 실행되지 않는다 (약속 위반)
- [x] **크루 관리** · `app/c/[ws]/crew/[slug]/page.jsx` — 카드 패널에서 엔진(러너/모델) 바꾼 뒤 카드 저장·규칙 추가하면 엔진 선택이 조용히 원복됨
- [x] **루틴·스케줄러** · `src/routines.mjs` — 예약 분을 놓치면 catch-up 없이 그날은 조용히 스킵

## MEDIUM (34)

- [x] **채팅 턴 흐름** · `src/turn-status.mjs` — 영어 모드에서도 진행 단계 라벨이 한국어로 노출
- [x] **채팅 턴 흐름** · `src/chat.mjs` — Codex·Gemini 러너 턴은 중단 불가 + 정지 버튼이 조용히 무동작
- [x] **채팅 턴 흐름** · `app/c/[ws]/crew/[slug]/page.jsx` — 메시지 재전송 시 첨부(이미지·파일)가 누락됨
- [x] **채팅 턴 흐름** · `src/chat.mjs` — 기기 전환/새 세션 재개 시 이전에 공유한 이미지·파일을 크루가 못 봄
- [ ] **채팅 턴 흐름** · `src/turn-status.mjs` — 루틴·메신저·타기기발 턴의 진행 표시가 2분 후 사라짐
- [ ] **멀티기기 동기화** · `src/sync.mjs` — 특정 파일의 반복 실패가 UI에 안 보임 — '가동 중'인데 조용히 미동기
- [ ] **메신저 게이트웨이** · `src/gateway.mjs` — 슬랙은 오프셋 영속·디스크 큐가 없어 재시작/크래시 시 지시·결재가 조용히 유실
- [ ] **메신저 게이트웨이** · `src/gateway.mjs` — 슬랙 채널의 모든 멤버가 크루 구동·결재 승인 가능(텔레그램은 사장만)
- [ ] **메신저 게이트웨이** · `src/gateway.mjs` — 기기 전환 시 옛 리더에 큐잉된 텔레그램 지시가 새 리더로 넘어오지 못하고 멈춤
- [ ] **결재·권한** · `src/permission-gate.mjs` — 게이트/능력 결재 카드가 한국어 하드코딩 — 영어 회사 사장에게 한글 카드가 그대로 노출
- [ ] **결재·권한** · `src/permission-gate.mjs` — kind:'tool' 결재는 중복 방지가 없어 재시도마다 동일 카드가 쌓이고, 고아 카드가 결재함/아침보고 카운트를 부풀린다
- [ ] **마켓·MCP·스킬** · `src/remote-market.mjs` — 키 필요(needsKey) MCP는 설치돼도 키를 넣을 데가 없어 항상 동작 불가 — '연결됨'은 거짓 상태
- [ ] **마켓·MCP·스킬** · `src/remote-market.mjs` — 설치한 스킬이 6000자 캡의 break에 걸려 조용히 주입 안 됨 — '설치됨'인데 반영 0
- [ ] **마켓·MCP·스킬** · `src/market.mjs` — 설치·검색 실패 오류 메시지가 영어 회사에도 한국어로 그대로 노출
- [ ] **마켓·MCP·스킬** · `src/remote-market.mjs` — 공식 MCP 3종이 내장 카탈로그와 추천 TOP에 다른 이름으로 중복 — 이미 설치했는데 또 '설치' 뜨고 중복 설치됨
- [x] **크루 관리** · `src/persona.mjs` — 이름 변경 시 정규식 미이스케이프 — 특수문자 이름은 본문 제목 미갱신 또는 rename 실패
- [x] **기억/vault** · `app/api/companies/[ws]/vault/route.js` — ‘노트 작성’이 같은 슬러그의 기존 주제 노트를 경고 없이 통째로 덮어씀 (기억 유실)
- [ ] **기억/vault** · `src/memory.mjs` — 노트 삭제 후 이웃 노트의 [[관련]] 역링크가 깨진 채 남음
- [ ] **기억/vault** · `app/c/[ws]/vault/page.jsx` — 노트 편집·삭제 실패가 데스크톱 앱에서 조용히 삼켜짐 (native alert)
- [ ] **기억/vault** · `src/memory.mjs` — 주간 롤업 파일이 연중 내내 인덱스의 ‘최근 일지(14일)’에 남음
- [ ] **루틴·스케줄러** · `src/routines.mjs` — 수동 '지금 실행'이 예약 실행/동시 실행과 무조율 — 같은 루틴 이중 과금·기억 동시쓰기
- [x] **루틴·스케줄러** · `app/api/companies/[ws]/routines/route.js` — routines.json 손상 시 UI에서 모든 루틴이 '없음'으로 사라짐(디스크엔 존재)
- [ ] **루틴·스케줄러** · `app/c/[ws]/routines/page.jsx` — '지금 실행' 중에는 최대 5분간 모달에 갇혀 닫기/취소 불가
- [x] **회의실·경쟁 시안** · `app/c/[ws]/compete/page.jsx` — 완성됐지만 미채택인 경쟁의 하단 바가 '시안 작성 중...'으로 오표시
- [x] **러너 연결·모델** · `src/runners.mjs` — 폴백으로 다른 엔진·모델로 실행됐는데 사용자에게 아무 표시가 없음
- [ ] **러너 연결·모델** · `app/api/companies/[ws]/keys/route.js` — 러너 연결 실패/형식 오류 메시지가 한국어 고정 — 영어 모드에서 그대로 노출
- [x] **온보딩·회사 생성** · `app/api/companies/[ws]/route.js` — 회사 '보관'을 앱에서 되돌릴 방법이 없다 — '복구 가능' 문구와 어긋남
- [x] **설정 화면 전체** · `app/c/[ws]/settings/page.jsx` — AI 러너 연결 '제거'가 확인 없이 즉시 실행 — 전 기기·전 크루 영향
- [x] **다국어·테마·공용 UI** · `app/i18n.jsx` — 언어 부팅 스크립트 부재 — 영어 사용자는 매 로드마다 한국어 화면이 번쩍인 뒤 영어로 전환
- [ ] **활동·데크·그래프** · `/Users/yoogeon/lean-projects/_worktrees/argo-resident/app/c/[ws]/page.jsx` — "최근 기억"·항해일지·"마지막 기록"이 시간순이 아니라 파일명순 — 방금 한 대화가 안 뜸
- [x] **활동·데크·그래프** · `/Users/yoogeon/lean-projects/_worktrees/argo-resident/app/c/[ws]/activity/page.jsx` — 활동 '오늘' 집계·상단 날짜가 UTC 기준 — KST 오전엔 오늘 한 일이 0, 날짜가 어제로
- [x] **활동·데크·그래프** · `/Users/yoogeon/lean-projects/_worktrees/argo-resident/app/c/[ws]/page.jsx` — 아침 브리핑이 최근이 아니라 16시간 창의 '가장 오래된' 턴 3개를 보여줌
- [ ] **사용량·비용·예산** · `app/api/companies/[ws]/tasks/route.js` — 2분 넘게 도구를 안 쓴 장시간 턴이 '지금 도는 턴' 패널에서 사라짐
- [x] **데스크톱 앱 통합** · `public/boot.js` — 치명적 부팅 실패에도 진행바가 계속 기어가며 'Still working'을 띄워 모순 신호

## LOW (50)

- [ ] **채팅 턴 흐름** · `app/c/[ws]/crew/[slug]/page.jsx` — 긴 부분 답변을 중단하면 이미 생성된 내용이 통째로 소실
- [ ] **채팅 턴 흐름** · `src/chat.mjs` — 성공했지만 빈 답변이면 빈 크루 말풍선이 저장됨
- [ ] **멀티기기 동기화** · `src/sync.mjs` — 동기화 오류 메시지가 영어 모드에서도 한국어로 그대로 노출
- [ ] **멀티기기 동기화** · `src/sync.mjs` — 리더 기기가 꺼지면 최대 2분간 예약 루틴·텔레그램 봇이 어느 기기에서도 안 돈다
- [ ] **멀티기기 동기화** · `src/sync.mjs` — 대량 삭제 브레이크가 걸리면 회사 동기화 전체가 멈추고 복구 방법이 없다
- [ ] **멀티기기 동기화** · `src/sync.mjs` — 노트 동시 편집 시 정체불명의 .conflict 사본이 예고 없이 생김
- [ ] **메신저 게이트웨이** · `src/gateway.mjs` — 크루 직통 봇: '그룹에서 함께 일한다'고 안내하지만 실제로는 사장 외 멘션을 조용히 무시
- [ ] **메신저 게이트웨이** · `src/gateway.mjs` — 그룹의 결재 인라인 버튼은 전원에게 보이지만 사장 외 탭은 응답 없이 로딩만 돈다
- [ ] **메신저 게이트웨이** · `src/gateway.mjs` — 메신저 표면 다국어 누락 — 결재 토큰·잘림 문구·에러 토스트가 영어 모드에서도 한국어
- [ ] **마켓·MCP·스킬** · `src/remote-market.mjs` — needsKey 경고가 추천 TOP에만 있고 원격 검색 결과엔 없음 — 검색으로 설치하면 키 경고 0
- [ ] **마켓·MCP·스킬** · `app/c/[ws]/market/page.jsx` — UI safeId는 48자 절단을 안 해 이름 긴 스킬/MCP은 설치 후에도 '설치됨'이 안 뜸
- [ ] **크루 관리** · `app/c/[ws]/crew/[slug]/page.jsx` — 해고 DELETE가 실패해도 성공처럼 처리 — '해고됨'으로 나가지만 크루는 그대로 남음
- [ ] **크루 관리** · `src/chat.mjs` — 러너 폴백을 사용자에게 고지하지 않음 — UI는 미연결 엔진을 계속 표시
- [ ] **크루 관리** · `src/persona.mjs` — 서버측 오류 메시지가 한국어로 고정 — 영어 모드 사용자에게 한국어 노출
- [ ] **크루 관리** · `app/c/[ws]/crew/[slug]/page.jsx` — 러너/모델 저장 실패를 감지·복구하지 못함 — UI만 바뀌고 서버는 옛 값
- [ ] **기억/vault** · `src/memory.mjs` — 재정리된 노트에서 관련 링크가 ‘## 근거’(출처) 아래로 잘못 붙음
- [ ] **기억/vault** · `app/c/[ws]/vault/page.jsx` — vault API 오류 문구가 영어 모드에서도 하드코딩 한국어로 노출
- [ ] **루틴·스케줄러** · `src/routines.mjs` — 수동 실행이 사용자가 보고 있는 결과에 대해 메신저 푸시까지 중복 발송
- [ ] **루틴·스케줄러** · `src/routines.mjs` — 서버측 검증/조회 에러가 한국어 하드코딩 — 영어 모드 사용자에게 그대로 노출
- [ ] **루틴·스케줄러** · `app/c/[ws]/routines/page.jsx` — toggle/삭제가 raw fetch에 에러 처리 없음 — 실패 시 조용히 원상복귀
- [ ] **회의실·경쟁 시안** · `app/c/[ws]/room/page.jsx` — 회의 마치기: 확인 모달 없이 즉시 실행 — 되돌릴 수 없는데 한 번 클릭에 전 기기 방이 비워짐
- [ ] **회의실·경쟁 시안** · `src/room.mjs` — 공백 있는 크루 이름은 회의실에서 멘션 불가 — 엉뚱한(첫 번째) 크루가 대신 답함
- [ ] **회의실·경쟁 시안** · `src/chat.mjs` — 예산 초과 등 서버 에러 문자열이 한국어+USD 하드코딩 — 영어 모드에 한국어로 새어나감
- [ ] **회의실·경쟁 시안** · `src/compete.mjs` — 서버 재시작/크래시 시 진행 중 경쟁이 'running'으로 영구 잔존 — 폴링 무한, 채택·재시도 불가
- [ ] **회의실·경쟁 시안** · `src/compete.mjs` — 전원 실패한 경쟁은 막다른 길 — 재시도·채택 버튼이 전혀 없음
- [ ] **러너 연결·모델** · `src/runners.mjs` — 러너 연결 해제 후에도 OAuth 토큰 파일이 디스크에 그대로 남음
- [ ] **러너 연결·모델** · `src/runners.mjs` — OAuth로 연결한 Codex/Gemini의 마스킹 표시가 JSON 조각(예: {"OPEN***)로 나옴
- [ ] **온보딩·회사 생성** · `app/page.jsx` — 이미 회사가 있는 사용자는 페어링이 즉시 '수신 완료'로 오표시된다
- [ ] **온보딩·회사 생성** · `app/api/companies/route.js` — 온보딩 API 오류 메시지가 한국어 고정 — 영어 모드 사용자에게 한국어로 노출
- [ ] **설정 화면 전체** · `app/c/[ws]/settings/page.jsx` — 언어 전환 시 저장 안 한 회사명·예산 입력이 조용히 사라짐
- [ ] **설정 화면 전체** · `app/c/[ws]/settings/page.jsx` — 회사 보관이 실패해도 성공한 듯 홈으로 이동 / 네트워크 오류 시 무피드백
- [ ] **설정 화면 전체** · `app/c/[ws]/settings/page.jsx` — 크루 응답 언어 전환이 실패해도 바뀐 것처럼 표시되는 무음 실패
- [ ] **설정 화면 전체** · `app/c/[ws]/settings/page.jsx` — 결재 게이트 우회(bypass) 토글이 확인 절차 없이 한 번에 켜짐
- [ ] **설정 화면 전체** · `app/c/[ws]/settings/page.jsx` — 러너 연결 폴링 2분 타임아웃 후 안내 없이 멈춤
- [ ] **설정 화면 전체** · `app/c/[ws]/settings/page.jsx` — 보관함 복구·영구삭제 실패 시 무반응(무음 실패)
- [ ] **다국어·테마·공용 UI** · `app/layout.jsx` — 영어 모드에서도 <html lang>이 'ko'로 고정 — 스크린리더·브라우저 번역·맞춤법 오동작
- [ ] **다국어·테마·공용 UI** · `app/globals.css` — 모바일 폭에서 사이드바가 접히지 않고 네비+크루 명단 전체가 콘텐츠 위에 쌓임
- [ ] **다국어·테마·공용 UI** · `app/c/[ws]/settings/page.jsx` — 설정 화면에서 언어 전환 시 저장 안 한 회사명·예산 입력이 조용히 초기화
- [ ] **다국어·테마·공용 UI** · `app/layout.jsx` — 테마 부팅 스크립트가 저장값을 THEMES로 검증하지 않아 삭제/변경된 테마명이 DOM에 잔류
- [ ] **활동·데크·그래프** · `/Users/yoogeon/lean-projects/_worktrees/argo-resident/app/c/[ws]/layout.jsx` — 회사 데이터 일시적 로드 실패가 '회사를 찾을 수 없습니다'로 고착 — 삭제된 것처럼 보임
- [ ] **활동·데크·그래프** · `/Users/yoogeon/lean-projects/_worktrees/argo-resident/app/c/[ws]/activity/page.jsx` — 활동 행 펼침·재실행 안내가 20초 자동 새로고침/필터 전환 후 다른 이벤트에 붙음
- [ ] **활동·데크·그래프** · `/Users/yoogeon/lean-projects/_worktrees/argo-resident/app/c/[ws]/page.jsx` — 데크 '일별 기억 적립' 차트·'오늘 +N' 칩이 노트를 전혀 세지 않고 UTC 날짜로 셈
- [ ] **사용량·비용·예산** · `app/api/companies/[ws]/trash/route.js` — 해고한 크루의 보관함 대화를 복구하면 아무 데도 나타나지 않음(사실상 유실)
- [ ] **사용량·비용·예산** · `src/usage.mjs` — 월 예산 상한이 codex/gemini 등 구독형 러너 사용을 전혀 세지 않음
- [ ] **사용량·비용·예산** · `src/usage.mjs` — 오늘/이번 달 집계·예산 리셋이 로컬이 아닌 UTC 기준
- [ ] **사용량·비용·예산** · `src/chat.mjs` — 예산 초과 에러가 한국어 하드코딩 + 원화 UX인데 $ 표기
- [ ] **사용량·비용·예산** · `src/usage.mjs` — 턴당 비용이 비과금 턴까지 분모에 넣어 과소 표기
- [ ] **데스크톱 앱 통합** · `src-tauri/src/lib.rs` — 3001 포트에 뜬 서버가 Argo인지 검증하지 않음 — 외부/좀비 서버에 웹뷰가 붙는다
- [ ] **데스크톱 앱 통합** · `src-tauri/src/lib.rs` — 크루 턴 실행 중 앱을 끄면 에이전트 하위 프로세스가 고아로 남아 API 크레딧을 계속 소모
- [ ] **데스크톱 앱 통합** · `public/boot.js` — 부트 화면이 영어 전용 — 저장된 언어/시스템 로캘을 무시 (i18n 절대 규칙 위반)