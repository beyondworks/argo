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
  assert.match(src, /const dmTab = isPhone && \(page === 'dm' \|\| swipeTo === 'dm'\);/);
  assert.match(src, /const dmSorted = \(list\) => sortDms\(list, \{ sort: dmSort, lastAt, unread, nameOf: dmName \}\);/);
  assert.match(src, /const dmPinnedTop = dmTab \? channels\.filter\(\(c\) => c\.kind === 'dm' && pinned\.has\(c\.id\)\)\.sort\(\(a, b\) => \(pinPos\.get\(a\.id\) \?\? 1e9\) - \(pinPos\.get\(b\.id\) \?\? 1e9\)\)/, '고정 = 즐겨찾기한 DM, pin_pos 순');
  assert.match(src, /const dmList = !dmTab \? dms : dmFilter === 'fav' \? dmPinnedTop : dmSorted\(dmPool\.filter\(dmVisible\)\);/, 'DM 탭 목록은 필터를 거친다, 즐겨찾기 탭은 고정 순서 그대로(검수 L-6)');
  assert.match(src, /const dmPinnedShown = dmTab && dmFilter === 'all' \? dmPinnedTop : \[\];/, '고정 단락은 전체 탭에서만');
  assert.match(src, /<RailSection id="dmpin" label=\{t\('dm\.pinned'\)\} forceOpen><div className="msgr-list">\{dmPinnedShown\.map\(dmRow\)\}<\/div><\/RailSection>/, '고정 단락');
  assert.match(src, /<RailSection id="dms" label=\{t\('ch\.dms'\)\} forceOpen=\{dmTab\}/, 'DM 탭에서는 홈의 접힘 상태를 따르지 않는다');
  assert.match(src, /<div className="msgr-list">\{dmList\.map\(dmRow\)\}<\/div>/);
  assert.match(src, /localStorage\.setItem\('argo-msgr-dm-sort', v\)/, '정렬은 기기에 기억');
  assert.match(src, /DM_SORTS\.map\(\(v\) => <button key=\{v\} type="button" role="menuitemradio" aria-checked=\{dmSort === v\}/, '정렬 메뉴');
  assert.doesNotMatch(src, /msgr-dmpin/, '고정 별 아이콘 없음(유건 2026-09-15: 즐겨찾기 별 아이콘 쓰지 마)');
  assert.match(src, /const dmVisible = \(c\) => dmFilter === 'all' \|\| \(dmFilter === 'fav' && pinned\.has\(c\.id\)\) \|\| \(dmFilter === 'unread' && unread\[c\.id\]\?\.n > 0 && !muted\.has\(c\.id\)\) \|\| \(dmFilter === 'group' && dmIsGroup\(c\)\);/, '필터 4종');
  assert.match(src, /if \(people\.length === 1 && crewsIn\.length === 1 && crewOf\(crewsIn\[0\]\.member_id\)\?\.owner_user_id === people\[0\]\.member_id\) return false;/, '그룹 판정 정본: 나 뺀 참가자 2 이상, 남의 크루 1:1(소유자 동반)은 예외');
  assert.match(src, /if \(dmIsGroup\(c\)\) \{ const names = \[\.\.\.crewsIn\.map/, 'dmName은 같은 판정을 쓴다(검수 HIGH-2)');
  assert.match(src, /\{muted\.has\(c\.id\) && <I name="belloff" size=\{12\} className="mi" \/>\}<\/span>\{lastMsg/, 'DM 탭 행 음소거 벨(검수 HIGH-1 회귀 방지)');
  assert.match(src, /<><span className="name">\{dmBaseName\(c\)\}<\/span>\{muted\.has\(c\.id\) && <I name="belloff" size=\{12\} className="mi" \/>\}<\/>/, '데스크톱·홈 행은 이름과 음소거 벨만 표기');
  assert.doesNotMatch(src, /dmVacated|msgr-vacated|dm\.vacated\.tag/, 'DM 상태를 추정해 이름 뒤에 라벨을 붙이지 않는다');
  assert.match(src, /onPointerUp: \(e\) => \{ lp\.onPointerUp\(e\); swallowNext\(\); \}/, 'click 삼킴은 손 뗀 직후에만 등록(검수 HIGH-3)');
  assert.match(src, /draggable=\{!isPhone\}/, '폰 행은 드래그 끔(iOS 드래그 리프트가 click을 삼키는 것 방지) — 홈에도 길게 누르기(2026-09-15)');
  assert.match(src, /select\('id, channel_id, body, author_user_id, crew_id, created_at'\)\.in\('id', ids\)\.is\('deleted_at', null\)/, '한 줄 미리보기는 마지막 글 id로 한 번에, 삭제 글 제외');
  assert.match(src, /const swallowNext = \(\) => \{ if \(!st\.opened\) return; st\.opened = false; const swallow = \(e\) => \{ e\.preventDefault\(\); e\.stopPropagation\(\); \}; document\.addEventListener\('click', swallow, \{ capture: true, once: true \}\); setTimeout\(\(\) => document\.removeEventListener\('click', swallow, \{ capture: true \}\), 300\);/, '길게 눌러 메뉴가 열린 누름의 손 뗄 때 click만 300ms 안에서 삼킨다(상태 플래그 — 재검수 M-B)');
  assert.match(src, /\.eq\('id', payload\.id\)\.is\('deleted_at', null\)\.maybeSingle\(\)/, '방송엔 본문이 없어 그 글 1건을 조회해 미리보기를 갱신한다(재검수 M-A)');
  assert.match(src, /m\[r\.channel_id\]\?\.at > Date\.parse\(r\.created_at\) \? m :/, '늦게 온 옛 글 응답은 미리보기를 덮지 않는다(재검수 L-1)');
  assert.match(src, /payload\.id && isPhoneRef\.current && dmIdsRef\.current\.has/, '구독 핸들러는 폰 여부를 ref로 본다(재검수 L-2)');
  assert.match(src, /dragging' : ''\}`\} onDragStart=\{dragStart\(c\)\}[^\n]*draggable=\{!isPhone\}/, 'DM 행은 draggable={!isPhone} 하나만(맨 draggable 중복 없음 — 빌드 경고)');
  assert.match(src, /function DmPeekSheet\(/, '미리보기 시트');
  assert.match(src, /function DmGroupSheet\(/, '새 그룹 대화 시트'); assert.match(src, /const createGroupDm = async \(picks\) =>/, '그룹 생성'); assert.match(src, /isPersonal && page === 'home' \? \(setPage\('settings'\), setSettingsTab\('friends'\)\) : page === 'dm' \? setDmGroup\(true\) : setNewCh\(\{ name: '', kind: newChKind \}\)/, 'DM 탭의 +는 그룹 대화 — 개인 공간도 같다(유건 2026-09-17), 개인 홈 +는 친구 추가 — 행동은 personal-space.browser.mjs');
  assert.match(src, /const dmSwipe = useSwipeTabs\(DM_FILTERS, dmFilter, pickDmFilter, isPhone && \(page === 'dm' \|\| swipeTo === 'dm'\)\)/, 'DM 탭에서 좌우 스와이프 = 상단 거르개 탭 이동(유건 2026-09-15 교정: 하단 탭이 아니다), 탭 누름과 같은 pickDmFilter');
  assert.doesNotMatch(src, /useSwipeTabs\(ROOT_ORDER/, '하단 탭 스와이프는 없앤다');
  assert.match(src, /\{\.\.\.\(isPhone \? rowLongPress\(c, items\) : \{\}\)\}/, '폰 레일 행(채널·DM·즐겨찾기 대상) 길게 누르기 = 점 세 개 메뉴');
  assert.equal((src.match(/\{\.\.\.\(isPhone \? rowLongPress\(c, items\) : \{\}\)\}/g) || []).length, 3, '채널·DM·대상 행 셋 다');
  assert.match(src, /setDmGroup\(false\); \/\/ 시트는 어느 경로든 닫는다/, '한 명 경로에서도 시트 닫힘(검수 HIGH-1)');
  assert.match(src, /const dmTab = isPhone && \(page === 'dm' \|\| swipeTo === 'dm'\);/, '스와이프 중 밑 화면 DM 탭 미리 그리기');
  assert.match(src, /\{!dmTab && <button type="button" className="more"/, 'DM 탭에는 점 세 개 없음(길게 누르기 메뉴로 대체)');
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
