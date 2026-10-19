// 서버가 정하는 최소 앱 버전(유건 2026-10-13) — 옛 버전 기기는 기기 세션을 쓰지 않고(주기 호출 0) 일시 정지 화면을 띄운다.
// 경우 표: 최신·경계(같은 버전)·낮은 버전·버전 미상·서버 값 없음·옛 서버(함수 없음)·오프라인(확인 실패)·재시작(파일 유지)·값 낮춤(풀림)·확인 주기.
// 실제 getFreshDeviceSession을 임시 데이터 루트로 돌린다(서버 확인은 가짜 클라이언트 — 네트워크 없음).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-app-gate-'));
const G = await import('../src/app-gate.mjs');
const { getFreshDeviceSession } = await import('../src/devicesession.mjs');

const nowSec = () => Math.floor(Date.now() / 1000);
const mkRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-app-gate-root-'));
  await writeFile(join(root, '.device-session.json'), JSON.stringify({ url: 'http://127.0.0.1:9', anonKey: 'anon', user: { id: 'u1' }, access_token: 'at', refresh_token: 'rt', expires_at: nowSec() + 3600 }));
  return root;
};
/** 가짜 확인 클라이언트 — 서버 함수 답을 정하고 부른 횟수를 센다 */
const gateClient = (answer) => { const calls = []; const mk = (url, key, opts) => ({ rpc: async (name, args) => { calls.push({ name, args, auth: opts?.global?.headers?.Authorization }); return answer(); } }); mk.calls = calls; return mk; };
const settle = () => new Promise((r) => setTimeout(r, 20));
beforeEach(() => G._resetAppGateForTest());

test('비교(순수): 낮은 버전만 막는다 — 같은 버전(경계)·높은 버전·최소 버전 없음·이 앱 버전 미상은 막지 않는다', () => {
  assert.equal(G.belowMin('0.1.106', '0.1.107'), true);
  assert.equal(G.belowMin('0.1.99', '0.1.100'), true, '자리수가 다른 버전(문자열 비교였다면 거짓)');
  assert.equal(G.belowMin('0.1.107', '0.1.107'), false, '경계');
  assert.equal(G.belowMin('0.2.0', '0.1.107'), false);
  assert.equal(G.belowMin('0.1.106', null), false, '서버 값 없음');
  assert.equal(G.belowMin(null, '0.1.107'), false, '버전 미상 — 비교할 수 없으면 막지 않는다');
  assert.equal(G.belowMin('0.0.0', '0.1.107'), false, "'0.0.0'도 모름 — 번들에서 버전을 못 읽던 설치본 결함(0.1.101)에서 최신 앱을 막지 않는다");
  assert.equal(G.belowMin('v0.0.0', '0.1.107'), false);
  assert.equal(G.belowMin('0.0.1', '0.1.107'), true, '0.0.0만 모름으로 본다');
});

test('최소 버전 미만이면 기기 세션이 없다(동기화·메신저·알림 호출 0의 관문) — 서버 확인 뒤 다음 호출부터', async () => {
  const root = await mkRoot();
  const mk = gateClient(() => ({ data: '0.1.107', error: null }));
  const first = await getFreshDeviceSession({ root, _gateClient: mk, _version: '0.1.106' });
  assert.ok(first, '처음 확인 전에는 막지 않는다(판정 파일 없음)');
  await settle();
  assert.equal(mk.calls.length, 1, '서버에 한 번 묻는다');
  assert.equal(mk.calls[0].name, 'argo_min_app_version'); assert.deepEqual(mk.calls[0].args, { p_app: 'desktop' });
  assert.equal(mk.calls[0].auth, 'Bearer at', '기기 세션의 접속 토큰으로');
  assert.equal(await getFreshDeviceSession({ root, _gateClient: mk, _version: '0.1.106' }), null, '낮은 버전 — 세션 없음');
  assert.ok(await getFreshDeviceSession({ root, _gateClient: mk, _version: '0.1.107' }), '경계(같은 버전) — 그대로');
  assert.ok(await getFreshDeviceSession({ root, _gateClient: mk, _version: '0.1.110' }), '최신 — 그대로');
  assert.ok(await getFreshDeviceSession({ root, _gateClient: mk, _version: null }), '버전 미상 — 그대로');
  await settle();
  assert.equal(mk.calls.length, 1, '확인은 30분에 한 번 — 세션을 꺼낼 때마다 묻지 않는다');
  const st = G.appGateState(root, '0.1.106');
  assert.equal(st.blocked, true); assert.equal(st.min, '0.1.107');
});

test('재시작해도(메모 없음) 판정 파일로 막힌 채다 — 확인 실패(오프라인)는 판정을 바꾸지 않고 5분 뒤 다시 묻는다', async () => {
  const root = await mkRoot();
  await writeFile(join(root, G.APP_GATE_FILE), JSON.stringify({ min: '0.1.107', checkedAt: Date.now() - G.APP_GATE_RECHECK_MS - 1 }));
  const offline = gateClient(() => { throw new Error('fetch failed'); });
  assert.equal(await getFreshDeviceSession({ root, _gateClient: offline, _version: '0.1.106' }), null, '파일 판정으로 막힘');
  await settle();
  assert.equal(offline.calls.length, 1, '기한이 지나 한 번 묻고 실패');
  const after = JSON.parse(await readFile(join(root, G.APP_GATE_FILE), 'utf8'));
  assert.equal(after.min, '0.1.107', '실패는 판정을 바꾸지 않는다(오프라인에서 풀리지 않게)');
  assert.ok(Date.now() - after.checkedAt >= G.APP_GATE_RECHECK_MS - G.APP_GATE_RETRY_MS - 1000, '5분 뒤 다시 묻는 시각으로 남긴다');
  G._resetAppGateForTest();
  assert.equal(await getFreshDeviceSession({ root, _gateClient: offline, _version: '0.1.106' }), null, '재시작(메모 없음)에도 막힘');
  await settle();
  assert.equal(offline.calls.length, 1, '5분 안에는 다시 묻지 않는다');
});

test('서버가 값을 지우면(또는 낮추면) 다음 확인에서 풀린다 — 막힌 동안에도 확인은 계속된다', async () => {
  const root = await mkRoot();
  await writeFile(join(root, G.APP_GATE_FILE), JSON.stringify({ min: '0.1.107', checkedAt: Date.now() - G.APP_GATE_RECHECK_MS - 1 }));
  const cleared = gateClient(() => ({ data: null, error: null }));
  assert.equal(await getFreshDeviceSession({ root, _gateClient: cleared, _version: '0.1.106' }), null, '이번 호출은 아직 막힘(확인은 뒤에서)');
  await settle();
  assert.equal(cleared.calls.length, 1, '막힌 동안에도 묻는다');
  assert.ok(await getFreshDeviceSession({ root, _gateClient: cleared, _version: '0.1.106' }), '값이 없어져 풀림');
});

test('옛 서버(함수 없음 PGRST202)는 막지 않는다 — 서버 값 없음과 같다', async () => {
  const root = await mkRoot();
  const old = gateClient(() => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }));
  await getFreshDeviceSession({ root, _gateClient: old, _version: '0.0.1' }); await settle();
  assert.ok(await getFreshDeviceSession({ root, _gateClient: old, _version: '0.0.1' }));
  assert.equal(G.readAppGate(root).min, null);
});

test('기기 세션이 없으면(로그인 전) 서버에 묻지 않는다 — 판정 파일도 만들지 않는다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-app-gate-empty-'));
  const mk = gateClient(() => ({ data: '9.9.9', error: null }));
  assert.equal(await getFreshDeviceSession({ root, _gateClient: mk, _version: '0.1.106' }), null);
  await settle();
  assert.equal(mk.calls.length, 0);
  assert.equal(existsSync(join(root, G.APP_GATE_FILE)), false);
});

test('메신저 세션 클라이언트도 막힌 동안 null — 브리지·알림이 "세션 없음" 경로로 멈춘다', async () => {
  const { WS_ROOT } = await import('../src/workspace.mjs');
  await writeFile(join(WS_ROOT, '.device-session.json'), JSON.stringify({ url: 'http://127.0.0.1:9', anonKey: 'anon', user: { id: 'u1' }, access_token: 'at2', refresh_token: 'rt', expires_at: nowSec() + 3600 }));
  const { sessionClient } = await import('../src/gateway/msgr.mjs');
  await writeFile(join(WS_ROOT, G.APP_GATE_FILE), JSON.stringify({ min: '0.1.106', checkedAt: Date.now() }));
  const ok = await sessionClient();
  assert.ok(ok?.client, '이 앱(package.json 버전)이 최소 버전 이상이면 그대로');
  await writeFile(join(WS_ROOT, G.APP_GATE_FILE), JSON.stringify({ min: '99.0.0', checkedAt: Date.now() }));
  G._resetAppGateForTest();
  assert.equal(await sessionClient(), null, '최소 버전 미만 — 세션 없음');
});

test('판정 파일은 동기화하지 않는다 — 기기마다 그 앱 버전으로 내린 판정(다른 기기로 넘기면 안 된다)', async () => {
  const { EXCLUDE } = await import('../src/sync.mjs');
  // 전체 암호화 스위치가 꺼진 기기에서도 제외돼야 한다 — 스위치가 켜지고 키가 없으면 다른 규칙(암호화 대상인데 키 없음)이 대신 거르지만,
  // 키가 있거나 스위치가 꺼지면 그 규칙이 빠진다. 이 파일 자체의 제외 줄을 잠그려고 스위치를 끄고 본다(ARGO_ENC_VAULT는 매번 다시 읽는다).
  const prev = process.env.ARGO_ENC_VAULT;
  process.env.ARGO_ENC_VAULT = '0';
  try {
    assert.equal(EXCLUDE('notes.md'), false, '전제: 평범한 파일은 동기화 대상');
    assert.equal(EXCLUDE(G.APP_GATE_FILE), true);
    assert.equal(EXCLUDE(`some-co/${G.APP_GATE_FILE}`), true, '회사 폴더 안에 생겨도');
  } finally { if (prev === undefined) delete process.env.ARGO_ENC_VAULT; else process.env.ARGO_ENC_VAULT = prev; }
});

// 0.1.114부터 관문 요청에도 X-Client-Info 끝 ' argo/<버전>' — 서버가 관문 기록에 이 세션의 앱 버전을 남겨, 옛 앱 사용 중지 장치(20261019135000)가
// 이 세션의 꼬리 없는 다른 요청을 옛 앱으로 오인하지 않게 한다. 꼬리가 빠지면 기준 0.1.113에서 새 앱 세션이 폐기될 수 있다.
test('appGateClient의 관문 요청은 X-Client-Info에 argo/<앱 버전> 꼬리를 단다(supabase-js 기본값 보존)', async () => {
  const { appGateClient } = await import('../src/app-gate.mjs');
  const { ARGO_CLIENT_INFO } = await import('../src/app-version.mjs');
  assert.ok(ARGO_CLIENT_INFO, '시험 환경에서 앱 버전을 읽지 못했다');
  const real = globalThis.fetch; let seen = null;
  globalThis.fetch = async (u, init = {}) => { seen = new Headers(init.headers).get('x-client-info'); return new Response('"0.1.107"', { status: 200, headers: { 'content-type': 'application/json' } }); };
  try {
    const sb = appGateClient('http://127.0.0.1:9', 'anon', { auth: { persistSession: false, autoRefreshToken: false } });
    await sb.rpc('argo_min_app_version', { p_app: 'desktop' });
  } finally { globalThis.fetch = real; }
  assert.match(seen ?? '', /^supabase-js\/[^ ]+; runtime=node/, 'supabase-js 기본 X-Client-Info가 남아 있어야 한다');
  assert.ok((seen ?? '').split(' ').includes(ARGO_CLIENT_INFO), `꼬리가 없다: ${seen}`);
});
