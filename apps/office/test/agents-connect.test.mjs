// 10/5 연결성(CX-01·04·05·06, OFC-20) — 오피스 에이전트 목록이 메신저와 같은 에이전트·같은 수·같은 상태를 보이게.
// 기록판 행(msgr_crews)을 화면 모양으로 바꾸는 mapBoard와 공간별 목록 crewsIn을 실제로 돌려 확인한다(소스 글자 단언 아님).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as B from '../src/core/board.js';
import * as L from '../src/core/crew-list.js';
// 이름공간으로 가져온다 — 고치기 전 코드(함수 없음)에서도 파일이 열리고 시험마다 따로 실패하게
const mapBoard = (...a) => B.mapBoard(...a), canDecideAp = (...a) => B.canDecideAp(...a), decidableSet = (...a) => B.decidableSet(...a);
const crewsIn = (...a) => L.crewsIn(...a), groupCrews = (...a) => L.groupCrews(...a);
import { agentLooks } from '../../messenger/src/crew-face.mjs';
import { approvalDecider } from '../../messenger/src/approval-display.js';

const ME = 'u-me', O1 = 'o1', O2 = 'o2';
const orgKey = new Map([[O1, 'acme'], [O2, 'beta']]);
const AT = Date.parse('2026-10-05T03:00:00Z');
const ago = (s) => new Date(AT - s * 1000).toISOString();
// office_crew_list 행(조직 크루) — 서버가 돌려주는 모양
const listed = (id, org, extra = {}) => ({ id, org_id: org, owner_user_id: ME, display_name: '페퍼', department: null, role_text: '비서', face: null, access: 'ok', ...extra });
// msgr_crews 직접 읽기 행(조직 크루 + 내 개인 공간 크루)
const raw = (id, org, extra = {}) => ({ id, org_id: org, owner_user_id: ME, ws_id: 'ws1', slug: 'pepper', status: 'active', face: null, created_at: '2026-09-01T00:00:00Z', display_name: '페퍼', role_text: '비서', department: null, hosting: 'local', last_seen_at: null, ...extra });
const board = (crews, agents) => mapBoard({ crews, agents }, { orgKey, decidable: new Set(), looks: agentLooks(agents.filter((r) => r.owner_user_id === ME)), me: ME, at: AT });

// CX-01: 조직이 없는 사람도 개인 공간 에이전트(org_id NULL, 9/30 #779)가 '내 에이전트'에 보인다. 남의 개인 행·꺼진 개인 행은 싣지 않는다
test('CX-01: 개인 공간 에이전트는 내 공간에만, 조직 목록에는 나오지 않는다', () => {
  const agents = [raw('p1', null, { slug: 'solo', display_name: '혼자' }), raw('p2', null, { slug: 'off', status: 'available' }), raw('p3', null, { slug: 'x', owner_user_id: 'u-other' })];
  const b = mapBoard({ agents }, { orgKey: new Map(), decidable: new Set(), looks: agentLooks(agents), me: ME, at: AT });
  assert.deepEqual(b.crews.map((c) => [c.id, c.space, c.org, c.personal]), [['p1', 'me', null, true]]);
  assert.deepEqual(crewsIn(b.crews, 'me', ME).map((c) => c.id), ['p1'], '조직이 없어도 내 에이전트 1명');
  assert.deepEqual(groupCrews(crewsIn(b.crews, 'me', ME), { me: ME }).groups.flatMap((g) => g.crews.map((c) => c.id)), ['p1'], '좌측 목록에도 보인다(쓸 수 있는 내 크루)');
  // 조직이 있으면: 개인 행이 조직 공간 목록에 새지 않는다(예전 mapBoard는 space를 null로 만들어 모든 조직 목록에 넣었다)
  const b2 = board([listed('c1', O1)], [raw('c1', O1), raw('p1', null, { slug: 'solo', display_name: '혼자' })]);
  assert.deepEqual(crewsIn(b2.crews, 'acme', ME).map((c) => c.id), ['c1']);
});

// CX-04: 파견 해제·분리(서버 판정 access 'inactive' — msgr_instruct_check status<>'active')와 동기화 충돌 사본(slug .conflict-)은 메신저 목록에 없다 → 오피스도 뺀다
test('CX-04: 꺼진 크루·충돌 사본은 조직·내 공간 목록 어디에도 없다(메신저와 같은 수)', () => {
  const crews = [listed('c1', O1), listed('c2', O1, { owner_user_id: 'u-kim', display_name: '헤르메스', access: 'inactive' }), listed('c3', O1, { display_name: '페퍼 사본' })];
  const agents = [raw('c1', O1), raw('c2', O1, { owner_user_id: 'u-kim', slug: 'bot-1', status: 'available' }), raw('c3', O1, { slug: 'pepper.conflict-mac-1700000000' })];
  const b = board(crews, agents);
  assert.deepEqual(crewsIn(b.crews, 'acme', ME).map((c) => c.id), ['c1']);
  assert.deepEqual(crewsIn(b.crews, 'me', ME).map((c) => c.id), ['c1']);
  assert.ok(b.crews.some((c) => c.id === 'c2'), '기록판 행은 그대로 둔다 — 지난 결재·일지의 이름이 비지 않게');
});

// CX-05: 조직 두 곳에 파견한 같은 에이전트(주인·회사·slug 같음)와 그 개인 행은 내 공간에서 한 줄. 대표는 조직 행(고정·순서가 사는 행), 맡기기는 개인 행(twin)
test('CX-05: 같은 에이전트는 내 공간에서 한 줄 — 묶인 행·개인 행·들어 있는 조직', () => {
  const b = board([listed('c1', O1), listed('c2', O2), listed('d1', O1, { display_name: '울프' })],
    [raw('c1', O1), raw('c2', O2), raw('p1', null), raw('d1', O1, { slug: 'wolff', display_name: '울프' })]);
  const me = crewsIn(b.crews, 'me', ME);
  assert.deepEqual(me.map((c) => c.name).sort(), ['울프', '페퍼'], '페퍼가 두(세) 번 나오지 않는다');
  const pepper = me.find((c) => c.name === '페퍼');
  assert.deepEqual([pepper.id, pepper.ids.slice().sort(), pepper.twin, pepper.spaces.slice().sort()], ['c1', ['c1', 'c2', 'p1'], 'p1', ['acme', 'beta']]);
  assert.equal(me.find((c) => c.name === '울프').twin, null, '개인 행이 없는 에이전트(옛 본체)는 조직 1:1 그대로');
  assert.deepEqual(crewsIn(b.crews, 'beta', ME).map((c) => c.id), ['c2'], '조직 공간은 그 조직 행 하나 그대로');
});

// CX-06: 접속 상태 — 메신저와 같은 90초(AWAY_MS), 받아 온 때 기준. 개인 행은 같은 에이전트 조직 행의 시각을 빌린다(서버 msgr_personal_room_crews와 같은 규칙).
// 꺼진 에이전트는 '대기'(메신저의 '대기 중' = 켜짐과 같은 말)가 아니라 '꺼져 있음'. 접속 시각을 모르면(읽기 실패) 꺼짐이라 단정하지 않는다
test('CX-06: 꺼짐·켜짐 — 90초, 개인 행은 조직 행 시각을 빌리고, 모르면 단정하지 않는다', () => {
  const on = board([listed('c1', O1)], [raw('c1', O1, { last_seen_at: ago(30) }), raw('p1', null)]);
  assert.deepEqual(on.crews.map((c) => [c.id, c.status, c.on]), [['c1', 'idle', true], ['p1', 'idle', true]]);
  const off = board([listed('c1', O1)], [raw('c1', O1, { last_seen_at: ago(200) }), raw('p1', null)]);
  assert.deepEqual(off.crews.map((c) => [c.id, c.status, c.on]), [['c1', 'off', false], ['p1', 'off', false]]);
  assert.equal(crewsIn(off.crews, 'me', ME)[0].status, 'off', '묶은 줄도 꺼짐');
  const unknown = mapBoard({ crews: [listed('c1', O1)] }, { orgKey, decidable: new Set(), at: AT });
  assert.deepEqual(unknown.crews.map((c) => [c.status, c.on]), [['idle', null]], '크루 행을 못 읽었으면 예전처럼');
  const busy = mapBoard({ crews: [listed('c1', O1)], agents: [raw('c1', O1, { last_seen_at: ago(500) })], runs: [{ id: 'w', org_id: O1, lead_crew_id: 'c1', status: 'running' }] }, { orgKey, decidable: new Set(), me: ME, at: AT });
  assert.equal(busy.crews[0].status, 'work', '진행 중인 일의 담당이면 일하는 중이 먼저');
});

// OFC-20: 결재 버튼 판정을 결재마다 msgr_can_decide 대신 조직 정책 한 번 읽기로 — 메신저 approvalDecider와 모든 칸에서 같아야 한다(최종은 서버 RLS)
test('OFC-20: 화면용 결재권 판정 = 메신저 approvalDecider(모든 칸), 정책을 못 읽으면 서버에 맡긴다', () => {
  for (const risk of ['low', 'high']) for (const mode of [undefined, 'admin', 'owner', 'approvers']) for (const role of ['owner', 'admin', 'member'])
    for (const owner of [ME, 'u-kim', undefined]) for (const listedMe of [true, false]) {
      const policy = mode ? { approval_high_by: mode, approver_user_ids: listedMe ? [ME] : [] } : null;
      const want = approvalDecider({ ap: { risk }, uid: ME, crewOwnerId: owner, isAdmin: role === 'owner' || role === 'admin', policy }).can;
      assert.equal(canDecideAp({ risk }, { me: ME, role, owner, policy }), want, JSON.stringify({ risk, mode, role, owner, listedMe }));
    }
  assert.equal(canDecideAp({ risk: 'high' }, { me: ME, role: 'guest', owner: ME, policy: { approval_high_by: 'approvers', approver_user_ids: [ME] } }), false, '손님은 지정 결재권자여도 안 된다(서버 msgr_can_decide와 같다)');
  const aps = [{ id: 'a1', org_id: O1, crew_id: 'c1', risk: 'low' }, { id: 'a2', org_id: O1, crew_id: 'c9', risk: 'high' }];
  const ctx = { me: ME, crews: [{ id: 'c1', owner_user_id: ME }, { id: 'c9', owner_user_id: 'u-kim' }], orgs: [{ id: O1, role: 'member' }] };
  assert.deepEqual([...decidableSet(aps, { ...ctx, policies: [] })], ['a1'], '정책 행이 없으면 기본(관리자)');
  assert.deepEqual([...decidableSet(aps, { ...ctx, policies: null })], ['a1', 'a2'], '정책을 못 읽었으면 버튼을 띄우고 서버가 가른다');
});
