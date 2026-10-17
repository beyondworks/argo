// 본체 연결부(src/agent-link-host.mjs) — 가짜 서버(약속 v1 판정 그대로) + 가짜 chat()으로 주인 턴·등급 거부·첨부·답 파일·중단·일지·재동기화 간격을 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { createAgentLinkHost, agentLinkEnabled, legacyMsgrBridgeEnabled, contextSection, ATTACH_IN_MAX, RESYNC_MIN_MS, peersSection, parseHandoffs, approvalRequestFrom } from '../src/agent-link-host.mjs';
import { TIER_POLICY, tierPolicy } from '../packages/agent-link/tiers.mjs';
import { tierAllows, TIERS } from '../packages/agent-link/contract/v1.mjs';
import { isGuestCtx } from '../src/gateway/msgr-handoff.mjs';
import { createFakeServer } from '../packages/agent-link/test/fake-server.mjs';

const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
// 실제 파일 쓰기가 끼는 칸(첨부 저장) — 윈도우는 느려 정해진 횟수로는 모자라다. 조건이 설 때까지 기다린다(상한 10초)
const until = async (cond, ms = 10_000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); };
const DEVICE = 'c4d5e6f7-8091-4a2b-9c3d-4e5f6a7b8c03';

async function setup({ chatImpl, regFails = false, plan, agents = [{ ws: 'co-1', slug: 'pm', name: 'PM', role: '기획' }] } = {}) {
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
  const calls = { chat: [], interrupt: [], listed: 0, logs: [], resolved: [], closed: [] };
  // 알림 버스 대역(notify.mjs와 같이 비동기로 나눠 준다) + 결재 확정 대역(approval-actions·approvals)
  const handlers = new Set();
  const bus = { emit: (ev) => { for (const h of handlers) Promise.resolve().then(() => h(ev)); } };
  const toolGates = new Map(); // 셸 결재 id → 기다리는 턴을 풀어 줄 함수
  const host = createAgentLinkHost({
    getSession: async () => ({ client: {}, uid: 'u1' }),
    listOwnedAgents: async () => { calls.listed++; return agents; },
    chat: async (ws, slug, text, sid, opts) => { calls.chat.push({ ws, slug, text, sid, opts }); return chatImpl ? chatImpl(opts, { bus, toolGates, ws, slug }) : { reply: '초안입니다', costUsd: 0.01 }; },
    onNotify: (fn) => { handlers.add(fn); return () => handlers.delete(fn); },
    // 실제 resolveWithFollowUp처럼: 상태를 바꾸고, 셸 결재(tool)는 기다리던 턴을 풀고, 그 밖은 후속 턴 답을 approval_followup으로 알린다
    resolveWithFollowUp: async (ws, id, approve, opts) => {
      calls.resolved.push({ ws, id, approve, effectAt: server.effects.get(`approval:${id}`) ?? null, via: opts?.resolvedBy?.via });
      const item = calls.items?.get(id);
      if (item && item.status !== 'pending') throw Object.assign(new Error('이미 처리된 결재입니다'), { code: 'approval_already_resolved' }); // approvals.mjs와 같다
      if (item) item.status = approve ? 'approved' : 'rejected';
      if (item?.kind === 'tool') toolGates.get(id)?.(approve);
      else bus.emit({ type: 'approval_followup', wsId: ws, item: item ?? { id }, reply: approve ? `후속: ${item?.action} 처리 완료` : '후속: 거절되어 하지 않음' });
    },
    resolveApproval: async (ws, id, approve) => { calls.closed.push({ id, approve }); },
    interruptTurn: async (ws, slug, o) => { calls.interrupt.push({ ws, slug, ...o }); },
    planReplyFiles: plan ?? (async (ws, reply) => ({ body: reply, files: [] })),
    readReplyFile: async () => new TextEncoder().encode('file-bytes'),
    vaultDir: () => vault,
    appVersion: '0.1.113',
    transportFor: () => server.transport,
    clock,
    linkClock: clock, // 부품도 같은 가짜 시계(offer 만료 판정)
    log: (...a) => calls.logs.push(a.join(' ')),
  });
  host.start(); await flush();
  // 시작(등록 → 목록 보내기 → 구독·따라잡기)이 끝날 때까지 — 느린 CI(윈도우)에서는 정해진 flush 횟수로 모자라 대응표가 비어 있었다
  if (!regFails) await until(() => !!host.link && server.agentIds.has('co-1/pm') && server.rpcCount('msgr2_link_pending') > 0);
  else { await until(() => calls.logs.some((l) => /device register failed/.test(l))); await flush(); }
  const agentId = server.agentIds.get('co-1/pm');
  // 범위를 단 로컬 결재를 올린다(chat.mjs addApproval → emitNotify({type:'approval'})와 같은 모양)
  const raise = (opts, item) => {
    const it = { status: 'pending', ...item, scope: opts.mirrorCtx.scope };
    (calls.items ??= new Map()).set(it.id, it);
    bus.emit({ type: 'approval', wsId: 'co-1', item: it });
    return it;
  };
  return { server, host, calls, vault, agentId, clock, bus, raise };
}

test('플래그: ARGO_AGENT_LINK는 정확히 1일 때만 켬, 옛 브리지는 off일 때만 끔(기본 = 지금 그대로)', () => {
  assert.equal(agentLinkEnabled({}), false);
  assert.equal(agentLinkEnabled({ ARGO_AGENT_LINK: '1' }), true);
  assert.equal(agentLinkEnabled({ ARGO_AGENT_LINK: 'true' }), false);
  assert.equal(legacyMsgrBridgeEnabled({}), true);
  assert.equal(legacyMsgrBridgeEnabled({ ARGO_MSGR_LEGACY: ' OFF ' }), false);
  assert.equal(legacyMsgrBridgeEnabled({ ARGO_MSGR_LEGACY: '0' }), true);
});

test('시작: runner 기기 등록(약속 범위) → 에이전트 목록 보내기 → 대응표 → v2:w:<uid> 따라잡기', async () => {
  const { server, host, agentId } = await setup();
  const reg = server.log.find((x) => x.name === 'msgr2_device_register');
  assert.deepEqual({ kind: reg.args.p_kind, app: reg.args.p_app, min: reg.args.p_link_min, max: reg.args.p_link_max }, { kind: 'runner', app: 'desktop', min: 1, max: 1 });
  assert.equal(server.sentOf('agent.sync').length, 1);
  assert.ok(agentId);
  assert.deepEqual(host.agents.get(agentId), { ws: 'co-1', slug: 'pm' });
  assert.equal(server.rpcCount('msgr2_link_pending'), 1);
});

test('주인 offer: chat()을 그 에이전트로 부르고(방 문맥 + 지시, abortTag = 일 id) 결과를 보낸다', async () => {
  const { server, calls, agentId } = await setup();
  const o = server.offer({ agent: agentId, text: '회의 자료 초안' });
  o.data.context = [{ id: 501, author: { kind: 'user', id: crypto.randomUUID(), name: '유건' }, text: '지난 회의록 참고', at: o.at }];
  server.push(o); await flush();
  await until(() => server.sentOf('work.result', o.work).length > 0);
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

test('등급별 실행: owner는 주인 도구(범위 owner 표지), team·guest는 손님 도구 묶음으로 돈다(tier_denied 거절 없음)', async () => {
  for (const tier of ['owner', 'team', 'guest']) {
    const { server, calls, agentId } = await setup();
    const o = server.offer({ agent: agentId, tier });
    server.push(o); await flush();
    await until(() => server.sentOf('work.result', o.work).length > 0);
    assert.equal(calls.chat.length, 1, tier);
    const mc = calls.chat[0].opts.mirrorCtx;
    assert.deepEqual(mc, { kind: 'scope', scope: { kind: 'link', work: o.work, room: o.data.room, owner: tier === 'owner' } }, tier);
    assert.equal(isGuestCtx(mc), tier !== 'owner', `${tier}: 손님 판정`);
    assert.equal(server.sentOf('work.error', o.work).length, 0, tier);
    assert.equal(server.works.get(o.work).state, 'done', tier);
  }
});

test('등급표: 부품 한 곳(TIER_POLICY)이 약속 tierAllows와 같고, 모르는 등급은 guest, link 범위는 owner 표지가 있을 때만 주인', () => {
  assert.deepEqual(Object.keys(TIER_POLICY).sort(), [...TIERS].sort());
  for (const tier of TIERS) {
    const p = TIER_POLICY[tier];
    assert.equal(p.approvals, tierAllows(tier, 'work.approval_request'), `${tier} 승인`);
    assert.equal(p.effects, tierAllows(tier, 'work.effect'), `${tier} 효과`);
    assert.equal(p.uploads, tierAllows(tier, 'work.result', { files: ['x'] }), `${tier} 파일`);
    assert.equal(p.run, true, tier);
  }
  assert.equal(TIER_POLICY.owner.ownerTools, true);
  assert.equal(TIER_POLICY.team.ownerTools, false); // 지금 배포본의 조직 채널 = 주인 아닌 사람의 지시는 손님 도구
  assert.deepEqual(TIER_POLICY.guest, { run: true, ownerTools: false, approvals: false, effects: false, uploads: false, handoffs: false }); // D12 대화·읽기만
  assert.equal(tierPolicy('admin'), TIER_POLICY.guest);
  assert.equal(isGuestCtx({ kind: 'scope', scope: { kind: 'link', work: 'w' } }), true, '표지 없음 = 손님(fail-closed)');
  assert.equal(isGuestCtx({ kind: 'scope', scope: { kind: 'link', owner: 'yes' } }), true, 'true만 주인');
  assert.equal(isGuestCtx({ kind: 'scope', scope: { kind: 'link', owner: true } }), false);
  assert.equal(isGuestCtx({ kind: 'scope', scope: { kind: 'tg-group', chatId: '1' } }), false, '다른 범위 턴은 종전대로');
});

test('guest: 답 속 파일을 올리지 않고 넘김도 싣지 않는다', async () => {
  const plan = async () => ({ body: '파일', files: [{ abs: '/v/a.pdf', name: 'a.pdf', bytes: 1 }] });
  const { server, agentId } = await setup({ plan, chatImpl: () => ({ reply: '여기\n[넘김 @비] 이어서' }) }); // 넘김 줄 모양(줄 맨 앞) — 손님이라 넘김으로 읽지 않는다
  const o = server.offer({ agent: agentId, tier: 'guest' });
  o.data.peers = [{ agent: crypto.randomUUID(), name: '비', role: '' }];
  server.push(o); await flush();
  await until(() => server.sentOf('work.result', o.work).length > 0);
  const res = server.sentOf('work.result', o.work)[0];
  assert.deepEqual(res.data.files, []);
  assert.deepEqual(res.data.handoffs, []);
  assert.equal(server.rpcCount('msgr2_link_upload_slot'), 0);
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

test('받은 첨부: Storage 위치(bucket·path)에서 runner 세션으로 받아 vault/files/msgr2에 두고 chat()에 넘긴다, 25MB 넘는 것은 받지 않는다(#1076)', async () => {
  const { server, calls, agentId, vault } = await setup();
  server.files.set('msgr/s1/r1/501/0-a.pdf', new TextEncoder().encode('PDFDATA'));
  const o = server.offer({ agent: agentId });
  o.data.attachments = [
    { id: 501, name: '../보고서 v1.pdf', mime: 'application/pdf', bytes: 7, bucket: 'msgr', path: 's1/r1/501/0-a.pdf' },
    { id: 502, name: 'big.bin', mime: 'application/octet-stream', bytes: ATTACH_IN_MAX + 1, bucket: 'msgr', path: 's1/r1/502/0-big.bin' },
  ];
  server.push(o); await flush();
  await until(() => calls.chat.length > 0);
  assert.deepEqual(server.downloads, ['msgr/s1/r1/501/0-a.pdf']);
  const att = calls.chat[0].opts.attachments;
  assert.equal(att.length, 1);
  assert.match(att[0].rel, /^files\/msgr2\/[0-9a-f]{8}-보고서_v1\.pdf$/); // 경로 조각을 지운 이름
  assert.equal(await readFile(join(vault, att[0].rel), 'utf8'), 'PDFDATA');
});

test('offer에 첨부가 비어도 accept 답에 실린 원글 첨부를 받는다(사람 글의 첨부는 글 뒤에 붙는다, #1076)', async () => {
  const { server, calls, agentId } = await setup();
  server.files.set('msgr/s1/r1/600/0-late.png', new TextEncoder().encode('PNG'));
  const o = server.offer({ agent: agentId });
  server.works.get(o.work).attachments = [{ id: 600, name: 'late.png', mime: 'image/png', bytes: 3, bucket: 'msgr', path: 's1/r1/600/0-late.png' }];
  server.push(o); await flush();
  await until(() => calls.chat.length > 0);
  assert.deepEqual(server.downloads, ['msgr/s1/r1/600/0-late.png']);
  assert.equal(calls.chat[0].opts.attachments[0].isImage, true);
});

test('첨부 받기가 실패해도(권한·없음) 턴은 그대로 돈다 — 그 첨부만 빠진다', async () => {
  const { server, calls, agentId } = await setup();
  const o = server.offer({ agent: agentId });
  o.data.attachments = [{ id: 700, name: 'x.pdf', mime: 'application/pdf', bytes: 3, bucket: 'msgr', path: 'nope' }];
  server.push(o); await flush();
  await until(() => server.sentOf('work.result', o.work).length > 0);
  assert.deepEqual(calls.chat[0].opts.attachments, []);
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
  assert.deepEqual(runnerRegisterArgs({ runners: ['codex', 'claude', 'codex'] }).p_runners, ['claude', 'codex']);
  // U3 함수의 이름 있는 인자(p_ 접두)만 싣는다 — 다른 이름이면 PostgREST가 함수를 못 찾는다(PGRST202)
  assert.deepEqual(Object.keys(runnerRegisterArgs({ appVersion: '0.2.0' })).sort(), ['p_app', 'p_app_version', 'p_kind', 'p_link_max', 'p_link_min', 'p_runners']);
  assert.deepEqual(await detectRunnerIds(async () => ({ gemini: { installed: true, authed: true }, claude: { installed: true, authed: true }, codex: { installed: true, authed: false } })), ['claude', 'gemini']);
  assert.deepEqual(await detectRunnerIds(() => new Promise(() => {}), { timeoutMs: 10 }), []);
  const mk = (replies) => { const calls = []; return { calls, mkClient: (url, key, opts) => ({ rpc: async (name, args) => { calls.push({ name, args, auth: opts.global.headers.Authorization }); return replies.shift(); } }) }; };
  const ok = mk([{ data: null, error: { status: 503 } }, { data: { device_id: DEVICE }, error: null }]);
  const r = await registerRunnerOnLogin({ url: 'u', anonKey: 'k', accessToken: 'tok' }, { mkClient: ok.mkClient, runners: ['codex', 'claude'], sleep: async () => {}, log: () => {} });
  assert.deepEqual(r, { ok: true, device_id: DEVICE });
  assert.equal(ok.calls.length, 2);
  assert.equal(ok.calls[0].auth, 'Bearer tok');
  assert.deepEqual(ok.calls[0].args.p_runners, ['claude', 'codex']);
  const gone = mk([{ data: null, error: { status: 404, code: 'PGRST202' } }]);
  assert.deepEqual(await registerRunnerOnLogin({ url: 'u', anonKey: 'k', accessToken: 't' }, { mkClient: gone.mkClient, sleep: async () => {}, log: () => {} }), { ok: false, code: 'PGRST202' });
  assert.equal(gone.calls.length, 1);
  const down = mk([{ data: null, error: { status: 500 } }, { data: null, error: { status: 500 } }, { data: null, error: { status: 500 } }, { data: { device_id: DEVICE } }]);
  assert.equal((await registerRunnerOnLogin({ url: 'u', anonKey: 'k', accessToken: 't' }, { mkClient: down.mkClient, sleep: async () => {}, log: () => {} })).ok, false);
  assert.equal(down.calls.length, 3);
});

test('로그인 직후 등록: 응답 없는 서버 — 한 번 5초·합계 상한으로 끊고 실패를 돌려준다(로그인을 붙잡지 않는다)', async () => {
  const { registerRunnerOnLogin } = await import('../src/agent-link-host.mjs');
  // ① 끝나지 않는 약속(빌더 아님) — 경주로 끊는다
  let n = 0;
  const hang = () => ({ rpc: () => { n++; return new Promise(() => {}); } });
  const t0 = Date.now();
  const r = await registerRunnerOnLogin({ url: 'u', anonKey: 'k', accessToken: 't' }, { mkClient: hang, timeoutMs: 30, budgetMs: 1_000, sleep: async () => {}, log: () => {} });
  assert.deepEqual(r, { ok: false, code: 'timeout' });
  assert.equal(n, 3, '시도마다 끊고 3번까지');
  assert.ok(Date.now() - t0 < 900, '시도 상한 안에 끝난다');
  // ② supabase-js 빌더 모양 — abortSignal로 요청 자체를 끊는다
  const signals = [];
  const builder = () => ({ rpc: () => ({ abortSignal(sig) { signals.push(sig); return new Promise((res) => sig.addEventListener('abort', () => res({ data: null, error: { code: '', message: 'AbortError', status: 0 } }))); } }) });
  const b = await registerRunnerOnLogin({ url: 'u', anonKey: 'k', accessToken: 't' }, { mkClient: builder, timeoutMs: 30, budgetMs: 1_000, sleep: async () => {}, log: () => {} });
  assert.equal(b.ok, false);
  assert.equal(signals.length, 3);
  assert.ok(signals.every((s) => s.aborted), '요청마다 시간 제한 신호');
  // ③ 합계 상한: 남은 시간이 없으면 더 시도하지 않는다
  let m = 0, clock = 0;
  const slow = () => ({ rpc: () => { m++; clock += 60; return new Promise(() => {}); } });
  const c = await registerRunnerOnLogin({ url: 'u', anonKey: 'k', accessToken: 't' }, { mkClient: slow, timeoutMs: 20, budgetMs: 100, now: () => clock, sleep: async () => {}, log: () => {} });
  assert.equal(c.ok, false);
  assert.equal(m, 2, '합계 상한 100ms 안에서 2번만');
  // ④ 클라이언트를 못 만들어도 던지지 않는다
  assert.deepEqual(await registerRunnerOnLogin({ url: 'u', anonKey: 'k', accessToken: 't' }, { mkClient: () => { throw new Error('bad url'); }, log: () => {} }), { ok: false, code: 'client' });
});

test('saveDeviceSession: 등록 모듈을 못 읽어도(import 실패) 로그인은 저장된다', async () => {
  const { saveDeviceSession } = await import('../src/devicesession.mjs');
  const { existsSync } = await import('node:fs');
  const root = await mkdtemp(join(tmpdir(), 'argo-link-login-'));
  const _mkClient = () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) });
  const prev = process.env.ARGO_AGENT_LINK;
  process.env.ARGO_AGENT_LINK = '1';
  try {
    await saveDeviceSession({ url: 'https://x.invalid', anonKey: 'k', session: { access_token: 'a.b.c', refresh_token: 'r', expires_at: 9e9, user: { id: 'u1', email: '' } } },
      { root, _mkClient, _loadLinkReg: async () => { throw new Error('Cannot find module agent-link-host.mjs'); } });
  } finally { if (prev === undefined) delete process.env.ARGO_AGENT_LINK; else process.env.ARGO_AGENT_LINK = prev; }
  assert.ok(existsSync(join(root, '.device-session.json')), '로그인은 그대로 저장된다');
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

// ── 결재 다리(U4b): chat() 결재 ↔ work.approval_request / work.approval_decision ──
const approvalOf = (server, work) => server.log.filter((x) => x.args?.p_env?.type === 'work.approval_request' && x.args.p_env.work === work).map((x) => x.args.p_env);

test('행동 결재: 턴 뒤 approval_request → 승인 → effect intent 먼저 → resolveWithFollowUp(승인) → 후속 답이 결과에 이어진다', async () => {
  let ctxRef;
  const { server, calls, agentId, raise } = await setup({ chatImpl: (opts) => { raise(opts, { id: 'ap-1', kind: 'action', action: '거래처 메일 발송', reason: '회의 일정 안내', slug: 'pm' }); ctxRef = opts; return { reply: '결재를 올렸습니다' }; } });
  const o = server.offer({ agent: agentId });
  server.push(o); await flush();
  await until(() => approvalOf(server, o.work).length > 0);
  const req = approvalOf(server, o.work)[0];
  assert.equal(req.data.effect_key, 'approval:ap-1');
  assert.equal(req.data.risk, 'medium');
  assert.match(req.data.summary, /거래처 메일 발송 — 회의 일정 안내/);
  assert.equal(server.works.get(o.work).state, 'awaiting_approval');
  assert.equal(calls.resolved.length, 0, '결정 전에는 로컬 결재를 풀지 않는다');
  server.decide(o.work, req.data.approval_id, 'approve'); await flush();
  await until(() => server.sentOf('work.result', o.work).length > 0);
  assert.deepEqual(calls.resolved.map((x) => [x.id, x.approve, x.effectAt, x.via]), [['ap-1', true, 'intent', 'msgr2']], '승인 실행 순간 서버에 intent가 있다');
  assert.equal(server.effects.get('approval:ap-1'), 'done');
  assert.equal(server.sentOf('work.result', o.work)[0].data.text, '결재를 올렸습니다\n\n후속: 거래처 메일 발송 처리 완료');
  assert.equal(ctxRef.mirrorCtx.scope.work, o.work);
});

test('행동 결재 거절: effect 없이 resolveWithFollowUp(거절), 후속 답이 결과에 이어진다', async () => {
  const { server, calls, agentId, raise } = await setup({ chatImpl: (opts) => { raise(opts, { id: 'ap-2', kind: 'action', action: '삭제', slug: 'pm' }); return { reply: '올렸습니다' }; } });
  const o = server.offer({ agent: agentId });
  server.push(o); await flush();
  await until(() => approvalOf(server, o.work).length > 0);
  server.decide(o.work, approvalOf(server, o.work)[0].data.approval_id, 'reject'); await flush();
  await until(() => server.sentOf('work.result', o.work).length > 0);
  assert.deepEqual(calls.resolved.map((x) => [x.id, x.approve]), [['ap-2', false]]);
  assert.equal(server.effects.has('approval:ap-2'), false);
  assert.match(server.sentOf('work.result', o.work)[0].data.text, /후속: 거절되어 하지 않음$/);
});

test('결재 만료(expire): 후속 턴 없이 로컬 결재를 닫고 결과를 낸다', async () => {
  const { server, calls, agentId, raise } = await setup({ chatImpl: (opts) => { raise(opts, { id: 'ap-3', kind: 'action', action: '구매', slug: 'pm' }); return { reply: '올렸습니다' }; } });
  const o = server.offer({ agent: agentId });
  server.push(o); await flush();
  await until(() => approvalOf(server, o.work).length > 0);
  server.decide(o.work, approvalOf(server, o.work)[0].data.approval_id, 'expire'); await flush();
  await until(() => server.sentOf('work.result', o.work).length > 0);
  assert.deepEqual(calls.resolved, []);
  assert.deepEqual(calls.closed, [{ id: 'ap-3', approve: false }]);
  assert.equal(server.sentOf('work.result', o.work)[0].data.text, '올렸습니다');
});

test('셸 결재(tool): 턴이 기다리는 동안 approval_request(high) → 승인 → 기다리던 턴이 재개, 후속 턴 없음', async () => {
  const { server, calls, agentId, raise } = await setup({ chatImpl: async (opts, { toolGates }) => {
    const ok = await new Promise((res) => { toolGates.set('ap-t', res); raise(opts, { id: 'ap-t', kind: 'tool', action: 'rm -rf build', slug: 'pm' }); });
    return { reply: ok ? '실행했습니다' : '하지 않았습니다' };
  } });
  const o = server.offer({ agent: agentId });
  server.push(o); await flush();
  await until(() => approvalOf(server, o.work).length > 0);
  assert.equal(approvalOf(server, o.work)[0].data.risk, 'high');
  server.decide(o.work, approvalOf(server, o.work)[0].data.approval_id, 'approve'); await flush();
  await until(() => server.sentOf('work.result', o.work).length > 0);
  assert.equal(server.sentOf('work.result', o.work)[0].data.text, '실행했습니다');
  assert.equal(calls.resolved[0].effectAt, 'intent');
});

test('guest 결재: 승인 요청을 보내지 않고 로컬 결재를 거절로 닫는다(막힌 셸 결재도 풀린다)', async () => {
  const { server, calls, agentId, raise } = await setup({ chatImpl: async (opts) => { raise(opts, { id: 'ap-g', kind: 'action', action: '발송', slug: 'pm' }); return { reply: '안내만 했습니다' }; } });
  const o = server.offer({ agent: agentId, tier: 'guest' });
  server.push(o); await flush();
  await until(() => server.sentOf('work.result', o.work).length > 0);
  assert.equal(approvalOf(server, o.work).length, 0);
  assert.deepEqual(calls.closed, [{ id: 'ap-g', approve: false }]);
});

test('다른 일·다른 회사의 결재는 이 일에 붙지 않는다(범위의 work로 거른다)', async () => {
  const { server, agentId, bus } = await setup({ chatImpl: (opts) => {
    bus.emit({ type: 'approval', wsId: 'co-1', item: { id: 'x1', kind: 'action', action: '남의 일', scope: { kind: 'link', work: crypto.randomUUID() } } });
    bus.emit({ type: 'approval', wsId: 'co-2', item: { id: 'x2', kind: 'action', action: '다른 회사', scope: opts.mirrorCtx.scope } });
    bus.emit({ type: 'approval', wsId: 'co-1', item: { id: 'x3', kind: 'action', action: '범위 없음' } });
    return { reply: '끝' };
  } });
  const o = server.offer({ agent: agentId });
  server.push(o); await flush();
  await until(() => server.sentOf('work.result', o.work).length > 0);
  assert.equal(approvalOf(server, o.work).length, 0);
  assert.equal(server.sentOf('work.result', o.work)[0].data.text, '끝');
});

test('결재를 기다리는 중 취소: 로컬 결재를 거절로 닫고 결과를 내지 않는다', async () => {
  const { server, calls, agentId, raise } = await setup({ chatImpl: (opts) => { raise(opts, { id: 'ap-c', kind: 'action', action: '발송', slug: 'pm' }); return { reply: '올림' }; } });
  const o = server.offer({ agent: agentId });
  server.push(o); await flush();
  await until(() => approvalOf(server, o.work).length > 0);
  server.cancel(o.work); await flush();
  await until(() => calls.closed.length > 0);
  assert.deepEqual(calls.closed, [{ id: 'ap-c', approve: false }]);
  assert.deepEqual(calls.resolved, []);
  assert.equal(server.sentOf('work.result', o.work).length, 0);
});

test('approvalRequestFrom: 쉬운 문장(plain)이 있으면 요약으로, 위험도는 셸·커넥터 high', () => {
  const r = approvalRequestFrom({ id: 'a', kind: 'connector', action: 'x'.repeat(300), plain: { purpose: '뉴스레터', task: '1200명 발송', need: 'Gmail' } }, Date.parse('2026-10-18T00:00:00Z'));
  assert.equal(r.action.length, 200); assert.equal(r.risk, 'high'); assert.equal(r.summary, '뉴스레터 · 1200명 발송 · Gmail');
  assert.equal(r.expires_at, '2026-10-19T00:00:00.000Z'); assert.equal(r.effect_key, 'approval:a');
});

// ── 넘김(U4b): offer.peers → 동료 구역, 답의 넘김 줄 → result.handoffs ──
test('넘김: 동료 목록을 지시 앞에 보여 주고, [넘김 @이름] 줄을 result.handoffs로 보낸다(본문에서 지움, 모르는 이름은 그대로)', async () => {
  const B = crypto.randomUUID();
  const { server, calls, agentId } = await setup({ chatImpl: () => ({ reply: '초안 끝.\n[넘김 @비] 일정 확정해 줘\n[넘김 @없는사람] 이것도' }) });
  const o = server.offer({ agent: agentId, tier: 'team' });
  o.data.peers = [{ agent: B, name: '비', role: '일정 담당' }];
  server.push(o); await flush();
  await until(() => server.sentOf('work.result', o.work).length > 0);
  assert.match(calls.chat[0].text, /## 이 방에서 넘길 수 있는 동료\n- @비 — 일정 담당\n/);
  const res = server.sentOf('work.result', o.work)[0];
  assert.deepEqual(res.data.handoffs, [{ agent: B, text: '일정 확정해 줘' }]);
  assert.equal(res.data.text, '초안 끝.\n[넘김 @없는사람] 이것도');
});

test('parseHandoffs·peersSection: 동명이인은 넘기지 않고, 8개까지, 동료가 없으면 구역도 없다', () => {
  const p = [{ agent: 'a1', name: '비' }, { agent: 'a2', name: '씨' }, { agent: 'a3', name: '씨' }];
  assert.deepEqual(parseHandoffs('[handoff @비] go\n[넘김 @씨] 둘', p).handoffs, [{ agent: 'a1', text: 'go' }]);
  const many = Array.from({ length: 10 }, () => '[넘김 @비] 일').join('\n');
  assert.equal(parseHandoffs(many, p).handoffs.length, 8);
  assert.deepEqual(parseHandoffs('[넘김 @비] x', []), { body: '[넘김 @비] x', handoffs: [] });
  assert.equal(peersSection([]), '');
  assert.match(peersSection([{ agent: 'a', name: 'B', role: '' }], 'en'), /\[handoff @name\]/);
});

test('주인이 데스크톱·텔레그램에서 먼저 확정한 결재: v2 승인이 와도 다시 풀지 않고, 먼저 나온 후속 답을 결과에 쓴다', async () => {
  const { server, calls, agentId, raise, bus } = await setup({ chatImpl: (opts) => { raise(opts, { id: 'ap-l', kind: 'action', action: '발송', slug: 'pm' }); return { reply: '올림' }; } });
  const o = server.offer({ agent: agentId });
  server.push(o); await flush();
  await until(() => approvalOf(server, o.work).length > 0);
  // 로컬(데스크톱 결재함)에서 먼저 확정 — 상태가 바뀌고 후속 답이 먼저 나온다
  calls.items.get('ap-l').status = 'approved';
  bus.emit({ type: 'approval_followup', wsId: 'co-1', item: calls.items.get('ap-l'), reply: '후속: 데스크톱에서 승인되어 보냈음' }); await flush();
  server.decide(o.work, approvalOf(server, o.work)[0].data.approval_id, 'approve'); await flush();
  await until(() => server.sentOf('work.result', o.work).length > 0);
  assert.equal(server.sentOf('work.result', o.work)[0].data.text, '올림\n\n후속: 데스크톱에서 승인되어 보냈음');
  assert.equal(calls.resolved.length, 1, 'v2 승인은 한 번 시도하고(이미 처리됨) 다시 실행하지 않는다');
});
