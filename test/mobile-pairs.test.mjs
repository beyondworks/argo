// 휴대폰 페어링 상태 파일(src/mobile-pairs.mjs) — 행동 테스트. 잠그는 것:
//  ① 코드: 5분 TTL·5회 오입력 폐기·1회 소비·토글 off 거절  ② 토큰: 파일엔 해시만(평문 부재)·상수시간 대조·해제 즉시 무효
//  ③ mobileAccess: 루프백=판정 없음 / 비루프백 무쿠키=none / 유효=mobile / 무효=deny (currentUser·미들웨어 계약의 원천)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-mobile-pairs-'));
process.env.ARGO_ROOT = root;
const M = await import('../src/mobile-pairs.mjs');

test('토글 off면 코드가 있어도 페어링 거절', async () => {
  await M.newPairCode({ root });
  const m = await M.loadMobile({ root });
  assert.equal((await M.consumePairCode(m.pending.code, { root })).error, 'mobile_disabled');
});

test('코드 오입력 5회 → 폐기(locked), 그 뒤엔 expired', async () => {
  await M.setMobileEnabled(true, { root, port: 3031, upstreamPort: 3001 });
  await M.newPairCode({ root });
  for (let i = 0; i < 4; i++) assert.equal((await M.consumePairCode('ZZZZZZ', { root })).error, 'mobile_code_wrong');
  assert.equal((await M.consumePairCode('ZZZZZZ', { root })).error, 'mobile_code_locked');
  assert.equal((await M.consumePairCode('ZZZZZZ', { root })).error, 'mobile_code_expired');
});

test('TTL 경과 코드는 expired — now 주입', async () => {
  const { code, exp } = await M.newPairCode({ root, now: 1_000_000 });
  assert.equal(exp, 1_000_000 + M.CODE_TTL_MS);
  assert.equal((await M.consumePairCode(code, { root, now: exp })).error, 'mobile_code_expired');
});

test('옳은 코드 → 토큰 1회 발급(소문자·공백 관용), 재사용 불가, 파일엔 해시만', async () => {
  const { code } = await M.newPairCode({ root });
  const r = await M.consumePairCode(` ${code.toLowerCase()} `, { root, name: 'iPhone', ua: 'Mozilla/5.0 (iPhone)' });
  assert.ok(r.token && r.token.length === 64, '32바이트 hex 토큰');
  assert.equal(r.pair.name, 'iPhone');
  assert.equal((await M.consumePairCode(code, { root })).error, 'mobile_code_expired', '1회 소비');
  const raw = await readFile(join(root, '.mobile.json'), 'utf8');
  assert.ok(!raw.includes(r.token), '토큰 평문이 파일에 없다');
  assert.ok(!raw.includes(code), '소비된 코드가 파일에 남지 않는다');
  const v = await M.verifyMobileToken(r.token, { root });
  assert.equal(v?.id, r.pair.id);
  assert.equal(await M.verifyMobileToken(r.token.slice(0, 63) + '0', { root }), null, '한 글자 다른 토큰 거절');
  assert.equal(await M.verifyMobileToken('', { root }), null);
  // 해제 → 즉시 무효
  assert.equal(await M.revokePair(r.pair.id, { root }), true);
  assert.equal(await M.revokePair(r.pair.id, { root }), false);
  assert.equal(await M.verifyMobileToken(r.token, { root }), null);
});

test('토글 off → 기존 토큰도 거절, 발급 중 코드 폐기', async () => {
  const { code } = await M.newPairCode({ root });
  const { token } = await M.consumePairCode(code, { root });
  assert.ok(await M.verifyMobileToken(token, { root }));
  await M.setMobileEnabled(false, { root });
  assert.equal(await M.verifyMobileToken(token, { root }), null);
  assert.equal((await M.loadMobile({ root })).pending, null);
  await M.setMobileEnabled(true, { root });
  assert.ok(await M.verifyMobileToken(token, { root }), '다시 켜면 페어링은 살아 있다');
});

test('mobileAccess — 루프백은 판정 없음, 비루프백은 쿠키 유무·유효성으로 갈린다', async () => {
  const { code } = await M.newPairCode({ root });
  const { token } = await M.consumePairCode(code, { root });
  assert.equal((await M.mobileAccess({ host: '127.0.0.1:3001', cookieHeader: 'argo-mobile=bogus', root })).kind, 'loopback');
  assert.equal((await M.mobileAccess({ host: 'localhost:3001', cookieHeader: `argo-mobile=${token}`, root })).kind, 'loopback');
  assert.equal((await M.mobileAccess({ host: '192.168.0.12:3031', cookieHeader: 'sb-x=1', root })).kind, 'none');
  assert.equal((await M.mobileAccess({ host: '192.168.0.12:3031', cookieHeader: `a=b; argo-mobile=${token}`, root })).kind, 'mobile');
  assert.equal((await M.mobileAccess({ host: '100.101.1.2:3031', cookieHeader: 'argo-mobile=bogus', root })).kind, 'deny');
});

test('publicView — 해시·tries 비노출, 만료 코드는 null', async () => {
  const m = await M.loadMobile({ root });
  const v = M.publicView(m);
  assert.ok(v.pairs.every((p) => !('hash' in p)));
  assert.equal(M.publicView({ ...m, pending: { code: 'ABC', exp: 1, tries: 0 } }, 2).pending, null);
});

// ── 배선 트립와이어 — currentUser(app/auth.mjs)가 토큰 판정을 AUTH_ON 분기보다 **먼저** 부르는지(무인증 모드에서도
// 무효 토큰이 local로 새지 않게). 행동은 scripts/e2e-mobile-pair.mjs가 격리 서버로 실증한다(cookies() 요청 스코프).
test('배선 — currentUser: mobileDenied가 AUTH_ON 분기보다 앞, 루프백은 판정 없음, 검증 오류는 fail-closed', async () => {
  const src = await readFile(new URL('../app/auth.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function currentUser()'), src.indexOf('async function mobileDenied()'));
  const iDeny = fn.indexOf('await mobileDenied()'), iAuth = fn.indexOf("if (!AUTH_ON) return { id: 'local'");
  assert.ok(iDeny > 0 && iAuth > iDeny, '토큰 판정이 무인증 local 반환보다 먼저');
  assert.match(fn, /if \(!TENANT && \(await mobileDenied\(\)\)\) return null;/);
  const helper = src.slice(src.indexOf('async function mobileDenied()'));
  assert.match(helper, /mobileAccess\(\{ host, cookieHeader \}\)\)\.kind === 'deny'/, '판정은 src/mobile-pairs.mjs mobileAccess 단일 원천');
  assert.ok(!/catch[^}]*return true/.test(helper), '검증 오류를 삼켜 deny로 만들지 않는다(throw = 500 fail-closed)');
});
