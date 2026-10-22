// 메신저 단순화 2단계(2026-10-22, 유건 승인 15:3x KST) — 공간 전환 없는 한 목록. 판정은 src/v2/one-list.mjs(행동 시험), 화면 배선은 App.jsx 소스.
// 화면은 v2 픽스처(test/v2-shell.fixture.html)에서 개인·조직 × 1280·390 × 라이트·다크 × ko·en으로 눌렀다(PR 본문 표).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadOneList, oneListOrgs, oneListView, oneListBump, oneListSeen, oneListSort, oneListTitle, oneListUnread, oneListSpace, ONE_LIST_LIMIT } from '../src/v2/one-list.mjs';

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
  assert.equal(oneListTitle(rows[4], names), '주말 모임'); assert.equal(oneListTitle(row({ id: 'x', room_name: '' }), names), null, '이름이 없으면 부르는 쪽 기본 문구');
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
  assert.match(app, /\{V2 && !isPhone && \(<RailSection id="onelist"[^\n]*\{olOrgPick\}<button type="button" className="btn" onClick=\{\(\) => setOlNew\(true\)\}/);
  const menu = app.slice(app.indexOf('const olOrgMenuEl = ('), app.indexOf('const olOrgPick = '));
  for (const s of ['joinable.map(', 'deletedOrgs.map(', 'orgJoinForms(isPhone)']) assert.ok(menu.includes(s), `조직 메뉴: ${s}`);
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
  assert.match(app, /const olShown = oneListView\(olRows\?\.map\(\(r\) => \(\{ \.\.\.r, _title: olName\(r\) \}\)\), \{ filter: olFilter/, '이름 먼저 — 1:1은 방 이름이 비어 있다');
  assert.match(app, /const maybeAgentDm = row\.space_kind === 'team' && row\.users === 1 && row\.agents === 1;[^\n]*if \(maybeAgentDm && fn\.redirect\?\.\(row\.room_id, 'list'\)\) return;/);
  assert.match(app, /latestOpen\.current\.redirect = openAgentDmInstead;/);
  assert.match(app, /if \(r\.error\) \{ if \(r\.error\.pro\) setOlPro\(true\); else setOlErr\(true\); return; \}/);
  assert.match(app, /const olLoadNote = olErr \? [^\n]*onClick=\{\(\) => \{ setOlErr\(false\); bumpOl\(\); \}\}/, '다시 시도 = 한 번 다시 읽기(자동 재시도 없음)');
  assert.match(app, /if \(V2\) bumpOl\(\); \/\/ 한 목록: 들어간 채널/);
  assert.match(app, /const olOrgGated = V2 && \(aiConsent === undefined \? !aiConsentFailOpen : !aiConsented\);/, 'AI 이용 동의 전·조회 중엔 조직 방을 뺀다(9/27)');
  assert.match(app, /const olRows = olOrgGated && ol \? ol\.filter\(\(r\) => r\.space_kind !== 'team'\) : ol;/);
  for (const k of ['olOrgList = oneListOrgs(olRows)', 'olUnreadN = oneListUnread(olRows)']) assert.ok(app.includes(k), `칩·탭 숫자도 거른 행: ${k}`);
});
