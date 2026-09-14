#!/usr/bin/env node
// Sign in with Apple(웹 플로우) 클라이언트 시크릿 생성 — Supabase Auth "Apple" 제공자의 Secret Key 칸에 넣는 ES256 JWT.
// Apple 규칙: 최대 6개월(15,777,000초) 유효 → 만료 전에 다시 만들어 Supabase에 갱신해야 한다(달력에 표시).
// 입력은 전부 환경변수·파일 경로로만 받고, 출력은 JWT 한 줄뿐이다(키 본문은 절대 출력하지 않는다).
//   APPLE_TEAM_ID       Apple Developer 팀 ID (10자)
//   APPLE_SERVICES_ID   Services ID (예: com.beyondworks.argo.messenger.signin) — Supabase의 Client ID와 같아야 한다
//   APPLE_KEY_ID        Sign in with Apple 키 ID (10자)
//   APPLE_KEY_P8        .p8 파일 경로
// 사용: APPLE_TEAM_ID=… APPLE_SERVICES_ID=… APPLE_KEY_ID=… APPLE_KEY_P8=~/Downloads/AuthKey_XXXX.p8 node scripts/apple-client-secret.mjs
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`${k} 가 필요합니다`); process.exit(2); } return v; };
const teamId = need('APPLE_TEAM_ID'), clientId = need('APPLE_SERVICES_ID'), keyId = need('APPLE_KEY_ID'), p8 = need('APPLE_KEY_P8');
const key = createPrivateKey(readFileSync(p8.replace(/^~/, process.env.HOME), 'utf8'));
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const maxAge = Number(process.env.APPLE_SECRET_MAX_AGE ?? 15_777_000); // 6개월(Apple 상한)
const header = b64({ alg: 'ES256', kid: keyId, typ: 'JWT' });
const payload = b64({ iss: teamId, iat: now, exp: now + maxAge, aud: 'https://appleid.apple.com', sub: clientId });
const der = sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
process.stdout.write(`${header}.${payload}.${Buffer.from(der).toString('base64url')}\n`);
console.error(`만료: ${new Date((now + maxAge) * 1000).toISOString()} — 그 전에 다시 생성해 Supabase Auth › Apple › Secret Key 갱신`);
