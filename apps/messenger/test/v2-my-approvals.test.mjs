// 메신저 v2 결재 대기 목록(src/v2/my-approvals.mjs, UX 정리 P1 2026-10-22). 서버 쪽(RLS·결정 뒤 빠짐·쓰기 0)은 루트 test/msgr2-my-approvals-pg.test.mjs가 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { myApprovalItems, approvalsNeedReload, loadMyApprovals } from '../src/v2/my-approvals.mjs';
import { phoneApprovalDecider, decidableApprovals, approvalPageItems } from '../src/approval-display.js';

const ME = 'u-me', OTHER = 'u-other';
const NOW = Date.parse('2026-10-22T05:00:00Z');
const iso = (ms) => new Date(NOW + ms).toISOString();
const work = (id, o = {}) => ({ id, room_id: 'r-dm', agent_id: 'ag-1', owner_user_id: ME, root_user_id: ME, state: 'awaiting_approval', expires_at: iso(3600e3), lease_until: iso(600e3), has_result: false, late: false, error_code: null, created_at: iso(-60e3), ...o });
const ap = (id, workId, o = {}) => ({ id, work_id: workId, room_id: 'r-dm', action: '메일 발송', risk: 'high', summary: '3명에게', state: 'pending', expires_at: iso(1800e3), created_at: iso(-30e3), ...o });
const rooms = [{ id: 'r-dm', space_id: 's-me', kind: 'direct' }, { id: 'r-team', space_id: 's-team', kind: 'private' }];
const spaces = [{ id: 's-me', kind: 'personal' }, { id: 's-team', kind: 'team', name: '팀' }];

test('myApprovalItems: 내가 결정할 수 있는 대기만 — 남의 일·끝난 일·기한 지난 결재·결재 없는 일은 뺀다, 일마다 가장 최근 결재', () => {
  const works = [work('w1'), work('w2', { room_id: 'r-team' }), work('w3', { owner_user_id: OTHER }), work('w4', { state: 'running' }), work('w5'), work('w6')];
  const approvals = [ap('a1-old', 'w1', { created_at: iso(-50e3), state: 'pending' }), ap('a1', 'w1'), ap('a2', 'w2', { room_id: 'r-team', created_at: iso(-10e3) }), ap('a3', 'w3'), ap('a4', 'w4'), ap('a5', 'w5', { expires_at: iso(-1) })];
  const items = myApprovalItems({ works, approvals, rooms, spaces, uid: ME, now: NOW });
  assert.deepEqual(items.map((it) => it.id), ['a2', 'a1'], '최신이 위, 일마다 최근 결재 하나');
  const [team, dm] = items;
  assert.equal(team.org_id, 's-team'); assert.equal(dm.org_id, null, '개인 공간은 공간 이름을 붙이지 않는다');
  assert.equal(dm.key, 'v2ap:a1'); assert.equal(dm.v2, true); assert.equal(dm.kind, 'approval'); assert.equal(dm.status, 'pending');
  assert.equal(dm.workId, 'w1'); assert.equal(dm.channel_id, 'r-dm'); assert.equal(dm.crew_id, 'ag-1'); assert.equal(dm.crewOwnerId, ME);
  assert.equal(dm.reason, '3명에게'); assert.equal(dm.risk, 'high'); assert.equal(dm.payload, null);
  assert.deepEqual(myApprovalItems({ works, approvals, rooms, spaces, uid: OTHER, now: NOW }).map((it) => it.id), ['a3'], '주인 기준');
  assert.deepEqual(myApprovalItems({ uid: ME }), [], '빈 자료');
  assert.deepEqual(myApprovalItems({ works: [work('w1', { lease_until: iso(-1) })], approvals: [ap('a1', 'w1')], rooms, spaces, uid: ME, now: NOW }), [], '리스가 끊긴(stalled) 일은 결정할 수 없다(일 카드와 같은 판정)');
});

test('결재 페이지·숫자 판정: v2 줄은 주인만 결정(등급·조직 정책과 무관), 같은 목록이 페이지·숫자에 그대로', () => {
  const items = myApprovalItems({ works: [work('w1'), work('w2', { room_id: 'r-team' })], approvals: [ap('a1', 'w1'), ap('a2', 'w2', { room_id: 'r-team', risk: 'low' })], rooms, spaces, uid: ME, now: NOW });
  const orgs = [{ id: 's-team', role: 'member' }];
  for (const it of items) assert.equal(phoneApprovalDecider(it, { uid: ME, orgs }).can, true, it.id);
  assert.equal(phoneApprovalDecider(items[0], { uid: OTHER, orgs }).can, false);
  assert.equal(phoneApprovalDecider(items.find((x) => x.id === 'a1'), { uid: ME, orgs }).high, true, "'꼭 확인' 표시는 등급대로");
  assert.equal(decidableApprovals(items, { uid: ME, orgs }).length, 2, '데스크톱 숫자·폰 카드 숫자');
  assert.equal(approvalPageItems(items).length, 2, '결재 페이지 줄');
  assert.equal(approvalPageItems(items, { done: new Set(['v2ap:a1']) }).length, 1, '방금 결정한 줄은 바로 빠진다');
  // 옛 줄(v2 아님)은 종전 판정 그대로
  const old = { kind: 'approval', org_id: 's-team', crewOwnerId: OTHER, risk: 'high', policy: null };
  assert.equal(phoneApprovalDecider(old, { uid: ME, orgs: [{ id: 's-team', role: 'admin' }] }).can, true, '옛 고위험 = 관리자');
});

test('approvalsNeedReload: 결재 대기로 바뀐 내 일이 오거나 목록의 일이 바뀔 때만 다시 읽는다', () => {
  const items = [{ v2: true, workId: 'w1' }];
  assert.equal(approvalsNeedReload([{ id: 'w9', state: 'awaiting_approval', owner_user_id: ME }], [], ME), true);
  assert.equal(approvalsNeedReload([{ id: 'w9', state: 'awaiting_approval', owner_user_id: OTHER }], [], ME), false, '남의 결재 대기는 요청 0');
  assert.equal(approvalsNeedReload([{ id: 'w1', state: 'running', owner_user_id: ME }], items, ME), true, '목록의 일이 다른 곳에서 결정됨');
  assert.equal(approvalsNeedReload([{ id: 'w2', state: 'running', owner_user_id: ME }], items, ME), false, '그 밖의 일 사건은 요청 0');
  assert.equal(approvalsNeedReload([], items, ME), false);
});

test('loadMyApprovals 요청 수: 결재 대기 일이 없으면 1번, 있으면 일·결재·방·공간 4번, 결재 행이 없으면 2번', async () => {
  const fake = (tables) => { const calls = []; return { calls, from: (t) => { const b = { select: () => b, eq: () => b, in: () => b, order: () => b, limit: () => b, then: (res) => { calls.push(t); res({ data: tables[t] ?? [], error: null }); } }; return b; } }; };
  let c = fake({}); assert.deepEqual(await loadMyApprovals(c, ME), { works: [], approvals: [], rooms: [], spaces: [] }); assert.deepEqual(c.calls, ['msgr2_works']);
  c = fake({ msgr2_works: [work('w1')] }); await loadMyApprovals(c, ME); assert.deepEqual(c.calls, ['msgr2_works', 'msgr2_approvals']);
  c = fake({ msgr2_works: [work('w1')], msgr2_approvals: [ap('a1', 'w1')], msgr2_rooms: rooms, msgr2_spaces: spaces }); const d = await loadMyApprovals(c, ME);
  assert.deepEqual(c.calls, ['msgr2_works', 'msgr2_approvals', 'msgr2_rooms', 'msgr2_spaces']); assert.equal(d.approvals.length, 1);
  c = fake({}); await loadMyApprovals(c, null); assert.deepEqual(c.calls, [], '로그인 전 요청 0');
  const bad = { from: () => { const b = { select: () => b, eq: () => b, in: () => b, order: () => b, limit: () => b, then: (res) => res({ data: null, error: { message: 'denied' } }) }; return b; } };
  await assert.rejects(loadMyApprovals(bad, ME), /denied/, '실패는 던진다 — 셸이 지난 값을 둔다');
});

test('App 배선: v2는 결재 목록을 v2 표에서, 채팅 탭 맨 위 카드는 있을 때만, 에이전트 탭 카드는 그대로, 데스크톱 결재 단추는 v2·있을 때만', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const load = app.slice(app.indexOf('const loadApprovals = useCallback('), app.indexOf('const approvalsSoon = useRef('));
  assert.match(load, /if \(!uid \|\| \(!isPhoneRef\.current && !V2\)\) return;/);
  assert.match(load, /if \(V2\) \{ const d = await v2LoadMyApprovals\(supabase, uid\)\.catch\(\(\) => null\); if \(d\) setApprovals\(v2ApprovalItems\(\{ \.\.\.d, uid \}\)\); return; \}/);
  assert.ok(load.indexOf('if (V2)') < load.indexOf("msgr_crew_approvals"), 'v2면 옛 표를 읽지 않는다(옛 경로는 v2 끔에서 그대로)');
  assert.match(app, /if \(v2ApprovalsNeedReload\(works, approvalsRef\.current, uid\)\) approvalsSoon\.current\(\);/, "일 표지가 결재와 관련될 때만 다시 읽기");
  assert.match(app, /\{rootTab === 'chats' && \(<>\n {10}\{!tabQText\.trim\(\) && approvalItems\.length > 0 && apCard\}/, '채팅 탭 맨 위 — 0건이면 카드 없음');
  assert.match(app, /\{rootTab === 'agents' && \(<>\n {10}\{!tabQText\.trim\(\) && apCard\}/, "에이전트 탭은 종전대로(0건이면 '없음'으로 꺼 둔 카드)");
  assert.equal(app.match(/className=\{`ph-apcard\$\{/g)?.length, 1, '카드 모양은 한 곳(apCard)');
  assert.match(app, /const deskAp = V2 && !isPhone && approvalItems\.length > 0;/, '데스크톱 결재 단추는 v2·있을 때만');
  assert.match(app, /\{deskAp && <button type="button" className="btn ghost bell" onClick=\{\(\) => openApproval\(approvalItems\[0\]\)\}/, '누르면 가장 최근 결재의 방(그 방 일 카드에서 결정)');
  assert.match(app, /className=\{`msgr-foot\$\{deskAp \? ' has-ap' : ''\}`\}/, '단추가 있을 때만 칸 하나 더');
  assert.match(app, /\) : isPhone && page === 'approvals' \? \(/, '결재 페이지는 폰 그대로');
  const page = app.slice(app.indexOf('function PhoneApprovals('), app.indexOf('function PhoneFriendsManage('));
  assert.match(page, /else if \(it\.v2\) \{[^]*?await v2DecideApproval\(supabase, it\.id, ok \? 'approve' : 'reject'\);/, 'v2 결정은 msgr2_approval_decide');
  assert.ok(page.indexOf('else if (it.v2)') < page.indexOf("from('msgr_crew_approvals').update"), 'v2 줄은 옛 표를 고치지 않는다');
});
