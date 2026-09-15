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
  assert.deepEqual(DM_SORTS, ['recent', 'unread', 'name']);
});

test('배선 — DM 탭에서만 고정 DM을 맨 위에 + 정렬 메뉴, 즐겨찾기는 DM 탭에서도 사라지지 않는다', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /const dmTab = isPhone && page === 'dm';/);
  assert.match(src, /const dmSorted = \(list\) => sortDms\(list, \{ sort: dmSort, lastAt, unread, nameOf: dmName \}\);/);
  assert.match(src, /const dmPinnedTop = dmTab \? channels\.filter\(\(c\) => c\.kind === 'dm' && pinned\.has\(c\.id\)\)\.sort\(\(a, b\) => \(pinPos\.get\(a\.id\) \?\? 1e9\) - \(pinPos\.get\(b\.id\) \?\? 1e9\)\)/, '고정 = 즐겨찾기한 DM, pin_pos 순');
  assert.match(src, /const dmList = dmTab \? \[\.\.\.dmPinnedTop, \.\.\.dmSorted\(dms\)\] : dms;/);
  assert.match(src, /<div className="msgr-list">\{dmList\.map\(dmRow\)\}<\/div>/);
  assert.match(src, /localStorage\.setItem\('argo-msgr-dm-sort', v\)/, '정렬은 기기에 기억');
  assert.match(src, /DM_SORTS\.map\(\(v\) => <button key=\{v\} type="button" role="menuitemradio" aria-checked=\{dmSort === v\}/, '정렬 메뉴');
  assert.match(src, /dmTab && pinned\.has\(c\.id\) && <span className="mi msgr-dmpin"/, '고정 표시');
  assert.match(src, /if \(payload\?\.channel_id && dmIdsRef\.current\.has\(payload\.channel_id\)\) setLastAt\(\(m\) => \(\{ \.\.\.m, \[payload\.channel_id\]: Date\.now\(\) \}\)\);/, '방송으로 최근 시각 갱신(DM만)');
  assert.match(src, /supabase\.rpc\('msgr_dm_latest', \{ org: orgId \}\)/, '채널당 1행 RPC(500건 상한·created_at 정렬 없음)');
  assert.match(src, /\}, \[orgId, dmIdsKey, isPhone, resumeEpoch\]\);/, '재연결·조직 전환·DM 집합 변화 때 재조회');
  assert.match(src, /useEffect\(\(\) => \{ dmIdsRef\.current = new Set\(dmIdsKey \? dmIdsKey\.split\(','\) : \[\]\); \}, \[dmIdsKey\]\);/, 'ref 갱신은 효과에서');
  assert.match(src, /setMyAvailable\(\[\]\); setLastAt\(\{\}\);/, '조직 전환 때 비움');
  assert.match(src, /document\.addEventListener\('pointerdown', down, true\)/, '바깥 누름으로 메뉴 닫기(터치)');
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.msgr-phone\.phone-dm \.msgr-sec\[data-sec='dms'\] > summary\.msgr-group \.right \{ display: inline-flex; margin-left: auto; \}/, '폰 DM 탭에서 정렬 메뉴가 보인다(CRITICAL-1)');
  const dict = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
  for (const k of ['dm.sort', 'dm.sort.recent', 'dm.sort.unread', 'dm.sort.name', 'dm.pinned']) assert.match(dict, new RegExp(`'${k.replace(/\\./g, '\\\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
});
