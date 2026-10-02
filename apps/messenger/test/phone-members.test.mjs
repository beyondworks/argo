// 5차 피드백(유건 2026-10-02) — 폰 조직 설정 멤버 탭: 맨 위 '나'(사진·이름·역할 + 부서·직급 칸), 검색(이름·부서)과 역할 칩(전체/관리자/멤버/게스트),
// 나머지 멤버는 친구 줄처럼(사진·한 줄 이름·'부서 · 직급'·오른쪽 역할, 버튼 없음). 줄을 누르면 시트에서 역할 바꾸기·내보내기(권한 있을 때만), 소유자는 못 바꾸고 못 내보낸다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memberRows, memberPerms, MEMBER_CHIPS } from '../src/phone-members.mjs';

const members = [
  { user_id: 'me', role: 'admin', display_name: '유건' },
  { user_id: 'o', role: 'owner', display_name: '대표' },
  { user_id: 'a', role: 'admin', display_name: 'Alice' },
  { user_id: 'm', role: 'member', display_name: '민수' },
  { user_id: 'g', role: 'guest', display_name: '손님' },
  { user_id: 'svc', role: 'member', display_name: '서버' },
];
const profiles = new Map([['m', { department: '마케팅', title: '매니저' }], ['a', { department: '개발', title: '' }]]);

test('목록 — 나는 빼고(맨 위 따로), 칩은 전체/관리자/멤버/게스트이고 관리자 칩에 소유자도 든다', () => {
  assert.deepEqual(MEMBER_CHIPS, ['all', 'admin', 'member', 'guest']);
  const ids = (o) => memberRows(members, { uid: 'me', profiles, ...o }).map((r) => r.user_id);
  assert.deepEqual(ids({}), ['o', 'a', 'm', 'g', 'svc']);
  assert.deepEqual(ids({ chip: 'admin' }), ['o', 'a']);
  assert.deepEqual(ids({ chip: 'member', serviceId: 'svc' }), ['m'], '서버 계정은 역할 칩에서 빠진다(전체에서만)');
  assert.deepEqual(ids({ chip: 'guest' }), ['g']);
});

test('검색 — 이름·부서에서 대소문자 없이, 칩과 같이 건다', () => {
  const ids = (o) => memberRows(members, { uid: 'me', profiles, ...o }).map((r) => r.user_id);
  assert.deepEqual(ids({ q: '마케' }), ['m'], '부서로 찾는다');
  assert.deepEqual(ids({ q: 'alice' }), ['a']);
  assert.deepEqual(ids({ q: '개발', chip: 'member' }), [], '칩과 검색은 같이');
  assert.deepEqual(ids({ q: '  ' }), ['o', 'a', 'm', 'g', 'svc']);
});

test("줄 정보 — '부서 · 직급'(빈 칸은 뺀다), 서버 계정 표시", () => {
  const rows = memberRows(members, { uid: 'me', profiles, serviceId: 'svc' });
  assert.equal(rows.find((r) => r.user_id === 'm').sub, '마케팅 · 매니저');
  assert.equal(rows.find((r) => r.user_id === 'a').sub, '개발');
  assert.equal(rows.find((r) => r.user_id === 'g').sub, '');
  assert.equal(rows.find((r) => r.user_id === 'svc').service, true);
});

test('권한 — 관리자·소유자만 바꾸고 내보낸다, 소유자·나·서버 계정은 누구도 못 바꾼다', () => {
  const p = (viewerRole, target, extra = {}) => memberPerms({ viewerRole, target, uid: 'me', serviceId: 'svc', ...extra });
  assert.deepEqual(p('admin', members[3]), { canRole: true, canRemove: true });
  assert.deepEqual(p('owner', members[2]), { canRole: true, canRemove: true });
  assert.deepEqual(p('member', members[3]), { canRole: false, canRemove: false }, '멤버는 보기만');
  assert.deepEqual(p('admin', members[1]), { canRole: false, canRemove: false }, '소유자는 못 바꾸고 못 내보낸다');
  assert.deepEqual(p('admin', members[0]), { canRole: false, canRemove: false }, '나 자신은 여기서 안 바꾼다');
  assert.deepEqual(p('admin', members[5]), { canRole: false, canRemove: false }, '서버 계정');
});
