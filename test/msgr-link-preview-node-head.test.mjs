// 게이트웨이 Node 요청기 — </head>에서 멈춤·1MB 상한(2026-10-02 총괄 결정, 엣지 readHead와 같은 규칙).
// 로컬 서버를 쓰되 lookup은 테스트 전용으로 로컬을 가리킨다(기본 lookup은 내부 주소를 막는다 — msgr-gateway-media.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { nodeRequest } from '../src/gateway/link-preview-node.mjs';

const toLocal = (hostname, options, cb) => (options?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4));
async function server(handler) {
  const s = createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { port: s.address().port, close: () => { s.closeAllConnections?.(); return new Promise((r) => s.close(r)); } };
}

test('nodeRequest — </head>를 받으면 응답이 끝나기를 기다리지 않고 멈춘다', async () => {
  const s = await server((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<head><meta property="og:title" content="t"></head><body>'); setTimeout(() => res.end('늦은 본문'), 3000); });
  try {
    const t0 = Date.now();
    const r = await nodeRequest(`http://fake.example:${s.port}/`, { timeoutMs: 2500, maxBytes: 1024 * 1024 }, { lookup: toLocal });
    assert.ok(Date.now() - t0 < 1000, `기다림 ${Date.now() - t0}ms`);
    assert.equal(new TextDecoder().decode(r.body), '<head><meta property="og:title" content="t">');
  } finally { await s.close(); }
});

test('nodeRequest — </head> 없이 1MB를 넘으면 1MB에서 끊는다', async () => {
  const s = await server((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<head>${'x'.repeat(1300 * 1024)}`); });
  try {
    const r = await nodeRequest(`http://fake.example:${s.port}/`, { timeoutMs: 3000, maxBytes: 1024 * 1024 }, { lookup: toLocal });
    assert.equal(r.body.length, 1024 * 1024);
  } finally { await s.close(); }
});
