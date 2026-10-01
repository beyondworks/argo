// 점검 A·B #3 — 조직을 나간 사람의 옛 글 작성자가 id 앞 8자리("b84c0107")로 보이던 결함.
// 재현(QA 로컬 DB, 데스크톱 1440 general): .msgr-row .who에 "b84c0107", 아바타 "b". 원인 = nameOfUser가 멤버(removed_at null만 읽음) → 개인 그룹 이름표 →
// id.slice(0, 8) 순이었다. 나간 사람은 조직 구성원 목록에 없고, 같은 방에도 이미 없어서 서버 이름 조회(msgr_people_names)도 비어 돌아온다 —
// 그래서 (1) 조직 안 이름은 나간 사람의 행에서도 읽고 (2) 그래도 없으면 서버 이름 규칙 (3) 끝내 모르면 id 대신 "나간 사용자".
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePeopleNames, nameForUser } from '../src/person-names.mjs';

// 질의 흉내 — select/eq/in/is는 기록만 하고, await 하면 표에서 거른 행을 돌려준다
function fakeClient({ orgRows = [], rpcRows = null, rpcError = false, profiles = [] } = {}) {
  const calls = { org: [], rpc: [], profiles: [] };
  const query = (table, rows, log) => {
    const f = { eq: [], in: [] };
    const q = { select() { return q; }, eq(k, v) { f.eq.push([k, v]); return q; }, in(k, v) { f.in.push([k, v]); return q; },
      then(resolve, reject) { log.push(f); const ids = f.in[0]?.[1] ?? []; return Promise.resolve({ data: rows.filter((r) => ids.includes(r.user_id)), error: null }).then(resolve, reject); } }; // 실제 질의 빌더처럼 then이 Promise를 돌려준다
    return q;
  };
  return { calls, from(table) {
    if (table === 'msgr_org_members') return query(table, orgRows, calls.org);
    if (table === 'msgr_profiles') return query(table, profiles, calls.profiles);
    throw new Error(`unexpected table ${table}`);
  }, rpc(name, args) {
    assert.equal(name, 'msgr_people_names'); calls.rpc.push(args.ids);
    return Promise.resolve(rpcError ? { data: null, error: { message: 'function does not exist' } } : { data: (rpcRows ?? []).filter((r) => args.ids.includes(r.user_id)), error: null });
  } };
}

test('나간 사람도 조직 안 이름이 남아 있으면 그 이름을 쓴다(removed 행 포함 조회)', async () => {
  const sb = fakeClient({ orgRows: [{ user_id: 'u-left', display_name: '민준' }] });
  const names = await resolvePeopleNames(sb, { orgId: 'org1', ids: ['u-left'] });
  assert.equal(names['u-left'], '민준');
  assert.deepEqual(sb.calls.org[0].eq, [['org_id', 'org1']], '그 조직의 행만');
  assert.equal(sb.calls.rpc.length, 0, '이미 찾았으면 서버 이름 조회를 하지 않는다');
});

test('조직 안 이름이 비어 있으면 서버 이름 규칙(프로필 이름 → 이메일 앞부분)으로 물러난다', async () => {
  const sb = fakeClient({ orgRows: [{ user_id: 'a', display_name: '  ' }, { user_id: 'b', display_name: null }], rpcRows: [{ user_id: 'a', name: 'hana' }] });
  const names = await resolvePeopleNames(sb, { orgId: 'org1', ids: ['a', 'b', 'c'] });
  assert.equal(names.a, 'hana');
  assert.equal('b' in names, false, '끝내 못 찾으면 키가 없다');
  assert.equal('c' in names, false);
  assert.deepEqual(sb.calls.rpc, [['a', 'b', 'c']], '못 찾은 것만 한 번에');
});

test('개인 공간(조직 없음)은 조직 행을 읽지 않고 서버 이름 규칙만 쓴다', async () => {
  const sb = fakeClient({ rpcRows: [{ user_id: 'x', name: '친구' }] });
  assert.deepEqual(await resolvePeopleNames(sb, { orgId: null, ids: ['x'] }), { x: '친구' });
  assert.equal(sb.calls.org.length, 0);
});

test('옛 서버(함수 없음)면 프로필 이름으로 물러난다 — 목록이 통째로 비지 않는다', async () => {
  const sb = fakeClient({ rpcError: true, profiles: [{ user_id: 'p', display_name: '프로필이름' }] });
  assert.deepEqual(await resolvePeopleNames(sb, { orgId: null, ids: ['p', 'q'] }), { p: '프로필이름' });
});

test('빈 목록은 호출하지 않고, 같은 id는 한 번만 묻고, 200명씩 끊어 묻는다', async () => {
  const none = fakeClient(); assert.deepEqual(await resolvePeopleNames(none, { orgId: 'o', ids: [] }), {});
  assert.deepEqual([none.calls.org.length, none.calls.rpc.length], [0, 0]);
  const many = fakeClient({ rpcRows: [] });
  const ids = Array.from({ length: 450 }, (_, i) => `u${i}`);
  await resolvePeopleNames(many, { orgId: null, ids: [...ids, ...ids] });
  assert.deepEqual(many.calls.rpc.map((c) => c.length), [200, 200, 50]);
});

test('nameForUser — 멤버 → 개인 그룹 이름표 → 조회한 이름 → "나간 사용자", id 앞 8자리는 절대 보이지 않는다', () => {
  const members = [{ user_id: 'm1', display_name: '유건' }];
  const base = { members, otherNames: { o1: '하나' }, resolved: { r1: '민준' }, left: '나간 사용자', deleted: '삭제된 사용자' };
  assert.equal(nameForUser({ ...base, id: 'm1' }), '유건');
  assert.equal(nameForUser({ ...base, id: 'o1' }), '하나');
  assert.equal(nameForUser({ ...base, id: 'r1' }), '민준');
  assert.equal(nameForUser({ ...base, id: 'b84c0107-aaaa-bbbb-cccc-000000000000' }), '나간 사용자');
  assert.equal(nameForUser({ ...base, id: null }), '삭제된 사용자', '계정 삭제(작성자 id null)는 종전 문구');
  assert.equal(nameForUser({ ...base, id: 'm1', members: [{ user_id: 'm1', display_name: '' }], resolved: { m1: '이메일앞' } }), '이메일앞', '멤버 행에 이름이 비면 다음 규칙');
});
