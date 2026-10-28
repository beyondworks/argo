// 본체 0.1.120 핫픽스(2026-10-28 운영 제보) — 메신저 일 받기 연결부(src/agent-link-host.mjs)
// ① 러너 감지가 시간 상한에 걸리면 빈 러너 목록으로 등록한 채 그 실행 동안 다시 등록하지 않았다(서버는 러너가 있는 기기에만 일을 넘긴다)
// ② 메신저 앱의 "모든 기기 로그아웃"으로 기기가 폐기(403)돼도 설정·argo_status는 "연결됨"이었다 — 실제 상태를 노출한다
// ③ 일을 받지 않고 버리는 경로마다 이유를 한 줄 로그로 남긴다(개인 정보·토큰 없음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { createAgentLinkHost, detectRunnerState, registerFailure, RUNNER_RECHECK_MS } from '../src/agent-link-host.mjs';
import { createFakeServer } from '../packages/agent-link/test/fake-server.mjs';

const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const until = async (cond, ms = 5_000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5)); };
const DEVICE = 'c4d5e6f7-8091-4a2b-9c3d-4e5f6a7b8c03';
const SECRETISH = /eyJ|sk-|re_|postgresql:\/\/|refresh|access_token|@/;

/** register(args, n) → 서버 답. detect() → 러너 맵(시험이 늦게 풀 수 있다). sessionKey() → 로컬 세션 표지 */
async function setup({ register, detect, sessionKey, agents = [{ ws: 'co-1', slug: 'pm', name: 'PM', role: '기획' }], getSession, chat } = {}) {
  let t = Date.parse('2026-10-28T06:00:00Z');
  const timers = new Set();
  const clock = { now: () => t, setTimeout: (fn, ms) => { const h = { fn, at: t + ms }; timers.add(h); return h; }, clearTimeout: (h) => timers.delete(h), sleep: async (ms) => { t += ms; },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers].filter((h) => h.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due); t = due.at; await due.fn(); await flush();
      }
      t = end;
    } };
  const server = createFakeServer({ now: clock.now, uid: 'u1' });
  const regs = [];
  const rpc0 = server.transport.rpc;
  server.transport.rpc = async (name, args) => {
    if (name === 'msgr2_device_register') {
      regs.push(args);
      server.log.push({ name, args });
      return register ? register(args, regs.length) : { data: { device_id: DEVICE }, error: null };
    }
    return rpc0(name, args);
  };
  const vault = await mkdtemp(join(tmpdir(), 'argo-link-status-'));
  const logs = [], statuses = [];
  const host = createAgentLinkHost({
    getSession: getSession ?? (async () => ({ client: {}, uid: 'u1' })),
    sessionKey,
    listOwnedAgents: async () => agents,
    detectRunners: detect,
    chat: chat ?? (async () => ({ reply: '네' })),
    onNotify: () => () => {},
    resolveWithFollowUp: async () => {}, resolveApproval: async () => {}, interruptTurn: async () => {},
    planReplyFiles: async (ws, body) => ({ body, files: [] }), readReplyFile: async () => new Uint8Array(),
    vaultDir: () => vault, appVersion: '0.1.120', transportFor: () => server.transport,
    clock, linkClock: clock,
    log: (...a) => logs.push(a.join(' ')),
    onStatus: (s) => statuses.push(s),
    detectTimeoutMs: 50, // 감지 상한(실제 3초) — 시험은 짧게
  });
  return { server, host, clock, regs, logs, statuses, last: () => statuses.at(-1) };
}

test('detectRunnerState: 시간 상한 초과(complete=false)와 진짜 0개(complete=true)를 가른다, 늦게 끝난 감지는 late로 받는다', async () => {
  const fast = await detectRunnerState(async () => ({ codex: { installed: true, authed: true }, claude: { installed: true, authed: false } }));
  assert.deepEqual({ runners: fast.runners, complete: fast.complete }, { runners: ['codex'], complete: true });
  const none = await detectRunnerState(async () => ({}));
  assert.deepEqual({ runners: none.runners, complete: none.complete }, { runners: [], complete: true }, '진짜 0개');
  let release;
  const slow = await detectRunnerState(() => new Promise((r) => { release = r; }), { timeoutMs: 5 });
  assert.deepEqual({ runners: slow.runners, complete: slow.complete }, { runners: [], complete: false }, '상한 초과 — 0개가 아니라 모름');
  release({ gemini: { installed: true, authed: true } });
  assert.deepEqual(await slow.late, ['gemini'], '늦게 끝난 감지 결과');
  const boom = await detectRunnerState(async () => { throw new Error('x'); });
  assert.equal(boom.complete, false, '감지 실패도 0개로 단정하지 않는다');
});

test('러너 감지가 시간 상한에 걸려도 늦게 끝나면 그 러너로 다시 등록한다(빈 목록 등록으로 일을 영영 못 받던 결함)', async () => {
  let release;
  const { host, regs, last, logs } = await setup({ detect: () => new Promise((r) => { release = r; }) });
  host.start();
  await until(() => regs.length >= 1 && !!host.link);
  assert.deepEqual(regs[0].p_runners, [], '상한 초과 — 일단 기기만 등록(링크를 열어야 한다)');
  assert.equal(last()?.state, 'starting', '감지가 끝나기 전에는 "러너 없음"으로 단정하지 않는다');
  release({ claude: { installed: true, authed: true } });
  await until(() => regs.length >= 2);
  assert.deepEqual(regs[1].p_runners, ['claude'], '감지가 끝나면 그 러너로 다시 등록');
  await until(() => last()?.state === 'ok');
  assert.equal(last().state, 'ok');
  assert.deepEqual(last().runners, ['claude']);
  assert.ok(logs.some((l) => /runners updated/.test(l)));
  host.stop();
});

test('러너 주기 재확인: 10분마다 감지하되 바뀔 때만 다시 등록(유휴 쓰기 0), 진짜 0개면 no_runners', async () => {
  let m = {};
  const { host, regs, last, clock } = await setup({ detect: async () => m });
  host.start();
  await until(() => !!host.link && last()?.state === 'no_runners');
  assert.equal(last().state, 'no_runners', '감지가 끝났고 0개 — 일을 받지 못한다고 보인다');
  assert.equal(regs.length, 1);
  // 1시간 유휴(게이트웨이가 10초마다 resync): 러너가 그대로면 등록 요청 0
  for (let i = 0; i < 360; i++) { await clock.advance(10_000); await host.resync(); }
  await flush();
  assert.equal(regs.length, 1, '바뀌지 않으면 다시 등록하지 않는다');
  // 사용자가 CLI에 로그인 → 다음 재확인(10분 안)에 한 번 등록
  m = { codex: { installed: true, authed: true } };
  for (let i = 0; i < RUNNER_RECHECK_MS / 10_000; i++) { await clock.advance(10_000); await host.resync(); }
  await until(() => regs.length >= 2);
  assert.equal(regs.length, 2);
  assert.deepEqual(regs[1].p_runners, ['codex']);
  await until(() => last()?.state === 'ok');
  for (let i = 0; i < 360; i++) { await clock.advance(10_000); await host.resync(); }
  await flush();
  assert.equal(regs.length, 2, '다시 유휴 — 요청 0');
  host.stop();
  assert.equal(last().state, 'off');
});

test('기기 등록 403(기기 폐기·세션 거부) → reauth로 보이고, 다시 로그인하면(세션 표지가 바뀌면) 10분을 기다리지 않고 다시 붙는다', async () => {
  let key = 'old';
  const { host, regs, last, logs, clock } = await setup({
    sessionKey: () => key,
    detect: async () => ({ claude: { installed: true, authed: true } }),
    register: () => (key === 'old' ? { data: null, error: { code: '42501', status: 403, message: 'device_revoked' } } : { data: { device_id: DEVICE }, error: null }),
  });
  host.start();
  await until(() => last()?.state === 'reauth');
  assert.deepEqual({ state: last().state, code: last().code }, { state: 'reauth', code: 'device_revoked' });
  assert.equal(host.link, null);
  assert.ok(logs.some((l) => /device register failed device_revoked/.test(l)));
  // 같은 세션 그대로: resync가 10초마다 불려도 등록을 다시 하지 않는다(재시도 간격 1→2→5→10분만)
  const n0 = regs.length;
  for (let i = 0; i < 5; i++) { await clock.advance(10_000); await host.resync(); }
  assert.equal(regs.length, n0, '세션이 그대로면 10초 확인에서 등록하지 않는다');
  // 다시 로그인(세션 파일이 바뀜) → 다음 확인에서 바로 등록·연결
  key = 'new';
  await clock.advance(10_000); await host.resync();
  await until(() => last()?.state === 'ok');
  assert.equal(last().state, 'ok');
  assert.ok(host.link);
  host.stop();
});

test('돌던 링크가 device_revoked를 받으면(메신저 "모든 기기 로그아웃") 링크를 내리고 reauth, 다시 로그인하면 새로 붙는다', async () => {
  let key = 'old';
  const { host, server, last, clock, regs } = await setup({ sessionKey: () => key, detect: async () => ({ claude: { installed: true, authed: true } }) });
  host.start();
  await until(() => last()?.state === 'ok' && server.rpcCount('msgr2_link_pending') > 0);
  server.opts.revoked = true;
  await host.link.catchUp(); await flush();
  assert.equal(last().state, 'reauth');
  assert.equal(last().code, 'device_revoked');
  assert.equal(host.link, null, '멈춘 링크를 남겨 두지 않는다(남기면 다시 시작하지 못한다)');
  server.opts.revoked = false;
  key = 'new';
  const n0 = regs.length;
  await clock.advance(10_000); await host.resync();
  await until(() => last()?.state === 'ok');
  assert.ok(regs.length > n0);
  assert.ok(host.link);
  host.stop();
});

test('registerFailure: pro_required·reauth(403·기기 폐기·세션 없음)·update_required·일시 오류를 가른다', () => {
  assert.equal(registerFailure({ error: { code: '42501', status: 403, message: 'msgr2_pro_required' } }).state, 'pro_required');
  assert.equal(registerFailure({ data: { code: 'pro_required' } }).state, 'pro_required');
  for (const m of ['device_revoked', 'device_expired', 'device_login_required', 'msgr2_session_required', 'msgr2_device_kind_locked']) {
    assert.deepEqual(registerFailure({ error: { code: '42501', status: 403, message: m } }), { state: 'reauth', code: m }, m);
  }
  assert.deepEqual(registerFailure({ error: { code: 'PGRST301', status: 401, message: 'JWT expired' } }), { state: 'reauth', code: 'http_401' });
  assert.equal(registerFailure({ error: { code: 'P0001', status: 400, message: 'app_version_unsupported' } }).state, 'update_required');
  assert.equal(registerFailure({ error: { code: 'PGRST202', status: 404 } }).state, 'error');
  assert.equal(registerFailure({ data: {} }).state, 'error');
});

test('무료 계정(pro_required)·세션 없음도 상태로 보인다', async () => {
  const a = await setup({ register: () => ({ data: null, error: { code: '42501', status: 403, message: 'msgr2_pro_required' } }), detect: async () => ({}) });
  a.host.start();
  await until(() => a.last()?.state === 'pro_required');
  assert.equal(a.last().state, 'pro_required');
  a.host.stop();
  const b = await setup({ getSession: async () => null });
  b.host.start();
  await until(() => b.last()?.state === 'signed_out');
  assert.equal(b.last().state, 'signed_out');
  b.host.stop();
});

test('일을 받지 않고 버리는 경로마다 이유 한 줄 — 대응표에 없는 에이전트·기한 지남(토큰·글 내용 없음)', async () => {
  const { host, server, logs, last } = await setup({ detect: async () => ({ claude: { installed: true, authed: true } }) });
  host.start();
  await until(() => last()?.state === 'ok' && server.agentIds.has('co-1/pm'));
  const stranger = server.offer({ agent: crypto.randomUUID(), text: '비밀 지시 eyJabc' });
  server.push(stranger); await flush();
  assert.ok(logs.some((l) => /offer skipped/.test(l) && /agent_not_mapped/.test(l) && l.includes(stranger.work)), logs.join('\n'));
  const old = server.offer({ agent: server.agentIds.get('co-1/pm'), expiresIn: -1000 });
  server.push(old); await flush();
  assert.ok(logs.some((l) => /offer skipped/.test(l) && /expired/.test(l) && l.includes(old.work)), logs.join('\n'));
  assert.equal(server.sentOf('work.accept').length, 0);
  for (const l of logs.filter((x) => /offer skipped/.test(x))) assert.doesNotMatch(l, SECRETISH, '글 내용·토큰을 싣지 않는다');
  host.stop();
});

test('받은 일이 오류로 끝나면(러너 실패 등) 코드를 한 줄로 남긴다', async () => {
  const { host, server, logs, last } = await setup({ detect: async () => ({ claude: { installed: true, authed: true } }), chat: async () => { throw Object.assign(new Error('비밀 지시 실패'), { code: 'runner_unavailable' }); } });
  host.start();
  await until(() => last()?.state === 'ok' && server.agentIds.has('co-1/pm'));
  const o = server.offer({ agent: server.agentIds.get('co-1/pm') });
  server.push(o);
  await until(() => logs.some((l) => /work failed/.test(l)));
  assert.ok(logs.some((l) => /work failed/.test(l) && /runner_unavailable/.test(l) && l.includes(o.work)), logs.join('\n'));
  assert.ok(!logs.some((l) => /비밀 지시/.test(l)), '오류 문구(사용자 글이 섞일 수 있다)는 싣지 않는다');
  host.stop();
});

test('설정 메신저 칸(linkStatusView): 정상은 표지만, 폐기·로그인 없음은 로그인 단추, 러너 0개는 AI 연결 단추, 연결부가 돌지 않으면 표지 없음 — 사전 키는 ko·en 둘 다', async () => {
  const { linkStatusView } = await import('../app/c/[ws]/settings/msgr-card.mjs');
  const { LINK_STATES } = await import('../src/agent-link-status.mjs');
  const { readFile } = await import('node:fs/promises');
  assert.equal(linkStatusView(null), null);
  assert.equal(linkStatusView({ state: 'off' }), null, '연결부가 돌지 않음 — 종전 카드 그대로');
  assert.deepEqual(linkStatusView({ state: 'ok' }), { tone: 'ok', chip: 'settings.msgr.link.chip.ok', line: null, action: null }, '정상 = 표지만(규칙집 7-10)');
  assert.deepEqual(linkStatusView({ state: 'reauth', code: 'device_revoked' }), { tone: 'warn', chip: 'settings.msgr.link.chip.reauth', line: 'settings.msgr.link.line.reauth', action: 'login' });
  assert.equal(linkStatusView({ state: 'signed_out' }).action, 'login');
  assert.equal(linkStatusView({ state: 'no_runners' }).action, 'runners');
  assert.equal(linkStatusView({ state: 'update_required' }).action, 'update');
  assert.notEqual(linkStatusView({ state: 'ok' }).chip, linkStatusView({ state: 'reauth' }).chip, '폐기된 기기를 연결됨으로 보이지 않는다');
  const dict = await readFile(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  const keys = new Set(['settings.msgr.link.title', 'settings.msgr.link.toRunners']);
  for (const st of LINK_STATES) { const v = linkStatusView({ state: st }); if (v) { keys.add(v.chip); if (v.line) keys.add(v.line); } }
  for (const k of keys) assert.match(dict, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['(?:[^'\\\\]|\\\\.)+', (?:'[^']+'|"[^"]+")\\]`), `사전 ko·en ${k}`);
  const page = await readFile(new URL('../app/c/[ws]/settings/page.jsx', import.meta.url), 'utf8');
  assert.match(page, /linkStatusView\(archive\?\.link\)/, 'v2 카드가 연결부 상태를 읽는다');
  const route = await readFile(new URL('../app/api/companies/[ws]/msgr-archive/route.js', import.meta.url), 'utf8');
  assert.match(route, /const link = v2 \? linkStatus\(\) : null;/);
});
