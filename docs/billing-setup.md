# 결제(레몬스퀴지) 설정 — 운영 가이드

> 결제의 UX 원칙(2026-07-28 확정): **결제는 클라우드(동기화·멀티디바이스)만 잠근다.** 로컬 사용은
> 플랜과 무관하게 항상 가능. 연체는 유예(차단 아님), 강등 시 클라우드 데이터는 **동결**(삭제 아님).
> 집행 권위는 서버 RLS(is_pro), 상태 환산은 웹훅(app/api/billing/webhook)이 유일한 쓰기 지점.

## 레몬스퀴지 쪽 설정 (1회)

1. 스토어 생성 → **Pro 구독 상품** 생성: 월간 $16 variant + 연간 $160 variant (가격 확정 2026-07-24).
2. Settings → Webhooks → 엔드포인트 추가: `https://<서비스 도메인>/api/billing/webhook`,
   이벤트는 `subscription_*` 전부 체크. **signing secret**을 받아 env로.
3. Settings → API → API 키 발급(포털 클릭 시점 발급용).
4. 두 variant의 **Buy Link**(호스티드 체크아웃 URL)를 복사.

## 서버 env 4종 + 체크아웃 2종 (값은 배포 환경에만 — 문서·채팅에 평문 금지)

| env | 용도 | 주의 |
|---|---|---|
| `LEMONSQUEEZY_WEBHOOK_SECRET` | 웹훅 서명 검증(미설정=401 fail-closed) | 없으면 결제해도 plan이 절대 안 바뀐다 — **[유실 위험] 로그** 확인 |
| `LEMONSQUEEZY_API_KEY` | "구독 관리" 클릭 시점 포털 발급 | 없으면 포털 버튼이 안내 텍스트로 실패(자격 판정과 무관) |
| `LEMONSQUEEZY_PRO_VARIANT_IDS` | Pro로 인정할 variant 허용목록(콤마 구분) | ⚠ **월간·연간 둘 다** 넣을 것 — 하나만 넣으면 다른 쪽 유료 고객이 `other-product`로 조용히 탈락한다(검수 실측 경고). 미설정=게이트 없음(단일 상품일 때만 허용) |
| `LEMONSQUEEZY_ALLOW_TEST` | `1`이면 test_mode 결제 수용 | 스테이징 전용 — 프로덕션에서 켜면 가짜 카드로 Pro가 붙는다 |
| `NEXT_PUBLIC_LS_CHECKOUT_MONTHLY` / `_YEARLY` | 설정 카드 업그레이드 버튼의 Buy Link | 미설정이면 버튼 대신 "결제 준비 중" 표기(정직 폴백) |

## 배포 후 검증 (발행 전 반드시)

1. **테스트 모드 결제 1회**(스테이징 + `LEMONSQUEEZY_ALLOW_TEST=1`): 체크아웃 → 웹훅 로그에
   `plan: pro` → 설정 카드에 Pro 배지. 이때 체크아웃 URL에 `checkout[custom][user_id]`가
   실려 있는지 확인(없으면 `[유실 위험] 귀속 실패` 로그가 뜬다 — 정상 감지).
2. **"구독 관리" 클릭 1회**: LS 포털이 새 탭으로 열리는지(클릭 시점 발급 — 저장 URL은 24h 만료라
   쓰지 않는다), 실패 시 빈 탭에 이중언어 안내가 보이는지.
3. 해지 → `cancelled`(유예 pro 유지) → LS 대시보드에서 기간 종료 시뮬 → `expired`(free 강등,
   설정 카드에 "클라우드가 잠자는 중" 문구).

## 운영 중 봐야 할 로그

- `[argo] billing webhook [유실 위험] ...` — env 미설정·DB 실패·귀속 실패(**LS 재시도는 3회·약
  155초가 전부**라 이 로그가 뜨면 수동 조치 대상. LS 대시보드 → Webhooks에서 resend 가능).
- `[argo] billing 대사: ...` — 웹훅을 놓친 결제를 /api/me/billing 접근 시 LS API 대조로
  복구한 흔적(O2). `LEMONSQUEEZY_API_KEY` 필요, 사용자당 10분 쿨다운(프로세스 로컬).
  `[수동 확인 필요]`·`duplicate-attribution`이 찍히면 자동 복구가 막힌 것 — 수동 조치 대상.
  **커버 범위 주의**: 이 대사는 클라우드 웹(쿠키 세션 또는 서비스 롤 있는 배포)의
  /api/me/billing에서만 돈다. 서비스 롤 키가 없는 데스크톱 로컬 서버에서는 실행되지 않으므로,
  데스크톱 전용 사용자는 웹 설정 화면을 한 번 열어야 복구된다 — "모든 유실의 자동 복구"가 아니다.
- 귀속 실패 이벤트는 `billing_unmatched` 테이블(서비스 롤 전용)에 적재된다(M4) — 구독 id·
  customer id·결제 이메일·사유로 수동 귀속: Supabase 콘솔에서 조회 후 해당 user_id로
  `apply_ls_event`를 직접 호출하거나 LS 웹훅 resend. 처리 후 `resolved_at`을 찍어 큐에서 뺀다.

## 배포 순서 (M1 마이그레이션 — 어기면 그 창의 결제가 유실된다)

웹훅 코드는 DB 함수 `apply_ls_event`를 호출한다. **코드가 마이그레이션보다 먼저 뜨면** RPC 404
→ 웹훅 5xx → LS 재시도 3회·155초 소진 → 유실(대사가 최후 방어지만 커버 범위 한계는 위 참조).

1. 마이그레이션(`20260728113000_billing_hardening.sql`) 적용
2. PostgREST 스키마 캐시 갱신 확인 — `notify pgrst, 'reload schema';` 또는 콘솔에서 확인
3. 스모크: SQL 편집기에서 `select public.apply_ls_event('<테스트 uuid>','free','','','', null, null, null);`
   가 문자열을 돌려주는지 확인 (테스트 행은 삭제)
4. 그 다음에 코드 배포. 배포 후 LS 대시보드 → Webhooks에서 실패 이벤트 resend 체크.

이월분(칩 task_ee4d4270) 반영 현황: 동시 이벤트 원자 가드(M1 — DB 함수 `apply_ls_event`
단일 문장 upsert, 순서 가드는 같은 구독 한정), 유실 대사(O2 — /api/me/billing 폴백 +
중복 귀속 가드), 미귀속 적재(M4), ends_at UI 표기 모두 반영 완료(2026-07-28).
