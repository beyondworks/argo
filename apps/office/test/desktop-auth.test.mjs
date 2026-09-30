import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptMailCallback, mailAuthorization, localPasswordAllowed } from '../src/core/desktop-auth-policy.js';
import { sealState } from '../server/seal.js';
import { POST, OPTIONS } from '../api/mail/[op].js';

const pending = { state: 'expected', uid: 'u1', expires: 100 };
const link = 'argo-office://mail/callback?state=expected&code=code';
test('mail callback binds route, pending state and account; replay has no pending state', () => {
  assert.deepEqual(acceptMailCallback(link, pending, 'u1', 1), { state: 'expected', code: 'code' });
  assert.equal(acceptMailCallback(link, null, 'u1', 1), null);
  assert.equal(acceptMailCallback(link.replace('expected', 'wrong'), pending, 'u1', 1), null);
  for (const bad of [link.replace('mail/callback', 'evil/callback'), link.replace('mail/callback', 'mail/other'), link.replace('argo-office:', 'https:'), link.replace('mail/', 'evil@mail/'), `${link}#x`, `${link}&state=expected`]) assert.equal(acceptMailCallback(bad, pending, 'u1', 1), null);
  assert.throws(() => acceptMailCallback(link, pending, 'u2', 1), { code: 'signed_out' });
  assert.throws(() => acceptMailCallback(link, pending, 'u1', 100), { code: 'expired' });
  assert.throws(() => acceptMailCallback(link.replace('code=code', 'error=access_denied'), pending, 'u1', 1), { code: 'access_denied' });
  assert.throws(() => acceptMailCallback(`${link}&error=access_denied`, pending, 'u1', 1), { code: 'state' });
});
test('authorization rejects non-Google navigation and empty state', () => {
  assert.equal(mailAuthorization('https://accounts.google.com/o/oauth2/v2/auth?state=abc'), 'abc');
  for (const bad of ['https://evil.example/?state=x', 'javascript:alert(1)', 'https://accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com@evil.example/o/oauth2/v2/auth?state=x']) assert.throws(() => mailAuthorization(bad));
});
test('fake Google is available only to explicitly enabled local review with exact loopback origin', () => {
  const local = 'http://127.0.0.1:58411/auth?state=fake';
  assert.throws(() => mailAuthorization(local));
  assert.throws(() => mailAuthorization(local, { reviewOrigin: 'http://127.0.0.1:58411' }));
  assert.equal(mailAuthorization(local, { reviewOrigin: 'http://127.0.0.1:58411', reviewEnabled: true }), 'fake');
  assert.throws(() => mailAuthorization('http://evil.example/auth?state=fake', { reviewOrigin: 'http://evil.example', reviewEnabled: true }));
  assert.throws(() => mailAuthorization(local.replace('58411', '58412'), { reviewOrigin: 'http://127.0.0.1:58411', reviewEnabled: true }));
});
test('review password login requires loopback and explicit flag outside development', () => {
  assert.equal(localPasswordAllowed({ configured: true, review: '1', url: 'http://127.0.0.1:54321' }), true);
  assert.equal(localPasswordAllowed({ configured: true, review: '1', url: 'https://project.supabase.co' }), false);
  assert.equal(localPasswordAllowed({ configured: true, url: 'http://localhost:54321' }), false);
  assert.equal(localPasswordAllowed({ configured: true, dev: true, url: 'http://localhost:54321' }), true);
});
test('desktop preflight allows exact native origins without credentials or arbitrary reflection', async () => {
  for (const origin of ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']) {
    const r = await OPTIONS(new Request('https://office.example/api/mail/list', { method: 'OPTIONS', headers: { origin } }));
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), origin);
    assert.equal(r.headers.get('access-control-allow-credentials'), null);
  }
  const r = await OPTIONS(new Request('https://office.example/api/mail/list', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }));
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});
test('relay preserves web path and validates sealed desktop intent; finish rejects other user before Google exchange', async () => {
  const key = Buffer.alloc(32, 7);
  const saved = process.env.OFFICE_MAIL_KEY;
  process.env.OFFICE_MAIL_KEY = key.toString('base64');
  const originalFetch = globalThis.fetch;
  const call = (op, args, token) => POST(new Request(`https://office.example/api/mail/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(args) }));
  try {
    const web = sealState(key, { uid: 'u1', v: 'v' });
    assert.deepEqual(await (await call('relay', { state: web, code: 'c' })).json(), { desktop: false });
    const state = sealState(key, { uid: 'u1', v: 'v', desktop: true });
    const relay = await (await call('relay', { state, error: 'access_denied' })).json();
    assert.equal(new URL(relay.url).searchParams.get('error'), 'access_denied');
    assert.equal((await call('relay', { state: `${state}broken`, code: 'c' })).status, 400);
    assert.equal((await call('relay', { state: sealState(key, { uid: 'u1', desktop: true }, 0), code: 'c' })).status, 400);
    const calls = [];
    globalThis.fetch = async (url) => { calls.push(url); return Response.json({ id: 'u2' }); };
    assert.equal((await call('finish', { state, code: 'c' }, 'test-jwt')).status, 400);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/auth\/v1\/user$/);
  } finally {
    globalThis.fetch = originalFetch;
    if (saved === undefined) delete process.env.OFFICE_MAIL_KEY; else process.env.OFFICE_MAIL_KEY = saved;
  }
});
