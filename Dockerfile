# syntax=docker/dockerfile:1
# Argo 클라우드 워커 — "부재 중 대리 근무자". Next standalone + src 코어를 담는다.
# 원칙: 인스턴스 1대 = 계정 1개(ARGO_TENANT_OWNER 바인딩), 이미지에 시크릿·워크스페이스 절대 미포함.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Supabase 공개 설정은 빌드에 인라인된다(NEXT_PUBLIC_*) — 값은 배포 시 --build-arg로만 주입(레포 평문 금지)
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    ARGO_STANDALONE=1
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=8080 ARGO_ROOT=/data
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# SDK 네이티브 CLI — 플랫폼별 패키지를 동적 로드하므로 standalone 트레이싱이 놓친다(linux-x64 미포함 실측).
# 빌드 스테이지(리눅스 npm ci)의 풀 패키지를 덮어써 워커에서 크루 턴이 돌게 한다.
COPY --from=build /app/node_modules/@anthropic-ai ./node_modules/@anthropic-ai
# 시크릿 게이트 — 워크스페이스/시크릿이 이미지에 실리면 빌드를 실패시킨다(stage-sidecar와 동일 원칙:
# 패키징은 "무엇을 담았는가"를 스캔으로 증명한다)
RUN rm -rf ./workspaces ./.next/cache && \
    if find . \( -name 'connections.json' -o -name '.secrets.json' -o -name '.env' -o -name '.env.*' \) -not -path './node_modules/*' | grep -q .; then \
      echo '[docker] 시크릿 파일 잔존 — 빌드 차단'; exit 1; \
    fi
EXPOSE 8080
CMD ["node", "server.js"]
