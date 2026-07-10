# Argo

> 프롬프트 한 줄로 전문 AI 크루를 영입하고, 회사가 폴더 단위 기억으로 항해하는
> 개인용 AI 회사 SaaS. 아르고호(Argo) — 전문성이 다른 영웅들이 한 배를 타고
> 황금양털을 향해 함께 항해한 배.

- 도메인: saas · 생성일 2026-07-10 · 제품명 확정 2026-07-10 (구 코드네임 crewbase)
- 설계서: [PRODUCT-SPEC.md](PRODUCT-SPEC.md)
- 실행: `npm run dev` → http://localhost:3000 (웹 UI) · `npm run demo` (P0 코어 CLI 데모)
- 인증: 로컬 Claude Code 세션 그대로 사용. BYOK는 `ANTHROPIC_API_KEY` 또는 `CLAUDE_CODE_OAUTH_TOKEN` (환경변수로만 — 평문 저장 금지)
