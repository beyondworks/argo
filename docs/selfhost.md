# Argo 셀프호스트 (리눅스 VPS — 1차)

> 배포 경로(2026-07-23 현행): 데스크톱 앱(dmg·서명·공증, argo-agent Latest)이 정문이고,
> 이 CLI 설치 트랙은 리눅스 VPS·헤드리스용 병행 경로다.
> 웹/앱 기능 패리티 절대 원칙 — 셀프호스트 웹은 데스크톱 앱과 기능이 같아야 한다(연결 포함).

## 설치 (리눅스, Node 20+)

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
- 로컬 모드 서버는 **독립 섬** — 기기 간 동기화(Supabase)는 인증 모드에서만 붙는다.

## 러너 연결 (헤드리스)

- **API 키**: 설정 → 러너 연결에 붙여넣기(저장 시 실검증 — 무효면 저장 안 됨).
- **Codex/Gemini OAuth**: "로그인 페이지 열기" → 노트북 브라우저에서 승인 → 리다이렉트된 주소를 복사해 붙여넣기(콜백은 서버에 못 오므로 붙여넣기 폴백이 정식 경로).
- **Claude**: 노트북 터미널에서 `claude setup-token` → 출력 토큰 붙여넣기(줄바꿈 섞여도 자기치유).

## 24/7 활용

루틴·텔레그램/슬랙 게이트웨이가 노트북 수면과 무관하게 상시 동작 — VPS가 리더 기기가 된다.

## 빌드·검증 이력

- 타르볼 = `scripts/stage-server.mjs`(stage-sidecar와 동일 조립 계약: standalone+static/public+SDK 네이티브+시크릿 유출 가드). CI `server` 잡(ubuntu, 릴리스 자산에 `argo-server-<ver>-linux-x64.tar.gz` + `install.sh` 동봉).
- 2026-07-20 스모크: 타르볼 추출 → `node server.js` → ping `{"argo":true}` + 홈 200(로컬 모드) 실측.
- 2차 예정: 맥/윈도 CLI 설치, Docker 이미지, 인증 모드 셀프호스트 가이드, `argo update` 전용 명령.
