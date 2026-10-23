// 메신저 재공개 전 검수 F5(2026-10-23) — 팀 방 턴에서 올린 결재의 action 원문(최대 300자)이 활동 기록(events.jsonl — Pro 클라우드 동기화, 행 합집합이라 회수 불가)에 남았다.
// #1150(linkEventScrub)이 턴 행만 막아서 생긴 같은 계급의 빈칸이다. 결재 이벤트 3곳(올림·확정·만료)에 같은 판정을 쓴다.
// 핀(고치기 전에도 통과): 로컬 결재·개인 공간 링크 결재·옛 채널(msgr) 결재는 action 원문 그대로. approvals.json의 항목(action·reason·plain)은 이번에도 그대로(카드가 쓴다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-linkap-home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-linkap-'));
process.env.ARGO_ENC_VAULT = '0';
const { createCompany } = await import('../src/workspace.mjs');
const { addApproval, resolveApproval, expireApproval, loadApprovals } = await import('../src/approvals.mjs');
const { readEvents } = await import('../src/events.mjs');

const OWNER = '11111111-1111-4111-8111-111111111111';
const SPACE = 'aaaaaaaa-0000-4000-8000-000000000001';
const ROOM = 'dddddddd-0000-4000-8000-000000000001';
const WORK = 'eeeeeeee-0000-4000-8000-000000000001';
const link = (extra = {}) => ({ kind: 'link', work: WORK, room: ROOM, owner: true, ...extra });
let seq = 0;
async function company(lang = 'ko') { const ws = `linkap-${++seq}`; await createCompany(ws, '린', '유건', OWNER, lang); return ws; }
const apEvents = async (ws) => (await readEvents(ws, 50)).filter((e) => e.type === 'approval');
const SECRET = '김○○ 대표에게 인수 조건 메일 보내기';

test('핀: 로컬 결재·개인 공간 링크 결재·옛 채널(msgr) 결재는 이벤트 action 원문 그대로(올림·확정·만료)', async () => {
  const ws = await company();
  const a = await addApproval(ws, { slug: 'seoyun', action: `${SECRET} 로컬`, reason: 'r' });
  const b = await addApproval(ws, { slug: 'seoyun', action: `${SECRET} 개인`, reason: 'r', scope: link({ space: SPACE, spaceKind: 'personal' }) });
  const c = await addApproval(ws, { slug: 'seoyun', action: `${SECRET} 옛 채널`, reason: 'r', msgr: { orgId: SPACE, channelId: ROOM } });
  await resolveApproval(ws, a.id, true);
  await expireApproval(ws, b.id);
  await resolveApproval(ws, c.id, false);
  const ev = await apEvents(ws);
  assert.equal(ev.length, 6);
  for (const e of ev) assert.match(e.action, /김○○ 대표에게 인수 조건/, `${e.status}: 원문`);
});

for (const [name, scope, label] of [
  ['팀 공간', link({ space: SPACE, spaceKind: 'team' }), '조직 방 지시 (dddddddd)'],
  ['공간 모름(옛 범위·조회 실패)', link(), '메신저 방 지시 (dddddddd)'],
  ['개인 공간 + 기억 안 남김', link({ space: SPACE, spaceKind: 'personal', memoryOff: true }), '메신저 방 지시 (dddddddd)'],
]) {
  test(`${name} 링크 결재 — 올림·확정·만료 이벤트 모두 고정 라벨, 결재 항목(카드)은 원문 그대로`, async () => {
    const ws = await company();
    const a = await addApproval(ws, { slug: 'seoyun', action: SECRET, reason: '이유 원문', scope, plain: { task: '할 일 원문' } });
    const b = await addApproval(ws, { slug: 'seoyun', action: `${SECRET} 2`, reason: 'r', scope });
    await resolveApproval(ws, a.id, true);
    await expireApproval(ws, b.id);
    const ev = await apEvents(ws);
    assert.deepEqual(ev.map((e) => e.status).sort(), ['approved', 'expired', 'pending', 'pending']);
    for (const e of ev) { assert.equal(e.action, label, `${e.status}`); assert.equal(e.scrubbed, true); }
    assert.doesNotMatch(JSON.stringify(await readEvents(ws, 50)), /김○○|인수 조건/, '활동 기록 어디에도 원문 없음');
    const item = (await loadApprovals(ws)).find((x) => x.id === a.id);
    assert.deepEqual([item.action, item.reason, item.plain.task], [SECRET, '이유 원문', '할 일 원문'], '결재 항목은 그대로(카드가 무엇을 승인하는지 보여 준다)');
  });
}

test('영어 회사는 영어 라벨', async () => {
  const ws = await company('en');
  await addApproval(ws, { slug: 'seoyun', action: SECRET, reason: 'r', scope: link({ space: SPACE, spaceKind: 'team' }) });
  assert.equal((await apEvents(ws))[0].action, 'Org room request (dddddddd)');
});

test('셸 결재(권한 게이트 모양: msgr + scope=link)도 같은 판정', async () => {
  const ws = await company();
  await addApproval(ws, { slug: 'seoyun', action: `셸 명령 실행(삭제): rm -rf ${SECRET}`, reason: 'r', payload: { shell: 'rm -rf x', rule: 'rm' }, msgr: { channelId: ROOM }, scope: link({ space: SPACE, spaceKind: 'team' }) });
  const [e] = await apEvents(ws);
  assert.equal(e.action, '조직 방 지시 (dddddddd)');
});
