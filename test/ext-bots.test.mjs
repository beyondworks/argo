// 외부 봇 호출기(src/ext-bots.mjs) — 헤르메스·오픈클로 설치본이 없어 127.0.0.1의 가짜 HTTP 서버로 시험한다(실호출 미검증).
// 경우 표(PR 본문)의 봇 칸: 정상(종류별 요청 모양)·꺼짐·키 없음·429·공개 주소 거절·속도·연쇄 상한·키 비노출·리다이렉트 안 따라감.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-extbot-'));
const bots = await import('../src/ext-bots.mjs');
const { paths } = await import('../src/workspace.mjs');
const { saveBot, listBots, callBot, checkBotUrl, isAllowedBotIp, guardedLookup, newBotBudget, _resetBotGates, BOT_LIMITS, workErrorCodeFor } = bots;
const KEY = 'sk-test-ext-bot-key-0001';

/** 가짜 봇 서버 — handler(req, body) → {status, headers, json}. 받은 요청과 동시 진행 최댓값을 기록한다. */
async function fakeBot(handler) {
  const st = { reqs: [], inflight: 0, max: 0 };
  const srv = http.createServer(async (req, res) => {
    st.inflight += 1; st.max = Math.max(st.max, st.inflight);
    let raw = ''; for await (const c of req) raw += c;
    const rec = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
    st.reqs.push(rec);
    try {
      const r = await handler(rec, st);
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...(r.headers ?? {}) });
      res.end(JSON.stringify(r.json ?? {}));
    } finally { st.inflight -= 1; }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  st.url = `http://127.0.0.1:${srv.address().port}`;
  st.close = () => new Promise((r) => srv.close(r));
  return st;
}
const hermesOk = (text = '헤르메스 답') => ({ json: { id: 'r1', object: 'response', status: 'completed', output: [{ type: 'function_call' }, { type: 'message', content: [{ type: 'output_text', text }] }] } });
const clawOk = (text = '오픈클로 답') => ({ json: { choices: [{ message: { role: 'assistant', content: text } }] } });
let n = 0;
async function ws() { const id = `eb-${++n}`; await mkdir(paths(id).root, { recursive: true }); return id; }
beforeEach(() => _resetBotGates());

test('헤르메스 정상 — POST /v1/responses, Bearer 키, X-Hermes-Session-Id, input 본문, output_text를 꺼낸다', async () => {
  const srv = await fakeBot(() => hermesOk());
  try {
    const w = await ws();
    await saveBot(w, { id: 'hermes', kind: 'hermes', name: '헤르메스', url: srv.url, key: KEY });
    const r = await callBot({ ws: w, id: 'hermes' }, { text: '사용자: 안녕', sessionId: 'room1:hermes' });
    assert.equal(r.text, '헤르메스 답');
    const q = srv.reqs[0];
    assert.equal(q.method, 'POST'); assert.equal(q.url, '/v1/responses');
    assert.equal(q.headers.authorization, `Bearer ${KEY}`);
    assert.equal(q.headers['x-hermes-session-id'], 'room1:hermes');
    assert.deepEqual(q.body, { model: 'hermes-agent', input: '사용자: 안녕' });
  } finally { await srv.close(); }
});

test('오픈클로 정상 — POST /v1/chat/completions, model openclaw, x-openclaw-session-key, choices[0].message.content', async () => {
  const srv = await fakeBot(() => clawOk());
  try {
    const w = await ws();
    await saveBot(w, { id: 'claw', kind: 'openclaw', url: srv.url, key: KEY });
    const r = await callBot({ ws: w, id: 'claw' }, { text: '질문', sessionId: 's1' });
    assert.equal(r.text, '오픈클로 답');
    const q = srv.reqs[0];
    assert.equal(q.url, '/v1/chat/completions');
    assert.equal(q.headers['x-openclaw-session-key'], 's1');
    assert.deepEqual(q.body, { model: 'openclaw', messages: [{ role: 'user', content: '질문' }] });
  } finally { await srv.close(); }
});

test('봇 꺼짐 — 듣는 프로세스가 없으면 bot_unreachable, 사용 안 함으로 두면 요청 없이 bot_off', async () => {
  const srv = await fakeBot(() => hermesOk());
  const url = srv.url; await srv.close(); // 닫힌 포트 = 봇 프로세스 꺼짐
  const w = await ws();
  await saveBot(w, { id: 'h', kind: 'hermes', url, key: KEY });
  await assert.rejects(callBot({ ws: w, id: 'h' }, { text: 'x' }), { code: 'bot_unreachable' });
  const srv2 = await fakeBot(() => hermesOk());
  try {
    await saveBot(w, { id: 'h2', kind: 'hermes', url: srv2.url, key: KEY, enabled: false });
    await assert.rejects(callBot({ ws: w, id: 'h2' }, { text: 'x' }), { code: 'bot_off' });
    assert.equal(srv2.reqs.length, 0);
  } finally { await srv2.close(); }
});

test('키 없음 — 요청 없이 no_key, 없는 봇은 bot_missing', async () => {
  const srv = await fakeBot(() => hermesOk());
  try {
    const w = await ws();
    await saveBot(w, { id: 'h', kind: 'hermes', url: srv.url });
    await assert.rejects(callBot({ ws: w, id: 'h' }, { text: 'x' }), { code: 'no_key' });
    await assert.rejects(callBot({ ws: w, id: 'nope' }, { text: 'x' }), { code: 'bot_missing' });
    assert.equal(srv.reqs.length, 0);
  } finally { await srv.close(); }
});

test('429 — Retry-After를 지키고 1번만 다시 부른다(성공), 두 번째도 429면 bot_rate_limited(요청 정확히 2번)', async () => {
  let k = 0;
  const srv = await fakeBot(() => (++k === 1 ? { status: 429, headers: { 'retry-after': '0' }, json: { error: 'Too many concurrent runs (max 10)' } } : hermesOk('재시도 성공')));
  try {
    const w = await ws();
    await saveBot(w, { id: 'h', kind: 'hermes', url: srv.url, key: KEY });
    assert.equal((await callBot({ ws: w, id: 'h' }, { text: 'x' })).text, '재시도 성공');
    assert.equal(srv.reqs.length, 2);
  } finally { await srv.close(); }
  const srv2 = await fakeBot(() => ({ status: 429, headers: { 'retry-after': '0' } }));
  try {
    const w = await ws();
    await saveBot(w, { id: 'h', kind: 'hermes', url: srv2.url, key: KEY });
    await assert.rejects(callBot({ ws: w, id: 'h' }, { text: 'x' }), { code: 'bot_rate_limited' });
    assert.equal(srv2.reqs.length, 2, '재시도는 1번뿐 — 429 폭주에 요청을 쌓지 않는다');
  } finally { await srv2.close(); }
});

test('공개 주소 거절 — 저장 단계(공인·사설 IP·일반 도메인), 호출 단계(파일을 손으로 고친 경우), 이름 풀이가 공개 IP를 주는 경우', async () => {
  const w = await ws();
  for (const url of ['http://8.8.8.8:8642', 'http://192.168.0.10:8642', 'http://10.0.0.5:18789', 'https://bot.example.com', 'http://[2001:4860::8888]:1']) {
    await assert.rejects(saveBot(w, { id: 'x', kind: 'hermes', url, key: KEY }), { code: 'public_address' }, url);
  }
  await assert.rejects(saveBot(w, { id: 'x', kind: 'hermes', url: 'file:///etc/passwd' }), { code: 'bad_url' });
  await assert.rejects(saveBot(w, { id: 'x', kind: 'hermes', url: 'http://u:p@127.0.0.1:1' }), { code: 'bad_url' });
  // 파일을 손으로 고쳐 공개 주소를 넣어도 호출 전에 다시 본다
  const f = join(paths(w).root, '.connector-secrets.json');
  await writeFile(f, JSON.stringify({ extBots: { evil: { kind: 'openclaw', url: 'http://1.1.1.1:18789', key: KEY } } }));
  await assert.rejects(callBot({ ws: w, id: 'evil' }, { text: 'x' }), { code: 'public_address' });
  // *.ts.net 이름이라도 연결 직전 풀이 결과가 공개 IP면 막는다(검사와 연결 사이 DNS 바뀜 포함 — 연결이 이 lookup을 쓴다)
  const pub = guardedLookup((h, o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]));
  await assert.rejects(new Promise((res, rej) => pub('evil.tail1234.ts.net', {}, (e, a) => (e ? rej(e) : res(a)))), { code: 'public_address' });
  const ok = guardedLookup((h, o, cb) => cb(null, [{ address: '100.101.102.103', family: 4 }]));
  assert.equal(await new Promise((res, rej) => ok('pc.tail1234.ts.net', {}, (e, a) => (e ? rej(e) : res(a)))), '100.101.102.103');
});

test('허용 IP 표 — 루프백·Tailscale만', () => {
  const yes = ['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1', '100.64.0.1', '100.127.255.254', 'fd7a:115c:a1e0::1'];
  const no = ['0.0.0.0', '8.8.8.8', '10.0.0.1', '172.16.0.1', '192.168.1.1', '100.63.255.255', '100.128.0.0', '169.254.1.1', '::', 'fe80::1', 'fd00::1', '::ffff:8.8.8.8', '2001:db8::1', 'not-ip'];
  for (const ip of yes) assert.equal(isAllowedBotIp(ip), true, ip);
  for (const ip of no) assert.equal(isAllowedBotIp(ip), false, ip);
  assert.equal(checkBotUrl('http://localhost:8642').ok, true);
  assert.equal(checkBotUrl('https://my-pc.tail1234.ts.net').ok, true);
  assert.equal(checkBotUrl('http://[::1]:8642').ok, true);
});

test('속도 — 봇마다 동시 1(가짜 서버 동시 진행 최댓값 1), 분당 6회를 넘는 7번째는 요청 없이 rate_limited', async () => {
  const srv = await fakeBot(async () => { await new Promise((r) => setTimeout(r, 30)); return hermesOk(); });
  try {
    const w = await ws();
    await saveBot(w, { id: 'h', kind: 'hermes', url: srv.url, key: KEY });
    const calls = Array.from({ length: 7 }, () => callBot({ ws: w, id: 'h' }, { text: 'x' }));
    const out = await Promise.allSettled(calls);
    assert.equal(out.filter((o) => o.status === 'fulfilled').length, BOT_LIMITS.perMinute);
    assert.equal(out.filter((o) => o.status === 'rejected' && o.reason.code === 'rate_limited').length, 1);
    assert.equal(srv.reqs.length, 6);
    assert.equal(srv.max, 1, '봇마다 동시 1');
  } finally { await srv.close(); }
});

test('연쇄 상한 — 사람 글 1개당 봇 턴 4번까지(5번째 bot_turn_cap), hop 3은 bot_hop_cap. 둘 다 요청 없음', async () => {
  const srv = await fakeBot(() => clawOk());
  try {
    const w = await ws();
    for (const id of ['a', 'b', 'c']) await saveBot(w, { id, kind: 'openclaw', url: srv.url, key: KEY });
    const budget = newBotBudget();
    for (const id of ['a', 'b', 'c', 'a']) await callBot({ ws: w, id }, { text: 'x', budget });
    await assert.rejects(callBot({ ws: w, id: 'b' }, { text: 'x', budget }), { code: 'bot_turn_cap' });
    await assert.rejects(callBot({ ws: w, id: 'c' }, { text: 'x', budget: newBotBudget(), hop: 3 }), { code: 'bot_hop_cap' });
    assert.equal(srv.reqs.length, 4);
  } finally { await srv.close(); }
});

test('키 비노출 — 목록에는 hasKey만, 인증 실패 오류 글에도 키가 없다', async () => {
  const srv = await fakeBot(() => ({ status: 401, json: { error: `bad key ${KEY}` } }));
  try {
    const w = await ws();
    await saveBot(w, { id: 'h', kind: 'hermes', url: srv.url, key: KEY });
    const list = await listBots(w);
    assert.deepEqual(list, [{ id: 'h', kind: 'hermes', name: 'Hermes', url: srv.url, enabled: true, hasKey: true }]);
    assert.ok(!JSON.stringify(list).includes(KEY));
    const e = await callBot({ ws: w, id: 'h' }, { text: 'x' }).catch((x) => x);
    assert.equal(e.code, 'bot_auth');
    assert.ok(!String(e.message).includes(KEY) && !String(e.stack).includes(KEY));
  } finally { await srv.close(); }
});

test('리다이렉트는 따라가지 않는다 — 302는 bot_http, 요청 1번', async () => {
  const srv = await fakeBot(() => ({ status: 302, headers: { location: 'http://8.8.8.8/v1/responses' } }));
  try {
    const w = await ws();
    await saveBot(w, { id: 'h', kind: 'hermes', url: srv.url, key: KEY });
    await assert.rejects(callBot({ ws: w, id: 'h' }, { text: 'x' }), { code: 'bot_http' });
    assert.equal(srv.reqs.length, 1);
  } finally { await srv.close(); }
});

test('키 저장 자리 = 커넥터 자격 파일(.connector-secrets.json) — 동기화 제외 목록에 있다, 커넥터 기록과 같은 파일에서 서로 덮지 않는다', async () => {
  const { CONNECTOR_SECRETS_BASE } = await import('../src/connectors.mjs');
  assert.equal(bots.BOT_SECRETS_BASE, CONNECTOR_SECRETS_BASE);
  const sync = await readFile(new URL('../src/sync.mjs', import.meta.url), 'utf8');
  assert.match(sync, /base === '\.connector-secrets\.json' \|\|/, '동기화 제외(sync.mjs EXCLUDE)');
  const w = await ws();
  const f = join(paths(w).root, '.connector-secrets.json');
  await writeFile(f, JSON.stringify({ servers: { gmail: { status: 'connected' } } }));
  await saveBot(w, { id: 'h', kind: 'hermes', key: KEY });
  const s = JSON.parse(await readFile(f, 'utf8'));
  assert.deepEqual(s.servers, { gmail: { status: 'connected' } }, '커넥터 기록 보존');
  assert.equal(s.extBots.h.url, 'http://127.0.0.1:8642', '기본 주소');
});

test('localhost 이름 주소 — 연결 직전 풀이(가드)를 거쳐 실제로 붙는다', async () => {
  const srv = await fakeBot(() => hermesOk('로컬 이름'));
  try {
    const w = await ws();
    await saveBot(w, { id: 'h', kind: 'hermes', url: srv.url.replace('127.0.0.1', 'localhost'), key: KEY });
    assert.equal((await callBot({ ws: w, id: 'h' }, { text: 'x' })).text, '로컬 이름');
  } finally { await srv.close(); }
});

test('BOT_RATE(약속 v1.1 상수) — 동시 2번째는 앞 호출이 끝난 뒤 나가고(대기), 분당 7번째는 bot_limit, 429는 1회 재시도 뒤 실패(bot_limit)', async () => {
  const { BOT_RATE } = await import('../packages/agent-link/contract/v1.mjs');
  assert.deepEqual({ ...BOT_RATE }, { concurrent: 1, perMin: 6, retryOn429: 1 });
  assert.equal(BOT_LIMITS.perMinute, BOT_RATE.perMin); assert.equal(BOT_LIMITS.retry429, BOT_RATE.retryOn429); assert.equal(BOT_LIMITS.concurrent, BOT_RATE.concurrent);
  // 동시 2번째 대기 — 첫 요청이 끝나기 전에는 둘째 요청이 서버에 닿지 않는다
  let releaseFirst; const firstHeld = new Promise((r) => { releaseFirst = r; });
  // 답 번호는 요청이 도착한 순간의 순번으로(기다림 뒤에 세면 끝나는 시점에 따라 번호가 바뀐다 — 맥 CI 간헐 실패)
  const srv = await fakeBot(async (q, st) => { const n = st.reqs.length; if (n === 1) await firstHeld; return hermesOk(`답${n}`); });
  try {
    const w = await ws();
    await saveBot(w, { id: 'h', kind: 'hermes', url: srv.url, key: KEY });
    const a = callBot({ ws: w, id: 'h' }, { text: '1' });
    const b = callBot({ ws: w, id: 'h' }, { text: '2' });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(srv.reqs.length, 1, '둘째는 대기 중');
    releaseFirst();
    // 동시 두 호출 가운데 누가 먼저 나가는지는 약속이 아니다(각자 자격 파일을 읽은 뒤 줄에 선다) — 둘 다 답을 받고, 한 번에 하나만 나갔는지를 본다
    assert.deepEqual([(await a).text, (await b).text].sort(), ['답1', '답2']);
    assert.equal(srv.max, 1, "봇 서버에 동시에 닿은 요청은 1개");
    assert.equal(srv.reqs.length, 2);
    for (let i = 0; i < 4; i++) await callBot({ ws: w, id: 'h' }, { text: 'x' });
    const e = await callBot({ ws: w, id: 'h' }, { text: '7번째' }).catch((x) => x);
    assert.equal(e.code, 'rate_limited'); assert.equal(workErrorCodeFor(e.code), 'bot_limit');
    assert.equal(srv.reqs.length, 6);
  } finally { await srv.close(); }
  const srv2 = await fakeBot(() => ({ status: 429, headers: { 'retry-after': '0' } }));
  try {
    const w = await ws();
    await saveBot(w, { id: 'h', kind: 'hermes', url: srv2.url, key: KEY });
    const e = await callBot({ ws: w, id: 'h' }, { text: 'x' }).catch((x) => x);
    assert.equal(srv2.reqs.length, 1 + BOT_RATE.retryOn429);
    assert.equal(workErrorCodeFor(e.code), 'bot_limit');
  } finally { await srv2.close(); }
  for (const c of ['bot_unreachable', 'bot_off', 'no_key', 'public_address', 'bot_auth', 'bot_http', 'bot_empty', 'bot_missing']) assert.equal(workErrorCodeFor(c), 'bot_unreachable', c);
  for (const c of ['bot_turn_cap', 'bot_hop_cap', 'bot_rate_limited']) assert.equal(workErrorCodeFor(c), 'bot_limit', c);
});
