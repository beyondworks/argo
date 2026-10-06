// argo CLI 로그인 서버 — 앱의 브라우저 핸드오프와 같은 원칙(명시적 승인·단일 소유자·첫 사용 회전)을 실행으로 잠근다.
// 가장 위험한 실패는 로그인 CSRF다: 다른 웹사이트가 127.0.0.1:<port>/bind로 공격자 토큰을 밀어 넣으면 CLI가 공격자 계정으로
// 로그인해 사장의 크루 대화가 그 계정으로 새어 나간다. nonce(리다이렉트 주소에만 있음)와 Host 검사가 그것을 막는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startLoginServer, isLoopback, sameOriginBind } from '../src/cli/login.mjs';

// 기본값은 "브라우저가 이 서버의 페이지에서 보낸 요청"(Sec-Fetch-Site: same-origin, JSON). 공격 경우는 headers로 덮는다.
const call = (port, { method = 'GET', path = '/', host, body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const base = body ? { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } : {};
  const all = Object.fromEntries(Object.entries({ ...base, ...(host ? { host } : {}), ...headers }).filter(([, v]) => v != null));
  const req = request({ host: '127.0.0.1', port, method, path, headers: all }, (res) => {
    let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
  });
  req.on('error', reject); if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body)); req.end();
});
const startPath = (srv) => new URL(srv.url).pathname + new URL(srv.url).search; // 터미널에 출력되는 첫 주소(비밀값 k 포함)

const boot = (over = {}) => {
  const saved = [];
  return startLoginServer({ supabaseUrl: 'https://sb.example', anonKey: 'anon', port: 0,
    verify: async (at) => { if (at !== 'good-access') throw new Error('bad'); return { id: 'u1', email: 'u@x.io' }; },
    save: async (s) => { saved.push(s); }, ...over }).then((srv) => ({ srv, saved }));
};

test('시작 페이지의 로그인 링크는 127.0.0.1/auth/paired로 돌아오고 nonce를 싣는다(허용 목록 그대로 — 설정 변경 없음)', async () => {
  const { srv } = await boot();
  try {
    const r = await call(srv.port, { path: startPath(srv) });
    assert.equal(r.status, 200);
    const href = decodeURIComponent(r.body.match(/href="([^"]+)"/)[1].replace(/&amp;/g, '&'));
    assert.ok(href.startsWith('https://sb.example/auth/v1/authorize?provider=google&redirect_to='));
    assert.ok(href.includes(`http://127.0.0.1:${srv.port}/auth/paired?cli=${srv._nonce}`));
  } finally { await srv.close(); }
});

test('승인하면 검증 뒤 expires_at 0으로 저장하고(첫 사용 회전), 두 번째 승인은 받지 않는다', async () => {
  const { srv, saved } = await boot();
  try {
    const ok = await call(srv.port, { method: 'POST', path: '/bind', body: { cli: srv._nonce, access_token: 'good-access', refresh_token: 'r1' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await srv.done, { id: 'u1', email: 'u@x.io' });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].expires_at, 0);
    assert.equal(saved[0].refresh_token, 'r1');
    const again = await call(srv.port, { method: 'POST', path: '/bind', body: { cli: srv._nonce, access_token: 'good-access', refresh_token: 'r2' } });
    assert.equal(again.status, 400, '한 번 로그인한 뒤 다른 토큰으로 덮어쓰지 못한다');
    assert.equal(saved.length, 1);
  } finally { await srv.close(); }
});

test('로그인 CSRF 차단 — nonce가 틀리거나 Host가 루프백이 아니면 저장하지 않는다', async () => {
  const { srv, saved } = await boot();
  try {
    assert.equal((await call(srv.port, { method: 'POST', path: '/bind', body: { cli: 'guess', access_token: 'good-access', refresh_token: 'r' } })).status, 400);
    assert.equal((await call(srv.port, { method: 'POST', path: '/bind', host: 'evil.example', body: { cli: srv._nonce, access_token: 'good-access', refresh_token: 'r' } })).status, 403, 'DNS 리바인딩');
    assert.equal((await call(srv.port, { path: `/auth/paired?cli=wrong` })).status, 400);
    assert.equal(saved.length, 0);
  } finally { await srv.close(); }
});

test('검증에 실패한 토큰은 저장하지 않는다 — 로그인은 끝나지 않고 다시 승인하면 된다', async () => {
  const { srv, saved } = await boot();
  try {
    const r = await call(srv.port, { method: 'POST', path: '/bind', body: { cli: srv._nonce, access_token: 'forged', refresh_token: 'r' } });
    assert.equal(r.status, 401);
    assert.equal(saved.length, 0);
    const ok = await call(srv.port, { method: 'POST', path: '/bind', body: { cli: srv._nonce, access_token: 'good-access', refresh_token: 'r2' } });
    assert.equal(ok.status, 200);
    assert.equal((await srv.done).id, 'u1');
  } finally { await srv.close(); }
});

test('루프백 판정(순수)', () => {
  for (const h of ['127.0.0.1:38417', 'localhost:1', '[::1]:80', '127.0.0.1']) assert.equal(isLoopback(h), true, h);
  for (const h of ['evil.example', '127.0.0.1.evil.example', '', undefined]) assert.equal(isLoopback(h), false, String(h));
});

/* ─── 검수 L1(2026-10-01): 같은 컴퓨터의 다른 프로세스가 대기 중인 로그인에 자기 계정을 밀어 넣던 결함 ─── */

test('L1 재현 경로 차단 — 비밀값 없이 GET /를 읽으면 nonce가 든 링크를 주지 않는다(포트만 아는 로컬 프로세스)', async () => {
  const { srv, saved } = await boot();
  try {
    assert.match(srv.url, /\/\?k=[0-9a-f]{32}$/, '첫 주소에 비밀값이 실린다(터미널에만 출력)');
    for (const path of ['/', '/?k=', '/?k=deadbeef']) {
      const r = await call(srv.port, { path });
      assert.equal(r.status, 403, path);
      assert.ok(!r.body.includes(srv._nonce), `${path}: nonce가 새면 안 된다`);
    }
    // 수정 전 재현과 같은 순서 — GET /에서 nonce를 못 얻었으니 /bind도 실패한다
    const r = await call(srv.port, { method: 'POST', path: '/bind', body: { cli: '', access_token: 'good-access', refresh_token: 'ATTACKER-RT' }, headers: { 'content-type': 'text/plain' } });
    assert.notEqual(r.status, 200);
    assert.equal(saved.length, 0);
  } finally { await srv.close(); }
});

test('L1 — /bind는 브라우저의 같은 출처 JSON 요청만 받는다(교차 사이트·출처 없음·text/plain 거절)', async () => {
  const { srv, saved } = await boot();
  const good = { cli: srv._nonce, access_token: 'good-access', refresh_token: 'r' };
  try {
    assert.equal((await call(srv.port, { method: 'POST', path: '/bind', body: good, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await call(srv.port, { method: 'POST', path: '/bind', body: good, headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
    assert.equal((await call(srv.port, { method: 'POST', path: '/bind', body: good, headers: { 'sec-fetch-site': null } })).status, 403, '헤더도 Origin도 없으면 거절');
    assert.equal((await call(srv.port, { method: 'POST', path: '/bind', body: good, headers: { 'sec-fetch-site': null, origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call(srv.port, { method: 'POST', path: '/bind', body: good, headers: { 'content-type': 'text/plain' } })).status, 415, '단순 요청(text/plain)은 사전 확인 없이 교차 출처로 온다');
    assert.equal(saved.length, 0);
    const ok = await call(srv.port, { method: 'POST', path: '/bind', body: good, headers: { 'sec-fetch-site': null, origin: `http://127.0.0.1:${srv.port}` } });
    assert.equal(ok.status, 200, 'Sec-Fetch-Site가 없는 옛 브라우저는 Origin이 이 서버면 받는다');
    assert.equal(saved.length, 1);
  } finally { await srv.close(); }
});

test('L1 — 모든 응답에 X-Frame-Options: DENY와 frame-ancestors none(다른 페이지가 승인 화면을 끼워 누르게 하지 못한다)', async () => {
  const { srv } = await boot();
  try {
    for (const path of [startPath(srv), `/auth/paired?cli=${srv._nonce}`, '/', '/nope']) {
      const r = await call(srv.port, { path });
      assert.equal(r.headers['x-frame-options'], 'DENY', path);
      assert.match(String(r.headers['content-security-policy']), /frame-ancestors 'none'/, path);
    }
  } finally { await srv.close(); }
});

test('L1 — 저장 전 터미널 확인: 거절하면 저장하지 않고(409) 계속 기다리며, 승인하면 저장한다', async () => {
  const asked = [];
  let answer = false;
  const { srv, saved } = await boot({ confirm: async (u) => { asked.push(u.email); return answer; } });
  let finished = false; srv.done.then(() => { finished = true; });
  try {
    const no = await call(srv.port, { method: 'POST', path: '/bind', body: { cli: srv._nonce, access_token: 'good-access', refresh_token: 'r1' } });
    assert.equal(no.status, 409);
    assert.deepEqual(asked, ['u@x.io'], '터미널에 검증된 계정 이메일을 보여 준다');
    assert.equal(saved.length, 0);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(finished, false, '거절은 로그인을 끝내지 않는다');
    answer = true;
    const yes = await call(srv.port, { method: 'POST', path: '/bind', body: { cli: srv._nonce, access_token: 'good-access', refresh_token: 'r2' } });
    assert.equal(yes.status, 200);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].refresh_token, 'r2');
    assert.equal((await srv.done).id, 'u1');
  } finally { await srv.close(); }
});

test('L1 — 터미널 확인이 진행 중이면 두 번째 승인 요청은 받지 않는다(429) — 확인 창에 다른 계정을 끼워 넣지 못한다', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { srv, saved } = await boot({ confirm: async () => { await gate; return true; } });
  try {
    const first = call(srv.port, { method: 'POST', path: '/bind', body: { cli: srv._nonce, access_token: 'good-access', refresh_token: 'r1' } });
    await new Promise((r) => setTimeout(r, 100));
    const second = await call(srv.port, { method: 'POST', path: '/bind', body: { cli: srv._nonce, access_token: 'good-access', refresh_token: 'r2' } });
    assert.equal(second.status, 429);
    release();
    assert.equal((await first).status, 200);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].refresh_token, 'r1');
  } finally { await srv.close(); }
});

test('같은 출처 판정(순수)', () => {
  const base = 'http://127.0.0.1:38417';
  assert.equal(sameOriginBind({ 'sec-fetch-site': 'same-origin' }, base), true);
  assert.equal(sameOriginBind({ 'sec-fetch-site': 'same-origin', origin: 'https://evil.example' }, base), true, 'Sec-Fetch-Site는 브라우저만 붙이는 헤더 — 있으면 그것을 따른다');
  for (const v of ['cross-site', 'same-site', 'none']) assert.equal(sameOriginBind({ 'sec-fetch-site': v, origin: base }, base), false, v);
  assert.equal(sameOriginBind({ origin: base }, base), true);
  assert.equal(sameOriginBind({ origin: 'http://localhost:38417' }, base), false);
  assert.equal(sameOriginBind({}, base), false);
  assert.equal(sameOriginBind({ origin: '' }, ''), false);
});

test('#791 LOW-6 — 검증(verify)이 느려도 동시 승인 요청 둘이 터미널 확인에 같이 들어가지 않는다(확인 1번, 나머지 429)', async () => {
  let asked = 0;
  const { srv, saved } = await boot({
    verify: async () => { await new Promise((r) => setTimeout(r, 150)); return { id: 'u1', email: 'u@x.io' }; },
    confirm: async () => { asked++; await new Promise((r) => setTimeout(r, 50)); return true; },
  });
  try {
    const body = (rt) => ({ cli: srv._nonce, access_token: 'good-access', refresh_token: rt });
    const [r1, r2] = await Promise.all([
      call(srv.port, { method: 'POST', path: '/bind', body: body('r1') }),
      call(srv.port, { method: 'POST', path: '/bind', body: body('r2') }),
    ]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 429]);
    assert.equal(asked, 1, '터미널에 확인을 두 번 묻지 않는다');
    assert.equal(saved.length, 1);
  } finally { await srv.close(); }
});

test('로그인 서버 확인 실패 — 연결 못 함은 502(+원인 코드), 토큰 거부·일반 오류는 401, 어느 쪽도 저장하지 않고 다시 시도할 수 있다', async () => {
  const warns = []; const realWarn = console.warn; console.warn = (...a) => warns.push(a.join(' '));
  let mode = 'unreachable';
  const { srv, saved } = await boot({ verify: async () => {
    if (mode === 'unreachable') throw Object.assign(new Error('x'), { failure: { kind: 'unreachable', name: 'AuthRetryableFetchError', status: 0, code: 'ECONNREFUSED' } });
    if (mode === 'rejected') throw Object.assign(new Error('x'), { failure: { kind: 'rejected', name: 'AuthApiError', status: 401 } });
    if (mode === 'unknown') throw Object.assign(new Error('x'), { failure: { kind: 'unknown', name: 'Error', status: 503 } });
    throw new Error('plain');
  } });
  try {
    const bind = () => call(srv.port, { method: 'POST', path: '/bind', body: { cli: srv._nonce, access_token: 'SECRET-TOK', refresh_token: 'r' } });
    const a = await bind(); assert.equal(a.status, 502); assert.deepEqual(JSON.parse(a.body), { ok: false, kind: 'unreachable', code: 'ECONNREFUSED' });
    mode = 'unknown'; const u = await bind(); assert.equal(u.status, 502); assert.deepEqual(JSON.parse(u.body), { ok: false, kind: 'unknown' });
    mode = 'rejected'; assert.equal((await bind()).status, 401);
    mode = 'plain'; assert.equal((await bind()).status, 401);
    assert.equal(saved.length, 0);
    assert.ok(warns.some((w) => w.includes('unreachable') && w.includes('ECONNREFUSED')), '서버 콘솔에 이름·status·code가 남는다');
    assert.ok(warns.every((w) => !w.includes('SECRET-TOK')), '토큰은 기록하지 않는다');
    const pg = await call(srv.port, { path: `/auth/paired?cli=${srv._nonce}` }); // 승인 뒤 화면 문구가 구분된다
    assert.match(pg.body, /로그인 서버\(Supabase\)에 연결하지 못했습니다/);
  } finally { console.warn = realWarn; await srv.close(); }
});
