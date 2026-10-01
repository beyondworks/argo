// 초대 창을 닫을 때 설정 > 멤버의 초대 목록을 다시 읽는다(UX 점검 D) — 단, 링크를 만들거나 버린 적이 있을 때 한 번만,
// 그리고 창이 닫히며 지우는 링크의 삭제 요청이 끝난 뒤에(먼저 읽으면 곧 사라질 링크가 목록에 한 번 보인다 — QA 재현 2026-10-01).
// DB 위생: 열었다 닫기만 하거나 닫기를 반복해도 조회가 늘면 안 된다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inviteListSync } from '../src/invite-list-sync.mjs';

const make = () => { const log = []; const s = inviteListSync(() => log.push('read')); return { s, log }; };
const create = (s) => { s.start(); s.finish(+1); }; const discard = (s) => { s.start(); s.finish(-1); };

test('열었다 닫기만 하면 읽지 않는다', () => {
  const { s, log } = make(); s.opened(); assert.equal(s.closed(), false); assert.deepEqual(log, []);
});

test('링크를 만들고 복사해 남긴 채 닫으면 닫는 순간 한 번 읽는다(남긴 링크가 목록에 나타난다)', () => {
  const { s, log } = make(); s.opened(); create(s);
  assert.deepEqual(log, [], '창이 열려 있는 동안엔 읽지 않는다');
  assert.equal(s.closed(), true); assert.deepEqual(log, ['read']);
  assert.equal(s.closed(), false); assert.deepEqual(log, ['read'], '닫기 반복은 조회하지 않는다');
});

test('만든 링크를 복사 안 하고 닫아 창이 지우면 순변화 0 — 읽지 않는다(DB 위생)', () => {
  const { s, log } = make(); s.opened(); create(s);
  discard(s);                       // 창이 사라지며 삭제
  assert.equal(s.closed(), false); assert.deepEqual(log, []);
});

test('옵션을 바꿔 만들고 버리기를 여러 번 한 뒤 마지막 하나를 복사해 두면 읽기는 한 번', () => {
  const { s, log } = make(); s.opened();
  for (let i = 0; i < 4; i++) { create(s); discard(s); }
  create(s); s.closed(); assert.deepEqual(log, ['read']);
});

test('닫히며 보낸 삭제 요청이 끝난 뒤에 읽는다 — 먼저 읽으면 곧 지워질 링크가 보인다', () => {
  const { s, log } = make(); s.opened();
  create(s); create(s);             // 처음 링크는 복사해 남기고, 옵션을 바꿔 새로 만든 링크는 복사 안 함
  s.start();                        // 창이 사라지며 복사 안 한 링크 삭제 요청(closed보다 먼저)
  assert.equal(s.closed(), false, '삭제가 끝나지 않았다'); assert.deepEqual(log, []);
  s.finish(-1); assert.deepEqual(log, ['read'], '삭제가 끝나자 읽는다(남긴 링크 하나)');
});

test('삭제 요청이 실패하면(링크가 남는다) 그래도 읽어 남은 링크를 보인다', () => {
  const { s, log } = make(); s.opened(); create(s);
  s.start(); s.closed(); s.finish(0);  // 삭제 실패 — 순변화 +1
  assert.deepEqual(log, ['read']);
});

test('닫는 도중 끝난 만들기 요청 — 창의 버리기가 먼저 시작되고 만들기 끝(+1)은 한 박자 늦게 오면, 읽지 않는다(검수 #797 LOW-1: 같은 링크를 두 번 읽던 것)', () => {
  const { s, log } = make(); s.opened();
  s.start();                        // 만들기 요청이 가는 중에
  s.closed();                       // 사용자가 닫음(요청이 남아 있어 아직 안 읽음)
  s.start();                        // 응답이 오자 창이 보여 준 적 없는 링크를 바로 버림(버리기 시작)
  s.finish(+1);                     // 만들기 끝 — 앱이 이 호출을 setTimeout으로 미뤄 버리기 시작 뒤에 부른다
  assert.deepEqual(log, [], '버리기가 진행 중이라 읽지 않는다');
  s.finish(-1); assert.deepEqual(log, [], '만들기+버리기 = 순변화 0 — 읽을 이유가 없다');
});

test('같은 일이 반대 순서(만들기 끝이 먼저)로 오면 읽기가 두 번이었다 — 그래서 앱이 만들기 끝을 미룬다', () => {
  const { s, log } = make(); s.opened();
  s.start(); s.closed();
  s.finish(+1); assert.deepEqual(log, ['read']);   // 버리기 시작 전에 끝나면 곧 지워질 링크를 읽는다
  s.start(); s.finish(-1); assert.deepEqual(log, ['read', 'read']);
});

test('닫힌 뒤 도착한 링크를 창이 버리지 않으면(남는다) 한 번 읽어 목록에 보인다', () => {
  const { s, log } = make(); s.opened(); s.start(); s.closed(); s.finish(+1);
  assert.deepEqual(log, ['read']);
});

test('다음 창은 새로 센다', () => {
  const { s, log } = make();
  s.opened(); create(s); s.closed();
  s.opened(); s.closed();
  s.opened(); create(s); discard(s); s.closed();
  s.opened(); create(s); s.closed();
  assert.deepEqual(log, ['read', 'read']);
});

test('앱: 만들기(+1)·버리기(-1)를 start/finish로 감싸고, 창이 열리고 사라진 뒤(효과) opened/closed를 부르며, 멤버 카드는 신호가 바뀔 때만(마운트 직후 제외) 다시 읽는다', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /const inviteSync = useRef\(null\); if \(!inviteSync\.current\) inviteSync\.current = inviteListSync\(\(\) => setInvitesTick\(\(n\) => n \+ 1\)\);/);
  assert.match(app, /const createInviteCode = async \(opts\) => \{ inviteSync\.current\.start\(\); let made = 0; try \{ const r = await createInvite\(supabase, \{ orgId, uid, \.\.\.opts \}\); made = 1; return r; \} finally \{ setTimeout\(\(\) => inviteSync\.current\.finish\(made\), 0\); \} \};/, '만들기 끝은 한 박자 늦게 — 창이 늦은 링크를 버리는 start가 먼저 잡힌다');
  assert.match(app, /discard=\{async \(id\) => \{ inviteSync\.current\.start\(\); let gone = 0; try \{ const r = await discardInvite\(supabase, id\); gone = r \? -1 : 0; return r; \} finally \{ inviteSync\.current\.finish\(gone\); \} \}\}/);
  assert.match(app, /useEffect\(\(\) => \{ if \(inviteFor\) inviteSync\.current\.opened\(\); else inviteSync\.current\.closed\(\); \}, \[inviteFor\]\);/, '창 언마운트 정리(버리기 start)가 끝난 같은 커밋의 효과에서 closed');
  assert.doesNotMatch(app, /onClose=\{\(\) => \{ setInviteFor\(null\); inviteSync/, '닫기 핸들러에서 곧바로 읽지 않는다(버리기가 아직 시작도 안 했다)');
  assert.match(app, /invitesTick=\{invitesTick\}/, 'Settings → OrgCard로 신호 전달');
  assert.match(app, /const seenTick = useRef\(invitesTick\); useEffect\(\(\) => \{ if \(part !== 'members' \|\| seenTick\.current === invitesTick\) return; seenTick\.current = invitesTick; loadInvites\(\)/);
});
