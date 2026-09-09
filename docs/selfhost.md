# Argo 셀프호스트 (리눅스 VPS — 1차)

> 배포 경로(2026-07-23 현행): 데스크톱 앱(dmg·서명·공증, argo-agent Latest)이 정문이고,
> 이 CLI 설치 트랙은 리눅스 VPS·헤드리스용 병행 경로다.
> 웹/앱 기능 패리티 절대 원칙 — 셀프호스트 웹은 데스크톱 앱과 기능이 같아야 한다(연결 포함).

## 설치 (리눅스 x64, Node 22+)

```bash
curl -fsSL https://github.com/beyondworks/argo-agent/releases/latest/download/install.sh | bash
```

하는 일: 최신 서버 타르볼 설치(`~/.argo-selfhost/app`) → systemd user 서비스(`Restart=always` + linger) →
`127.0.0.1:3001` 기동 → `/api/ping` 신원 검증. **업데이트 = 같은 명령 재실행**(데이터는 `~/.argo-selfhost/data` 보존).

## 보안 기본값 (install.sh가 강제 — 바꾸기 전에 읽을 것)

- **루프백 바인딩 + 로컬 모드(무인증)** — 원격 사용은 SSH 터널:
  `ssh -L 3001:127.0.0.1:3001 user@서버` 후 브라우저에서 `http://localhost:3001`
- **포트를 공개로 열지 말 것.** 무인증 공개 = 회사(크루·기억·자격) 전체가 인터넷에 노출된다.
  공개 접근이 필요하면 인증 모드(Supabase env로 빌드) — 후속 문서.
- 기본 서버 타르볼은 **로컬 1인 모드**다. 기기 간 동기화·팀 메신저 크루 브리지는 같은 Supabase에 로그인한 인증 모드에서 동작한다. 아래 회사 서버 절의 재빌드 절차가 필요하다.
- 지원 배포물: 데스크톱 Argo·Argo Messenger는 macOS Apple Silicon/Intel 및 Windows x64, 셀프호스트 타르볼은 Linux x64다. Linux용 Messenger 데스크톱이나 ARM Linux 타르볼을 제공한다는 뜻은 아니다.

## 러너 연결 (헤드리스)

- **API 키**: 설정 → 러너 연결에 붙여넣기(저장 시 실검증 — 무효면 저장 안 됨).
- **Codex/Gemini OAuth**: "로그인 페이지 열기" → 노트북 브라우저에서 승인 → 리다이렉트된 주소를 복사해 붙여넣기(콜백은 서버에 못 오므로 붙여넣기 폴백이 정식 경로).
- **Claude**: 노트북 터미널에서 `claude setup-token` → 출력 토큰 붙여넣기(줄바꿈 섞여도 자기치유).

### base URL을 손대지 말 것 (2026-09-05 실사용 장애)

러너 base URL은 Argo가 러너마다 정한다. env로 덮을 수 있지만 **끝에 `/v1`을 붙이면 안 된다** — Argo가
`/v1/messages`를 덧붙이므로 경로가 겹쳐 전 모델이 404가 되고, 화면에는 "선택한 모델에 문제가 있습니다"로
보인다(모델을 바꿔도 같다). 정본 값:

| env | 정본 값 |
|---|---|
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api` |
| `GLM_BASE_URL` | `https://api.z.ai/api/anthropic` |
| `KIMI_BASE_URL` | `https://api.moonshot.ai/anthropic` |
| `GROK_BASE_URL` | `https://api.x.ai` |

같은 404는 OpenRouter 계정의 데이터 정책이 모든 제공사를 제외했을 때도 난다
(<https://openrouter.ai/settings/privacy>). 서버의 아웃바운드 프록시가 대신 응답하는 경우도 같은 증상이다.

## 회의실 동시 발언 상한

회의실에서 여러 크루를 부르면 동시에 발언한다(릴레이 `@A > @B` 제외). 동시 실행 상한은 `ARGO_ROOM_CONCURRENCY`(기본 8, 1~16으로 클램프). Claude 러너는 크루마다 CLI 프로세스를 띄우므로 메모리가 작은 서버는 3~4를 권한다. 크루 쪽지함 배달도 같은 방식으로 동시에 돈다 — 상한은 `ARGO_MAIL_CONCURRENCY`(기본 8, 1~16). **이 상한은 회사당**이라 회사가 여럿이면 실동시 턴은 회사 수만큼 곱해진다(매 분 자동 배달이므로 메모리가 작은 서버는 회의실과 같이 3~4를 권한다). 같은 크루 앞으로 온 쪽지는 그 크루 안에서 순차다(상한은 사실상 "동시에 도는 크루 수"). 착수는 크루별 라운드로빈이라 한 크루에 밀린 백로그가 다른 크루의 쪽지를 막지 않는다.

## 24/7 활용

루틴·텔레그램/슬랙 게이트웨이가 노트북 수면과 무관하게 상시 동작 — VPS가 리더 기기가 된다.

## 빌드·검증 이력

- 타르볼 = `scripts/stage-server.mjs`(stage-sidecar와 동일 조립 계약: standalone+static/public+SDK 네이티브+시크릿 유출 가드). CI `server` 잡(ubuntu, 릴리스 자산에 `argo-server-<ver>-linux-x64.tar.gz` + `install.sh` 동봉).
- 릴리스 CI는 배포 타르볼을 새 디렉터리에 추출하고 빈 HOME·임시 데이터에서 서버를 기동한다. `/api/ping` 버전/빌드, 홈 200, 로컬 사용자 인증 모드, 외부 Host 421, 로컬 자산 탐색 경로를 검사한다. 이는 실제 사용자 OAuth·벤더 호출 검증을 대체하지 않는다.
- 2차 예정: 맥/윈도 CLI 설치, Docker 이미지, `argo update` 전용 명령.

## 팀 메신저 (Argo Messenger) — 회사 서버로 운영하기

메신저의 서버는 **Supabase 프로젝트 하나**다(조직·채널은 그 안의 행, RLS가 조직 사이를 가른다). Argo 클라우드를
쓰지 않고 회사가 직접 운영하려면, 회사 소유의 Supabase(호스티드 프로젝트 또는 셀프호스트 스택)에 같은
마이그레이션을 적용하고 앱에서 서버만 바꾼다. 라이선스는 계약 기반이다(문의: 랜딩 "문의").

1. **전체 마이그레이션 적용** — 새 회사 Supabase에는 `supabase/migrations/`의 선행 인증·회사·플랜 마이그레이션부터 해당 릴리스까지 빠짐없이 적용한다. 이미 운영 중이면 `supabase migration list`로 적용 이력을 확인한 뒤 누락된 항목만 순서대로 적용한다. 운영 프로젝트를 reset하지 않는다. 메신저 기본 SQL 두 개만으로는 현재 앱을 운영할 수 없다. 이번 버전에 필요한 메신저 순서는 다음과 같다(선행 공통 마이그레이션을 대체하는 목록이 아니다):

   ```text
   20260903120000_msgr.sql
   20260907120000_msgr_crew_inventory.sql
   20260908120000_msgr_bots.sql
   20260908140000_msgr_crew_autodispatch.sql
   20260909000000_msgr_bot_external_id.sql
   20260909001000_msgr_crew_folder.sql
   20260909002000_msgr_profiles_friends.sql
   20260909003000_msgr_message_meta.sql
   20260909004000_msgr_p0_reads_reactions_prefs.sql
   20260909005000_msgr_avatars.sql
   20260909120000_msgr_execution_claims.sql
   20260909230000_msgr_bot_execution.sql
   ```

   마지막 두 항목은 여러 기기가 같은 크루·봇을 실행할 때 중복 실행과 중복 응답을 막는 DB 계약이다. 모든 Argo 크루 호스트와 외부 봇 실행기도 같은 릴리스의 계약으로 갱신한 뒤 검수한다. 과거 SQL만 적용한 서버로 새 클라이언트를 연결하지 않는다.
2. **첨부 버킷** — 기본 메신저 SQL은 첨부 버킷을 만들지 않는다. 없는 경우에만 생성한다:
   `insert into storage.buckets (id, name, public, file_size_limit) values ('msgr', 'msgr', false, 26214400) on conflict (id) do nothing;`
   기존 버킷도 `public=false`·파일 크기 제한·`storage.objects` 조직/채널 접근 정책을 확인한다. `msgr-avatars` 공개 버킷과 프로필 정책은 아바타 마이그레이션이 생성한다.
3. **인증** — 회사 프로젝트의 Supabase Auth에서 Google·GitHub provider를 구성하고 Redirect URLs 허용 목록에 `http://127.0.0.1:*/auth/paired`를 등록한다. 웹 로그인도 사용하면 해당 서버의 `/auth/callback` 주소를 추가한다. 앱은 루프백 임시 포트로 OAuth를 돌려받는다.
4. **메신저에서 서버 지정** — 로그인 화면의 "서버"에 회사 프로젝트 URL과 공개 anon 키를 저장한다. 프로필은 해당 기기에만 저장되며 같은 배포 앱을 사용할 수 있다. 서비스 역할 키는 메신저 프로필에 넣지 않는다.
5. **크루 브리지(Argo 서버)는 재빌드 필요** — Argo의 `NEXT_PUBLIC_SUPABASE_URL`·`NEXT_PUBLIC_SUPABASE_ANON_KEY`는 **빌드 때 클라이언트와 인증 게이트에 인라인된다**. 기본 로컬 모드 타르볼을 설치한 뒤 `.env.local`만 바꾸거나 서버만 재시작해서 회사 서버로 전환할 수 없다. 해당 릴리스 소스에서 회사 프로젝트의 두 공개 env를 빌드 환경에 설정한 후 아래처럼 새 standalone과 타르볼을 만든다. env 값은 셸 이력·문서에 붙여넣지 말고 보호된 환경 파일/배포 설정으로 주입한다.

   ```bash
   npm ci
   ARGO_STANDALONE=1 npm run build
   node scripts/stage-server.mjs
   ```

   `stage-server.mjs`는 기존 standalone을 재사용하므로 앞의 빌드를 생략하지 않는다. 새 산출물을 설치하고 런타임에도 같은 프로젝트 공개 env를 설정한다. 각 크루 호스트에서 회사 프로젝트 계정으로 로그인하고 조직 소속·크루 파견 상태를 확인한다. 일반 크루 브리지는 해당 사용자의 기기 세션을 사용한다. `SUPABASE_SERVICE_ROLE_KEY`는 관리자 기능을 운영하는 신뢰된 서버에만 필요 시 설정하며, 데스크톱/메신저 빌드나 배포 타르볼에는 넣지 않는다.
6. **회사 노드(선택)** — 회사 크루를 두려면 조직 카드 "회사 노드"의 연결 코드로 `node scripts/msgr-node-bootstrap.mjs`를 회사 서버에서 한 번 실행한다.

확인: 무인증 `/api/me`가 401인지 → 로그인 → 조직 만들기 → 채널에 글 → 첨부 업로드 → 크루 파견 → 두 크루의 순차 멘션 답변과 종료까지 확인한다. 두 호스트가 연결된 경우에도 응답이 한 번씩만 생기고 원래 메신저 채널에 남아야 한다. 다른 조직/비공개 채널의 비회원 읽기·쓰기가 거절되는지도 별도 계정으로 확인한다.
데이터는 전부 회사 프로젝트에 평문으로 남는다([privacy-sync.md](privacy-sync.md) "팀 메신저").
