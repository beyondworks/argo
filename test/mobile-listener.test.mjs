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
    const forwarded = Object.keys(req.headers).filter((k) => k.startsWith('x-forwarded-') || k === 'forwarded');
    res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, cookie: req.headers.cookie ?? null, body, ...(forwarded.length ? { forwarded } : {}) }));
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamPort = upstream.address().port;
after(async () => { await stopMobileListener(); upstream.close(); });

// 기본 Host는 비루프백(폰이 보내는 형태) — 루프백형 Host는 리스너가 421로 끊는 것이 계약이다.
const raw = (port, { method = 'GET', path = '/', headers = {}, body = '' } = {}) => new Promise((resolve, reject) => {
  // agent:false — 기본 에이전트의 keep-alive 풀이 이전 리스너 소켓을 재사용하는 경우를 배제(전체 스위트 1회 간헐 실패 2026-09-03, 단독·병렬 10회 미재현)
  const req = http.request({ host: '127.0.0.1', port, method, path, agent: false, headers: { host: '192.168.0.12:3031', ...headers } }, (res) => {
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

test('루프백 위조 Host·Host 부재는 리스너가 421로 끊는다(업스트림 미도달), x-forwarded-*는 제거', async () => {
  const cfg = await startMobileListener({ port: 0, upstreamPort });
  for (const host of [`127.0.0.1:${upstreamPort}`, 'localhost:3001', 'LOCALHOST', '[::1]:3001', '::1', ' 127.0.0.1 ']) {
    const r = await raw(cfg.port, { headers: { host, cookie: 'argo-mobile=abc' } });
    assert.equal(r.status, 421, `위조 Host ${JSON.stringify(host)} → ${r.status} 업스트림 관측: ${r.data.slice(0, 160)}`);
    assert.equal(JSON.parse(r.data).error, 'invalid host');
  }
  const noHost = await new Promise((resolve, reject) => {
    const s = http.request({ host: '127.0.0.1', port: cfg.port, path: '/', setHost: false }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, data: d })); });
    s.on('error', reject); s.end();
  });
  assert.ok(noHost.status === 400 || noHost.status === 421, `Host 부재는 Node(400) 또는 리스너(421)가 끊는다 — 업스트림 미도달 (${noHost.status})`);
  const ok = await raw(cfg.port, { headers: { host: '127.0.0.1.nip.io:3031', 'x-forwarded-host': '127.0.0.1', 'x-forwarded-for': '1.2.3.4', forwarded: 'host=localhost' } });
  assert.equal(ok.status, 201, '루프백으로 해석되는 도메인이라도 Host 문자열이 비루프백이면 통과(판정은 문자열)');
  const j = JSON.parse(ok.data);
  assert.equal(j.host, '127.0.0.1.nip.io:3031');
  assert.equal(j.forwarded, undefined, 'x-forwarded-*·forwarded 헤더 제거');
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
