// 대체 실행 뒤 사용 한도 — 방 문구가 마지막 원인(한도)과 순서(지정 러너 → 대체 러너 → 한도)를 말한다(2026-10-16 11:43 KST 맥 one 상주 운영).
// 개인 공간 '다빈치'(카드 codex)가 codex 실패 → 자가치유로 claude → claude 주간 한도로 실패했는데, 방에는 원인 없는 문구가 올랐다.
// 시험 대역 재현(이 파일 F1): codex가 인증 오류로 빠진 사슬은 방에 "Codex 로그인이 만료"만 말해 마지막 원인(Claude 한도)이 가려졌다 — 다시 로그인해도 또 한도에 걸린다.
// 잠그는 계약(경우 표 — PR 본문):
//  F1 지정 러너 인증 오류 → 대체 러너 한도(주인 요청): "Codex 로그인 만료 → Claude로 넘김 → Claude 한도 · 해제 시각 · 할 일", ko·en, 원문 없음
//  F2 지정 러너 잠김(인증 아님) → 대체 러너 한도: "Codex 대신 Claude → 한도"(인증 오류라고 말하지 않는다)
//  F3 남의 요청: 방은 종전(로그인 만료는 누구에게나 그 러너), 주인 1:1 안내에 순서·한도(묶음 기준에 지정 러너)
//  F4 대체 뒤 인증(대체 러너도 로그인 만료)·대체 뒤 다른 실패·대체 대상 없음: 종전 그대로 처음 만료된 러너
//  (대체 없는 한도 = msgr-claim-runner-yield LIM-2·LIM-3이 잠근다 — from 없음)
// 실제 chat(): 러너 해석·codex CLI 실행만 대역, claude는 실제 SDK를 로컬 가짜 Messages 엔드포인트로(ARGO_CLAUDE_BASE_URL — 실자격·비용 0).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { registerHooks } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-fallback-limit-home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-fallback-limit-'));
process.env.ARGO_CACHE_DIR = join(process.env.ARGO_ROOT, 'cache');
Object.assign(process.env, { ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

// 가짜 Messages 엔드포인트 — claude 턴의 실패 모양을 경우마다 고른다(SDK가 재시도하지 않는 4xx만)
const WEEKLY = "You've hit your weekly limit · resets Oct 19 at 1pm (Asia/Seoul)";
let vendor = 'limit';
const srv = http.createServer((req, res) => {
  let b = ''; req.setEncoding('utf8'); req.on('data', (c) => { b += c; }); req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      const [status, type, message] = vendor === 'limit' ? [400, 'invalid_request_error', WEEKLY]
        : vendor === 'auth' ? [400, 'invalid_request_error', 'OAuth session expired'] // 401은 SDK가 수 분 재시도한다 — 같은 인증 분류(AUTH_ERR_RE)를 400으로
        : [400, 'invalid_request_error', 'messages: unexpected payload shape'];
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type, message } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

const wrappers = new Map();
for (const [relative, replacements] of [
  ['./runners.mjs', `
    export const resolveRunner = async (_ws, _want, { exclude = [] } = {}) => { // 사슬 순서대로 아직 안 뺀 첫 러너 — 카드 러너(codex)가 빠지면 claude
      const chain = globalThis.__argoFbChain ?? ['codex', 'claude'];
      const next = chain.find((r) => !(exclude ?? []).includes(r) && !(globalThis.__argoFbDown ?? []).includes(r)); // __argoFbDown = 턴 전 판정에서 사용 불가(미연결·감지 실패)
      return next ? { runner: next, available: true, fellBack: next !== chain[0] } : { runner: chain[0], available: false };
    };
    export const isBilledRunner = async () => false;
    export const externalExec = (...args) => globalThis.__argoFbExec(...args);
    export const reprovisionRunner = async () => false; // 잠김 재조달(codex 관리본 내려받기)을 하지 않는다
  `],
  ['./connectors.mjs', 'export const connectorBriefing = async () => [];'],
  ['./runners/catalog-remote.mjs', 'export const loadRemoteCatalog = async () => null;'],
]) {
  const real = new URL(`../src/${relative.slice(2)}`, import.meta.url).href;
  wrappers.set(relative, `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(real)};\n${replacements}`)}`);
}
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (/\/src\/chat\.mjs$/.test(context.parentURL ?? '') && wrappers.has(specifier)) return { url: wrappers.get(specifier), shortCircuit: true };
  return next(specifier, context);
} });
after(() => { hooks.deregister(); delete globalThis.__argoFbExec; delete globalThis.__argoFbChain; delete globalThis.__argoFbDown; });

const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { readEvents } = await import('../src/events.mjs');
const { chat } = await import('../src/chat.mjs');
const { roomTurnFailureFor } = await import('../src/gateway/msgr-room-errors.mjs');
const { ownerNoticeCause, ownerNoticeText, sendOwnerNotice } = await import('../src/gateway/msgr-owner-notice.mjs');
const { runnerPickReasonLine } = await import('../src/runners.mjs');

const CODEX_AUTH = 'Failed to authenticate: OAuth session expired. Please run /login'; // 상주 실측 원문 모양(AUTH_ERR_RE)
const RAW = /weekly limit|You've hit|OAuth session|\/login|unexpected payload|sk-proj|sk-ant/; // 방에 실리면 안 되는 원문·자격

let seq = 0;
async function turn({ codex = () => new Error('codex should not run'), chain = ['codex', 'claude'], claude = 'limit', down = [] }) {
  const ws = `fb-${++seq}`;
  await createCompany(ws, '대체 한도', 'owner', null, 'ko');
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'davinci.md'), '---\nname: 다빈치\nrole: 검증\nrunner: codex\n---\n검증용.\n');
  await saveRunnerCred(ws, 'codex', 'apikey', `sk-proj-${'y'.repeat(40)}`);
  await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만
  globalThis.__argoFbChain = chain; globalThis.__argoFbDown = down; vendor = claude;
  const calls = [];
  globalThis.__argoFbExec = async (o) => { calls.push(o?.runner ?? o); throw codex(); };
  let err = null; const warns = []; const warn = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); warn(...a); };
  try { await chat(ws, 'davinci', '안녕', null, {}).catch((e) => { err = e; }); } finally { console.warn = warn; }
  assert.ok(err, '턴은 실패해야 한다');
  return { ws, err, calls, warns, own: (lang) => roomTurnFailureFor(err, lang, { ownerCause: ownerNoticeCause(err) }), other: (lang) => roomTurnFailureFor(err, lang) };
}

test('F1. 지정 러너(codex) 인증 오류 → claude로 넘김 → claude 주간 한도: 주인 방 문구가 순서·해제 시각·할 일을 말한다(ko·en, 원문 없음)', async () => {
  const t = await turn({ codex: () => new Error(CODEX_AUTH) });
  assert.deepEqual(t.calls, ['codex'], '자가치유는 종전 그대로 — codex 한 번, 그다음 claude(SDK)');
  assert.equal(t.err.failCode, 'quota', `마지막 원인은 대체 러너의 한도(${t.err.failCode})`);
  assert.equal(t.err.authFailedRunner, 'codex');
  assert.deepEqual(ownerNoticeCause(t.err), { kind: 'limit', runner: 'claude', resets: { month: 10, day: 19, hour: 13, minute: 0, tz: 'Asia/Seoul' }, from: 'codex', fromAuth: true });
  const ko = t.own('ko');
  assert.equal(ko, '지정 러너 Codex의 로그인이 만료돼 Claude(으)로 넘겼지만, 내 실행기의 Claude 사용 한도에 걸려 답하지 못했습니다 · 10/19 13:00에 풀립니다. Argo 데스크톱 설정 → AI 연결에서 Codex에 다시 로그인하거나, 한도가 풀린 뒤 다시 보내세요.');
  const en = t.own('en');
  assert.match(en, /^The Codex login \(this agent's assigned runner\) has expired, so it switched to Claude, but the Claude usage limit was reached \(resets Oct 19, 1:00 PM\)/);
  for (const s of [ko, en]) assert.doesNotMatch(s, RAW, `원문·자격이 방에 샜다: ${s}`);
  // 활동 기록(주인만 보는 원문)은 종전 그대로 — 실패 러너 사건(selfHealed·authLost)과 대체 러너 사건(fellBackFrom)
  const evs = (await readEvents(t.ws, 50)).filter((e) => e.type === 'turn');
  assert.ok(evs.some((e) => e.runner === 'codex' && e.selfHealed && e.authLost), '자가치유 직전 codex 실패 기록');
  assert.ok(evs.some((e) => e.runner === 'claude' && e.fellBackFrom === 'codex' && e.failCode === 'quota'), '대체 러너 실패 기록');
});

test('F2. 지정 러너(codex) 도구 잠김 → claude 한도: "Codex 대신 Claude → 한도"(인증 오류라고 말하지 않는다)', async () => {
  const t = await turn({ codex: () => Object.assign(new Error('codex tool lockup'), { toolLockup: true }) });
  assert.equal(t.err.authFailedRunner, undefined, '인증 오류가 아니다');
  assert.equal(t.err.fellBackFrom, 'codex', '대신 돈 지정 러너가 오류에 남는다');
  const c = ownerNoticeCause(t.err);
  assert.equal(c.from, 'codex'); assert.equal(c.fromAuth, false);
  const ko = t.own('ko');
  assert.equal(ko, '지정 러너 Codex 대신 Claude(으)로 답하려 했지만, 내 실행기의 Claude 사용 한도에 걸려 답하지 못했습니다 · 10/19 13:00에 풀립니다. 풀린 뒤 다시 보내거나, Argo 데스크톱에서 이 에이전트의 러너를 확인하세요(연결된 러너가 없으면 설정 → AI 연결).');
  assert.doesNotMatch(ko, /로그인/);
  assert.match(t.own('en'), /^It tried Claude instead of this agent's assigned runner Codex, but the Claude usage limit was reached \(resets Oct 19, 1:00 PM\)/);
});

test('F3. 남의 요청 — 방은 종전(Codex 로그인 만료, 누구에게나), 주인 1:1 안내에 순서·한도, 묶음 기준에 지정 러너', async () => {
  const t = await turn({ codex: () => new Error(CODEX_AUTH) });
  assert.match(t.other('ko'), /^이 에이전트를 돌리는 실행기의 Codex 로그인이 만료돼 답하지 못했습니다/, '남에게는 한도(주인 설정 정보)를 말하지 않는다 — 종전 문구');
  const cause = ownerNoticeCause(t.err);
  assert.equal(ownerNoticeText(cause, 'ko'), '다른 분의 요청에 답하지 못했습니다. 지정 러너 Codex의 로그인이 만료돼 Claude(으)로 넘겼지만, 이 실행기의 Claude 사용 한도에 걸렸습니다 · 10/19 13:00에 풀립니다. Argo 데스크톱 설정 → AI 연결에서 Codex에 다시 로그인하거나, 한도가 풀린 뒤 다시 받아 주세요.');
  assert.match(ownerNoticeText(cause, 'en'), /The Codex login \(this agent's assigned runner\) has expired, so it switched to Claude, but the Claude usage limit on this runner was reached \(resets Oct 19, 1:00 PM\)/);
  const sent = [];
  await sendOwnerNotice({ c: {}, wsId: 'w', slug: 's', cause, lang: 'ko', now: 0 }, { personalRoom: async () => ({ channelId: 'c' }), insertNotice: async (_c, _r, x) => { sent.push(x); return 'sent'; } });
  assert.equal(sent[0].basis, 'runner-fail:limit:claude:from-codex:0', '대체 뒤 한도는 지정 러너를 기준에 — Claude 한도 단독 안내와 묶여 Codex 만료를 못 듣는 일이 없게');
  assert.deepEqual(sent[0].meta, { kind: 'limit', runner: 'claude' });
});

test('F4. 인접 핀 — 대체 뒤 인증(claude도 만료)·대체 뒤 다른 실패·대체 대상 없음은 종전 그대로 처음 만료된 러너(Codex)', async () => {
  const both = await turn({ codex: () => new Error(CODEX_AUTH), claude: 'auth' });
  assert.match(both.own('ko'), /^이 에이전트를 돌리는 실행기의 Codex 로그인이 만료돼/, `대체 뒤 인증: ${both.own('ko')}`);
  const other = await turn({ codex: () => new Error(CODEX_AUTH), claude: 'other' });
  assert.match(other.own('ko'), /^이 에이전트를 돌리는 실행기의 Codex 로그인이 만료돼/, `대체 뒤 다른 실패: ${other.own('ko')}`);
  const alone = await turn({ codex: () => new Error(CODEX_AUTH), chain: ['codex'] });
  assert.deepEqual(alone.calls, ['codex'], '넘길 러너가 없으면 codex 한 번');
  assert.equal(alone.err.fellBackFrom, undefined);
  assert.deepEqual(ownerNoticeCause(alone.err), { kind: 'auth', runner: 'codex' });
  assert.match(alone.own('ko'), /^이 에이전트를 돌리는 실행기의 Codex 로그인이 만료돼/);
  for (const t of [both, other, alone]) assert.doesNotMatch(t.own('ko'), RAW);
});

test('F5. 인접 핀(분리 검수 LOW) — 대체 없는 단일 러너가 인증 표지와 한도 낱말을 함께 가지면 종전대로 로그인 만료', () => {
  const e = Object.assign(new Error('429 rate limit'), { authError: true, authExpired: 'codex', failCode: 'quota', failRunner: 'codex' });
  assert.deepEqual(ownerNoticeCause(e), { kind: 'auth', runner: 'codex' });
  assert.match(roomTurnFailureFor(e, 'ko', { ownerCause: ownerNoticeCause(e) }), /^이 에이전트를 돌리는 실행기의 Codex 로그인이 만료돼/);
});

// 11:43 운영의 실제 모양(맥 one events.jsonl): codex 줄 없이 claude 한 줄, fellBackFrom codex, failCode quota, error 머리 "지정 러너 Codex가 이 기기에 연결돼 있지 않아…".
// = codex를 실행하지 않고 턴 전 판정(pickRunner)이 사용 불가로 보고 claude로 넘긴 갈래. 이 코드(주인 요청)는 한도 문구를 낸다 — 방의 일반 문구는 이 코드 밖(PR 본문 "남은 것").
test('F6. 턴 전 판정으로 대체("이 기기에 연결돼 있지 않아") → claude 한도: 주인 방 문구에 순서·한도, 대체 근거 진단 한 줄(값은 참거짓·종류·감지 시각)', async () => {
  const t = await turn({ down: ['codex'] });
  assert.deepEqual(t.calls, [], 'codex는 실행되지 않는다');
  assert.equal(t.err.failCode, 'quota'); assert.equal(t.err.fellBackFrom, 'codex'); assert.equal(t.err.authFailedRunner, undefined);
  assert.match(String(t.err.message), /^지정 러너 Codex가 이 기기에 연결돼 있지 않아 Claude\(으\)로 대체 실행됐습니다\. API Error: 400 You've hit your weekly limit/, '운영 기록과 같은 모양');
  assert.equal(t.own('ko'), '지정 러너 Codex 대신 Claude(으)로 답하려 했지만, 내 실행기의 Claude 사용 한도에 걸려 답하지 못했습니다 · 10/19 13:00에 풀립니다. 풀린 뒤 다시 보내거나, Argo 데스크톱에서 이 에이전트의 러너를 확인하세요(연결된 러너가 없으면 설정 → AI 연결).');
  assert.match(t.other('ko'), /^에이전트가 지금 답하지 못했습니다\./, '남의 요청은 종전 일반 문구(한도는 주인 1:1 안내)');
  const diag = t.warns.filter((w) => w.includes('러너 대체('));
  assert.equal(diag.length, 1, `대체 턴마다 한 줄(${diag.length})`);
  assert.match(diag[0], /지정 codex 사용 불가 → claude · connected=true type=apikey invalid=false unsupported=false installed=(true|false) authed=(true|false) 감지=/);
  assert.doesNotMatch(diag[0], /sk-proj|sk-ant|\/Users\/|\/home\//, '자격 값·경로를 싣지 않는다');
});

test('F7. 진단 줄은 자가치유 대체(인증 오류로 제외)에는 남기지 않는다 — 판정 근거가 아니라 실행 실패라서', async () => {
  const t = await turn({ codex: () => new Error(CODEX_AUTH) });
  assert.equal(t.warns.filter((w) => w.includes('러너 대체(')).length, 0);
  assert.equal(runnerPickReasonLine('codex', 'claude', { connected: true, type: 'host', invalid: true, installed: false, authed: false, detectedAt: 1_000 }, 61_000),
    '지정 codex 사용 불가 → claude · connected=true type=host invalid=true unsupported=false installed=false authed=false 감지=1970-01-01T00:00:01.000Z(60초 전)');
  assert.match(runnerPickReasonLine('codex', 'claude', null), /connected=false type=- .* 감지=-$/, '근거를 못 읽으면 빈 값');
  assert.match(runnerPickReasonLine('codex', 'claude', { detectedAt: 1_000, freshDetect: true }, 1_000), /감지=1970-01-01T00:00:01\.000Z\(0초 전\)\(진단이 새로 감지 — 판정 때 감지와 다를 수 있음\)$/, '진단이 만든 감지는 판정 근거와 구분');
});
