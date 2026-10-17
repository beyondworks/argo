// 본체 연결부(src/agent-link-host.mjs) — 가짜 서버(약속 v1 판정 그대로) + 가짜 chat()으로 주인 턴·등급 거부·첨부·답 파일·중단·일지·재동기화 간격을 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { createAgentLinkHost, agentLinkEnabled, legacyMsgrBridgeEnabled, contextSection, ATTACH_IN_MAX, RESYNC_MIN_MS } from '../src/agent-link-host.mjs';
import { createFakeServer } from '../packages/agent-link/test/fake-server.mjs';

const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const DEVICE = 'c4d5e6f7-8091-4a2b-9c3d-4e5f6a7b8c03';

async function setup({ chatImpl, regFails = false, plan, fetchImpl, agents = [{ ws: 'co-1', slug: 'pm', name: 'PM', role: '기획' }] } = {}) {
  let t = Date.parse('2026-10-17T06:00:00Z');
  const clock = { now: () => t, setTimeout: (fn, ms) => ({ fn, ms }), clearTimeout: () => {}, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
  const server = createFakeServer({ now: clock.now, uid: 'u1' });
  const rpc0 = server.transport.rpc;
  server.transport.rpc = async (name, args) => {
    if (name === 'msgr2_device_register') {
      server.log.push({ name, args });
      return regFails ? { data: null, error: { code: 'PGRST202', status: 404 } } : { data: { device_id: DEVICE }, error: null };
    }
    return rpc0(name, args);
  };
  const vault = await mkdtemp(join(tmpdir(), 'argo-link-host-'));
  const calls = { chat: [], interrupt: [], listed: 0, logs: [] };
  const host = createAgentLinkHost({
    getSession: async () => ({ client: {}, uid: 'u1' }),
    listOwnedAgents: async () => { calls.listed++; return agents; },
    chat: async (ws, slug, text, sid, opts) => { calls.chat.push({ ws, slug, text, sid, opts }); return chatImpl ? chatImpl(opts) : { reply: '초안입니다', costUsd: 0.01 }; },
    interruptTurn: async (ws, slug, o) => { calls.interrupt.push({ ws, slug, ...o }); },
    planReplyFiles: plan ?? (async (ws, reply) => ({ body: reply, files: [] })),
    readReplyFile: async () => new TextEncoder().encode('file-bytes'),
    vaultDir: () => vault,
    appVersion: '0.1.113',
    transportFor: () => server.transport,
    fetchImpl,
    clock,
    linkClock: clock, // 부품도 같은 가짜 시계(offer 만료 판정)
    log: (...a) => calls.logs.push(a.join(' ')),
  });
  host.start(); await flush();
  const agentId = server.agentIds.get('co-1/pm');
  return { server, host, calls, vault, agentId, clock };
}

test('플래그: ARGO_AGENT_LINK는 정확히 1일 때만 켬, 옛 브리지는 off일 때만 끔(기본 = 지금 그대로)', () => {
  assert.equal(agentLinkEnabled({}), false);
  assert.equal(agentLinkEnabled({ ARGO_AGENT_LINK: '1' }), true);
  assert.equal(agentLinkEnabled({ ARGO_AGENT_LINK: 'true' }), false);
  assert.equal(legacyMsgrBridgeEnabled({}), true);
  assert.equal(legacyMsgrBridgeEnabled({ ARGO_MSGR_LEGACY: ' OFF ' }), false);
  assert.equal(legacyMsgrBridgeEnabled({ ARGO_MSGR_LEGACY: '0' }), true);
});

test('시작: runner 기기 등록(약속 범위) → 에이전트 목록 보내기 → 대응표 → w:<uid> 따라잡기', async () => {
  const { server, host, agentId } = await setup();
  const reg = server.log.find((x) => x.name === 'msgr2_device_register');
  assert.deepEqual({ kind: reg.args.kind, min: reg.args.link_min, max: reg.args.link_max }, { kind: 'runner', min: 1, max: 1 });
  assert.equal(server.sentOf('agent.sync').length, 1);
  assert.ok(agentId);
  assert.deepEqual(host.agents.get(agentId), { ws: 'co-1', slug: 'pm' });
  assert.equal(server.rpcCount('msgr2_link_pending'), 1);
});

test('주인 offer: chat()을 그 에이전트로 부르고(방 문맥 + 지시, abortTag = 일 id) 결과를 보낸다', async () => {
  const { server, calls, agentId } = await setup();
  const o = server.offer({ agent: agentId, text: '회의 자료 초안' });
  o.data.context = [{ id: crypto.randomUUID(), author: { kind: 'user', id: crypto.randomUUID(), name: '유건' }, text: '지난 회의록 참고', at: o.at }];
  server.push(o); await flush();
  assert.equal(calls.chat.length, 1);
  const c = calls.chat[0];
  assert.equal(c.ws, 'co-1'); assert.equal(c.slug, 'pm'); assert.equal(c.sid, null);
  assert.match(c.text, /이 방의 최근 대화[\s\S]*유건: 지난 회의록 참고[\s\S]*회의 자료 초안$/);
  assert.equal(c.opts.abortTag, o.work);
  assert.equal(c.opts.source, 'messenger');
  assert.equal(c.opts.journal, undefined); // memory=true → chat() 기본 일지
  const res = server.sentOf('work.result', o.work)[0];
  assert.equal(res.data.text, '초안입니다');
  assert.deepEqual(res.data.usage, { cost_usd: 0.01 });
  assert.equal(server.works.get(o.work).state, 'done');
});

test('기억 안 남김 방(memory=false)은 journal.off로 부른다', async () => {
  const { server, calls, agentId } = await setup();
  server.push(server.offer({ agent: agentId, memory: false })); await flush();
  assert.deepEqual(calls.chat[0].opts.journal, { off: true });
});

test('team·guest 등급 offer는 chat()을 부르지 않고 work.error{tier_denied}', async () => {
  for (const tier of ['team', 'guest']) {
    const { server, calls, agentId } = await setup();
    const o = server.offer({ agent: agentId, tier });
    server.push(o); await flush();
    assert.equal(calls.chat.length, 0, tier);
    assert.equal(server.sentOf('work.error', o.work)[0]?.data.code, 'tier_denied', tier);
    assert.equal(server.works.get(o.work).state, 'failed', tier);
  }
});

test('대응표에 없는 에이전트(다른 기기·다른 계정의 에이전트) offer는 accept하지 않는다', async () => {
  const { server, calls } = await setup();
  server.push(server.offer({ agent: crypto.randomUUID() })); await flush();
  assert.equal(server.sentOf('work.accept').length, 0);
  assert.equal(calls.chat.length, 0);
});

test('기기 등록이 실패하면 링크를 열지 않는다(구독·요청 0, 나중에 다시)', async () => {
  const { server, host, calls } = await setup({ regFails: true });
  assert.equal(host.link, null);
  assert.equal(server.rpcCount('msgr2_link_pending'), 0);
  assert.equal(server.sentOf('agent.sync').length, 0);
  assert.ok(calls.logs.some((l) => /device register failed/.test(l)));
});

test('받은 첨부: 서명 URL에서 받아 vault/files/msgr2에 두고 chat()에 넘긴다, 25MB 넘는 것은 받지 않는다', async () => {
  const fetched = [];
  const fetchImpl = async (url) => { fetched.push(url); return { ok: true, arrayBuffer: async () => new TextEncoder().encode('PDFDATA').buffer }; };
  const { server, calls, agentId, vault } = await setup({ fetchImpl });
  const o = server.offer({ agent: agentId });
  o.data.attachments = [
    { id: crypto.randomUUID(), name: '../보고서 v1.pdf', mime: 'application/pdf', bytes: 7, url: 'https://x/sign/a', url_expires_at: o.data.expires_at },
    { id: crypto.randomUUID(), name: 'big.bin', mime: 'application/octet-stream', bytes: ATTACH_IN_MAX + 1, url: 'https://x/sign/b', url_expires_at: o.data.expires_at },
  ];
  server.push(o); await flush();
  assert.deepEqual(fetched, ['https://x/sign/a']);
  const att = calls.chat[0].opts.attachments;
  assert.equal(att.length, 1);
  assert.match(att[0].rel, /^files\/msgr2\/[0-9a-f]{8}-보고서_v1\.pdf$/); // 경로 조각을 지운 이름
  assert.equal(await readFile(join(vault, att[0].rel), 'utf8'), 'PDFDATA');
});

test('답 속 파일: 업로드 슬롯으로 올려 결과 files에 싣는다(본문은 경로를 지운 것)', async () => {
  const plan = async () => ({ body: '첨부했습니다', files: [{ abs: '/v/files/a.pdf', name: 'a.pdf', bytes: 10 }] });
  const { server, agentId } = await setup({ plan, chatImpl: () => ({ reply: '첨부했습니다 ![a](files/a.pdf)' }) });
  const o = server.offer({ agent: agentId });
  server.push(o); await flush();
  const res = server.sentOf('work.result', o.work)[0];
  assert.equal(res.data.text, '첨부했습니다');
  assert.equal(res.data.files.length, 1);
  assert.equal(server.slots.get(res.data.files[0]).put, true);
});

test('사람이 멈춤: interruptTurn(같은 에이전트, tag = 일 id)을 부르고 결과를 보내지 않는다', async () => {
  let release;
  const { server, calls, agentId } = await setup({ chatImpl: () => new Promise((r) => { release = r; }) });
  const o = server.offer({ agent: agentId });
  server.push(o); await flush();
  server.cancel(o.work); await flush();
  assert.deepEqual(calls.interrupt, [{ ws: 'co-1', slug: 'pm', source: 'messenger', tag: o.work }]);
  release({ reply: '늦은 답' }); await flush();
  assert.equal(server.sentOf('work.result', o.work).length, 0);
});

test('에이전트 목록 다시 보내기: 1분 안에 여러 번 불려도 한 번만 읽고, 바뀌지 않았으면 요청 0', async () => {
  const { server, host, calls, clock } = await setup();
  const listed0 = calls.listed;
  await host.resync(); await host.resync();
  assert.equal(calls.listed, listed0); // 시작 직후 1분 안
  clock.advance(RESYNC_MIN_MS + 1);
  await host.resync();
  assert.equal(calls.listed, listed0 + 1);
  assert.equal(server.sentOf('agent.sync').length, 1); // 같은 목록 → 보내지 않음
});

test('문맥 구역: 비면 빈 문자열, 글은 한 줄로 2,000자까지', () => {
  assert.equal(contextSection([]), '');
  const s = contextSection([{ author: { kind: 'agent' }, text: 'a\nb'.repeat(2000) }]);
  assert.match(s, /^## 이 방의 최근 대화\n- agent: a b/);
  assert.ok(s.length < 2100);
});

test('로그인 직후 등록: runner + 정렬한 러너, 일시 오류는 3번까지, 영구 거부(4xx)는 바로 멈춘다', async () => {
  const { registerRunnerOnLogin, runnerRegisterArgs, detectRunnerIds } = await import('../src/agent-link-host.mjs');
  assert.deepEqual(runnerRegisterArgs({ runners: ['codex', 'claude', 'codex'] }).runners, ['claude', 'codex']);
  assert.deepEqual(await detectRunnerIds(async () => ({ gemini: { installed: true, authed: true }, claude: { installed: true, authed: true }, codex: { installed: true, authed: false } })), ['claude', 'gemini']);
  assert.deepEqual(await detectRunnerIds(() => new Promise(() => {}), { timeoutMs: 10 }), []);
  const mk = (replies) => { const calls = []; return { calls, mkClient: (url, key, opts) => ({ rpc: async (name, args) => { calls.push({ name, args, auth: opts.global.headers.Authorization }); return replies.shift(); } }) }; };
  const ok = mk([{ data: null, error: { status: 503 } }, { data: { device_id: DEVICE }, error: null }]);
  const r = await registerRunnerOnLogin({ url: 'u', anonKey: 'k', accessToken: 'tok' }, { mkClient: ok.mkClient, runners: ['codex', 'claude'], sleep: async () => {}, log: () => {} });
  assert.deepEqual(r, { ok: true, device_id: DEVICE });
  assert.equal(ok.calls.length, 2);
  assert.equal(ok.calls[0].auth, 'Bearer tok');
  assert.deepEqual(ok.calls[0].args.runners, ['claude', 'codex']);
  const gone = mk([{ data: null, error: { status: 404, code: 'PGRST202' } }]);
  assert.deepEqual(await registerRunnerOnLogin({ url: 'u', anonKey: 'k', accessToken: 't' }, { mkClient: gone.mkClient, sleep: async () => {}, log: () => {} }), { ok: false, code: 'PGRST202' });
  assert.equal(gone.calls.length, 1);
  const down = mk([{ data: null, error: { status: 500 } }, { data: null, error: { status: 500 } }, { data: null, error: { status: 500 } }, { data: { device_id: DEVICE } }]);
  assert.equal((await registerRunnerOnLogin({ url: 'u', anonKey: 'k', accessToken: 't' }, { mkClient: down.mkClient, sleep: async () => {}, log: () => {} })).ok, false);
  assert.equal(down.calls.length, 3);
});

test('saveDeviceSession: 플래그가 켜지면 세션 파일을 쓰기 **전에** runner 등록, 꺼지면 등록 요청 0(배포본과 같음)', async () => {
  const { saveDeviceSession } = await import('../src/devicesession.mjs');
  const { existsSync } = await import('node:fs');
  for (const on of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), 'argo-link-login-'));
    const seen = [];
    const _mkClient = () => ({
      rpc: async (name) => { seen.push({ name, fileExists: existsSync(join(root, '.device-session.json')) }); return { data: { device_id: DEVICE }, error: null }; },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { display_name: 'Y' }, error: null }) }) }) }),
    });
    const prev = process.env.ARGO_AGENT_LINK;
    process.env.ARGO_AGENT_LINK = on ? '1' : '';
    try {
      await saveDeviceSession({ url: 'https://x.invalid', anonKey: 'k', session: { access_token: 'a.b.c', refresh_token: 'r', expires_at: 9e9, user: { id: 'u1', email: '' } } }, { root, _mkClient });
    } finally { if (prev === undefined) delete process.env.ARGO_AGENT_LINK; else process.env.ARGO_AGENT_LINK = prev; }
    const reg = seen.filter((x) => x.name === 'msgr2_device_register');
    if (on) { assert.equal(reg.length, 1); assert.equal(reg[0].fileExists, false, '세션 파일보다 먼저'); }
    else assert.equal(reg.length, 0);
    assert.ok(existsSync(join(root, '.device-session.json')), '로그인은 그대로 저장된다');
  }
});
