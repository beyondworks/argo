// 유건 결정 2026-10-06 — 조직 그룹 대화 삭제 권한(room-delete.mjs)과 신고 대상(report-target.mjs). 서버 20261006170000과 같은 기준.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canDeleteRoom, isOrgGroupRoom } from '../src/room-delete.mjs';
import { canReportMessage } from '../src/report-target.mjs';

const ME = 'me', B = 'b', C = 'c', AG = 'agent';
const u = (id) => ({ member_kind: 'user', member_id: id });
const cr = (id) => ({ member_kind: 'crew', member_id: id });
const orgDm = (created_by) => ({ id: 'x', kind: 'dm', org_id: 'org', created_by });

test('조직 그룹 대화(사람 3명 이상): 만든 사람(참여 중)·조직 관리자(참여 중)만 삭제', () => {
  const group = [u(ME), u(B), u(C)];
  assert.equal(isOrgGroupRoom(orgDm(B), group), true);
  assert.equal(canDeleteRoom({ c: orgDm(B), members: group, uid: ME }), false, '일반 참여자');
  assert.equal(canDeleteRoom({ c: orgDm(ME), members: group, uid: ME }), true, '만든 사람');
  assert.equal(canDeleteRoom({ c: orgDm(B), members: group, uid: ME, isOrgAdmin: true }), true, '조직 관리자');
  assert.equal(canDeleteRoom({ c: orgDm(ME), members: [u(B), u(C), u('d')], uid: ME }), false, '나간 만든 사람');
  assert.equal(canDeleteRoom({ c: orgDm(B), members: [u(B), u(C), u('d')], uid: ME, isOrgAdmin: true }), false, '방 밖 조직 관리자(서버도 참여 요구)');
});

test('1:1·사람 둘 + 에이전트·구성원 미로딩·채널·개인 방은 막지 않는다(종전 규칙)', () => {
  assert.equal(canDeleteRoom({ c: orgDm(B), members: [u(ME), u(B)], uid: ME }), true, '1:1');
  assert.equal(canDeleteRoom({ c: orgDm(B), members: [u(ME), u(B), cr(AG)], uid: ME }), true, '사람 둘 + 에이전트 — 에이전트는 세지 않는다');
  assert.equal(canDeleteRoom({ c: orgDm(B), members: [], uid: ME }), true, '구성원 미로딩 — 판정은 서버');
  for (const kind of ['public', 'private']) assert.equal(isOrgGroupRoom({ kind, org_id: 'org' }, [u(ME), u(B), u(C)]), false, kind);
  assert.equal(isOrgGroupRoom({ kind: 'dm', org_id: null, _personal_group: true }, [u(ME), u(B), u(C)]), false, '개인 그룹은 dmItemsOf의 종전 규칙');
});

test('신고: 진짜 시스템 글만 제외 — 에이전트 명의 글은 kind와 상관없이 신고', () => {
  const crew = (kind) => ({ id: 1, author_kind: 'crew', crew_id: AG, kind });
  for (const kind of ['text', 'system', 'approval_card']) assert.equal(canReportMessage(crew(kind), ME), true, `에이전트 ${kind}`);
  assert.equal(canReportMessage({ author_kind: 'system', kind: 'system' }, ME), false, '진짜 시스템 글');
  assert.equal(canReportMessage({ author_kind: 'user', author_user_id: B, kind: 'text' }, ME), true, '남의 사람 글');
  assert.equal(canReportMessage({ author_kind: 'user', author_user_id: B, kind: 'system' }, ME), true, '사람 명의 system 글(#846 전 위조분)');
  assert.equal(canReportMessage({ author_kind: 'user', author_user_id: ME, kind: 'text' }, ME), false, '내 글');
  assert.equal(canReportMessage({ ...crew('text'), pending: true }, ME), false, '보내는 중');
  assert.equal(canReportMessage(null, ME), false);
});

test('App.jsx가 두 판정을 실제로 쓴다(메뉴·신고 버튼) — 옛 kind 조건이 남지 않는다', async () => {
  const src = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /canDeleteRoom\(\{ c, members: dmMembers\[c\.id\] \?\? \[\], uid, isOrgAdmin: isAdmin \}\)/);
  assert.match(src, /const canReport = canReportMessage\(m, uid\);/);
  assert.doesNotMatch(src, /canReport = [^\n]*m\.kind !== 'system'/);
});

test('i18n: 비활성 삭제 안내 문구 ko/en', async () => {
  const { t } = await import('../src/i18n.js');
  assert.equal(t('dm.delete.groupOnly', 'ko'), '삭제는 방장·관리자만 — 나가기를 쓰세요');
  assert.equal(t('dm.delete.groupOnly', 'en'), 'Only the creator or an admin can delete — use Leave');
});
