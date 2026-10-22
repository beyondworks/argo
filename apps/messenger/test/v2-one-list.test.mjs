// 메신저 단순화 2단계(2026-10-22, 유건 승인 15:3x KST) — 공간 전환 없는 한 목록. 판정은 src/v2/one-list.mjs(행동 시험), 화면 배선은 App.jsx 소스.
// 화면은 v2 픽스처(test/v2-shell.fixture.html)에서 개인·조직 × 1280·390 × 라이트·다크 × ko·en으로 눌렀다(PR 본문 표).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadOneList, oneListOrgs, oneListView, oneListBump, oneListSeen, oneListSort, oneListTitle, oneListPair, oneListPinOrder, oneListUnread, oneListSpace, oneListAgentFolds, ONE_LIST_LIMIT } from '../src/v2/one-list.mjs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const T1 = 't1', T2 = 't2', ME = 'me';
const row = (o) => ({ room_id: o.id, room_kind: 'open', room_name: o.id, space_id: 'p', space_kind: 'personal', space_name: null, peer_kind: null, peer_id: null, users: 2, agents: 0, last_id: 10, last_at: '2026-10-22T05:00:00Z', unread: 0, pinned: false, muted: false, ...o });
const rows = [
  row({ id: 'gen', space_id: T1, space_kind: 'team', space_name: 'Beyond 팀', unread: 3, pinned: true }),
  row({ id: 'lab', space_id: T2, space_kind: 'team', space_name: 'Lumen 연구', unread: 1, muted: true }),
  row({ id: 'dm-agent', room_kind: 'direct', peer_kind: 'agent', peer_id: 'a1', unread: 2 }),
  row({ id: 'dm-friend', room_kind: 'direct', peer_kind: 'user', peer_id: 'u2' }),
  row({ id: 'group', room_kind: 'private', room_name: 'dm:주말 모임', agents: 1 }),
];

test('목록 읽기: msgr2_inbox 한 번(상한 200), 무료·Pro 끝난 계정은 pro 오류(FreeGate)', async () => {
  const calls = []; const ok = { rpc: async (fn, a) => { calls.push([fn, a]); return { data: rows, error: null }; } };
  const r = await loadOneList(ok);
  assert.deepEqual(calls, [['msgr2_inbox', { p_limit: ONE_LIST_LIMIT }]]);
  assert.equal(r.rows.length, 5); assert.equal(r.more, false); assert.equal(r.error, null);
  const full = await loadOneList({ rpc: async () => ({ data: Array.from({ length: 200 }, (_, i) => row({ id: `r${i}` })), error: null }) });
  assert.equal(full.more, true, '상한만큼 왔으면 더 있을 수 있다(검색 안내)');
  const pro = await loadOneList({ rpc: async () => ({ data: null, error: { message: 'msgr2_pro_required' } }) });
  assert.deepEqual([pro.rows, pro.error.pro], [null, true]);
  const other = await loadOneList({ rpc: async () => ({ data: null, error: { message: 'network' } }) });
  assert.equal(other.error.pro, false, '다른 오류는 Pro 안내로 바꾸지 않는다');
});

test('거르개: 전체·안 읽음(음소거 제외)·에이전트(1:1 상대 또는 방에 에이전트)·조직(그 조직 방만)·검색어(방·조직 이름)', () => {
  const ids = (v) => v.map((r) => r.room_id);
  assert.deepEqual(ids(oneListView(rows)), ['gen', 'lab', 'dm-agent', 'dm-friend', 'group']);
  assert.deepEqual(ids(oneListView(rows, { filter: 'unread' })), ['gen', 'dm-agent'], '음소거 방(lab)은 안 읽음 거르개에 안 나온다');
  assert.deepEqual(ids(oneListView(rows, { filter: 'agents' })), ['dm-agent', 'group']);
  assert.deepEqual(ids(oneListView(rows, { org: T2 })), ['lab']);
  assert.deepEqual(ids(oneListView(rows, { q: 'lumen' })), ['lab'], '조직 이름으로도 찾는다');
  assert.equal(oneListUnread(rows), 5, '탭 숫자 = 음소거 뺀 안 읽음 합');
  assert.deepEqual(oneListOrgs(rows), [{ id: T1, name: 'Beyond 팀' }, { id: T2, name: 'Lumen 연구' }], '조직 칩 재료는 목록에 나온 팀 공간만, 이름순');
  assert.equal(oneListSpace(rows[0], 'P'), T1); assert.equal(oneListSpace(rows[3], 'P'), 'P', '개인 종류 방은 셸의 개인 공간 키로 연다');
});

test('방송 반영: 남의 새 글은 안 읽음 +1·맨 위로, 내 글·보고 있는 방·시스템 글은 안 읽음 그대로, 중복은 무시, 모르는 방은 known=false', () => {
  const at = '2026-10-22T06:00:00Z';
  let r = oneListBump(rows, { room_id: 'dm-friend', id: 11, created_at: at, kind: 'text', author_user_id: 'u2', body: '안녕' }, { uid: ME });
  assert.equal(r.known, true); assert.equal(r.rows[1].room_id, 'dm-friend', '고정(gen) 다음 맨 위'); assert.equal(r.rows[1].unread, 1); assert.equal(r.rows[1].last_preview, '안녕');
  r = oneListBump(rows, { room_id: 'dm-friend', id: 11, created_at: at, kind: 'text', author_user_id: ME, body: '나' }, { uid: ME });
  assert.equal(r.rows.find((x) => x.room_id === 'dm-friend').unread, 0, '내 글');
  r = oneListBump(rows, { room_id: 'dm-friend', id: 11, created_at: at, kind: 'text', author_user_id: 'u2', body: 'x' }, { uid: ME, active: 'dm-friend' });
  assert.equal(r.rows.find((x) => x.room_id === 'dm-friend').unread, 0, '보고 있는 방');
  r = oneListBump(rows, { room_id: 'dm-friend', id: 11, created_at: at, kind: 'system', body: '' }, { uid: ME });
  const sys = r.rows.find((x) => x.room_id === 'dm-friend'); assert.equal(sys.unread, 0); assert.equal(sys.last_preview, null, '시스템 글은 미리보기 없음');
  assert.equal(oneListBump(rows, { room_id: 'gen', id: 10 }, { uid: ME }).rows, rows, '이미 반영한 글(따라잡기 중복)은 그대로');
  assert.equal(oneListBump(rows, { room_id: 'nope', id: 1 }).known, false, '모르는 방 — 부르는 쪽이 한 번 다시 읽는다');
  assert.equal(oneListBump(rows, { room_id: 'gen', id: 99, author_user_id: 'u2', kind: 'text' }, { uid: ME }).rows[0].unread, 4);
  assert.equal(oneListBump(rows.map((x) => (x.room_id === 'gen' ? { ...x, unread: 99 } : x)), { room_id: 'gen', id: 99, author_user_id: 'u2', kind: 'text' }, { uid: ME }).rows[0].unread, 99, '99에서 멈춘다(서버와 같은 상한)');
});

test('열면 안 읽음 0, 순서는 서버와 같이(고정 → 최근 활동 → 방 id 역순), 이름은 1:1이면 상대·아니면 방 이름(dm: 머리말 뺌)', () => {
  assert.equal(oneListSeen(rows, 'gen')[0].unread, 0); assert.equal(oneListSeen(rows, 'gen')[2].unread, 2, '다른 방은 그대로');
  const s = oneListSort([row({ id: 'a', last_at: '2026-10-22T01:00:00Z' }), row({ id: 'b', last_at: '2026-10-22T03:00:00Z' }), row({ id: 'c', last_at: '2026-10-22T02:00:00Z', pinned: true }), row({ id: 'd', last_at: '2026-10-22T03:00:00Z' })]);
  assert.deepEqual(s.map((r) => r.room_id), ['c', 'd', 'b', 'a']);
  const names = (k, id) => ({ 'agent:a1': '리서치', 'user:u2': '민지' }[`${k}:${id}`] ?? null);
  assert.equal(oneListTitle(rows[2], names), '리서치'); assert.equal(oneListTitle(rows[3], names), '민지');
  assert.equal(oneListTitle(rows[4], names), '주말 모임');
  // 서버 모양(msgr2_agent_dm_open = 이름 없는 private 방, msgr2_inbox 819fce07 = 그런 방에도 peer): 1:1로 보인다. 이름 붙은 방은 상대가 하나여도 방 이름
  const agentDm = row({ id: 'adm', room_kind: 'private', room_name: '', peer_kind: 'agent', peer_id: 'a1', users: 1, agents: 1 });
  assert.equal(oneListPair(agentDm), true); assert.equal(oneListTitle(agentDm, names), '리서치');
  const namedPriv = row({ id: 'plan', room_kind: 'private', room_name: '기획', peer_kind: 'user', peer_id: 'u2', space_kind: 'team', space_id: T1 });
  assert.equal(oneListPair(namedPriv), false); assert.equal(oneListTitle(namedPriv, names), '기획');
  assert.equal(oneListPair(row({ id: 'g', room_kind: 'private', room_name: '' })), false, '상대가 없는 이름 없는 방은 1:1이 아니다(기본 문구)'); assert.equal(oneListTitle(row({ id: 'x', room_name: '' }), names), null, '이름이 없으면 부르는 쪽 기본 문구');
});

test('배선: 읽기는 시작·복귀·방 사건·모르는 방 첫 글 때만(주기 조회 0), 무료·Pro 끝남은 FreeGate', () => {
  const load = app.slice(app.indexOf('const [ol, setOl] = useState(null)'), app.indexOf('const v2RoomEventRef = useRef(null)'));
  assert.match(load, /loadOneList\(supabase\)[^\n]*\}, \[uid, syncEpoch, olTick\]\);/, '다시 읽는 때 = 로그인·복귀(syncEpoch)·olTick(방 사건·모르는 방)');
  assert.ok(!/setInterval|setTimeout/.test(load), '주기 조회 없음');
  assert.match(load, /olMiss\.current\.has\(x\.room_id\)\) return; olMiss\.current\.add\(x\.room_id\); bumpOl\(\);/, '모르는 방은 방마다 한 번만 다시 읽는다');
  assert.match(app, /if \(V2 && \(plan\.orgs \|\| plan\.reload \|\| plan\.forget\.length\)\) \{ olMiss\.current\.clear\(\); bumpOl\(\); \}/, '방 사건 묶음(500ms)마다 한 번');
  assert.match(app, /olMsgRef\.current\?\.\(x\); \/\/ 한 목록/, '새 글 방송은 그 행만 고친다');
  assert.match(app, /if \(V2 && \(olPro \|\| v2StateBar/, 'Pro 거절이면 Pro 안내');
});

test('배선: 데스크톱 v2는 공간 바꾸기 단추 없이 한 목록 구역, 조직 거르개에 코드 참여·조직 만들기, 새 대화 단추 하나', () => {
  assert.match(app, /\{!\(V2 && !isPhone\) && <button type="button" className=\{`msgr-org\$\{orgMenu/, '공간 바꾸기 단추는 v2 데스크톱에서 안 그린다');
  // 레일 위쪽(유건 2026-10-22 19:0x — Slack·Telegram 배치): 범위 카드 → 검색 + 새 대화 → 칩 → 접기 머리 없는 목록
  assert.match(app, /\{V2 && !isPhone && olScope\}/, '범위 카드(옛 조직 카드 모양)');
  assert.match(app, /<div className="msgr-searchrow">\{f\}<button type="button" className="msgr-newbtn" onClick=\{\(\) => setOlNew\(\(v\) => !v\)\}[^\n]*\{!isPhone && olNewSheet\}<\/div>/, '검색칸 옆 새 대화, 팝오버는 그 줄 아래');
  assert.match(app, /\{V2 && !isPhone && olChips\}/);
  assert.match(app, /\{V2 && !isPhone && \(<div className="msgr-sec msgr-onelist" data-sec="onelist">/, '한 목록은 접기 머리(RailSection) 없이');
  assert.ok(!/RailSection id="onelist"/.test(app));
  assert.match(app, /<NewTalkSheet pop=\{!isPhone\}/, '데스크톱은 단추 아래 팝오버, 폰은 아래 시트');
  const menu = app.slice(app.indexOf('const olScope = '), app.indexOf('const olChips = '));
  for (const s of ['joinable.map(', 'deletedOrgs.map(', 'orgJoinForms()']) assert.ok(menu.includes(s), `조직 메뉴: ${s}`);
  const sheet = app.slice(app.indexOf('function NewTalkSheet('), app.indexOf('function DmGroupSheet('));
  for (const k of ['onelist.new.person', 'onelist.new.agent', 'onelist.new.group', 'onelist.new.channel']) assert.ok(sheet.includes(`t('${k}')`), k);
  assert.match(sheet, /orgs\.length === 1 \? goOrg\(orgs\[0\]\) : setStep\('org'\)/, '조직이 하나면 바로, 여럿이면 한 번 고른다');
  assert.match(sheet, /pick\(t\('phone\.ch\.new'\)[^\n]*onChannel\(org\.id\)[^\n]*!org\.canNew\)/, '그 조직에서 만들 수 없으면(손님) 만들기 칸은 꺼짐');
  assert.match(sheet, /pick\(t\('ch\.browse'\)[^\n]*onBrowse\(org\.id\)/, '공개 채널 둘러보기·참여 입구(분리 검수 4 — inbox에는 안 들어간 채널이 없다)');
  assert.match(sheet, /step === 'person' && onAddFriend && pick\(t\('friends\.add'\)/, '친구가 있어도 친구 추가 입구(분리 검수 3 — 폰 v2는 친구 탭이 없다)');
  assert.match(app, /onChannel=\{\(oid\) => \{ setOlNew\(false\); setTabQ\(null\); setBrowse\(null\); runInSpace\(oid, \(fn\) => fn\.openNewCh\(\)\); \}\}/, '그 조직으로 맞춘 뒤의 새 채널 칸');
  assert.match(app, /latestOpen\.current\.openNewCh = openNewCh;/);
  assert.match(app, /onBrowse=\{\(oid\) => \{ setOlNew\(false\); setTabQ\(null\); setNewCh\(null\); runInSpace\(oid, \(fn\) => fn\.openBrowse\(\)\); \}\}/, '둘러보기도 그 조직으로 맞춘 뒤');
  assert.match(app, /onGroup=\{\(\) => \{ setOlNew\(false\); setTabQ\(null\); runInSpace\(PERSONAL, \(\) => setDmGroup\(true\)\); \}\}/);
});

test('배선: 폰 v2 아래 탭 4개(대화·에이전트·기억·나), 나 = 설정', () => {
  assert.match(app, /const V2_PHONE_TABS = \['chats', 'agents', 'memory', 'me'\];/);
  assert.match(app, /<PhoneTabs v2 tabs=\{V2_PHONE_TABS\}[^\n]*onPick=\{\(k\) => \(k === 'me' \? openSettings\(\) : pickRoot\(k\)\)\}/);
});

test('배선(분리 검수 반영): 검색은 이름을 붙인 뒤, 옛 조직 에이전트 1:1은 개인 1:1로, 목록 읽기 실패는 다시 시도, 들어간 채널은 한 번 다시 읽기', () => {
  assert.match(app, /const olShown = oneListPinOrder\(oneListView\(olRows\?\.map\(\(r\) => \(\{ \.\.\.r, _title: olName\(r\) \}\)\), \{ filter: olFilter/, '이름 먼저 — 1:1은 방 이름이 비어 있다');
  assert.match(app, /const maybeAgentDm = row\.space_kind === 'team' && row\.users === 1 && row\.agents === 1;[^\n]*if \(maybeAgentDm && fn\.redirect\?\.\(row\.room_id, 'list'\)\) return;/);
  assert.match(app, /latestOpen\.current\.redirect = openAgentDmInstead;/);
  assert.match(app, /if \(r\.error\) \{ if \(r\.error\.pro\) setOlPro\(true\); else setOlErr\(true\); return; \}/);
  assert.match(app, /const olLoadNote = olErr \? [^\n]*onClick=\{\(\) => \{ setOlErr\(false\); bumpOl\(\); \}\}/, '다시 시도 = 한 번 다시 읽기(자동 재시도 없음)');
  assert.match(app, /if \(V2\) bumpOl\(\); \/\/ 한 목록: 들어간 채널/);
  assert.match(app, /const olOrgGated = V2 && \(aiConsent === undefined \? !aiConsentFailOpen : !aiConsented\);/, 'AI 이용 동의 전·조회 중엔 조직 방을 뺀다(9/27)');
  assert.match(app, /const olRows = olOrgGated && ol \? ol\.filter\(\(r\) => r\.space_kind !== 'team'\) : ol;/);
  for (const k of ['olOrgList = oneListOrgs(olRows)', 'olUnreadN = oneListUnread(olRows)']) assert.ok(app.includes(k), `칩·탭 숫자도 거른 행: ${k}`);
});

test('고정 순서: 고정한 방끼리만 pinPos 순, 순번 없는 고정 방은 뒤(서버 순서 유지), 고정 안 한 방은 그대로', () => {
  const r = [row({ id: 'p1', pinned: true }), row({ id: 'p2', pinned: true }), row({ id: 'p3', pinned: true }), row({ id: 'x' })];
  assert.deepEqual(oneListPinOrder(r, new Map([['p3', 0], ['p1', 1]])).map((x) => x.room_id), ['p3', 'p1', 'p2', 'x']);
  assert.deepEqual(oneListPinOrder(r, new Map()).map((x) => x.room_id), ['p1', 'p2', 'p3', 'x']);
  assert.equal(oneListPinOrder(null, new Map()), null);
});

test('배선(#1143 화면 검수 반영): 줄 메뉴는 옛 메뉴 그대로, 조직 메뉴는 구역 머리 밖, 폰은 채널·친구 탭으로 시작하지 않는다', () => {
  // Important 1 — 줄 메뉴(우클릭·더 보기·길게 누르기)·고정·순서
  const rows = app.slice(app.indexOf('const olPatch = '), app.indexOf('const olEmpty = '));
  assert.match(rows, /const base = \(isDm \? dmItemsOf\(c, isPhone\) : chItemsOf\(c\)\)/, '지금 공간의 방은 옛 줄 메뉴 그대로');
  assert.match(rows, /runInSpace\(space, \(fn\) => fn\.olRowAction\?\.\(row\.room_id, t\(key\)\)\)/, '다른 공간의 방은 그 공간으로 맞춘 뒤 같은 항목');
  assert.match(rows, /savePrefs\(\[\{ channel_id: row\.room_id, \[key\]: on \}\]\)/, '고정·알림 = msgr_channel_prefs(v2 msgr2_room_pref_set)');
  for (const k of ['{...olCtx(row, items)}', "{...rowLongPress({ id: row.room_id }, items", '{...olDrag(row)}', 'className="more" onClick={(e) => openCtx(e, items, row.room_id)}']) assert.ok(rows.includes(k), k);
  assert.match(app, /latestOpen\.current\.olRowAction = \(roomId, label, tries = 0\) => \{[^\n]*if \(!c && tries < 10\) \{ setTimeout\([^\n]*if \(it\) it\.run\(\); else setNote\(t\('ch\.noEdit'\)\);/, '저장본으로 연 공간은 방 목록이 다음 렌더 — 다시 찾는다(실측)');
  assert.match(app, /const olShown = oneListPinOrder\(oneListView\(/);
  assert.match(app, /import \{[^\n]*oneListSort[^\n]*\} from '\.\/v2\/one-list\.mjs';/, '고정 바꾸기가 쓰는 정렬을 가져온다(빠지면 앱 전체가 멈췄다 — 클릭 표 실측)');
  // Important 2 — 조직▾ 메뉴는 summary 밖
  assert.ok(!/\{V2 && !isPhone && olOrgMenuEl\}/.test(app), '데스크톱 범위 메뉴는 카드 바로 아래(구역 머리 summary 밖 — 제출·스페이스 막힘 없음)');
  assert.match(app, /const olScope = V2 && !isPhone && \(<div className="msgr-scopewrap">/);
  assert.match(app, /setNewOrg\(null\); setOrgMenu\(false\); setOlOrgMenu\(false\);/, '조직을 만들면 메뉴를 닫는다');
  // Important 3 — 시작 탭
  assert.match(app, /const v2PhonePage = \(p\) => \(V2 && \(p === 'channels' \|\| p === 'friends'\) \? 'chats' : p\);/);
  assert.match(app, /useState\(\(\) => v2PhonePage\(isPhone && PULL_RESTORE_PAGES/);
  assert.match(app, /useEffect\(\(\) => \{ if \(V2 && page !== v2PhonePage\(page\)\) setPage\(v2PhonePage\(page\)\); \}, \[page\]\);/);
});

test('배선(#1143 재검수 Nit 2): 범위 메뉴·새 대화 팝오버는 본문을 눌러도 닫힌다 — 문서 전체 pointerdown(useDismiss)', () => {
  assert.match(app, /useDismiss\(!!olOrgMenu, \(\) => setOlOrgMenu\(false\), '\.msgr-scopewrap, \.msgr-olorgmenu, \.msgr-inboxorgbtn'/);
  assert.match(app, /useDismiss\(V2 && !isPhone && olNew, \(\) => setOlNew\(false\), '\.msgr-newtalkpop, \.msgr-newbtn'/);
});

test('배선(유건 2026-10-22 20:1x + 재검수 Important 1): 데스크톱 v2 레일 에이전트 구역 = 열린 방과 무관한 내 에이전트 명단, 묶음·정렬·직접 배치·줄 메뉴·파견 유지', () => {
  const sec = app.slice(app.indexOf('const olMine = '), app.indexOf('const levelOf = '));
  assert.match(sec, /const olMine = \(myAgents \?\? \[\]\)\.filter\(\(c\) => c\.owner_user_id === uid\);/, '명단 = 내 에이전트 행(v2MyAgents, 모든 공간)');
  assert.match(sec, /label=\{`\$\{t\('rail\.agents'\)\} · \$\{olMine\.length\}`\}/, '머리 숫자 = 내 에이전트 수');
  for (const bad of ['myAvailable.length', 'railVisible', 'crews.filter', 'railSortPos']) assert.ok(!sec.includes(bad), `공간에 묶인 값을 그리기에 쓰지 않는다: ${bad}`);
  assert.match(sec, /const olFolds = oneListAgentFolds\(olSorted, sourceOf\);/, '묶음은 oneListAgentFolds(내 에이전트·외부, 유건 결정 접이 구조 유지)');
  assert.match(sec, /\{olFolds\.map\(\(\[id, k, list\]\) => <RailFold key=\{id\} id=\{id\} label=\{t\(k\)\} count=\{list\.length\}>\{list\.map\(olAgentRow\)\}<\/RailFold>\)\}/, '묶음마다 접이');
  for (const bad of ['olCompany', 'railCompany', "'mine.company'"]) assert.ok(!sec.includes(bad), `v2 레일에 회사 묶음을 두지 않는다(v2 서버에 회사 에이전트 없음): ${bad}`);
  assert.match(sec, /\['name', 'added', 'custom'\]\.map\(\(v\) => <button key=\{v\} type="button" role="menuitemradio" aria-checked=\{railSort === v\}/, '정렬 메뉴');
  assert.match(sec, /localStorage\.setItem\('argo-msgr-v2-agent-order'/, '직접 배치 순서는 이 기기에 하나(v2는 msgr_target_prefs가 서버에 없다)');
  for (const k of ["label: t('ctx.crew.card'), run: () => openAgentCard(c)", "label: t('ui.dm.personal')", "phone.agents.fav.add", "label: t('onelist.agent.dispatch', { org: o.name }), run: () => runInSpace(o.id, (fn) => fn.dispatchMine?.(c.id, c.display_name))"]) assert.ok(sec.includes(k), `줄 메뉴: ${k}`);
  assert.match(sec, /latestOpen\.current\.dispatchMine = \(agentId, name\) => \{ const c = myAvailable\.find/, '파견은 그 조직으로 맞춘 뒤 그 조직의 파견 대기에서');
  assert.match(app, /\{V2 && !isPhone && olAgentsSection\}\n\s*\{!\(V2 && !isPhone\) && railView\.section && \(<RailSection id="mine"/, '옛 구역은 옛 셸·폰에서만');
  assert.match(app, /if \(!\(V2 && !isPhone\) && \(!orgId \|\| orgId === PERSONAL \|\| !crews\.some/, 'v2 데스크톱은 시작 때 명단을 한 번 읽는다(개인 공간 시작이면 0명이었다)');
  assert.match(app, /\{V2 && !isPhone \? \(\(orgs \?\? \[\]\)\.length > 0 && !olOrgGated && <button[^\n]*runInSpace\(olOrg \?\? orgs\[0\]\.id, go\)/, '기억 단추는 열린 방과 무관하게 늘');
});

test('배선(유건 \'모바일 화면은 어때?\' 검토): 폰 한 목록 줄은 옛 폰 줄과 같은 안 읽음 배지, 글자 칸은 채널 칸과 같은 면, 결재 카드는 얇은 경계', () => {
  const row = app.slice(app.indexOf('const olPhoneRow = '), app.indexOf('const olDeskRow = '));
  assert.match(row, /<span className=\{`msgr-badge\$\{row\.muted \? ' dim' : ''\}`\}>\{badgeText\(row\.unread\)\}<\/span>/, '맨 숫자(msgr-tabn ph-kn)가 아니라 배지');
  assert.ok(!row.includes('ph-kn'));
  assert.match(app, /<div className="msgr-list ph-rooms ph-ol">\{olShown\.map\(olPhoneRow\)\}<\/div>/);
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.msgr-phone \.ph-ol \.ph-krow \.msgr-av\.kk:not\(\.crew\):not\(\.face\) \{ border-radius: 16px; background: var\(--card-2\); border: 1px solid var\(--border-soft\);/, '채널 칸(.ph-chav)과 같은 면·경계·반경');
  assert.match(css, /\.msgr-phone \.ph-root\.ph-v2 \.ph-apcard\.on \{ border-color: var\(--border\); \}/);
});

test('레일 에이전트 묶음(총괄 2026-10-22 22시): 내 에이전트·외부 둘, 빈 묶음은 뺀다, 회사 묶음은 없다(v2 서버에 회사 에이전트 없음) — 어느 방·어느 범위에서도 같다', () => {
  const src = (c) => (c.hosting === 'bot' ? 'custom' : 'argo');
  const mine = [{ id: 'a', hosting: 'local' }, { id: 'b', hosting: 'bot' }, { id: 'c', hosting: 'local' }];
  assert.deepEqual(oneListAgentFolds(mine, src).map(([id, k, list]) => [id, k, list.map((c) => c.id)]), [['mine.argo', 'rail.agents.mine', ['a', 'c']], ['mine.ext', 'rail.src.custom', ['b']]]);
  assert.deepEqual(oneListAgentFolds([{ id: 'a', hosting: 'local' }], src).map(([id]) => id), ['mine.argo'], '외부가 없으면 외부 묶음 없음');
  assert.deepEqual(oneListAgentFolds(null, src), [], '명단을 아직 못 읽었으면 묶음 없음');
  assert.ok(!oneListAgentFolds(mine, src).some(([id]) => id === 'mine.company'), '회사 묶음 없음');
  assert.equal(oneListAgentFolds.length, 2, '열린 방·범위 조직을 받지 않는다 — 묶음은 내 명단만으로 정해진다');
});
