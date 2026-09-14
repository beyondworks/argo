# App Store 심사 제출 준비 — Argo Messenger (iOS)

정식 출시 전수 검사(2026-09-14) 뒤 정리한 제출 체크리스트. 코드 쪽 차단 항목은 PR #528(Sign in with Apple, 병합됨)·#529(앱 내 계정 삭제)·#530(Apple 후속)·#531(채널 기록 스크롤백)로 다룬다. **#529~#531이 `main`에 병합되기 전에는 3절이 성립하지 않으므로 제출하지 않는다** — 제출 직전 `gh pr view 529 530 531 --json state`로 MERGED를 확인한다.

## 1. 계정·심사 노트

- 로그인은 Apple·Google·GitHub 브라우저 왕복뿐이라 **데모 계정 비밀번호가 없다.** 심사 노트에는 다음처럼 쓴다.
  > Sign in with Apple(or Google/GitHub) with your own account. After signing in, tap "초대 코드로 가입 / Join with invite code" on the empty-organization screen and enter the code below to enter the demo organization. Demo org: `<조직명>`, invite code: `<코드>`. The demo organization has two agents that reply within a minute; messages you post are visible to the reviewer team only.
- 데모 조직은 소유 계정에서 미리 만든다: 조직 생성 → 채널 `general` → 크루 2명 연결(브리지가 살아 있는 Mac/VPS) → 설정 › 멤버 › 초대 코드(멤버, 만료 30일). 초대 코드는 제출 직전에 새로 발급한다(만료·좌석 확인).
- 심사 기간 동안 브리지(Argo 본체)가 켜져 있어야 크루가 답한다. 꺼져 있으면 "실행 기기 오프라인" 상태로 보이므로 노트에 "agents reply only while our bridge is online; if you see no reply within 2 minutes, please retry" 한 줄을 넣는다.

## 2. App Store Connect 입력값

| 항목 | 값 |
|---|---|
| 개인정보처리방침 URL | https://argo.ceo/privacy |
| 이용약관 URL(선택) | https://argo.ceo/terms |
| 지원 URL | https://argo.ceo |
| 카테고리 | 비즈니스(보조: 생산성) |
| 연령 등급 | 4+ 예상(확정 아님 — 사용자 생성 콘텐츠가 있는 앱은 Apple이 신고·차단 수단을 따로 물을 수 있다. 메시지는 조직 내부, "무제한 웹 액세스 없음") |
| 수출 규정 | 암호화 면제(`ITSAppUsesNonExemptEncryption=false`, Info.plist) |
| 기기 | iPhone 전용(`TARGETED_DEVICE_FAMILY=1`) — 아이패드 레이아웃은 후속 |

개인정보 라벨(수집 항목): 이메일·이름(계정), 메시지 본문과 첨부(사용자 콘텐츠, 서버 저장·평문), 푸시 토큰(기기 ID), 진단 정보 없음(로컬만). 추적 없음(ATT 해당 없음).

## 3. 앱 안 필수 요소(PR #529~#531 병합 뒤 유효)

- 설정 › 내 계정 › **계정 삭제**(이메일 + 확인 문구 입력, 서버 함수 `msgr_delete_me`, PR #529). 5.1.1(v).
- 로그인 화면·설정에 개인정보처리방침·이용약관 링크. 5.1.1(i).
- Sign in with Apple 버튼이 다른 제3자 로그인과 같은 비중(맨 위, 같은 크기). 4.8.

## 4. 빌드·업로드

1. `apps/messenger/scripts/ios-store.mjs build <빌드번호>` → `upload` (ipa 게이트: 스킴·버전·암호화 면제·iPhone 전용 `UIDeviceFamily=[1]` 검사).
2. 업로드된 ipa의 `aps-environment`가 production인지 확인(커밋된 entitlements는 development).
3. TestFlight에서 로그아웃 상태부터 로그인 왕복(Apple 포함)·데모 조직 가입·메시지·크루 답변·계정 삭제까지 한 번 돌린다.

## 5. 서버 선행(제출 전)

- Supabase Auth › Apple 제공자 활성(Services ID·시크릿 — `scripts/apple-client-secret.mjs`). 6개월마다 시크릿 갱신.
- 마이그레이션 적용: `20260914200000_msgr_delete_me`, `20260914203000_msgr_public_domains_relay`, `20260914210000_msgr_push_secret`.
- 엣지 `msgr-push` 재배포 + 시크릿 `PUSH_FN_SECRET` 등록 + `msgr_settings.push_secret` 동일 값. 이 순서(엣지 먼저)면 중간 상태는 푸시만 잠깐 끊긴다.
  알려진 한계(검수 #532 M-1): pg_net 큐 `net.http_request_queue`는 확장 기본값으로 PUBLIC 권한이 열려 있어 워커가 소비하기 전 짧은 창 동안 헤더(시크릿)가 행에 남는다. `postgres` 역할은 소유자가 아니라 권한을 회수할 수 없고(로컬 스택 실측 `no privileges could be revoked`), PostgREST는 `net` 스키마를 노출하지 않으므로 DB 직접 접속 자격이 새지 않는 한 닿지 않는다.
- Supabase 콘솔에서 백업/PITR 활성 여부 확인·기록.
