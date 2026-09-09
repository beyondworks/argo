// 메신저 로그인 = 브라우저 핸드오프(Argo 앱과 같은 계약) — 순수 모듈 행동 + 셸(pair.rs)·화면·i18n 핀.
//  · authorizeUrl: 루프백 착지(127.0.0.1:<port>/auth/paired?pair=<code>)를 redirect_to로, provider는 google·github만
//  · handoff: 셸 없으면 not_app / pair_start 실패 start_failed / 브라우저 못 열면 open_failed / expired 즉시 중단 / ready면 토큰 / 시간 초과 timeout
//  · 이메일 OTP 경로(signInWithOtp·verifyOtp)는 화면에서 사라졌다(2026-09-07 라이브 실측: 메일에 코드가 안 실림)
//  · pair.rs: 루프백 바인드·verifier 회수·승인 없는 봉인 금지·no-store, lib.rs가 두 커맨드를 등록
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authorizeUrl, handoff, PAIR_TIMEOUT_MS, PROVIDERS } from '../apps/messenger/src/oauth-handoff.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SB = 'https://x.supabase.co';
const mkDeps = ({ start = { port: 53127, code: 'c1', verifier: 'v1' }, claims = [], open = async () => {} } = {}) => {
  const calls = { invoke: [], opened: [] }; let clock = 0; const q = [...claims];
  return { calls, deps: {
    invoke: async (cmd, args) => { calls.invoke.push([cmd, args]); if (cmd === 'pair_start') { if (start instanceof Error) throw start; return start; } return q.length ? q.shift() : { status: 'pending' }; },
    openUrl: async (u) => { calls.opened.push(u); await open(u); },
    sleep: async (ms) => { clock += ms; }, now: () => clock,
  } };
};

test('authorizeUrl: 루프백 착지 + provider 화이트리스트', () => {
  const u = new URL(authorizeUrl({ supabaseUrl: SB, port: 53127, provider: 'github', code: 'ab c' }));
  assert.equal(u.origin + u.pathname, SB + '/auth/v1/authorize');
  assert.equal(u.searchParams.get('provider'), 'github');
  assert.equal(u.searchParams.get('redirect_to'), 'http://127.0.0.1:53127/auth/paired?pair=ab%20c');
  assert.deepEqual(PROVIDERS, ['google', 'github']);
  assert.throws(() => authorizeUrl({ supabaseUrl: SB, port: 1, provider: 'email', code: 'x' }), /unknown provider/);
});

test('handoff: 셸 없음 → not_app, 브라우저·서버 호출 0', async () => {
  const { calls, deps } = mkDeps(); delete deps.invoke;
  await assert.rejects(handoff({ supabaseUrl: SB, provider: 'google' }, deps), /not_app/);
  assert.equal(calls.opened.length, 0);
});

test('handoff: pair_start 실패·반쪽 응답 → start_failed, 브라우저를 열지 않는다', async () => {
  for (const start of [new Error('boom'), { port: 1 }, null]) {
    const { calls, deps } = mkDeps({ start });
    await assert.rejects(handoff({ supabaseUrl: SB, provider: 'google' }, deps), /start_failed/);
    assert.equal(calls.opened.length, 0);
  }
});

test('handoff: 브라우저 못 열면 open_failed(폴링 없음)', async () => {
  const { calls, deps } = mkDeps({ open: async () => { throw new Error('nope'); } });
  await assert.rejects(handoff({ supabaseUrl: SB, provider: 'google' }, deps), /open_failed/);
  assert.equal(calls.invoke.filter(([c]) => c === 'pair_claim').length, 0);
});

test('handoff: pending… → ready면 토큰 반환, claim은 code+verifier로', async () => {
  const { calls, deps } = mkDeps({ claims: [{ status: 'pending' }, { status: 'pending' }, { status: 'ready', access_token: 'A', refresh_token: 'R' }] });
  const tok = await handoff({ supabaseUrl: SB, provider: 'google' }, deps);
  assert.deepEqual(tok, { access_token: 'A', refresh_token: 'R' });
  assert.equal(calls.opened.length, 1); assert.match(calls.opened[0], /provider=google/);
  const claim = calls.invoke.find(([c]) => c === 'pair_claim');
  assert.deepEqual(claim[1], { code: 'c1', verifier: 'v1' });
});

test('handoff: ready인데 토큰이 비면 계속 기다린다(반쪽 세션을 심지 않는다) → 결국 timeout', async () => {
  const { deps } = mkDeps({ claims: [{ status: 'ready', access_token: 'A' }] });
  await assert.rejects(handoff({ supabaseUrl: SB, provider: 'github' }, deps), /timeout/);
});

test('handoff: expired는 즉시 중단, 5분 넘기면 timeout', async () => {
  const a = mkDeps({ claims: [{ status: 'expired' }] });
  await assert.rejects(handoff({ supabaseUrl: SB, provider: 'github' }, a.deps), /expired/);
  assert.equal(a.calls.invoke.filter(([c]) => c === 'pair_claim').length, 1);
  const b = mkDeps();
  await assert.rejects(handoff({ supabaseUrl: SB, provider: 'github' }, b.deps), /timeout/);
  assert.ok(b.deps.now() >= PAIR_TIMEOUT_MS);
});

test('화면·셸·i18n 핀: OTP 제거, 두 provider 버튼, 셸 커맨드 등록, 루프백 서버 원칙', () => {
  const app = read('apps/messenger/src/App.jsx');
  const auth = app.slice(app.indexOf('function Auth('), app.indexOf('function Shell('));
  assert.doesNotMatch(auth, /signInWithOtp|verifyOtp/, '이메일 OTP 경로는 화면에서 제거(코드 없는 메일·SMTP 상한)');
  assert.match(auth, /viaBrowser\('google'\)/); assert.match(auth, /viaBrowser\('github'\)/);
  assert.match(auth, /supabase\.auth\.setSession\(tokens\)/, '회수한 토큰을 이 앱의 세션으로');
  assert.match(auth, /\(import\.meta\.env\.DEV \|\| import\.meta\.env\.VITE_DEV_LOGIN === '1'\) && \(/, '비밀번호 로그인은 dev 빌드 또는 검수용 번들 플래그에서만');
  const lib = read('apps/messenger/src-tauri/src/lib.rs');
  assert.match(lib, /generate_handler!\[pair::pair_start, pair::pair_claim, agents::agent_connect, agents::agent_list\]/, '셸 커맨드 = 페어링 2종 + 외부 에이전트 원클릭 연결');
  const pair = read('apps/messenger/src-tauri/src/pair.rs');
  assert.match(pair, /TcpListener::bind\(\("127\.0\.0\.1", 0\)\)/, '루프백·임시 포트');
  assert.match(pair, /e\.verifier == verifier/, '회수는 verifier 일치');
  assert.match(pair, /Some\(e\) if e\.session\.is_none\(\)/, '봉인은 1회');
  assert.match(pair, /Cache-Control: no-store/);
  assert.match(pair, /getElementById\('ok'\)\.onclick/, '착지 페이지는 사용자 승인 뒤에만 봉인(drive-by 차단)');
  const m = read('apps/messenger/src/i18n.js');
  const has = (k) => m.includes(`'${k}': ['`) && /\['[^']+', '[^']+'\]/.test(m.slice(m.indexOf(`'${k}': `), m.indexOf('\n', m.indexOf(`'${k}': `))));
  for (const k of ['auth.google', 'auth.github', 'auth.waiting', 'auth.cancel', 'auth.err.notApp', 'auth.err.start', 'auth.err.open', 'auth.err.timeout', 'auth.err.expired']) assert.ok(has(k), `${k} ko·en`);
  for (const k of ['auth.sendCode', 'auth.code', 'auth.sent']) assert.ok(!m.includes(`'${k}'`), `${k} 죽은 키 제거`);
});
