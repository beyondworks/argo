// 기록판 — 메신저 행(msgr_*)을 오피스 화면 모양으로. 규칙은 메신저 스키마(9/27 조사)에 맞춘다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJournal, mapBoard } from '../src/core/board.js';

// 이유: 크루 일지는 트리거 msgr_channel_journal이 "- 시:분 · **크루** ← 요청자: 요청 → 답" 줄로 쌓는다(요청자 없는 줄도 있다).
test('일지 줄 파싱: 요청자 있는 줄·없는 줄, 형식이 다른 줄은 버린다', () => {
  const body = '- 09:12 · **루나** ← 유건: 견적 다시 → 1,800개 기준으로 정리했습니다\n- 10:03 · **오토** → 가격 조사 끝\n아무 줄';
  assert.deepEqual(parseJournal(body), [
    { time: '09:12', crew: '루나', who: '유건', ask: '견적 다시', text: '1,800개 기준으로 정리했습니다' },
    { time: '10:03', crew: '오토', who: null, ask: null, text: '가격 조사 끝' },
  ]);
});

const ORG = 'o1', key = new Map([[ORG, 'bw']]);
const base = {
  crews: [{ id: 'c1', org_id: ORG, owner_user_id: 'u1', display_name: '루나', department: '영업', role_text: null, face: null },
    { id: 'c2', org_id: ORG, owner_user_id: 'u2', display_name: '오토', department: null, role_text: '리서치', face: null },
    { id: 'c3', org_id: ORG, owner_user_id: 'u1', display_name: '미오', department: null, role_text: null, face: null }],
  runs: [{ id: 'w1', org_id: ORG, channel_id: 'ch1', goal: '재견적', lead_crew_id: 'c1', status: 'running', created_at: 't1' }],
  approvals: [{ id: 'a1', org_id: ORG, channel_id: 'ch1', crew_id: 'c2', action: 'send_mail', reason: '', risk: 'high', created_at: 't2' }],
  decisions: [{ id: 'd1', org_id: ORG, crew_id: 'c1', action: 'post', reason: '공지 게시', status: 'approved', decided_at: 't3' }],
  files: [{ id: 'f1', org_id: ORG, name: 'a.pdf', bytes: 10, created_at: 't4', msg: { channel_id: 'ch1', crew_id: 'c1' } }],
  channels: [{ id: 'ch1', name: '영업', kind: 'public' }],
  journals: [{ org_id: ORG, title: '2026-09-27', body: '- 09:12 · **루나** → 끝' }],
};

// 이유: 사이드바 크루 상태 점 — 진행 중인 일의 담당이면 일하는 중, 대기 결재가 있으면 확인 필요, 아니면 대기(예시 데이터와 같은 값).
test('크루 상태: 담당 중 → work, 대기 결재 → ask, 그 외 idle. 역할은 부서 먼저', () => {
  const b = mapBoard(base, { orgKey: key, decidable: new Set() });
  assert.deepEqual(b.crews.map((c) => [c.id, c.status, c.role, c.space, c.owner]), [['c1', 'work', '영업', 'bw', 'u1'], ['c2', 'ask', '리서치', 'bw', 'u2'], ['c3', 'idle', '', 'bw', 'u1']]);
});

// 이유: 결재 버튼은 서버가 결재권이 있다고 한 것만(msgr_can_decide). 쉬운 문장이 비면 동작 이름으로.
test('결재·결정·산출물·일지: 공간 키, 결재권, 문장 대체, 채널 이름, 일지 크루 id', () => {
  const b = mapBoard(base, { orgKey: key, decidable: new Set(['a1']) });
  assert.deepEqual(b.approvals[0], { id: 'a1', space: 'bw', crew: 'c2', plain: 'send_mail', risk: 'high', at: 't2', channel: '영업', canDecide: true });
  assert.deepEqual(b.decisions[0], { id: 'd1', space: 'bw', crew: 'c1', plain: '공지 게시', result: 'approved', by: '', at: 't3' });
  assert.deepEqual(b.work[0], { id: 'w1', space: 'bw', goal: '재견적', lead: 'c1', status: 'running', started: 't1', channel: '영업' });
  assert.deepEqual(b.outputs[0], { id: 'f1', space: 'bw', name: 'a.pdf', crew: 'c1', channel: '영업', bytes: 10, at: 't4' });
  assert.deepEqual(b.journal, [{ space: 'bw', date: '2026-09-27', entries: [{ time: '09:12', crew: 'c1', name: '루나', text: '끝' }] }]);
  assert.equal(mapBoard(base, { orgKey: key, decidable: new Set() }).approvals[0].canDecide, false);
});
