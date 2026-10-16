// msgr-bot 일시 중단판(supabase/functions/msgr-bot/paused.js) — 실제 연결 도구 코드를 이 응답(로컬 HTTP 서버)에 붙여 가상 1시간 동안 요청 수를 센다.
// 잠그는 것: ① 응답 모양(UA별) ② Hermes(Python-urllib)는 받기 중이든 새로 켜든 요청 1번에 멈춘다 ③ OpenClaw(node)는 getMe를 지나 받기에서 1시간씩 쉰다
//   ④ 메신저가 다시 열리면 OpenClaw는 1시간 안에 스스로 다시 붙고, Hermes는 멈춘 채라 다시 시작해야 한다(PR 본문)
// 옛 버전(Hermes 0.1.0~0.3.7·OpenClaw 0.1.0~0.3.4)은 git 이력이 필요해 이 파일 밖에서 쟀다(PR 본문 표).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pausedReply, PAUSED_RETRY_S } from '../supabase/functions/msgr-bot/paused.js';
import { makeApi, pollLoop } from '../integrations/openclaw-argo-msgr/src/api.js';
import { RoutineMirror, ROUTINES_EVERY_MS } from '../integrations/openclaw-argo-msgr/src/contract.js';

const T = 'argo_bot_' + 'c'.repeat(48);
const log = [];
let mode = 'paused'; // 'normal' = 메신저 재개(원래 함수) 흉내 — 받기는 빈 목록
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  log.push({ path, ua: req.headers['user-agent'] ?? '' });
  const r = mode === 'normal'
    ? { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, result: path.endsWith('/getMe') ? { id: 1, is_bot: true, first_name: 'bot', org: { name: 'o' } } : [] }) }
    : pausedReply({ method: req.method, path, userAgent: req.headers['user-agent'] ?? '' });
  res.writeHead(r.status, r.headers); res.end(r.body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/msgr-bot`;
const home = mkdtempSync(join(tmpdir(), 'argo-paused-home-'));
after(() => { server.close(); rmSync(home, { recursive: true, force: true }); });

test('① 응답 — node는 getMe·미러 보고 200·나머지 429, 그 밖은 401, 모두 retry_after 3600·Retry-After·사유 "Argo Messenger is paused", 연결 스크립트는 410, DB·외부 호출 없음', async () => {
  const body = (r) => JSON.parse(r.body);
  const me = pausedReply({ path: '/msgr-bot/botX/getMe', userAgent: 'node' });
  assert.equal(me.status, 200); assert.equal(body(me).ok, true);
  for (const [ua, status] of [['node', 429], ['Python-urllib/3.14', 401], ['Python-urllib/3.13', 401], ['python-httpx/0.28.1', 401], ['', 401]]) {
    for (const m of ['getUpdates', 'sendMessage', 'getFile']) { // 미러 보고(reportStatus·setRoutines)는 아래 따로
      if (ua === 'node' && m === 'getMe') continue;
      const r = pausedReply({ method: 'POST', path: `/msgr-bot/bot${T}/${m}`, userAgent: ua });
      assert.equal(r.status, status, `${ua} ${m}`);
      assert.deepEqual({ ...body(r), description: undefined }, { ok: false, error_code: status, description: undefined, parameters: { retry_after: PAUSED_RETRY_S } });
      assert.match(body(r).description, /Argo Messenger is paused/);
      assert.equal(r.headers['Retry-After'], '3600');
    }
  }
  for (const m of ['reportStatus', 'setRoutines']) { // OpenClaw 미러 보고는 받았다고만(저장 안 함) — 그 밖의 UA는 401 그대로
    const r = pausedReply({ method: 'POST', path: `/msgr-bot/bot${T}/${m}`, userAgent: 'node' });
    assert.equal(r.status, 200, m); assert.deepEqual(body(r), { ok: true, result: {} });
    assert.equal(pausedReply({ method: 'POST', path: `/msgr-bot/bot${T}/${m}`, userAgent: 'Python-urllib/3.13' }).status, 401);
  }
  for (const m of ['routineEditDone', 'getUpdates', 'sendMessage', 'requestApproval']) assert.equal(pausedReply({ method: 'POST', path: `/msgr-bot/bot${T}/${m}`, userAgent: 'node' }).status, 429, m);
  assert.equal(pausedReply({ path: '/msgr-bot/connect', userAgent: 'curl/8' }).status, 410);
  assert.equal(pausedReply({ method: 'POST', path: '/msgr-bot/link/report', userAgent: 'Python-urllib/3.12' }).status, 410);
  const src = (await import('node:fs')).readFileSync(fileURLToPath(new URL('../supabase/functions/msgr-bot/paused.js', import.meta.url)), 'utf8')
    + (await import('node:fs')).readFileSync(fileURLToPath(new URL('../supabase/functions/msgr-bot/index.ts', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /\bfetch\(|createClient|rpc\(|SUPABASE_|Deno\.env/, '대체 함수는 DB·외부 호출·비밀값을 쓰지 않는다');
});

// Hermes 어댑터(현재판)를 python3로 실제로 불러 이 서버에 붙인다 — asyncio.sleep은 가상 시계(1시간 넘으면 끝)
const hermes = (scenario) => {
  const script = String.raw`
import asyncio, importlib.util, sys, types, json
for name in ['gateway', 'gateway.config', 'gateway.platforms', 'gateway.platforms.base']:
    sys.modules[name] = types.ModuleType(name)
sys.modules['gateway.config'].Platform = str
class Box:
    def __init__(self, **kw): self.__dict__.update(kw)
class Base:
    def __init__(self, *a, **kw): pass
b = sys.modules['gateway.platforms.base']
b.BasePlatformAdapter = Base; b.MessageEvent = b.SendResult = Box; b.MessageType = Box(TEXT='text')
spec = importlib.util.spec_from_file_location('argo_adapter', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
clock = [0.0]
real_sleep = asyncio.sleep
async def fake_sleep(s):
    clock[0] += float(s)
    if clock[0] >= 3600: raise asyncio.CancelledError()
    await real_sleep(0)
m.asyncio.sleep = fake_sleep
a = m.ArgoMsgrAdapter(Box(extra={'url': sys.argv[2], 'token': sys.argv[3]}))
a.base_url, a.token = sys.argv[2], sys.argv[3]
fatal = []
a._set_fatal_error = lambda *x, **k: fatal.append([x[0], k.get('retryable')])
a._mark_disconnected = lambda: None
a._mark_connected = lambda: None
async def main():
    if sys.argv[4] == 'connect':
        ok = await a.connect()
        return {'connected': ok}
    a._running = True; a._offset = 0
    try: await a._poll_loop()
    except asyncio.CancelledError: pass
    return {'running': a._running}
r = asyncio.run(main())
r.update({'fatal': fatal, 'virtual_s': clock[0]})
print(json.dumps(r))
`;
  return new Promise((resolve, reject) => {
    const p = spawn('python3', ['-c', script, fileURLToPath(new URL('../integrations/hermes-argo-msgr/adapter.py', import.meta.url)), BASE, T, scenario], { env: { PATH: process.env.PATH, HOME: home } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop())) : reject(new Error(err))));
  });
};

test('② Hermes(현재판) — 받기 중이면 요청 1번에 멈추고(다시 부르지 않음), 새로 켜면 getMe 1번에 재시도하지 않는 오류로 끝난다', async () => {
  assert.equal(spawnSync('python3', ['--version']).status, 0, 'python3 필요');
  mode = 'paused'; log.length = 0;
  const running = await hermes('poll');
  assert.equal(running.running, false, '받기 루프가 스스로 멈춘다');
  assert.deepEqual(running.fatal, [['auth', false]], '재시도하지 않는 인증 오류');
  assert.equal(log.length, 1, `가상 1시간 요청 ${log.length}번`);
  assert.match(log[0].ua, /^Python-urllib\//, 'Hermes는 Python-urllib으로 부른다(맥 one이 본 UA와 같다)');
  log.length = 0;
  const fresh = await hermes('connect');
  assert.equal(fresh.connected, false);
  assert.deepEqual(fresh.fatal, [['auth', false]]);
  assert.deepEqual(log.map((x) => x.path.split('/').pop()), ['getMe'], '새로 켜면 getMe 한 번뿐');
});

test('③ ④ OpenClaw(현재판) — getMe를 지나 받기에서 1시간씩 쉰다(가상 1시간 요청 2번 이하), 메신저가 다시 열리면 1시간 안에 스스로 받기를 잇는다', async () => {
  mode = 'paused'; log.length = 0;
  let clock = 0; const ac = new AbortController(); let resumedAt = null; let firstOkAfterResume = null;
  const api = makeApi({ url: BASE, token: T });
  const me = await api.getMe();
  assert.match(me.first_name, /paused/);
  const sleep = async (ms) => { clock += ms; if (clock >= 3600_000 && mode === 'paused') { mode = 'normal'; resumedAt = clock; } if (clock >= 3 * 3600_000) ac.abort(); };
  const wrapped = { ...api, getUpdates: async (o, l) => { const r = await api.getUpdates(o, l); if (mode === 'normal' && firstOkAfterResume === null) { firstOkAfterResume = clock; ac.abort(); } return r; } };
  await pollLoop(wrapped, { onMessage: () => {}, log: () => {}, signal: ac.signal, sleep });
  const pausedCalls = log.filter((x) => x.path.endsWith('/getUpdates')).length;
  assert.ok(log.every((x) => x.ua === 'node'), `UA ${[...new Set(log.map((x) => x.ua))]}`);
  assert.equal(log[0].path.split('/').pop(), 'getMe');
  assert.ok(pausedCalls <= 3, `받기 요청 ${pausedCalls}번(첫 1시간 1번 + 재개 뒤 1번)`);
  assert.equal(resumedAt, 3600_000);
  assert.ok(firstOkAfterResume !== null && firstOkAfterResume - resumedAt <= 3600_000, `재개 뒤 ${(firstOkAfterResume - resumedAt) / 1000}초 안에 다시 받는다`);
});

test('⑤ OpenClaw(현재판) 미러 루프 포함 가상 1시간 — getMe·받기·reportStatus·setRoutines 합계 한 자리(미러 보고는 처음 한 번, 1시간마다 재확인)', async () => {
  mode = 'paused'; log.length = 0;
  const api = makeApi({ url: BASE, token: T });
  await api.getMe();
  // 받기 루프 — 자기 가상 시계로 1시간(③과 같다)
  let pclock = 0; const ac = new AbortController();
  await pollLoop(api, { onMessage: () => {}, log: () => {}, signal: ac.signal, sleep: async (ms) => { pclock += ms; if (pclock >= 3600_000) ac.abort(); } });
  let clock = 0;
  // channel.ts startAccount의 mirrorLoop와 같은 순서·주기 — report → 3초 → (report → sync → 60초) 반복. 예약 작업은 비어 있는 계정
  const mirror = new RoutineMirror({ api, cronAccess: async () => ({ state: 'ready', cron: { list: async () => [] } }), accountId: 'default',
    stateFile: join(home, `routines-${Date.now()}.json`), version: () => '0.3.5', approvalMode: () => 'manual', now: () => clock, log: () => {} });
  const report = async () => { try { await mirror.reportStatus(); } catch { /* channel.ts와 같이 로그만 */ } };
  await report(); clock += 3_000;
  while (clock < 3600_000) {
    await report();
    try { await mirror.sync(); } catch { /* 같음 */ }
    clock += ROUTINES_EVERY_MS;
  }
  const by = {}; for (const x of log) { const k = x.path.split('/').pop(); by[k] = (by[k] ?? 0) + 1; }
  assert.ok(log.length <= 9, `가상 1시간 ${log.length}번 ${JSON.stringify(by)}`);
  assert.ok((by.reportStatus ?? 0) <= 2 && (by.setRoutines ?? 0) <= 2, JSON.stringify(by));
});

