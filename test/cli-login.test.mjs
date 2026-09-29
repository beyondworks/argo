// argo CLI 로그인 서버 — 앱의 브라우저 핸드오프와 같은 원칙(명시적 승인·단일 소유자·첫 사용 회전)을 실행으로 잠근다.
// 가장 위험한 실패는 로그인 CSRF다: 다른 웹사이트가 127.0.0.1:<port>/bind로 공격자 토큰을 밀어 넣으면 CLI가 공격자 계정으로
// 로그인해 사장의 크루 대화가 그 계정으로 새어 나간다. nonce(리다이렉트 주소에만 있음)와 Host 검사가 그것을 막는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startLoginServer, isLoopback } from '../src/cli/login.mjs';

const call = (port, { method = 'GET', path = '/', host, body } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, method, path, headers: { ...(host ? { host } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
    let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve({ status: res.statusCode, body: data }));
  });
  req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
});

const boot = (over = {}) => {
  const saved = [];
  return startLoginServer({ supabaseUrl: 'https://sb.example', anonKey: 'anon', port: 0,
    verify: async (at) => { if (at !== 'good-access') throw new Error('bad'); return { id: 'u1', email: 'u@x.io' }; },
    save: async (s) => { saved.push(s); }, ...over }).then((srv) => ({ srv, saved }));
};

test('시작 페이지의 로그인 링크는 127.0.0.1/auth/paired로 돌아오고 nonce를 싣는다(허용 목록 그대로 — 설정 변경 없음)', async () => {
  const { srv } = await boot();
  try {
    const r = await call(srv.port);
    assert.equal(r.status, 200);
    const href = decodeURIComponent(r.body.match(/href="([^"]+)"/)[1].replace(/&amp;/g, '&'));
    assert.ok(href.startsWith('https://sb.example/auth/v1/authorize?provider=google&redirect_to='));
    assert.ok(href.includes(`http://127.0.0.1:${srv.port}/auth/paired?cli=${srv._nonce}`));
  } finally { await srv.close(); }
});

test('승인하면 검증 뒤 expires_at 0으로 저장하고(첫 사용 회전), 두 번째 승인은 받지 않는다', async () => {
  const { srv, saved } = await boot();
  try {
    const ok = await call(srv.port, { method: 'POST', path: '/bind', body: { cli: srv._nonce, access_token: 'good-access', refresh_token: 'r1' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await srv.done, { id: 'u1', email: 'u@x.io' });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].expires_at, 0);
    assert.equal(saved[0].refresh_token, 'r1');
    const again = await call(srv.port, { method: 'POST', path: '/bind', body: { cli: srv._nonce, access_token: 'good-access', refresh_token: 'r2' } });
    assert.equal(again.status, 400, '한 번 로그인한 뒤 다른 토큰으로 덮어쓰지 못한다');
    assert.equal(saved.length, 1);
  } finally { await srv.close(); }
});

test('로그인 CSRF 차단 — nonce가 틀리거나 Host가 루프백이 아니면 저장하지 않는다', async () => {
  const { srv, saved } = await boot();
  try {
    assert.equal((await call(srv.port, { method: 'POST', path: '/bind', body: { cli: 'guess', access_token: 'good-access', refresh_token: 'r' } })).status, 400);
    assert.equal((await call(srv.port, { method: 'POST', path: '/bind', host: 'evil.example', body: { cli: srv._nonce, access_token: 'good-access', refresh_token: 'r' } })).status, 403, 'DNS 리바인딩');
    assert.equal((await call(srv.port, { path: `/auth/paired?cli=wrong` })).status, 400);
    assert.equal(saved.length, 0);
  } finally { await srv.close(); }
});

test('검증에 실패한 토큰은 저장하지 않는다 — 로그인은 끝나지 않고 다시 승인하면 된다', async () => {
  const { srv, saved } = await boot();
  try {
    const r = await call(srv.port, { method: 'POST', path: '/bind', body: { cli: srv._nonce, access_token: 'forged', refresh_token: 'r' } });
    assert.equal(r.status, 401);
    assert.equal(saved.length, 0);
    const ok = await call(srv.port, { method: 'POST', path: '/bind', body: { cli: srv._nonce, access_token: 'good-access', refresh_token: 'r2' } });
    assert.equal(ok.status, 200);
    assert.equal((await srv.done).id, 'u1');
  } finally { await srv.close(); }
});

test('루프백 판정(순수)', () => {
  for (const h of ['127.0.0.1:38417', 'localhost:1', '[::1]:80', '127.0.0.1']) assert.equal(isLoopback(h), true, h);
  for (const h of ['evil.example', '127.0.0.1.evil.example', '', undefined]) assert.equal(isLoopback(h), false, String(h));
});
