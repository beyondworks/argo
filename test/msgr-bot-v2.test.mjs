// msgr-bot v2 갈래(supabase/functions/msgr-bot/v2.js) — 토큰 접두 라우팅·v2 봇 처리기. DB 판정은 test/msgr2-server-links-pg.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routeOf, handleV2, isV2Token, linkRpcV2, V2_POLL_MS } from '../supabase/functions/msgr-bot/v2.js';
import { parseRequest, createRejectMemory } from '../supabase/functions/msgr-bot/core.js';

const V2 = `argo_bot_v2${'ab'.repeat(24)}`;
const V1 = `argo_bot_${'ab'.repeat(24)}`;
const W = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';

// 가상 시계 + 호출 기록
function harness(answers = {}) {
  const calls = []; let t = 0;
  const rpc = async (fn, args) => {
    calls.push({ fn, args });
    const a = answers[fn];
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a(args, calls.length) : a;
  };
  return { calls, rpc, opts: { now: () => t, sleep: async (ms) => { t += ms; } }, elapsed: () => t };
}

test('라우팅: v2 토큰만 v2, 옛 v1 토큰·토큰 없음은 중단 응답(DB 0), 스크립트·보고 경로는 따로', () => {
  const r = (method, path, headers = {}) => routeOf({ method, path, token: parseRequest(`https://x.supabase.co${path}`, headers, null).token });
  assert.equal(r('GET', `/functions/v1/msgr-bot/bot${V2}/getUpdates`), 'v2');
  assert.equal(r('POST', '/functions/v1/msgr-bot/sendMessage', { authorization: `Bearer ${V2}` }), 'v2');
  assert.equal(r('GET', `/functions/v1/msgr-bot/bot${V1}/getUpdates`), 'paused', '옛 v1 토큰');
  assert.equal(r('GET', `/functions/v1/msgr-bot/bot${V2}x/getMe`), 'paused', '모양이 다르면 v2가 아니다');
  assert.equal(r('GET', '/functions/v1/msgr-bot/getMe'), 'paused');
  assert.equal(r('GET', '/functions/v1/msgr-bot/connect'), 'connect');
  assert.equal(r('POST', '/functions/v1/msgr-bot/connect'), 'paused', '스크립트는 GET만');
  assert.equal(r('POST', '/functions/v1/msgr-bot/link/report'), 'link');
  assert.equal(isV2Token(V1), false);
  // index.ts: 중단 갈래가 본문 읽기·RPC보다 먼저다(옛 도구 요청에 DB·본문 처리 0)
  const src = readFileSync(new URL('../supabase/functions/msgr-bot/index.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('Deno.serve'));
  assert.ok(body.indexOf("route === 'paused'") < body.indexOf('req.json()') && body.indexOf("route === 'paused'") < body.indexOf('handleV2('), '중단 갈래가 맨 앞');
});

test('/link: v1 처리기(handleLink)가 부르는 RPC 이름을 v2로 바꾼다', async () => {
  const seen = [];
  const rpc = linkRpcV2(async (fn) => { seen.push(fn); return null; });
  await rpc('msgr_server_link_report', {}); await rpc('msgr_server_link_status', {}); await rpc('msgr_server_link_done', {});
  assert.deepEqual(seen, ['msgr2_server_link_report', 'msgr2_server_link_status', 'msgr2_server_link_done']);
});

test('getMe·지원 안 하는 메서드·미러 보고', async () => {
  const h = harness({ msgr2_bot_me: { bot_id: 'b', agent_id: 'a', name: 'Hermes', kind: 'hermes', status: 'active' } });
  const me = await handleV2({ token: V2, method: 'getMe' }, h.rpc, h.opts);
  assert.equal(me.status, 200); assert.equal(me.body.result.first_name, 'Hermes'); assert.equal(me.body.result.is_bot, true);
  assert.deepEqual(h.calls[0], { fn: 'msgr2_bot_me', args: { p_token: V2 } });
  for (const m of ['reportStatus', 'setRoutines']) assert.deepEqual((await handleV2({ token: V2, method: m }, h.rpc, h.opts)).body, { ok: true, result: {} });
  for (const m of ['requestApproval', 'getFile', 'createUpload', 'attachFile', 'routineEditDone']) assert.equal((await handleV2({ token: V2, method: m }, h.rpc, h.opts)).status, 400, m);
  assert.equal(h.calls.length, 1, '받기만 하는 메서드·지원 안 하는 메서드는 DB를 부르지 않는다');
});

test('getUpdates 롱폴: 대기 시작 1회 + 5초 간격, 최대 50초 — 빈 50초 대기 RPC 11회, 글이 오면 바로', async () => {
  const idle = harness({ msgr2_bot_updates: [] });
  const r = await handleV2({ token: V2, method: 'getUpdates', params: { timeout: '50', offset: '0' } }, idle.rpc, idle.opts);
  assert.deepEqual(r.body, { ok: true, result: [] });
  assert.equal(idle.calls.length, 11); assert.equal(idle.elapsed(), 50_000);
  assert.deepEqual(idle.calls[0].args, { p_token: V2, p_after: 0, p_lim: 1 });
  const capped = harness({ msgr2_bot_updates: [] });
  await handleV2({ token: V2, method: 'getUpdates', params: { timeout: '600' } }, capped.rpc, capped.opts);
  assert.equal(capped.elapsed(), 50_000, '50초 상한');
  const up = { update_id: 42, message: { message_id: 42, execution_attempt: W, chat: { id: ROOM, kind: 'dm' }, text: 'hi' } };
  const busy = harness({ msgr2_bot_updates: (_a, n) => (n === 3 ? [up] : []) });
  const got = await handleV2({ token: V2, method: 'getUpdates', params: { timeout: '50', offset: '42' } }, busy.rpc, busy.opts);
  assert.deepEqual(got.body.result, [up]); assert.equal(busy.elapsed(), 2 * V2_POLL_MS);
  assert.equal(busy.calls[0].args.p_after, 41, 'offset = 마지막 update_id + 1(ack)');
});

test('거부: 무효 토큰 401(retry_after) — 3번 연달아면 이 인스턴스는 DB 없이 거절, 무료 주인 403', async () => {
  const rejects = createRejectMemory({ now: () => 0 });
  const h = harness({ msgr2_bot_updates: new Error('msgr_bot_unauthorized') });
  for (let i = 0; i < 3; i++) { const r = await handleV2({ token: V2, method: 'getUpdates', params: { timeout: '0' } }, h.rpc, { ...h.opts, rejects }); assert.equal(r.status, 401); assert.ok(r.body.parameters.retry_after > 0); }
  const n = h.calls.length;
  assert.equal((await handleV2({ token: V2, method: 'getUpdates', params: { timeout: '0' } }, h.rpc, { ...h.opts, rejects })).status, 401);
  assert.equal(h.calls.length, n, '기억한 거부는 DB를 부르지 않는다');
  const p = harness({ msgr2_bot_updates: new Error('msgr_bot_plan_required') });
  const pr = await handleV2({ token: V2, method: 'getUpdates', params: { timeout: '0' } }, p.rpc, p.opts);
  assert.equal(pr.status, 403); assert.equal(pr.body.parameters.retry_after, 300);
  assert.equal((await handleV2({ token: V1, method: 'getMe' }, p.rpc, p.opts)).status, 401, '접두가 아니면 DB 없이 401');
  const gone = harness({ msgr2_bot_updates: new Error('Could not find the function public.msgr2_bot_updates(p_after, p_lim, p_token) in the schema cache') });
  assert.equal((await handleV2({ token: V2, method: 'getUpdates', params: { timeout: '0' } }, gone.rpc, gone.opts)).status, 401, 'DB가 되돌려져 함수가 없으면 401(Hermes가 멈춘다)');
});

test('sendMessage: execution_attempt면 최종 답(표지 떼기), 없으면 보충 글, 잘못된 값은 DB 전에 거절', async () => {
  const h = harness({ msgr2_bot_finish: 101, msgr2_bot_send: 102 });
  const fin = await handleV2({ token: V2, method: 'sendMessage', params: { chat_id: ROOM, text: '끝났습니다.\nMSGR: done', reply_to_message_id: 42, execution_attempt: W, disposition: 'done' } }, h.rpc, h.opts);
  assert.equal(fin.status, 200); assert.equal(fin.body.result.message_id, 101);
  assert.deepEqual(h.calls[0], { fn: 'msgr2_bot_finish', args: { p_token: V2, p_attempt: W, p_text: '끝났습니다.' } });
  const sent = await handleV2({ token: V2, method: 'sendMessage', params: { chat_id: ROOM, text: '파일 주소' } }, h.rpc, h.opts);
  assert.equal(sent.body.result.message_id, 102);
  assert.deepEqual(h.calls[1], { fn: 'msgr2_bot_send', args: { p_token: V2, p_room: ROOM, p_text: '파일 주소' } });
  assert.equal((await handleV2({ token: V2, method: 'sendMessage', params: { chat_id: ROOM, text: 'x', execution_attempt: 'nope' } }, h.rpc, h.opts)).status, 400);
  assert.equal((await handleV2({ token: V2, method: 'sendMessage', params: { chat_id: 'general', text: 'x' } }, h.rpc, h.opts)).status, 400);
  assert.equal(h.calls.length, 2);
  for (const [name, code] of [['msgr_execution_not_owner', 409], ['msgr_execution_forbidden', 403], ['msgr_bot_bad_body', 400], ['msgr_bot_not_member', 403], ['service_paused', 503]]) {
    const e = harness({ msgr2_bot_finish: new Error(`${name}`) });
    assert.equal((await handleV2({ token: V2, method: 'sendMessage', params: { chat_id: ROOM, text: 'x', execution_attempt: W } }, e.rpc, e.opts)).status, code, name);
  }
  assert.equal((await handleV2({ token: V2, method: 'sendChatAction', params: { chat_id: ROOM, action: 'typing' } }, h.rpc, h.opts)).status, 200);
  assert.equal(h.calls.length, 2, '타이핑은 DB를 부르지 않는다');
});

// 실제 Hermes 어댑터(integrations/hermes-argo-msgr/adapter.py)를 python3로 띄워 v2 처리기에 붙인다 — 받은 글에 답하면 그 답이 msgr2_bot_finish로 간다.
// 게이트웨이(Hermes 본체)는 대역: handle_message가 받은 글에 바로 답을 보낸다. DB는 일 하나짜리 상태 기계.
test('실제 Hermes 어댑터 왕복: getMe → getUpdates로 일 받기 → 최종 답이 execution_attempt와 함께 finish로, 같은 일은 한 번만', async () => {
  const { spawn, spawnSync } = await import('node:child_process');
  const { createServer } = await import('node:http');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  assert.equal(spawnSync('python3', ['--version']).status, 0, 'python3 필요');
  const work = { id: W, room: ROOM, src: 42, state: 'offered', text: '안녕 헤르메스' };
  const finished = []; const seen = [];
  const rpc = async (fn, a) => {
    seen.push(fn);
    if (a.p_token !== V2) throw new Error('msgr_bot_unauthorized');
    if (fn === 'msgr2_bot_me') return { bot_id: 'b1', agent_id: 'a1', name: 'Hermes', kind: 'hermes', status: 'active' };
    if (fn === 'msgr2_bot_updates') {
      if (work.state === 'offered' || (work.state === 'accepted' && work.src > a.p_after)) {
        work.state = 'accepted';
        return [{ update_id: work.src, message: { message_id: work.src, execution_attempt: work.id, text: work.text, date: 1, chat: { id: work.room, name: '', kind: 'dm' }, from: { id: 'u1', name: '' } } }];
      }
      return [];
    }
    if (fn === 'msgr2_bot_finish') { if (a.p_attempt !== work.id || work.state === 'done') { if (work.state === 'done') return 900; throw new Error('msgr_execution_not_owner'); } finished.push(a); work.state = 'done'; return 900; }
    throw new Error(`unexpected ${fn}`);
  };
  const srv = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    const parsed = parseRequest(`http://x${req.url}`, req.headers, body);
    const route = routeOf({ method: req.method, path: new URL(`http://x${req.url}`).pathname, token: parsed.token });
    const out = route === 'v2' ? await handleV2(parsed, rpc, { maxWaitMs: 300 }) : { status: 418, body: { ok: false } };
    res.writeHead(out.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out.body));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/functions/v1/msgr-bot`;
  const home = mkdtempSync(join(tmpdir(), 'argo-hermes-v2-'));
  const script = String.raw`
import asyncio, importlib.util, sys, types, json
for name in ['gateway', 'gateway.config', 'gateway.platforms', 'gateway.platforms.base']:
    sys.modules[name] = types.ModuleType(name)
sys.modules['gateway.config'].Platform = str
class Box:
    def __init__(self, **kw): self.__dict__.update(kw)
class Base:
    def __init__(self, *a, **kw): self._message_handler = True
    def build_source(self, **kw): return Box(**kw)
b = sys.modules['gateway.platforms.base']
b.BasePlatformAdapter = Base; b.MessageEvent = b.SendResult = Box; b.MessageType = Box(TEXT='text')
spec = importlib.util.spec_from_file_location('argo_adapter', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
a = m.ArgoMsgrAdapter(Box(extra={'url': sys.argv[2], 'token': sys.argv[3]}))
a._set_fatal_error = lambda *x, **k: None
a._mark_disconnected = lambda: None
a._mark_connected = lambda: None
answered = []
async def hm(ev):
    r = await a.send(ev.source.chat_id, '반갑습니다\nMSGR: done', metadata={'notify': True})
    answered.append(bool(getattr(r, 'success', False)))
a.handle_message = hm
async def main():
    ok = await a.connect()
    for _ in range(200):
        if answered: break
        await asyncio.sleep(0.05)
    await asyncio.sleep(0.8)
    await a.disconnect()
    return {'connected': ok, 'answered': answered}
print(json.dumps(asyncio.run(main())))
`;
  try {
    const out = await new Promise((resolve, reject) => {
      const p = spawn('python3', ['-c', script, fileURLToPath(new URL('../integrations/hermes-argo-msgr/adapter.py', import.meta.url)), base, V2], { env: { PATH: process.env.PATH, HOME: home } });
      let so = '', se = ''; p.stdout.on('data', (d) => { so += d; }); p.stderr.on('data', (d) => { se += d; });
      p.on('close', (c) => (c === 0 ? resolve(JSON.parse(so.trim().split('\n').pop())) : reject(new Error(se.slice(-2000)))));
    });
    assert.equal(out.connected, true);
    assert.deepEqual(out.answered, [true]);
    assert.equal(finished.length, 1, '최종 답은 한 번');
    assert.deepEqual(finished[0], { p_token: V2, p_attempt: W, p_text: '반갑습니다' }, '표지를 뗀 답이 받은 일의 execution_attempt로');
    assert.equal(seen[0], 'msgr2_bot_me');
    assert.ok(!seen.includes('msgr2_bot_send'), '최종 답이 보통 글로 새지 않는다');
  } finally { srv.close(); rmSync(home, { recursive: true, force: true }); }
});
