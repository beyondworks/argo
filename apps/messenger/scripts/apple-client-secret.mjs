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
const fail = (m) => { console.error(m); process.exit(2); };
if (!/^[A-Z0-9]{10}$/.test(teamId)) fail('APPLE_TEAM_ID 는 10자 영숫자');
if (!/^[A-Z0-9]{10}$/.test(keyId)) fail('APPLE_KEY_ID 는 10자 영숫자');
if (!/^[a-z0-9.-]+$/i.test(clientId)) fail('APPLE_SERVICES_ID 형식(예: com.company.app.signin)');
const home = process.env.HOME; if (p8.startsWith('~') && !home) fail('HOME 미설정 — .p8 경로를 절대경로로');
let pem; try { pem = readFileSync(p8.replace(/^~/, home), 'utf8'); } catch (e) { fail(`.p8 파일을 읽지 못했습니다: ${p8} (${e.code ?? e.message})`); }
let key; try { key = createPrivateKey(pem); } catch { fail('.p8 내용이 PEM 개인키가 아닙니다'); }
if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') fail('.p8 은 P-256(ES256) EC 키여야 한다 — Apple이 준 AuthKey_*.p8 인지 확인');
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const MAX = 15_777_000; // Apple 상한 6개월
const maxAge = process.env.APPLE_SECRET_MAX_AGE === undefined ? MAX : Number(process.env.APPLE_SECRET_MAX_AGE);
if (!Number.isInteger(maxAge) || maxAge <= 0 || maxAge > MAX) fail(`APPLE_SECRET_MAX_AGE 는 1~${MAX}초(Apple 상한 6개월)`); // 검증은 서명·출력보다 앞
const header = b64({ alg: 'ES256', kid: keyId, typ: 'JWT' });
const payload = b64({ iss: teamId, iat: now, exp: now + maxAge, aud: 'https://appleid.apple.com', sub: clientId });
const der = sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
process.stdout.write(`${header}.${payload}.${Buffer.from(der).toString('base64url')}\n`);
console.error(`만료: ${new Date((now + maxAge) * 1000).toISOString()} — 그 전에 다시 생성해 Supabase Auth › Apple › Secret Key 갱신`);
