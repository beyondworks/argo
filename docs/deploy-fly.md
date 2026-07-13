# Argo 클라우드 워커 배포 (Fly.io)

> 목적: Mac이 꺼져도 회사가 돈다 — 클라우드 리스 리더 승계로 텔레그램 응대·리서치·루틴을 대행.
> 원칙: **인스턴스 1대 = 계정 1개**(`ARGO_TENANT_OWNER` 바인딩). 시크릿 값은 이 문서에 절대 쓰지 않는다 — 이름과 위치만.

## 0. 사전 조건

- `brew install flyctl` (완료) + `fly auth login` (브라우저 승인 — 계정 주인만)
- Supabase 프로젝트 (P1에서 사용 중인 것 그대로)

## 1. 앱·볼륨 생성 (1회)

```bash
fly apps create argo-worker          # 이름이 선점됐으면 fly.toml의 app과 함께 변경
fly volumes create argo_data --region nrt --size 3 --app argo-worker
```

## 2. 시크릿 주입 (값은 Supabase 대시보드에서 — 여기 기록 금지)

```bash
fly secrets set --app argo-worker \
  SUPABASE_SERVICE_ROLE_KEY=***   # Supabase → Settings → API (service_role)
  ARGO_TENANT_OWNER=***           # Supabase → Auth → Users의 내 user id — 이 계정 외 전부 403
  ARGO_SYNC_OWNER=***             # 동일 user id — 동기화도 이 계정 회사만
```

## 3. 배포 (공개 설정은 빌드 인라인 — build-arg로 주입)

```bash
fly deploy --app argo-worker \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=***   \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=***
```

## 4. 배포 직후 검증 (빌드 통과 ≠ 동작)

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://argo-worker.fly.dev/login   # 200
fly logs --app argo-worker | head    # 부팅 로그 — 게이트웨이/스케줄러 기동 확인
```

## 5. 텔레그램 (1회 수동)

크레덴셜은 동기화 제외라 워커에 자동으로 넘어가지 않는다(의도된 격리).
워커 웹 UI(`https://argo-worker.fly.dev`) 로그인 → 설정 → 연결에서 봇 토큰을 1회 입력하면
워커 볼륨(/data)에만 저장된다. 러너도 같은 방식(API 키 경로 — Connect 버튼은 로컬 전용).

## 6. E2E 판정전 — "부재 중 대리 근무"

1. Mac 상주 서비스 정지: `launchctl bootout gui/$(id -u)/com.beyondworks.argo`
2. 클라우드 리스 승계 대기(리스 TTL) → 텔레그램으로 지시
3. 워커가 응답하면 통과. Mac 재기동 → 로컬이 리더 회수 + 폴더 동기화 정합 확인

## 운영 노트

- `auto_stop_machines = false` — 폴러 상주라 재우지 않는다(소형 머신 월 수 달러).
- 로컬 필요 지시(코딩·로컬 파일)는 워커가 대신 못 한다 — 이연 큐는 후속 작업.
- 이미지에 workspaces/.env가 실리면 Docker 빌드가 스스로 실패한다(시크릿 게이트).
