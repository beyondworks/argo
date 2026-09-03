// LAN 리스너(src/mobile-listener.mjs) — 행동 테스트: Host·쿠키·메서드·바디를 그대로 업스트림에 넘기고,
// 응답 상태·헤더를 되돌리며, 정지 후엔 접속이 거부된다. 업스트림 부재는 502.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMobileListener, stopMobileListener, mobileListenerStatus } from '../src/mobile-listener.mjs';

const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.writeHead(201, { 'content-type': 'application/json', 'set-cookie': 'argo-mobile=tok; Path=/' });
    res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, cookie: req.headers.cookie ?? null, body }));
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamPort = upstream.address().port;
after(async () => { await stopMobileListener(); upstream.close(); });

const raw = (port, { method = 'GET', path = '/', headers = {}, body = '' } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
    let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }));
  });
  req.on('error', reject);
  req.end(body);
});

test('Host·쿠키·메서드·바디 보존 + 응답 상태·Set-Cookie 회송', async () => {
  const cfg = await startMobileListener({ port: 0, upstreamPort });
  assert.equal(mobileListenerStatus().listening, true);
  const big = 'x'.repeat(300_000);
  const r = await raw(cfg.port, { method: 'POST', path: '/api/companies/w/chat?mtime=1', headers: { host: '192.168.0.12:3031', cookie: 'argo-mobile=abc', 'content-type': 'text/plain' }, body: big });
  assert.equal(r.status, 201);
  assert.equal(r.headers['set-cookie'][0], 'argo-mobile=tok; Path=/');
  const j = JSON.parse(r.data);
  assert.deepEqual([j.method, j.url, j.host, j.cookie, j.body.length], ['POST', '/api/companies/w/chat?mtime=1', '192.168.0.12:3031', 'argo-mobile=abc', big.length]);
});

test('같은 설정 재시작은 무동작, 정지 후 접속 거부', async () => {
  const a = await startMobileListener({ port: 0, upstreamPort });
  const b = await startMobileListener({ port: a.port, upstreamPort });
  assert.equal(a.port, b.port);
  await stopMobileListener();
  assert.equal(mobileListenerStatus().listening, false);
  await assert.rejects(raw(a.port), /ECONNREFUSED/);
});

test('업스트림 부재 → 502 JSON', async () => {
  const dead = http.createServer(); await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const deadPort = dead.address().port; await new Promise((r) => dead.close(r));
  const cfg = await startMobileListener({ port: 0, upstreamPort: deadPort });
  const r = await raw(cfg.port);
  assert.equal(r.status, 502);
  assert.equal(JSON.parse(r.data).error, 'upstream unavailable');
});

test('upstreamPort 없이 시작 불가', async () => {
  await assert.rejects(startMobileListener({ port: 0 }), /upstreamPort/);
});
