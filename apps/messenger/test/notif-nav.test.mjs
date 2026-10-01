// 알림 탭 → 그 채팅 열기(유건 요청 2026-10-01). 종전 App.jsx 효과는 목록(channels)에 없는 채널 요청을 조용히 버렸고(참여 전 공개 채널·
// 목록을 받은 뒤 생긴 방), 조직이 0개인 개인 공간 사용자는 영원히 기다렸다. 판단을 순수 함수로 빼서 경계 사례를 행동으로 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavInbox, decideNav, NAV_MAX_FAILS } from '../src/notif-nav.mjs';

const P = '__personal__';
const A = '0a0a0a0a-0000-4000-8000-00000000000a'; // 지금 조직
const B = '0b0b0b0b-0000-4000-8000-00000000000b'; // 내가 든 다른 조직
const C = '0c0c0c0c-0000-4000-8000-00000000000c'; // 내가 들지 않은 조직
const CH = '1c1c1c1c-0000-4000-8000-000000000001';
const OTHER = '1c1c1c1c-0000-4000-8000-000000000002';
const orgs = [{ id: A }, { id: B }];
const base = (over = {}) => ({ target: CH, owner: 'u1', uid: 'u1', orgs, orgId: A, personalId: P, loaded: true, channels: [{ id: OTHER }], previewChannels: [], row: undefined, fails: 0, refreshed: false, orgsRefreshed: false, ...over });

// 판단을 실제 흐름처럼 굴린다 — 셸이 하는 일(조회 응답·공간 전환·다시 읽기)을 world가 흉내 내고, 열기·버리기에서 멈춘다.
function drive(start, world) {
  let s = { ...start };
  const steps = [];
  for (let i = 0; i < 12; i++) {
    const act = decideNav(s);
    steps.push(act.do === 'switch' ? `switch:${act.orgId}` : act.do === 'drop' ? `drop:${act.reason}` : act.do);
    if (act.do === 'open' || act.do === 'drop' || act.do === 'report' || act.do === 'wait') return { steps, act };
    if (act.do === 'lookup') s = { ...s, ...world.lookup(s) };
    else if (act.do === 'switch') s = { ...s, orgId: act.orgId, ...world.space(act.orgId) };
    else if (act.do === 'refresh') s = { ...s, refreshed: true, ...world.space(s.orgId, true) };
    else if (act.do === 'refresh-orgs') s = { ...s, orgsRefreshed: true, orgs: world.orgs?.() ?? s.orgs };
  }
  throw new Error(`끝나지 않음: ${steps.join(' → ')}`);
}

test('목록에 있으면 바로 연다 — 조직 공간과 개인 공간 모두', () => {
  assert.deepEqual(decideNav(base({ channels: [{ id: CH }] })), { do: 'open' });
  assert.deepEqual(decideNav(base({ orgId: P, channels: [{ id: CH }] })), { do: 'open' });
});

test('(a) 참여 전 공개 채널(미리보기)의 멘션 알림은 미리보기로 연다 — 종전에는 channels만 봐서 버렸다', () => {
  assert.deepEqual(decideNav(base({ previewChannels: [{ id: CH }] })), { do: 'open' });
  const r = drive(base({ previewChannels: [{ id: CH }] }), { lookup: () => ({ row: { org_id: A } }), space: () => ({}) });
  assert.deepEqual(r.steps, ['open']);
  assert.notEqual(decideNav(base({ orgId: P, previewChannels: [{ id: CH }] })).do, 'open', '개인 공간에는 미리보기가 없다');
});

test('(b) 목록을 받은 뒤 새로 생긴 DM·비공개·개인 방 — 한 번 다시 읽고 나서 연다', () => {
  for (const orgId of [A, P]) {
    const space = orgId === P ? null : A;
    const r = drive(base({ orgId }), { lookup: () => ({ row: { org_id: space } }), space: (_id, refreshed) => (refreshed ? { channels: [{ id: OTHER }, { id: CH }] } : {}) });
    assert.deepEqual(r.steps, ['lookup', 'refresh', 'open'], String(orgId));
  }
});

test('(b) 다시 읽어도 없을 때만 버린다 — 다시 읽기 전에는 절대 버리지 않는다', () => {
  const r = drive(base(), { lookup: () => ({ row: { org_id: A } }), space: () => ({}) });
  assert.deepEqual(r.steps, ['lookup', 'refresh', 'drop:missing']);
  assert.equal(r.act.tell, 'unavailable', '사용자에게 열지 못했다고 알린다');
  assert.deepEqual(decideNav(base({ row: { org_id: A } })), { do: 'refresh' });
});

test('loadedOrg 경쟁 — 목록 ref는 도착했는데 화면 상태가 옛 목록이어도 다시 읽기 전에는 버리지 않는다', () => {
  // 종전: 조회 응답 시점에 loadedOrg.current === orgId면 바로 버렸다(목록 state가 아직 옛것이어도)
  assert.equal(decideNav(base({ loaded: true, channels: [], row: { org_id: A } })).do, 'refresh');
});

test('같은 공간 목록이 오는 중이면 기다린다(버리지 않는다)', () => {
  assert.deepEqual(decideNav(base({ loaded: false, channels: [], row: { org_id: A } })), { do: 'wait' });
  assert.deepEqual(decideNav(base({ loaded: false, channels: [] })), { do: 'lookup' }, '목록을 기다리는 동안 조회는 같이 한다');
});

test('(c) 조직이 0개인 개인 공간 사용자(orgId null) — 조회해서 개인 공간으로 옮긴 뒤 연다(종전에는 영원히 기다렸다)', () => {
  const start = base({ orgs: [], orgId: null, loaded: false, channels: [] });
  assert.deepEqual(decideNav(start), { do: 'lookup' });
  const r = drive(start, {
    lookup: () => ({ row: { org_id: null } }),
    space: (id) => (id === P ? { loaded: true, channels: [{ id: CH }] } : { loaded: false, channels: [] }),
  });
  assert.deepEqual(r.steps, ['lookup', `switch:${P}`, 'open']);
});

test('조직 공간을 보는 중에 개인 1:1 알림 — 개인 공간으로 옮겨 연다', () => {
  const r = drive(base(), { lookup: () => ({ row: { org_id: null } }), space: (id) => (id === P ? { loaded: true, channels: [{ id: CH }] } : {}) });
  assert.deepEqual(r.steps, ['lookup', `switch:${P}`, 'open']);
});

test('(d) 다른 조직 채널 — 그 조직으로 옮겨 목록이 오면 연다', () => {
  const r = drive(base(), {
    lookup: () => ({ row: { org_id: B } }),
    space: (id) => (id === B ? { loaded: true, channels: [{ id: CH }] } : {}),
  });
  assert.deepEqual(r.steps, ['lookup', `switch:${B}`, 'open']);
  assert.deepEqual(decideNav(base({ orgId: B, loaded: false, channels: [], row: { org_id: B } })), { do: 'wait' }, '옮긴 직후 목록 도착 전');
});

test('한 번 옮긴 뒤 사용자가 다른 공간으로 가면 다시 끌고 가지 않고 조용히 버린다(#788 검수 LOW-2)', () => {
  // 옮긴 공간의 목록 로드가 계속 실패하는 사이 사용자가 직접 다른 공간으로 갔다 — 배너 하나가 화면을 계속 빼앗으면 안 된다
  assert.deepEqual(decideNav(base({ orgId: A, row: { org_id: B }, switched: true })), { do: 'drop', reason: 'moved', tell: null });
  assert.deepEqual(decideNav(base({ orgId: A, row: { org_id: B } })), { do: 'switch', orgId: B }, '처음 한 번은 옮긴다');
  assert.deepEqual(decideNav(base({ orgId: B, loaded: true, channels: [{ id: CH }], row: { org_id: B }, switched: true })), { do: 'open' }, '옮긴 공간에 있으면 연다');
});
test('(d) 내 조직 목록에 없는 조직 — 조직 목록을 한 번 다시 읽고, 그래도 없으면 버린다', () => {
  const joinedElsewhere = drive(base(), {
    lookup: () => ({ row: { org_id: C } }), orgs: () => [...orgs, { id: C }],
    space: (id) => (id === C ? { loaded: true, channels: [{ id: CH }] } : {}),
  });
  assert.deepEqual(joinedElsewhere.steps, ['lookup', 'refresh-orgs', `switch:${C}`, 'open'], '다른 기기에서 막 들어간 조직');
  const notMember = drive(base(), { lookup: () => ({ row: { org_id: C } }), space: () => ({}) });
  assert.deepEqual(notMember.steps, ['lookup', 'refresh-orgs', 'drop:not-member']);
});

test('안 보이는 채널(권한 없음·지워짐)은 버리고 알린다', () => {
  const r = decideNav(base({ row: null }));
  assert.deepEqual(r, { do: 'drop', reason: 'unreadable', tell: 'unavailable' });
});

test('조회·다시 읽기 실패는 최대 3번까지 다시 하고, 그 뒤 버린다(요청 하나가 DB를 부르는 상한)', () => {
  assert.equal(decideNav(base({ fails: NAV_MAX_FAILS - 1 })).do, 'lookup');
  assert.deepEqual(decideNav(base({ fails: NAV_MAX_FAILS })), { do: 'drop', reason: 'offline', tell: 'offline' });
  assert.deepEqual(decideNav(base({ fails: NAV_MAX_FAILS, row: { org_id: A } })), { do: 'drop', reason: 'offline', tell: 'offline' });
  assert.deepEqual(decideNav(base({ fails: NAV_MAX_FAILS, channels: [{ id: CH }] })), { do: 'open' }, '목록에 이미 있으면 실패 횟수와 무관하게 연다');
});

test('조직 목록 전에는 기다린다(조회하지 않는다)', () => {
  assert.deepEqual(decideNav(base({ orgs: null, orgId: null, loaded: false, channels: [] })), { do: 'wait' });
});

test('신고 접수 알림은 운영 신고함으로, 그 밖의 잘못된 값은 조회 없이 조용히 버린다', () => {
  assert.deepEqual(decideNav(base({ target: 'report' })), { do: 'report' });
  for (const bad of ['', 'abc', `${CH}x`, 'report ', '../x', null, 42]) {
    assert.deepEqual(decideNav(base({ target: bad })), { do: 'drop', reason: 'invalid', tell: null }, String(bad));
  }
});

test('앞 계정에서 누른 요청은 다음 계정 셸이 열지 않는다', () => {
  assert.deepEqual(decideNav(base({ owner: 'u0', channels: [{ id: CH }] })), { do: 'drop', reason: 'account', tell: null });
  assert.deepEqual(decideNav(base({ owner: null, channels: [{ id: CH }] })), { do: 'open' }, '콜드 스타트(계정 모름)는 연다');
});

test('대기함 — 셸이 바뀌어도 남고, 그 요청을 끝낼 때만 비우며, 새 요청이 앞 요청을 대신한다', () => {
  const box = createNavInbox(() => 1);
  const seen = [];
  const off = box.subscribe((r) => seen.push(r?.channelId ?? null));
  assert.equal(box.offer({ channelId: '' }), null, '빈 값은 받지 않는다');
  const first = box.offer({ channelId: CH, source: 'push', owner: 'u1' });
  assert.deepEqual(box.get(), { seq: first.seq, channelId: CH, source: 'push', owner: 'u1', at: 1 });
  assert.equal(box.get(), first, '셸이 내려갔다 올라와도 같은 요청을 다시 읽는다(가져가도 비우지 않는다)');
  const second = box.offer({ channelId: OTHER, source: 'push' });
  assert.equal(box.done(first), false, '처리 중에 새 배너를 눌렀으면 새 요청은 남긴다');
  assert.equal(box.get(), second);
  assert.equal(box.done(second), true);
  assert.equal(box.get(), null);
  box.offer({ channelId: CH }); box.clear();
  assert.equal(box.get(), null, '로그아웃·계정 전환');
  off(); box.offer({ channelId: CH });
  assert.deepEqual(seen, [CH, OTHER, null, CH, null]);
});

test('배선: 알림 탭 리스너는 셸 밖(App) 한 곳 — 셸 안에 두면 셸이 다시 마운트될 때 그 사이의 탭이 사라진다', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const shellAt = app.indexOf('\nfunction Shell(');
  assert.ok(shellAt > 0);
  const calls = [...app.matchAll(/\bmountPush\(\{/g)].map((m) => m.index);
  assert.equal(calls.length, 1, '푸시 탭 리스너는 하나');
  assert.ok(calls[0] < shellAt, 'App(셸 밖)에 있다');
  const mac = [...app.matchAll(/\bmountNativeNotificationTaps\(\{/g)].map((m) => m.index);
  assert.equal(mac.length, 1); assert.ok(mac[0] < shellAt, '맥 알림 탭도 셸 밖');
  assert.match(app, /^const navInbox = createNavInbox\(\);$/m, '대기함은 모듈 수준');
  assert.doesNotMatch(app, /setNavTo\(/, '셸 안 상태값(navTo) 경로가 남지 않는다');
});
