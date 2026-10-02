// getUser 실패 판정 — "연결 못 함"과 "토큰 거부"를 같은 문구로 뭉개던 결함(Windows 구글 로그인이 계속
// "유효하지 않은 세션입니다"로만 보인 제보)을 행동으로 잠근다. 순수 판정 + 실제 닫힌 포트 왕복.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { classifyAuthError, linkFailure, verifyAccessToken } from '../src/auth-error.mjs';

const err = (name, status, extra = {}) => Object.assign(new Error(extra.message ?? 'x'), { name, status, ...extra });

test('연결 실패 — AuthRetryableFetchError status 0 / status 없음 / fetch failed 메시지', () => {
  assert.equal(classifyAuthError(err('AuthRetryableFetchError', 0, { message: 'fetch failed' })).kind, 'unreachable');
  assert.equal(classifyAuthError(err('AuthRetryableFetchError', undefined, { message: 'fetch failed' })).kind, 'unreachable');
  assert.equal(classifyAuthError(new TypeError('fetch failed')).kind, 'unreachable');
});

test('연결 실패 — 원인 코드는 인자로 받은 것 → error.cause 순으로 꺼낸다(없으면 undefined)', () => {
  const plain = err('AuthRetryableFetchError', 0, { message: 'fetch failed' });
  assert.equal(classifyAuthError(plain).code, undefined);
  assert.equal(classifyAuthError(plain, 'ECONNREFUSED').code, 'ECONNREFUSED');
  const viaCause = err('AuthRetryableFetchError', 0, { message: 'fetch failed', cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } });
  assert.equal(classifyAuthError(viaCause).code, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  const viaAgg = err('AuthRetryableFetchError', 0, { message: 'fetch failed', cause: { errors: [{ code: 'ENOTFOUND' }] } });
  assert.equal(classifyAuthError(viaAgg).code, 'ENOTFOUND');
});

test('토큰 거부 — AuthApiError 401·403', () => {
  assert.equal(classifyAuthError(err('AuthApiError', 401, { code: 'bad_jwt' })).kind, 'rejected');
  assert.equal(classifyAuthError(err('AuthApiError', 403, { code: 'session_not_found' })).kind, 'rejected');
});

test('알 수 없는 오류 — 토큰 탓으로 단정하지 않는다(5xx·429·이름 모를 오류)', () => {
  assert.equal(classifyAuthError(err('AuthRetryableFetchError', 503, { message: 'upstream' })).kind, 'unknown');
  assert.equal(classifyAuthError(err('AuthApiError', 429, { code: 'over_request_rate_limit' })).kind, 'unknown');
  assert.equal(classifyAuthError(new Error('boom')).kind, 'unknown');
});

test('응답 모양 — 연결 실패는 502 + 할 일 안내 + code, 거부는 401 + 기존 문구, 알 수 없음은 502', () => {
  const u = linkFailure(classifyAuthError(err('AuthRetryableFetchError', 0, { message: 'fetch failed' }), 'ECONNREFUSED'));
  assert.equal(u.status, 502);
  assert.equal(u.body.code, 'ECONNREFUSED');
  assert.equal(u.body.kind, 'unreachable'); // 화면이 표시 언어로 문구를 고르는 열쇠 — error는 예전 클라이언트용 ko 문구로 남는다
  assert.match(u.body.error, /로그인 서버\(Supabase\)에 연결하지 못했습니다/);
  assert.match(u.body.error, /네트워크·VPN·프록시·보안 프로그램/);
  assert.equal('code' in linkFailure(classifyAuthError(err('AuthRetryableFetchError', 0))).body, false); // 코드 없으면 필드 없음
  const r = linkFailure(classifyAuthError(err('AuthApiError', 401)));
  assert.equal(r.status, 401);
  assert.equal(r.body.kind, 'rejected');
  assert.equal(r.body.error, '유효하지 않은 세션입니다. 다시 로그인해 주세요.');
  const k = linkFailure(classifyAuthError(new Error('boom')));
  assert.equal(k.status, 502);
  assert.equal(k.body.kind, 'unknown');
  assert.doesNotMatch(k.body.error, /유효하지 않은 세션/);
});

test('실제 왕복 — 닫힌 포트면 verifyAccessToken이 unreachable + ECONNREFUSED를 돌려준다(토큰은 어디에도 안 실린다)', async () => {
  const srv = createServer(); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address(); await new Promise((r) => srv.close(r)); // 방금 닫은 포트 = 연결 거부
  const secret = 'tok-SECRET-123';
  const res = await verifyAccessToken({ url: `http://127.0.0.1:${port}`, anonKey: 'anon', accessToken: secret });
  assert.equal(res.user, undefined);
  assert.equal(res.failure.kind, 'unreachable');
  assert.equal(res.failure.code, 'ECONNREFUSED');
  assert.equal(JSON.stringify(res.failure).includes(secret), false);
});
