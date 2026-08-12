# Claude Code CLI 로그인 없이 사용 설정 및 연동 개선

## 1. 개요
로컬 환경에서 OAuth 로그인(`claude login`)이나 공식 인증 토큰 파일 없이 `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` 등의 환경변수로 Claude Code CLI를 사용하는 경우, Argo 앱에서 "이 컴퓨터 로그인 사용" (host 타입 연동) 등록 시 `authed: false`로 감지되어 연동이 거부되는 현상을 개선하였습니다.

## 2. 원인 분석
- 기존 Argo의 러너 감지 모듈(`detectRunners`)은 `claude` 러너에 대해 `~/.claude/.credentials.json` 파일이나 `~/.claude.json` 내 `oauthAccount` 정보, 또는 `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` 환경변수만으로 인증 여부를 판단하였습니다.
- 로그인 없이 로컬 커스텀 API/프록시 및 설치된 Claude Code CLI로 동작하는 환경에서 `ANTHROPIC_BASE_URL` 환경변수나 설치된 CLI 존재 여부가 감지 조건에 누락되어 `authed: false` 상태로 오판정되었습니다.
- 또한 `PROVIDER_AUTH_OWNERS`에 `ANTHROPIC_BASE_URL` 환경변수가 등록되어 있지 않아 러너 간 환경변수 세척 과정에서 소유권 누락 가능성이 존재하였습니다.

## 3. 주요 수정 내역

### 3.1 `src/runners/shared.mjs`
- `PROVIDER_AUTH_OWNERS`에 `ANTHROPIC_BASE_URL: ['claude', 'glm', 'kimi', 'openrouter']`를 등록하여 Anthropic 프로토콜 호환 러너들의 base URL 환경변수 소유권을 보호하도록 개선했습니다.

### 3.2 `src/runners/exec.mjs`
- `detectRunners()` 함수에서 `claude` CLI 실행 파일 존재 여부(`exec('claude', ['--version'])` 및 `bundledClaudeCli()`)를 병렬 감지하도록 보강했습니다.
- `claude` 러너의 `authed` 판정 조건에 `process.env.ANTHROPIC_BASE_URL` 및 설치된 `claude` CLI(`claudeInstalled`) 환경을 포함시켰습니다.
- 이에 따라 로그인 없이 로컬 `claude` CLI를 사용하는 사용자가 Argo 설정의 "이 컴퓨터 로그인 사용" (host 연동)을 선택하여 저장할 때 정상 연결되도록 조치하였습니다.

## 4. 검증 결과
- `node --check`를 통한 구문 무결성 검증 완료
- `npx next build`를 통한 Next.js 프로덕션 빌드 성공 확인
- 로그인 없이 로컬 환경변수 기반으로 구동되는 Claude Code CLI가 Argo 앱의 host 자격으로 정상 등록되어 턴 실행에 적용됨을 확인했습니다.
