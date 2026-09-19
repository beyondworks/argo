// D50: 로그인된 기기에서 익명 키로 나가려는 데이터 요청은 막는다 — RLS 아래 익명 조회는 오류 없이 빈 결과라 채널 목록이 통째로 사라졌다(로컬 스택 재현).
import test from 'node:test';
import assert from 'node:assert/strict';
import { guardAnonFetch, SESSION_REFRESHING } from '../src/anon-guard.mjs';
const ANON = 'anon-key';
const run = (stored, url, auth) => { const sent = []; const f = guardAnonFetch({ anonKey: ANON, hasStoredSession: () => stored, fetchImpl: async (u) => { sent.push(String(u)); return 'ok'; } });
  return f(url, { headers: { Authorization: `Bearer ${auth}` } }).then((r) => ({ r, sent }), (e) => ({ e, sent })); };
test('저장된 로그인이 있는데 익명 키로 나가는 데이터 요청은 보내지 않는다', async () => {
  for (const url of ['https://x.supabase.co/rest/v1/msgr_channels', 'https://x.supabase.co/storage/v1/object/msgr/a', 'https://x.supabase.co/rest/v1/rpc/msgr_unread']) {
    const { e, sent } = await run(true, url, ANON); assert.equal(e?.message, SESSION_REFRESHING, url); assert.deepEqual(sent, []);
  }
});
test('사용자 토큰·로그아웃 상태(저장 없음)·인증 요청은 그대로 보낸다', async () => {
  assert.equal((await run(true, 'https://x/rest/v1/msgr_channels', 'user-jwt')).r, 'ok');
  assert.equal((await run(false, 'https://x/rest/v1/msgr_invites', ANON)).r, 'ok', '로그인 전 초대 미리보기 등 익명 요청');
  assert.equal((await run(true, 'https://x/auth/v1/token?grant_type=refresh_token', ANON)).r, 'ok', '갱신 요청 자체는 막지 않는다');
  for (const url of ['https://x/auth/v1/token?grant_type=password', 'https://x/auth/v1/logout?scope=local', 'https://x/auth/v1/user']) assert.equal((await run(true, url, ANON)).r, 'ok', `로그인·로그아웃·사용자 조회는 통과: ${url}`);
});
test('supabase 클라이언트가 이 관문을 fetch로 쓴다(배선)', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/supabase.js', import.meta.url), 'utf8');
  assert.match(src, /global: \{ fetch: guardAnonFetch\(\{ anonKey: SB_ANON, hasStoredSession: storedSession \}\) \}/);
});
