#!/bin/zsh
# 오피스 dev 서버(기본 :5191 — 실제 연결을 쓰는 :5190과 따로)를 가짜 Google(:58401)에 붙여 띄운다 — 로컬 시험 전용 값(실제 구글 값 아님).
# 봉인 키는 이 기기 로컬 파일(~/.cache/argo-office/local-mail-key, 레포 밖)에 한 번 만들어 재사용한다.
K=~/.cache/argo-office/local-mail-key
[[ -f $K ]] || { mkdir -p ${K:h}; node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" > $K; chmod 600 $K; }
export OFFICE_GOOGLE_CLIENT_ID=fake-client.apps.googleusercontent.com OFFICE_GOOGLE_CLIENT_SECRET=fake-secret
export OFFICE_MAIL_KEY=$(cat $K) OFFICE_ORIGIN=http://localhost:${PORT:=5191}
export OFFICE_GOOGLE_AUTH_URL=http://127.0.0.1:58401/auth OFFICE_GOOGLE_TOKEN_URL=http://127.0.0.1:58401/token OFFICE_GOOGLE_REVOKE_URL=http://127.0.0.1:58401/revoke OFFICE_GMAIL_API=http://127.0.0.1:58401/gmail/v1/users/me
cd ${0:A:h}/../.. && exec npx vite --port $PORT --strictPort
