# LS(Lemon Squeezy) 결제 연결 — 출시 스텝 (5분)

> M-4에서 결제 기계는 전부 구현·배포됐다. 이 문서는 **실물 LS 계정을 끼우는** 마지막 단계다.
> 기계 자체는 테스트 secret으로 이미 E2E 검증됨(웹훅 서명·plan 전환·페이월 UI).

## 현재 배포 상태

- **웹훅 Edge Function**: `https://nvqorpdorlbkhpcvwoty.supabase.co/functions/v1/ls-webhook` (배포됨, `--no-verify-jwt`)
- **강제 스위치**: `ARGO_ENFORCE_PLAN` — **현재 off**(데모 기간엔 전원 통과). 켜는 날 = 유료 전환 시작일
- entitlements 쓰기는 이 함수가 유일 경로(서비스 롤). 사용자는 자기 plan 조작 불가(RLS)

## 유건이 할 일 (LS 대시보드)

1. **Store 생성** (없으면) — 통화 USD
2. **상품 "Argo Pro"** + variant 2개:
   - 월간: **$12/month** (subscription)
   - 연간: **$120/year** (subscription) — "2개월 무료" 문구
3. **각 variant의 체크아웃 링크(Share/Buy link) 복사** → 2개 URL
4. **웹훅 등록** (Settings → Webhooks):
   - URL: `https://nvqorpdorlbkhpcvwoty.supabase.co/functions/v1/ls-webhook`
   - 이벤트: `subscription_created`, `subscription_updated`, `subscription_cancelled`, `subscription_resumed`, `subscription_expired`, `subscription_paused`, `subscription_unpaused`, `subscription_plan_changed` (payment_* 는 불필요 — 무시됨)
   - **Signing secret 발급** → 복사

## Claude가 마무리할 값 주입 (secret은 채팅 평문 금지)

체크아웃 URL 2개는 알려주셔도 됩니다(비밀 아님). Signing secret은 **아래 명령을 직접 실행**하거나 Claude에게 "secret 주입해줘"라고 하면 안내합니다:

```bash
# 1) 웹훅 secret 교체 (테스트 secret → LS 실물) — 값은 셸에 직접, 히스토리 주의
supabase secrets set LS_WEBHOOK_SECRET="<LS Signing secret>" --project-ref nvqorpdorlbkhpcvwoty

# 2) 체크아웃 URL 2개 = 배포 env (Vercel/워커 프로덕션 env 또는 .env.local)
#    NEXT_PUBLIC_LS_CHECKOUT_MONTHLY=<월간 링크>
#    NEXT_PUBLIC_LS_CHECKOUT_YEARLY=<연간 링크>
```

체크아웃 링크는 클라이언트가 `?checkout[custom][user_id]=<uid>&checkout[email]=<email>`을 자동으로 붙여 보낸다 — LS가 그 user_id를 웹훅 custom_data로 되돌려주고, 함수가 그걸로 entitlements를 쓴다.

## 유료 전환 날 (별도 결정)

`ARGO_ENFORCE_PLAN=1`을 프로덕션 env에 추가하고 재배포하면 Free 계정의 멀티기기 동기화가 페이월로 막힌다(단일 기기·로컬은 계속 무료). 이때 강제-on 실서버 장기 E2E를 함께 돌린다.
