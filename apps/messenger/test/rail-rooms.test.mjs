// 넓은 화면 레일의 '즐겨찾기'·'채팅' 두 절(src/rail-rooms.mjs) — 보일 대화가 어느 절에도 없게 되는 일을 막는다.
// 실사고(2026-10-08): 즐겨찾기한 방은 '채팅' 절에서 빠지는데, 개인 공간에서는 '즐겨찾기' 절을 그리지 않아(9/16~) 즐겨찾기한 페퍼 1:1이
// 데스크톱 목록에서 사라지고 다시 풀 수도 없었다. 폰(≤ 720px)은 레일 대신 채팅 탭이 따로 그려 보였다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { railRooms } from '../src/rail-rooms.mjs';
import { emptyPersonalDm } from '../src/phone-shell.mjs';

const PERSONAL = '__personal__'; // App.jsx의 개인 공간 표지(export const PERSONAL)와 같은 값
const ids = (xs) => xs.map((x) => x.id);
const shown = (r) => [...(r.showFavs ? r.favs : []), ...(r.showDms ? r.dms : [])];
const hidden = (c) => emptyPersonalDm(c, null); // App.jsx와 같은 판정 — 글 없는 개인 1:1(D13)

// 개인 공간 방(loadPersonal이 만드는 모양)
const crewDm = { id: 'pcdm-pepper', kind: 'dm', name: 'dm:페퍼', org_id: null, _personal_crew: 'pcrew-pepper', _personal_other: null, _personal_last_at: '2026-10-03T00:00:00Z' };
const friendDm = { id: 'pdm-alice', kind: 'dm', name: 'dm:Alice', org_id: null, _personal_crew: null, _personal_other: 'u-alice', _personal_last_at: '2026-10-07T00:00:00Z' };
const emptyFriendDm = { id: 'pdm-bob', kind: 'dm', name: 'dm:Bob', org_id: null, _personal_crew: null, _personal_other: 'u-bob', _personal_last_at: null };
const personal = [crewDm, friendDm, emptyFriendDm];
const inPersonal = (pins, o = {}) => railRooms({ channels: personal, pinned: new Set(pins), hidden, space: PERSONAL, ...o });

// 조직 공간 방
const general = { id: 'general', kind: 'public', name: 'general', org_id: 'org-1' };
const ops = { id: 'ops', kind: 'private', name: 'ops', org_id: 'org-1' };
const kimDm = { id: 'odm-kim', kind: 'dm', name: 'dm:Kim', org_id: 'org-1' };
const leeDm = { id: 'odm-lee', kind: 'dm', name: 'dm:Lee', org_id: 'org-1' };
const org = [general, ops, kimDm, leeDm];
const pepperTarget = { id: 'target:crew:c1', kind: 'target', targetKind: 'crew', targetId: 'c1', name: '페퍼', pin_pos: 1 };

test('개인 공간 — 즐겨찾기한 에이전트 1:1은 즐겨찾기 절에 보이고 채팅 절에는 없다(넓은 화면 목록에서 사라지던 결함)', () => {
  const r = inPersonal([crewDm.id]);
  assert.equal(r.showFavs, true, '개인 공간에서도 즐겨찾기 절을 그린다');
  assert.deepEqual(ids(r.favs), [crewDm.id]);
  assert.ok(!ids(r.dms).includes(crewDm.id), '채팅 절과 겹치지 않는다');
  assert.ok(ids(shown(r)).includes(crewDm.id), '즐겨찾기한 방이 목록 어딘가에 보인다');
});

test('개인 공간 — 모든 대화가 즐겨찾기여도 채팅 절(머리의 새 대화 단추)은 남는다', () => {
  const r = inPersonal([crewDm.id, friendDm.id]);
  assert.deepEqual(ids(r.dms), [], '글 없는 1:1(D13)은 원래 빠지고, 나머지는 전부 즐겨찾기 절로');
  assert.equal(r.showDms, true, '새 대화를 시작할 자리가 사라지지 않는다');
  assert.equal(r.showFavs, true);
  assert.deepEqual(ids(r.favs), [friendDm.id, crewDm.id], '순서(pin_pos)가 없으면 이름순 — 조직과 같은 규칙');
});

test('즐겨찾기를 풀면 채팅 절로 돌아오고, 즐겨찾기가 하나도 없으면 즐겨찾기 절은 그리지 않는다', () => {
  const before = inPersonal([crewDm.id]);
  const after = inPersonal([]);
  assert.ok(ids(before.favs).includes(crewDm.id));
  assert.ok(ids(after.dms).includes(crewDm.id), '풀면 채팅 절로');
  assert.deepEqual(after.favs, []);
  assert.equal(after.showFavs, false, '빈 즐겨찾기 절을 남기지 않는다');
});

test('글 없는 개인 1:1(D13)은 채팅 절에서 빠진다 — 즐겨찾기 여부와 상관없이 종전과 같다', () => {
  assert.ok(!ids(inPersonal([]).dms).includes(emptyFriendDm.id));
  assert.deepEqual(ids(inPersonal([]).dms), [crewDm.id, friendDm.id], '나머지는 들어온 순서 그대로(넓은 화면 레일은 정렬하지 않는다)');
});

test('조직 공간 — 채널·1:1·사람/에이전트 즐겨찾기가 한 목록, pin_pos 순서이고 같으면 이름순(종전과 같다)', () => {
  const r = railRooms({ channels: org, pinned: new Set([general.id, ops.id, kimDm.id]), pinPos: new Map([[kimDm.id, 0], [general.id, 2]]), targets: [pepperTarget], space: 'org-1' });
  assert.equal(r.showFavs, true);
  assert.deepEqual(ids(r.favs), [kimDm.id, pepperTarget.id, general.id, ops.id], 'pin_pos 0 → 대상 1 → 2 → 순서 없는 것은 끝');
  assert.deepEqual(ids(r.dms), [leeDm.id], '채팅 절은 즐겨찾기하지 않은 1:1만(채널은 채널 절이 그린다)');
  assert.equal(r.showDms, true);
  const tie = railRooms({ channels: org, pinned: new Set([ops.id, general.id]), space: 'org-1' });
  assert.deepEqual(ids(tie.favs), [general.id, ops.id], '순서가 없으면 이름순');
});

test('조직 공간 — AI 동의 전·조회 중(blocked)이면 즐겨찾기·채팅 절을 모두 가린다', () => {
  const r = railRooms({ channels: org, pinned: new Set([general.id, kimDm.id]), targets: [pepperTarget], blocked: true, space: 'org-1' });
  assert.equal(r.showFavs, false);
  assert.equal(r.showDms, false);
  assert.deepEqual(shown(r), []);
});

test('조직이 없으면(공간 없음) 대화가 있을 때만 채팅 절을 그린다', () => {
  assert.equal(railRooms({ channels: [], pinned: new Set(), space: null }).showDms, false);
  assert.equal(railRooms({ channels: [kimDm], pinned: new Set(), space: null }).showDms, true);
  assert.equal(railRooms({ channels: [], pinned: new Set(), space: 'org-1' }).showDms, true, '조직이 있으면 비어 있어도 새 대화 단추 자리');
});

const subsets = (xs) => xs.reduce((acc, x) => [...acc, ...acc.map((s) => [...s, x])], [[]]);

test('공간 × 즐겨찾기 조합 전부 — 보일 대화는 빠짐없이 한 번씩만 보이고, 동의 전엔 하나도 보이지 않는다', () => {
  const cases = [
    { space: PERSONAL, channels: personal, blocked: [false] }, // 개인 공간은 동의 게이트가 없다(App.jsx orgBlocked는 개인에서 늘 false)
    { space: 'org-1', channels: org, blocked: [false, true] },
    { space: null, channels: [kimDm, leeDm], blocked: [false] },
  ];
  for (const { space, channels, blocked } of cases) for (const b of blocked) for (const pins of subsets(ids(channels))) {
    const pinned = new Set(pins);
    const r = railRooms({ channels, pinned, hidden, blocked: b, space });
    const got = ids(shown(r));
    const label = `${space} blocked=${b} pinned=[${pins}]`;
    if (b) { assert.deepEqual(got, [], label); continue; }
    const want = channels.filter((c) => pinned.has(c.id) || (c.kind === 'dm' && !hidden(c))).map((c) => c.id);
    assert.deepEqual([...got].sort(), [...want].sort(), `${label} — 빠지거나 겹친 방`);
  }
});
