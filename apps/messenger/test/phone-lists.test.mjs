// 폰 채팅·채널 목록 정리(유건 요청 2026-10-02)
//  ① 즐겨찾기·알림 끄기를 하면 작은 토스트(누르면 바로, 약 2.5초 뒤 저절로 사라진다) — 폰만, 데스크톱은 종전대로
//  ② 채팅 탭: 즐겨찾기한 대화는 목록 맨 위 '즐겨찾기' 단락으로 따로
//  ③ 채널 탭: '즐겨찾기 · 채널 · <그룹들…> · +' 메뉴. 그룹은 나만 보이고, 채널 하나는 그룹 하나에만.
//     그룹에 넣은 채널은 '채널'에서 빠지고 그 그룹에서 보인다. 그룹을 지우면 채널은 '채널'로 돌아간다(채널은 그대로).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FLASH_MS, flashKey, splitFavs, cleanGroupName, groupNameTaken, sortGroups, channelMenu, resolveMenu,
  menuChannels, menuTalks, groupOfChannel, linkChange, groupDiff, nextGroupPos,
} from '../src/phone-lists.mjs';
import { DICT } from '../src/i18n.js';

const ids = (l) => l.map((x) => x.id).join(',');
const ch = (id, extra = {}) => ({ id, name: id, kind: 'public', ...extra });
const G = [{ id: 'g2', name: '운영', pos: 1, created_at: '2026-10-02T01:00:00Z' }, { id: 'g1', name: '마케팅', pos: 0, created_at: '2026-10-02T02:00:00Z' }];

test('토스트 — 2.5초, 즐겨찾기·알림 켬/끔마다 다른 문구 키', () => {
  assert.equal(FLASH_MS, 2500);
  assert.equal(flashKey('fav', true), 'flash.fav.on');
  assert.equal(flashKey('fav', false), 'flash.fav.off');
  assert.equal(flashKey('mute', true), 'flash.mute.on');
  assert.equal(flashKey('mute', false), 'flash.mute.off');
});

test('채팅 탭 즐겨찾기 단락 — 고정한 것만 위 단락, 나머지는 아래. 각 단락 안 순서는 그대로', () => {
  const list = [ch('a'), ch('b'), ch('c'), ch('d')];
  const { favs, rest } = splitFavs(list, new Set(['c', 'a']));
  assert.equal(ids(favs), 'a,c');
  assert.equal(ids(rest), 'b,d');
  const none = splitFavs(list, new Set());
  assert.equal(none.favs.length, 0);
  assert.equal(ids(none.rest), 'a,b,c,d');
});

test('그룹 이름 — 앞뒤 공백·연속 공백 정리, 30자까지, 같은 이름(대소문자 무시)은 겹침', () => {
  assert.equal(cleanGroupName('  마케팅   팀 '), '마케팅 팀');
  assert.equal(cleanGroupName('가'.repeat(40)).length, 30);
  assert.equal(cleanGroupName('   '), '');
  assert.equal(groupNameTaken(G, ' 마케팅 '), true);
  assert.equal(groupNameTaken([{ id: 'x', name: 'Sales' }], 'sales'), true);
  assert.equal(groupNameTaken(G, '마케팅', 'g1'), false, '자기 이름으로 다시 저장은 겹침이 아니다');
  assert.equal(groupNameTaken(G, '디자인'), false);
});

test('메뉴 — 즐겨찾기 · 채널 · 그룹(pos 순) 순서', () => {
  assert.deepEqual(sortGroups(G).map((g) => g.id), ['g1', 'g2']);
  assert.deepEqual(channelMenu(G), ['fav', 'channels', 'g:g1', 'g:g2']);
  assert.deepEqual(channelMenu([]), ['fav', 'channels']);
  assert.equal(nextGroupPos(G), 2);
  assert.equal(nextGroupPos([]), 0);
});

test('메뉴 고르기 — 지운 그룹을 보고 있었으면 채널로 돌아간다', () => {
  assert.equal(resolveMenu('g:g1', G), 'g:g1');
  assert.equal(resolveMenu('g:gone', G), 'channels');
  assert.equal(resolveMenu('fav', G), 'fav');
  assert.equal(resolveMenu(undefined, G), 'channels');
});

test('채널 거르기 — 그룹에 넣은 채널은 채널 메뉴에서 빠지고 그 그룹에서만, 즐겨찾기는 그룹과 상관없이', () => {
  const list = [ch('lean'), ch('general'), ch('ops'), ch('design')];
  const links = [{ channel_id: 'lean', group_id: 'g1' }, { channel_id: 'ops', group_id: 'g2' }, { channel_id: 'design', group_id: 'gone' }];
  const ctx = { pinned: new Set(['lean', 'general']), links, groups: G };
  assert.equal(ids(menuChannels('channels', list, ctx)), 'general,design', 'lean(마케팅)·ops(운영)는 빠진다, 지운 그룹을 가리키는 연결은 그룹 없음으로 본다');
  assert.equal(ids(menuChannels('g:g1', list, ctx)), 'lean');
  assert.equal(ids(menuChannels('g:g2', list, ctx)), 'ops');
  assert.equal(ids(menuChannels('fav', list, ctx)), 'lean,general', '즐겨찾기는 그룹에 든 채널도 보인다');
  assert.equal(groupOfChannel(links, G, 'lean')?.name, '마케팅');
  assert.equal(groupOfChannel(links, G, 'design'), null);
});

test("'이 조직의 대화' 단락 — 채널 메뉴는 전부, 즐겨찾기는 고정한 대화만, 그룹 메뉴엔 없다(대화는 그룹에 안 들어간다)", () => {
  const talks = [ch('d1', { kind: 'dm' }), ch('d2', { kind: 'dm' })];
  const pinned = new Set(['d2']);
  assert.equal(ids(menuTalks('channels', talks, pinned)), 'd1,d2');
  assert.equal(ids(menuTalks('fav', talks, pinned)), 'd2');
  assert.equal(menuTalks('g:g1', talks, pinned).length, 0);
});

test('채널 하나는 그룹 하나에만 — 넣기·옮기기·빼기, 바뀐 것이 없으면 쓰지 않는다', () => {
  const links = [{ channel_id: 'lean', group_id: 'g1' }];
  assert.deepEqual(linkChange(links, 'lean', 'g1').op, 'none', '같은 그룹에 다시 넣기 = 쓰기 없음');
  assert.deepEqual(linkChange(links, 'general', null).op, 'none', '그룹 없는 채널 빼기 = 쓰기 없음');
  const moved = linkChange(links, 'lean', 'g2');
  assert.equal(moved.op, 'upsert');
  assert.deepEqual(moved.next, [{ channel_id: 'lean', group_id: 'g2' }], '옮기면 옛 그룹 연결이 남지 않는다');
  const added = linkChange(links, 'general', 'g1');
  assert.equal(added.op, 'upsert');
  assert.equal(added.next.length, 2);
  const out = linkChange(links, 'lean', null);
  assert.equal(out.op, 'delete');
  assert.deepEqual(out.next, []);
});

test('그룹 편집 저장 — 체크한 채널과 지금 연결을 비교해 넣을 것·뺄 것만 낸다', () => {
  const links = [{ channel_id: 'a', group_id: 'g1' }, { channel_id: 'b', group_id: 'g1' }, { channel_id: 'c', group_id: 'g2' }];
  const d = groupDiff(links, 'g1', ['b', 'c', 'd']);
  assert.deepEqual(d.add.sort(), ['c', 'd'], 'c는 운영에서 옮겨 오고 d는 새로');
  assert.deepEqual(d.remove, ['a']);
  const same = groupDiff(links, 'g1', ['a', 'b']);
  assert.deepEqual([same.add, same.remove], [[], []], '그대로면 쓰기 없음');
});

// 배선 — App.jsx가 순수 함수를 쓰고, 토스트는 폰에서만, 새 문구는 두 언어 모두
test('배선 — 토스트는 폰에서만, 2.5초 뒤 저절로·누르면 바로 사라진다', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/phone-lists\.mjs'/);
  assert.match(src, /const flash = \(key, vars\) => \{ if \(!isPhoneRef\.current\) return;/, '데스크톱은 토스트를 띄우지 않는다');
  assert.match(src, /flashed\.current = \{ text, ms: FLASH_MS \}/, 'flash 시간은 그 문구와 짝지어 둔다(L-5)');
  assert.match(src, /setTimeout\(clearToast, toastMs\(\{ err, note, flashed: flashed\.current \}\)\)/, '토스트 시간은 toastMs가 정한다(행동은 위 L-5 테스트가 잠근다)');
  assert.match(src, /onClick=\{tapToast\} role="status"/, '누르면 바로 닫힌다');
  assert.match(src, /const tapToast = \(\) => \{ const back = [^;]+; clearToast\(\); if \(back\) runInSpace\(/, '누르면 언제나 먼저 닫고, 공간 전환 안내일 때만 직전 조직으로 돌아간다(2026-10-04 — 자동 닫힘 타이머는 clearToast만)');
  assert.match(src, /flash\(flashKey\('fav', on\)\)/);
  assert.match(src, /flash\(flashKey\('mute', on\)\)/);
});

test('배선 — 그룹 표는 폰 조직 공간에서만, 바뀔 때·복귀 때만 읽는다(주기 없음)', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /from\('msgr_channel_groups'\)\.select\('id, name, pos, created_at, msgr_channel_group_links\(channel_id\)'\)/, '그룹과 연결을 한 번에 읽는다');
  assert.match(src, /\}, \[uid, orgId, isPhone, syncEpoch\]\);/, '앞으로 올 때(syncEpoch)·조직 전환 때만');
});

test('i18n — 새 문구는 ko/en 모두', () => {
  const keys = ['flash.fav.on', 'flash.fav.off', 'flash.mute.on', 'flash.mute.off', 'phone.sec.fav', 'phone.sec.chats', 'phone.chmenu', 'phone.chmenu.fav', 'phone.chmenu.channels', 'phone.chmenu.add',
    'grp.new', 'grp.edit', 'grp.name', 'grp.name.taken', 'grp.save', 'grp.create', 'grp.delete', 'grp.delete.confirm', 'grp.delete.note', 'grp.channels', 'grp.in', 'grp.pick', 'grp.pick.none', 'grp.pick.new',
    'grp.moved', 'grp.removed', 'grp.created', 'grp.deleted', 'grp.linkFail', 'grp.empty', 'grp.fav.empty', 'grp.channels.allGrouped', 'ch.group'];
  for (const k of keys) {
    const row = DICT[k];
    assert.ok(Array.isArray(row) && row.length === 2 && row.every((s) => typeof s === 'string' && s.trim()), `${k} ko/en`);
    assert.match(row[0], /[가-힣]/, `${k} 한국어`);
  }
});

// ── 분리 검수 M-4·L-4·L-5(2026-10-02) — 행동 테스트
import { searchMenu, toastMs, createGroupFlow } from '../src/phone-lists.mjs';

test('M-4 채널 탭 검색 — 검색어가 있으면 고른 메뉴를 무시하고 채널·대화 전체에서, 지우면 고른 메뉴로', () => {
  const list = [ch('lean'), ch('general'), ch('ops')];
  const talks = [ch('d1', { kind: 'dm' }), ch('d2', { kind: 'dm' })];
  const links = [{ channel_id: 'lean', group_id: 'g1' }, { channel_id: 'ops', group_id: 'g2' }];
  const ctx = { pinned: new Set(['d2']), links, groups: G };
  for (const key of ['g:g1', 'fav', 'channels']) {
    const k = searchMenu(key, 'o');
    assert.equal(ids(menuChannels(k, list, ctx)), 'lean,general,ops', `${key}에서 검색 — 채널 전부`);
    assert.equal(ids(menuTalks(k, talks, ctx.pinned)), 'd1,d2', `${key}에서 검색 — 대화 전부`);
  }
  assert.equal(searchMenu('g:g1', '   '), 'g:g1', '공백만이면 검색이 아니다');
  assert.equal(searchMenu('g:g1', ''), 'g:g1', '검색어를 지우면 고른 메뉴');
  assert.equal(ids(menuChannels(searchMenu('g:g1', ''), list, ctx)), 'lean');
});

test('L-5 토스트 시간 — 짧은 토스트(flash)의 시간은 그 문구에만, 그 사이 뜬 다른 안내는 종전 4초, 오류는 8초', () => {
  const flashed = { text: '즐겨찾기에 추가했습니다', ms: FLASH_MS };
  assert.equal(toastMs({ note: '즐겨찾기에 추가했습니다', flashed }), FLASH_MS);
  assert.equal(toastMs({ note: '링크를 복사했습니다', flashed }), 4000, 'flash 뒤 다른 안내가 2.5초 만에 사라지지 않는다');
  assert.equal(toastMs({ err: '실패', note: '', flashed }), 8000);
  assert.equal(toastMs({ note: '저장했습니다', flashed: null }), 4000);
});

test('L-4 그룹 만들기 — 그룹은 만들어졌는데 채널 넣기가 실패하면 만든 그룹을 돌려주고 넣기 실패만 알린다(다시 누르면 같은 이름 오류가 나던 것)', async () => {
  const made = { id: 'g-new', name: '마케팅', pos: 0 };
  const ok = await createGroupFlow({ insertGroup: async () => made, linkChannels: async () => {} });
  assert.deepEqual(ok, { row: made, linkError: null });
  const boom = new Error('network');
  const half = await createGroupFlow({ insertGroup: async () => made, linkChannels: async () => { throw boom; } });
  assert.equal(half.row, made, '만든 그룹은 그대로 돌려준다');
  assert.equal(half.linkError, boom);
  await assert.rejects(createGroupFlow({ insertGroup: async () => { throw new Error('dup'); }, linkChannels: async () => {} }), /dup/, '그룹 자체를 못 만들면 던진다');
});
