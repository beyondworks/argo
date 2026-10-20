// 받은 초대 거절을 v2 셸 가짜 서버(test/v2-shell.supabase.mjs)로 — state.failDecline으로 실패를 만들고, 거절 실행기·목록·오류 위치가 서로 맞는지 본다(#1102 검수 미룸 ④).
// 화면 연결(App.jsx)은 같은 함수(createDecliner·afterDecline·declineErrorTarget)를 쓴다 — 화면 확인은 PR 근거의 ego 캡처.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecliner, afterDecline, declineErrorTarget } from '../src/v2/invite-box.mjs';
import { myInviteRows } from '../src/v2/my-invites.mjs';

globalThis.window ??= {}; globalThis.location ??= { search: '' };
const { supabase: fake } = await import('./v2-shell.supabase.mjs');
const f = globalThis.window.__v2Fixture;
const rpc = (fn, a) => fake.rpc(fn, a);
const mine = async () => myInviteRows((await fake.rpc('msgr2_my_invites')).data);

test('가짜 서버 거절: 실패(failDecline)면 줄을 두고 오류는 열린 미리보기면 창 안·닫혔으면 전역, 다시 누르면 거절, 그 뒤는 이미 정해짐', async () => {
  f.invited();
  let list = await mine();
  assert.equal(list.length, 1);
  const code = list[0].code; const d = createDecliner(rpc);
  f.failDecline = true;
  const bad = await d.decline(code);
  assert.equal(bad.kind, 'error'); assert.match(bad.error.message, /msgr2_app_device_required/);
  list = afterDecline(list, code, bad);
  assert.equal(list.length, 1, '실패면 줄을 둔다');
  assert.equal(declineErrorTarget(bad, { code, openPreviewCode: code }), 'preview');
  assert.equal(declineErrorTarget(bad, { code, openPreviewCode: null }), 'global');
  assert.equal((await mine()).length, 1, '서버에도 그대로');
  f.failDecline = false;
  const ok = await d.decline(code);
  assert.deepEqual(ok, { kind: 'declined' });
  assert.deepEqual(afterDecline(list, code, ok), []);
  assert.equal((await mine()).length, 0);
  assert.deepEqual(await d.decline(code), { kind: 'gone' }, '이미 정해짐');
});
