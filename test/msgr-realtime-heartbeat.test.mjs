// 응답 없이 죽은 Realtime 소켓(서버 멈춤·반쯤 열린 TCP)을 15초 안에 안다(#943, 유건 10/11 "어떤 경우에도 지금보다 답이 늦으면 안 된다").
// 게이트웨이와 같은 옵션(msgrClientOptions)으로 실제 supabase-js/realtime-js를 띄우고, 의존성 없는 작은 WebSocket 서버가 Phoenix 프로토콜로 답하다가
// 어느 순간부터 아무것도 답하지 않는다(TCP는 열린 채). 그때부터 채널 CHANNEL_ERROR까지 걸린 실제 시간을 잰다 — 하트비트 간격 × 2 이하이고 15초 이하.
// 게이트웨이는 그 콜백에서 받은 글을 한 번 보고 15초 조회로 내려간다(msgr-bridge-idle·msgr-bridge-latency 시험) — 죽은 소켓 동안 온 글도 종전 15초보다 늦지 않다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-rt-hb-')); // 격리 루트
const { msgrClientOptions, RT_HEARTBEAT_MS } = await import('../src/gateway/msgr.mjs');
const { createClient } = await import('@supabase/supabase-js');

/** 텍스트 프레임만 다루는 최소 WebSocket 서버(RFC 6455) — Phoenix vsn 2.0.0 JSON 배열 [join_ref, ref, topic, event, payload] */
function phoenixServer() {
  const st = { frozen: false, sockets: [] };
  const srv = createServer((_, res) => { res.writeHead(404); res.end(); });
  srv.on('upgrade', (req, sock) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    st.sockets.push(sock);
    let buf = Buffer.alloc(0);
    const send = (arr) => { const p = Buffer.from(JSON.stringify(arr)); const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]); sock.write(Buffer.concat([h, p])); };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        const op = buf[0] & 15; let len = buf[1] & 127, off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4); const data = Buffer.from(buf.subarray(off + 4, off + 4 + len)).map((b, i) => b ^ mask[i % 4]);
        buf = buf.subarray(off + 4 + len);
        if (op !== 1 || st.frozen) continue; // 멈춘 뒤에는 아무것도 답하지 않는다(TCP는 열어 둔다)
        let msg; try { msg = JSON.parse(data.toString()); } catch { continue; }
        const [joinRef, ref, topic, event] = msg;
        if (event === 'phx_join' || event === 'heartbeat' || event === 'access_token') send([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: {} }]);
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ st, srv, port: srv.address().port })));
}

test('게이트웨이 클라이언트 옵션의 하트비트로 응답 없이 죽은 소켓을 15초 안에 안다(채널 CHANNEL_ERROR) — 기본 25초면 최대 50초', { timeout: 60_000 }, async () => {
  assert.ok(RT_HEARTBEAT_MS * 2 <= 15_000, `하트비트 ${RT_HEARTBEAT_MS}ms × 2가 종전 조회 주기 15초를 넘는다`);
  const { st, srv, port } = await phoenixServer();
  const client = createClient(`http://127.0.0.1:${port}`, 'anon-test', msgrClientOptions('test-access'));
  const events = [];
  try {
    const ch = client.channel('u:test', { config: { private: true } }).on('broadcast', { event: 'message' }, () => {});
    const joined = new Promise((r) => ch.subscribe((s) => { events.push([s, Date.now()]); if (s === 'SUBSCRIBED') r(); }));
    await joined;
    await new Promise((r) => setTimeout(r, RT_HEARTBEAT_MS + 500)); // 하트비트 한 번은 정상으로 오간다
    assert.equal(ch.state, 'joined');
    const frozenAt = Date.now(); st.frozen = true;
    const err = await new Promise((r) => { const iv = setInterval(() => { const e = events.find(([s, t]) => s === 'CHANNEL_ERROR' && t >= frozenAt); if (e) { clearInterval(iv); r(e); } }, 50); setTimeout(() => { clearInterval(iv); r(null); }, 40_000); });
    assert.ok(err, '40초 안에 끊김을 알지 못했다');
    const took = err[1] - frozenAt; console.log(`# 응답 없는 소켓 감지 ${took}ms(하트비트 ${RT_HEARTBEAT_MS}ms)`);
    assert.ok(took <= RT_HEARTBEAT_MS * 2 + 1_000 && took <= 16_000, `응답 없는 소켓을 아는 데 ${took}ms`);
  } finally {
    for (const s of st.sockets) s.destroy(); // 서버를 먼저 닫아 다시 연결 시도가 바로 거절되게(열린 채 두면 연결 대기로 프로세스가 남는다)
    srv.close();
    try { await client.removeAllChannels(); } catch { /* 무해 */ }
    try { await client.realtime.disconnect(); } catch { /* 무해 */ }
  }
});
