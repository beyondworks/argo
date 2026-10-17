// 보관 1:1 검색(총괄 결정 2026-10-13 ④) — 개인 공간 '전체에서 찾기'에 내 보관 1:1을 넣고, 결과를 누르면 보관 방을 읽기 전용으로 연다(조직 공간 Q3도 같은 경로).
//  · 보관 행 조회는 검색 1회에 1건(주기 없음). 개인 공간은 내 보관 1:1(사람 = 나 하나, 에이전트 = 내 크루 하나)만 글 조회에 더한다.
//  · App.jsx의 실제 runSearch·openArchivedHit를 꺼내 가짜 의존성으로 돌린다(legacy-dm-archived-view.test.mjs와 같은 방식).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as G from '../src/agent-groups.mjs';
import { fetchSearchRows } from '../src/search-rows.mjs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
function statement(head) { // 괄호 깊이 0의 첫 ';'까지(따옴표·템플릿 안은 건너뛴다)
  const start = app.indexOf(head); assert.ok(start >= 0, `${head} 가 App.jsx에 있어야 한다`);
  let depth = 0; let q = null;
  for (let i = start + head.length; i < app.length; i++) {
    const ch = app[i];
    if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') q = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ';' && depth === 0) return app.slice(start + head.length, i);
  }
  throw new Error('문장 끝을 찾지 못함');
}

const ME = 'u-me', LEAN = 'org-lean', OTHER = 'u-other';
const MY_ORG_CREW = 'k-pepper-org', THEIR_CREW = 'k-their';
const ch = (id, extra = {}) => ({ id, kind: 'dm', name: 'dm:페퍼', org_id: LEAN, archived_at: '2026-10-13T05:00:00Z', created_by: ME, ...extra });
const members = (...pairs) => pairs.map(([member_kind, member_id]) => ({ member_kind, member_id }));
const OWN = new Set([MY_ORG_CREW, 'k-pepper-personal']);

test('archivedSearchRooms — 내 보관 1:1만 mine, 그 밖의 보관 DM은 열 수만 있게 남긴다', () => {
  const rows = [
    { ...ch('mine'), msgr_channel_members: members(['user', ME], ['crew', MY_ORG_CREW]) },
    { ...ch('with-other'), msgr_channel_members: members(['user', ME], ['user', OTHER], ['crew', MY_ORG_CREW]) }, // 남이 낀 방
    { ...ch('their-crew'), msgr_channel_members: members(['user', ME], ['crew', THEIR_CREW]) }, // 남의 에이전트
    { ...ch('two-crews'), msgr_channel_members: members(['user', ME], ['crew', MY_ORG_CREW], ['crew', 'k-other-mine']) },
    { ...ch('live', { archived_at: null }), msgr_channel_members: members(['user', ME], ['crew', MY_ORG_CREW]) }, // 보관 안 됨
    { ...ch('personal', { org_id: null }), msgr_channel_members: members(['user', ME], ['crew', MY_ORG_CREW]) }, // 개인 방
    { ...ch('group', { kind: 'private' }), msgr_channel_members: members(['user', ME], ['crew', MY_ORG_CREW]) },
    { ...ch('no-members') },
  ];
  const got = G.archivedSearchRooms(rows, { uid: ME, ownCrewIds: OWN });
  assert.deepEqual([...got.keys()], ['mine', 'with-other', 'their-crew', 'two-crews', 'no-members'], '보관한 조직 DM만 담는다');
  assert.deepEqual([...got.values()].filter((a) => a.mine).map((a) => a.channel.id), ['mine']);
  assert.equal(got.get('mine').crewId, MY_ORG_CREW, '개인 1:1로 이동 띠가 쓸 조직 행');
  assert.equal(got.get('with-other').crewId, null, '내 1:1이 아니면 띠 없음');
  assert.equal('msgr_channel_members' in got.get('mine').channel, false, '채널 행에서 구성원은 뺀다(earlierRoom.channel 모양)');
  assert.equal(got.get('mine').orgId, LEAN);
  assert.equal(G.archivedSearchRooms(rows, { uid: ME, ownCrewIds: null }).get('mine').mine, false, '내 크루 행을 아직 모르면 mine 아님(좁게)');
  assert.equal(G.archivedSearchRooms(null, { uid: ME, ownCrewIds: OWN }).size, 0);
});

// ── runSearch — 가짜 supabase(조회 기록) ──
function fakeDb(answer) {
  const calls = [];
  const from = (table) => {
    const ops = [];
    const api = new Proxy({}, { get: (_, k) => (k === 'then' ? (res, rej) => { calls.push({ table, ops }); return Promise.resolve(answer(table, ops)).then(res, rej); } : (...args) => { ops.push([k, ...args]); return api; }) });
    return api;
  };
  return { calls, client: { from } };
}
const runSearchSrc = statement('const runSearch = ');
const DEPS = ['V2', 'v2SearchFound', 'supabase', 'q', 'org', 'isPersonal', 'blockedIds', 'uid', 'ownCrews', 'pushDiag', 'fetchSearchRows', 'SEARCH_LIMIT', 'searchSeq', 'activeOrg', 'setPage', 'setRail', 'setSearchRes', 'setSearchBusy',
  'members', 'crews', 'crewTier', 'channels', 'previewChannels', 'searchChannelsByName', 'archivedSearchRooms', 'ARCHIVED_ROOM_COLS'];
function makeRunSearch({ personal, db, ownRows = [{ id: MY_ORG_CREW }] }) {
  const out = { res: null, diag: [] };
  const deps = { supabase: db.client, q: (p) => Promise.resolve(p).then((r) => (r?.error ? Promise.reject(r.error) : r.data)), org: { id: personal ? 'personal' : LEAN }, isPersonal: personal, blockedIds: new Set(), uid: ME,
    V2: false /* 메신저 v2 플래그 꺼짐(기본) — 옛 검색 경로 */, v2SearchFound: null, ownCrews: { rows: ownRows }, pushDiag: (k, m) => out.diag.push([k, m]), fetchSearchRows, SEARCH_LIMIT: 60, searchSeq: { current: 0 }, activeOrg: { current: personal ? 'personal' : LEAN },
    setPage: () => {}, setRail: () => {}, setSearchRes: (r) => { out.res = r; }, setSearchBusy: () => {}, members: [], crews: [], crewTier: () => null, channels: [], previewChannels: [], searchChannelsByName: () => [],
    archivedSearchRooms: G.archivedSearchRooms, ARCHIVED_ROOM_COLS: G.ARCHIVED_ROOM_COLS };
  const fn = new Function(...DEPS, `return ${runSearchSrc};`)(...DEPS.map((k) => deps[k]));
  return { run: fn, out };
}
const ARCH_ROWS = [{ ...ch('arch-mine'), msgr_channel_members: members(['user', ME], ['crew', MY_ORG_CREW]) }, { ...ch('arch-other'), msgr_channel_members: members(['user', ME], ['user', OTHER]) }];
const answer = (table) => ({ data: table === 'msgr_channels' ? ARCH_ROWS : [{ id: 9, channel_id: 'arch-mine', author_kind: 'user', author_user_id: ME, body: '바버샵 예약', created_at: '2026-09-24T09:00:00Z' }], error: null });

test('개인 공간 검색 — 보관 행 조회 1건 뒤 글 조회에 내 보관 1:1만 더한다(org_id 없음 또는 그 방)', async () => {
  const db = fakeDb(answer);
  const { run, out } = makeRunSearch({ personal: true, db });
  await run('바버샵');
  assert.deepEqual(db.calls.map((c) => c.table), ['msgr_channels', 'msgr_messages'], '검색 1회 = 보관 행 1건 + 글 1건(종전보다 1건만 늘어남)');
  const arch = db.calls[0].ops;
  assert.deepEqual(arch.filter(([k]) => k !== 'select'), [['eq', 'kind', 'dm'], ['not', 'archived_at', 'is', null], ['not', 'org_id', 'is', null]], '보관한 조직 DM만');
  assert.match(arch.find(([k]) => k === 'select')[1], /msgr_channel_members\(member_kind, member_id\)/, '구성원을 같은 조회에 내장');
  const msgOps = db.calls[1].ops;
  assert.deepEqual(msgOps.find(([k]) => k === 'or'), ['or', 'org_id.is.null,channel_id.in.(arch-mine)'], '내 보관 1:1만(남이 낀 보관 방은 빼고)');
  assert.ok(!msgOps.some(([k, col]) => k === 'is' && col === 'org_id'), 'org_id IS NULL 단독 조건 대신 or');
  assert.ok(!msgOps.some(([k, col]) => k === 'eq' && col === 'org_id'), '개인 공간은 가상 org id로 조회하지 않는다(늘 빈다)');
  assert.equal(out.res.msgs.length, 1);
  assert.equal(out.res.archived.get('arch-mine').mine, true, '결과를 누를 때 쓸 보관 행을 결과에 싣는다');
});

test('개인 공간 검색 — 보관 1:1이 없거나 조회가 실패하면 종전 조건(org_id IS NULL) 그대로, 실패는 진단에만', async () => {
  for (const [label, ans] of [['없음', (t) => ({ data: t === 'msgr_channels' ? [] : [], error: null })], ['실패', (t) => (t === 'msgr_channels' ? { data: null, error: { message: 'boom' } } : { data: [], error: null })]]) {
    const db = fakeDb(ans);
    const { run, out } = makeRunSearch({ personal: true, db });
    await run('x');
    const msgOps = db.calls.find((c) => c.table === 'msgr_messages').ops;
    assert.deepEqual(msgOps.find(([k, col]) => k === 'is' && col === 'org_id'), ['is', 'org_id', null], label);
    assert.ok(!msgOps.some(([k]) => k === 'or'), label);
    assert.equal(out.res.archived.size, 0, label);
    if (label === '실패') assert.deepEqual(out.diag.map(([k]) => k), ['search-archived']);
  }
});

test('조직 공간 검색 — 글 조회 조건은 종전 그대로(org_id = 조직), 보관 행 조회 1건만 더해 결과에 싣는다(Q3)', async () => {
  const db = fakeDb(answer);
  const { run, out } = makeRunSearch({ personal: false, db });
  await run('바버샵');
  assert.deepEqual(db.calls.map((c) => c.table).sort(), ['msgr_channels', 'msgr_messages']);
  const msgOps = db.calls.find((c) => c.table === 'msgr_messages').ops;
  assert.deepEqual(msgOps.find(([k, col]) => k === 'eq' && col === 'org_id'), ['eq', 'org_id', LEAN]);
  assert.ok(!msgOps.some(([k]) => k === 'or'));
  assert.deepEqual([...out.res.archived.keys()], ['arch-mine', 'arch-other'], '조직 공간은 내 1:1이 아닌 보관 DM도 열 수 있게 싣는다');
});

// ── 결과 열기 — openArchivedHit ──
const openSrc = statement('const openArchivedHit = ');
test('보관 방 결과를 누르면 그 조직으로 옮겨 earlierRoom(읽기 전용)으로 열고 그 글로 이동한다 — 추가 조회 없음, 읽음 커서 안 씀', () => {
  const log = [];
  const deps = { runInSpace: (space, run) => { log.push(['space', space]); run(); }, setEarlierRoom: (v) => log.push(['earlier', v]), setChId: (v) => log.push(['ch', v]), setPage: (v) => log.push(['page', v]),
    setRail: () => {}, setSheet: () => {}, setJump: (v) => log.push(['jump', v]) };
  const open = new Function(...Object.keys(deps), `return ${openSrc};`)(...Object.values(deps));
  const a = G.archivedSearchRooms([{ ...ch('arch-mine'), msgr_channel_members: members(['user', ME], ['crew', MY_ORG_CREW]) }], { uid: ME, ownCrewIds: OWN }).get('arch-mine');
  open(a, 9);
  assert.deepEqual(log[0], ['space', LEAN], '그 방의 조직으로');
  const earlier = log.find(([k]) => k === 'earlier')[1];
  assert.deepEqual(earlier, { orgId: LEAN, channel: a.channel, crewId: MY_ORG_CREW, unread: 0 });
  assert.equal(G.archivedRoomFor(earlier, { orgId: LEAN, chId: 'arch-mine' }), a.channel, '그리기 판정(archivedRoomFor)이 이 방을 읽기 전용으로 본다');
  assert.equal(G.archivedReadStep(earlier, 'arch-mine'), 'skip', '안 읽은 수를 모르므로 읽음 커서를 쓰지 않는다');
  assert.deepEqual(log.find(([k]) => k === 'ch'), ['ch', 'arch-mine']);
  assert.deepEqual(log.find(([k]) => k === 'jump'), ['jump', { ch: 'arch-mine', mid: 9 }]);
});

test('결과 열기 분기 — 보관 행이 있고 지금 목록에 없는 방만 openArchivedHit, 그 밖은 종전대로 setChId', () => {
  const onOpenSrc = app.match(/<SearchPage [^\n]*?onOpen=\{(\(id, mid\) => \{[^\n]*?\})\} onCrew=/)?.[1];
  assert.ok(onOpenSrc, 'SearchPage onOpen 식');
  const run = (archived, channels) => {
    const log = [];
    const fn = new Function('searchRes', 'channels', 'openArchivedHit', 'setChId', 'setPage', 'setJump', `return ${onOpenSrc};`)(
      { archived }, channels, (a, mid) => log.push(['arch', a.channel.id, mid]), (v) => log.push(['ch', v]), () => {}, () => {});
    fn('arch-mine', 9); return log;
  };
  const a = G.archivedSearchRooms([{ ...ch('arch-mine'), msgr_channel_members: members(['user', ME], ['crew', MY_ORG_CREW]) }], { uid: ME, ownCrewIds: OWN });
  assert.deepEqual(run(a, []), [['arch', 'arch-mine', 9]], '보관 방');
  assert.deepEqual(run(a, [{ id: 'arch-mine' }]), [['ch', 'arch-mine']], '그 사이 보관이 풀려 목록에 있으면 종전대로');
  assert.deepEqual(run(new Map(), []), [['ch', 'arch-mine']], '보관 행 없음(옛 결과) — 종전대로');
  assert.deepEqual(run(undefined, []), [['ch', 'arch-mine']]);
});
