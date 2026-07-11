# Argo

> 프롬프트 한 줄로 전문 AI 크루를 영입하고, 회사가 폴더 단위 기억으로 항해하는
> 개인용 AI 회사 SaaS. 아르고호(Argo) — 전문성이 다른 영웅들이 한 배를 타고
> 황금양털을 향해 함께 항해한 배.

- 도메인: saas · 생성일 2026-07-10 · 제품명 확정 2026-07-10 (구 코드네임 crewbase)
- 설계서: [PRODUCT-SPEC.md](PRODUCT-SPEC.md)
- 실행: `npm run dev` → http://localhost:3000 (웹 UI) · `npm run demo` (P0 코어 CLI 데모)
- 인증: 로컬 Claude Code 세션 그대로 사용. BYOK는 `ANTHROPIC_API_KEY` 또는 `CLAUDE_CODE_OAUTH_TOKEN` (환경변수로만 — 평문 저장 금지)

## 24시간 상주 운항 (자가복구)

회사는 배처럼 항상 떠 있어야 한다 — 한 명령으로 재부팅·크래시·네트워크 단절을 모두 자가복구하는 상주 서비스로 만든다.

```bash
npm run service install    # 지금 켜고, 로그인/재부팅 시 자동 시작 + 죽으면 10초 내 재기동
npm run service status     # 등록 여부 + 실제 응답 확인
npm run service logs       # 로그 위치 + 최근 로그
npm run service uninstall  # 상주 해제
```

- 플랫폼: macOS launchd LaunchAgent / Linux systemd user unit(+linger) / Windows 작업 스케줄러 — 모두 사용자 권한, sudo 불필요
- 기본 포트 3999 (`ARGO_PORT`로 변경, 데이터 루트는 설치 시점 `ARGO_ROOT`를 구움)
- 서버가 뜨면 즉시 게이트웨이 폴러·루틴 스케줄러가 상주한다(`instrumentation.js`) — UI를 열지 않아도 텔레그램이 산다
- 네트워크 단절은 폴러가 5초 백오프 무한 재시도로 스스로 복구(`src/gateway.mjs`)
- node를 갈아끼웠다면(`nvm` 등) `install`을 다시 실행 — 절대 경로를 새로 굽는다
