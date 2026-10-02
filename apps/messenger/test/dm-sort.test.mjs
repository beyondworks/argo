// 폰 DM 탭 정렬(순수 함수) + App 배선 핀 — 유건 요청 2026-09-15(최근 메시지·안읽은 메시지·고정).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sortDms, DM_SORTS } from '../src/dm-sort.mjs';

const dms = [{ id: 'a', name: '나' }, { id: 'b', name: '가' }, { id: 'c', name: '다' }];
const lastAt = { a: 100, b: 300, c: 200 };
const ids = (l) => l.map((c) => c.id).join('');

test('recent — 마지막 메시지 시각 내림차순, 모르면 맨 뒤·이름순', () => {
  assert.equal(ids(sortDms(dms, { sort: 'recent', lastAt })), 'bca');
  assert.equal(ids(sortDms(dms, { sort: 'recent', lastAt: { c: 1 } })), 'cba', '시각 없는 a·b는 뒤에서 이름순(가<나)');
  assert.equal(ids(sortDms(dms, { sort: '없는값', lastAt })), 'bca', '모르는 값은 recent');
});

test('unread — 안읽음 있는 대화 먼저(그 안은 최근순), 없는 대화는 최근순', () => {
  assert.equal(ids(sortDms(dms, { sort: 'unread', lastAt, unread: { a: { n: 2 }, c: { n: 0 } } })), 'abc');
  assert.equal(ids(sortDms(dms, { sort: 'unread', lastAt, unread: { a: { n: 1 }, c: { n: 5 } } })), 'cab', '안읽음끼리는 최근순(c 200 > a 100)');
});

test('name — 한글 이름순, 입력을 바꾸지 않는다', () => {
  const copy = [...dms];
  assert.equal(ids(sortDms(dms, { sort: 'name' })), 'bac');
  assert.deepEqual(dms, copy);
  assert.deepEqual(DM_SORTS, ['recent', 'unread', 'name', 'custom']); // 직접 배치 추가(유건 확정 2026-09-29) — dm-sort-custom.test.mjs
});

test('배선 — 폰 채팅 탭: 고정한 방이 맨 위 + 정렬 메뉴 + 칩, 그룹 판정은 한 곳(phone-shell.mjs)', () => {
  // 폰 셸 v2(유건 확정 2026-10-01): 옛 DM 탭(즐겨찾기 칩·고정 단락)은 채팅 탭으로 바뀌었다 — 고정 방은 목록 맨 위(카톡), 칩은 전체/안읽음/에이전트/그룹.
  // 정렬·고정 순서의 행동은 test/phone-shell.test.mjs(sortRooms)가 본다. 여기서는 배선만 잠근다.
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /const chatSorted = sortRooms\(chatsAll, \{ sort: dmSort, atOf: \(c\) => rowOf\(c\)\.at, unread, pinned, pinPos, nameOf: dmBaseName, sortPos: dmSortPos \}\);/, '고정(pin_pos 순) 먼저, 나머지는 고른 정렬');
  assert.match(src, /const chatFiltered = chatSorted\.filter\(\(c\) => chatVisible\(dmFilter, \{ \.\.\.rowOf\(c\), \.\.\.traitsOf\(c\) \}\)\);/, '칩은 chatVisible 한 곳에서');
  assert.match(src, /CHAT_FILTERS\.map\(\(k\) => <button key=\{k\} type="button" role="radio" aria-checked=\{dmFilter === k\}/, '칩 4종');
  assert.match(src, /localStorage\.setItem\('argo-msgr-dm-sort', v\)/, '정렬은 기기에 기억');
  assert.match(src, /DM_SORTS\.map\(\(v\) => <button key=\{v\} type="button" role="menuitemradio" aria-checked=\{dmSort === v\}/, '정렬 메뉴');
  assert.doesNotMatch(src, /msgr-dmpin/, '고정 별 아이콘 없음(유건 2026-09-15: 즐겨찾기 별 아이콘 쓰지 마)');
  assert.match(src, /const traitsOf = \(c\) => roomTraits\(\{ c, members: dmMembers\[c\.id\] \?\? \[\], uid, ownerOf: \(id\) => crewOf\(id\)\?\.owner_user_id \?\? null \}\);/, '그룹 판정 정본: roomTraits(나 뺀 참가자 2 이상, 남의 크루 1:1은 예외)');
  assert.match(src, /const dmIsGroup = \(c\) => traitsOf\(c\)\.group;/);
  assert.match(src, /if \(dmIsGroup\(c\)\) \{ const names = \[\.\.\.crewsIn\.map/, 'dmName은 같은 판정을 쓴다(검수 HIGH-2)');
  assert.match(src, /\{r\.muted && <I name="belloff" size=\{13\} className="ph-kic" \/>\}/, '폰 줄 알림 끔 표시(검수 HIGH-1 회귀 방지)');
  assert.match(src, /<><span className="name">\{dmBaseName\(c\)\}<\/span>\{muted\.has\(c\.id\) && <I name="belloff" size=\{12\} className="mi" \/>\}<\/>/, '데스크톱 행은 이름과 음소거 벨만 표기');
  assert.doesNotMatch(src, /dmVacated|msgr-vacated|dm\.vacated\.tag/, 'DM 상태를 추정해 이름 뒤에 라벨을 붙이지 않는다');
  assert.match(src, /onPointerUp: \(e\) => \{\n\s+lp\.onPointerUp\(e\);[\s\S]{0,300}swallowNext\(\);\n\s+\},/, 'click 삼킴은 손 뗀 직후에만 등록(검수 HIGH-3) — 직접 배치 끌기 분기가 추가됐어도 항상 마지막에 swallowNext');
  assert.match(src, /draggable=\{!isPhone\}/, '폰 행은 드래그 끔(iOS 드래그 리프트가 click을 삼키는 것 방지)');
  assert.match(src, /\{\.\.\.rowLongPress\(c, items, dragCtx\)\}/, '폰 줄은 길게 누르기로 메뉴·끌기');
  assert.match(src, /select\('id, channel_id, body, author_user_id, crew_id, created_at'\)\.in\('id', ids\)\.is\('deleted_at', null\)/, '한 줄 미리보기는 마지막 글 id로 한 번에, 삭제 글 제외');
});
