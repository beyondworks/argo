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
  ARGO_TENANT_OWNER=***           # Supabase → Auth → Users의 내 user id — 이 계정 외 전부 403 + Claude 원클릭(setup-token) 하드 차단축(공개 셀프호스트 필수)
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

## 5. 텔레그램·러너 크레덴셜 — 자동 동기화 (봉투 암호화)

크레덴셜(connections.json·.secrets.json)은 **어느 기기에서든 1회만 입력**하면 동기화로 전 기기에
흐른다. 스토리지엔 항상 암호문(secretbox — AES-256-GCM, 키는 SUPABASE_SERVICE_ROLE_KEY에서
HKDF 파생)으로만 놓인다. 서비스 키 없는 환경(순수 로컬)은 기존대로 동기화 제외·기기별 입력.
러너 OAuth Connect 버튼만 로컬 전용(CLI 대행) — 워커에선 API 키 경로 또는 동기화된 키를 쓴다.

## 6. E2E 판정전 — "부재 중 대리 근무"

1. Mac 상주 서비스 정지: `launchctl bootout gui/$(id -u)/com.beyondworks.argo`
2. 클라우드 리스 승계 대기(리스 TTL) → 텔레그램으로 지시
3. 워커가 응답하면 통과. Mac 재기동 → 로컬이 리더 회수 + 폴더 동기화 정합 확인

## 운영 노트

- `auto_stop_machines = false` — 폴러 상주라 재우지 않는다(소형 머신 월 수 달러).
- 로컬 필요 지시(코딩·로컬 파일)는 워커가 대신 못 한다 — 이연 큐는 후속 작업.
- 이미지에 workspaces/.env가 실리면 Docker 빌드가 스스로 실패한다(시크릿 게이트).
