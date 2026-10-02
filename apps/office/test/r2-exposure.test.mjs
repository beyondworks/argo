// R2 접근 키가 브라우저로 새지 않는 구조(설계안 4-3) — 화면 코드(src/)는 R2 변수·서명 라이브러리를 쓰지 않고, 빌드 산출물(dist/, 있으면)에도 없다.
// 서명은 서버 함수(api/·server/)만 한다. 값은 모르므로(읽지 않는다) 이름·라이브러리 흔적으로 잠근다. CORS 설정안(r2-cors.json)도 모양을 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const BAD = [/R2_OFFICE_SECRET/, /R2_OFFICE_ACCESS_KEY/, /aws4fetch/, /AWS4-HMAC-SHA256/, /AwsV4Signer/];

test('화면 코드(src/)에는 R2 키 이름·서명 코드가 없다', () => {
  for (const f of walk(join(root, 'src')).filter((p) => /\.(js|jsx|mjs)$/.test(p))) {
    const t = readFileSync(f, 'utf8');
    for (const re of BAD) assert.ok(!re.test(t), `${f.slice(root.length)}: ${re}`);
  }
});

test('빌드 산출물(dist/)에도 R2 키 이름·서명 코드가 없다(빌드가 있을 때)', () => {
  const dist = join(root, 'dist');
  const files = existsSync(dist) ? walk(dist).filter((p) => /\.(js|html|map)$/.test(p)) : [];
  for (const f of files) { const t = readFileSync(f, 'utf8'); for (const re of BAD) assert.ok(!re.test(t), `${f.slice(root.length)}: ${re}`); }
});

test('CORS 설정안: 운영 버킷(r2-cors.json)은 운영·데스크톱 출처만, 로컬 출처는 개발용(r2-cors.dev.json) — GET·PUT, 서명에 넣은 헤더만', () => {
  const prod = JSON.parse(readFileSync(join(root, 'r2-cors.json'), 'utf8')), dev = JSON.parse(readFileSync(join(root, 'r2-cors.dev.json'), 'utf8'));
  assert.deepEqual(prod.flatMap((r) => r.AllowedOrigins), ['https://argo-office.vercel.app', 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);
  assert.ok(!prod.flatMap((r) => r.AllowedOrigins).some((o) => /localhost:\d/.test(o)), '운영 버킷에 로컬 개발 출처를 넣지 않는다');
  assert.deepEqual(dev.flatMap((r) => r.AllowedOrigins), ['http://localhost:5190', 'http://localhost:5192']);
  for (const r of [...prod, ...dev]) { assert.deepEqual(r.AllowedMethods, ['GET', 'PUT']); assert.deepEqual(r.AllowedHeaders, ['content-type', 'if-none-match']); assert.ok(r.MaxAgeSeconds <= 3600); assert.ok(!r.AllowedOrigins.includes('*')); }
});
