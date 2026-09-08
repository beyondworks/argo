// 프로필·친구(유건 지시 2026-09-09) — 화면 핀. 서버 판정은 test/msgr-bots-pg.test.mjs의 친구 케이스.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const app = read('apps/messenger/src/App.jsx'); const i18n = read('apps/messenger/src/i18n.js'); const sql = read('supabase/migrations/20260909002000_msgr_profiles_friends.sql');
test('i18n: 프로필·친구·레일 친구 절·알림함 친구 요청 키 ko/en', () => {
  for (const k of ['profile.title', 'profile.handle', 'profile.handle.bad', 'profile.handle.taken', 'profile.emailSearch', 'profile.handleSearch', 'profile.acceptRequests', 'friends.title', 'friends.find', 'friends.find.none', 'friends.request', 'friends.accept', 'friends.decline', 'friends.received', 'friends.list', 'friends.remove', 'friends.err.closed', 'inbox.kind.friend', 'inbox.friend.text'])
    assert.match(i18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
});
test('화면: 프로필 카드는 본인 upsert만 · 친구 찾기·요청·수락·거절·삭제는 전부 RPC · 레일 친구 절(같은 조직이면 DM) · 알림함에 받은 요청', () => {
  assert.match(app, /from\('msgr_profiles'\)\.upsert\(\{ user_id: uid, handle: draft\.handle \|\| null/, '프로필 upsert');
  assert.match(app, /\/\^\[a-z0-9\]\[a-z0-9_\.\]\{2,23\}\$\/\.test\(draft\.handle\)/, '아이디 형식은 서버 check와 같다');
  assert.match(app, /supabase\.rpc\('msgr_find_user', \{ q: v \}\)/, '찾기 RPC'); assert.match(app, /supabase\.rpc\('msgr_my_friends'\)/, '목록 RPC');
  for (const fn of ['msgr_friend_request', 'msgr_friend_decide', 'msgr_friend_remove']) assert.match(app, new RegExp(`call\\('${fn}'`), `${fn} 호출(call → supabase.rpc)`);
  assert.match(app, /const call = async \(fn, args, ok\) => \{ setBusy\(true\); try \{ await q\(supabase\.rpc\(fn, args\)\);/, 'call 래퍼');
  assert.doesNotMatch(app, /from\('msgr_friends'\)/, '친구 표 직접 읽기·쓰기 없음(RPC만)');
  assert.match(app, /inOrg \? <button type="button" className="btn sm" onClick=\{\(\) => onDm\?\.\(f\.user_id\)\}/, '같은 조직이면 DM(설정 친구 탭)');
  assert.match(app, /kind: 'friend', key: `friend:\$\{f\.user_id\}`/, '알림함 친구 요청');
});
test('서버: 이메일은 정확 일치+허용, 아이디 앞부분+허용, 결과에 이메일 없음, 쓰기는 RPC만(insert 정책 없음)', () => {
  assert.match(sql, /lower\(u\.email\) = needle and coalesce\(p\.email_search, false\)/, '이메일 정확 일치 + 허용');
  assert.match(sql, /p\.handle like needle \|\| '%' and coalesce\(p\.handle_search, true\)/, '아이디 앞부분 + 허용');
  assert.match(sql, /returns table \(user_id uuid, handle text, display_name text, relation text\)/, '결과 열에 이메일 없음');
  assert.doesNotMatch(sql, /create policy msgr_friends_(insert|write|all)/, '친구 표 쓰기 정책 없음');
  assert.match(sql, /if cur\.requested_by = me then return 'sent'; end if;\n\s*update public\.msgr_friends set status = 'accepted'/, '맞요청 = 수락');
});
