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

// 이유(유건 2026-10-05, 에이전트 = 한 사람): 같은 에이전트(주인·회사·slug)는 조직이 달라도 같은 얼굴이어야 한다. 메신저와 같은 기준
// (crew-face.mjs agentLooks — 대표 조직 행의 저장 얼굴, 없으면 대표 행 id 씨앗)을 pull.js가 내 크루 행으로 만들어 넘긴다. 지도에 없는 크루(남의 크루)는 그대로.
test('크루 얼굴: 내 에이전트는 대표 행 기준(faceSeed·face), 남의 크루는 자기 행 그대로', async () => {
  const { agentLooks } = await import('../../messenger/src/crew-face.mjs');
  const own = [
    { id: 'c1', org_id: ORG, owner_user_id: 'u1', ws_id: 'w', slug: 'luna', status: 'active', face: null, created_at: '2026-09-10T00:00:00+00:00' },
    { id: 'c0', org_id: 'o2', owner_user_id: 'u1', ws_id: 'w', slug: 'luna', status: 'active', face: { v: 2, shape: 8, color: 9 }, created_at: '2026-09-01T00:00:00+00:00' },
  ];
  const b = mapBoard(base, { orgKey: key, decidable: new Set(), looks: agentLooks(own) });
  const c1 = b.crews.find((c) => c.id === 'c1'); const c2 = b.crews.find((c) => c.id === 'c2');
  assert.deepEqual([c1.faceSeed, c1.face], ['c0', { v: 2, shape: 8, color: 9 }]);
  assert.deepEqual([c2.faceSeed, c2.face], ['c2', null]);
  assert.equal(mapBoard(base, { orgKey: key, decidable: new Set() }).crews[0].faceSeed, 'c1', '지도가 없으면(예시·옛 경로) 자기 id');
});

// 이유: 결재 버튼은 서버가 결재권이 있다고 한 것만(msgr_can_decide). 쉬운 문장이 비면 동작 이름으로.
test('결재·결정·산출물·일지: 공간 키, 결재권, 문장 대체, 채널 이름, 일지 크루 id', () => {
  const b = mapBoard(base, { orgKey: key, decidable: new Set(['a1']) });
  assert.deepEqual(b.approvals[0], { id: 'a1', space: 'bw', crew: 'c2', plain: 'send_mail', head: null, need: null, risk: 'high', at: 't2', channel: '영업', canDecide: true });
  assert.deepEqual(b.decisions[0], { id: 'd1', space: 'bw', crew: 'c1', plain: '공지 게시', action: 'post', risk: null, result: 'approved', by: '', at: 't3', asked: null, channel: '' });
  assert.deepEqual(b.work[0], { id: 'w1', space: 'bw', goal: '재견적', lead: 'c1', status: 'running', started: 't1', channel: '영업', done: null });
  assert.deepEqual(b.outputs[0], { id: 'f1', space: 'bw', name: 'a.pdf', crew: 'c1', channel: '영업', bytes: 10, at: 't4', path: null, mime: '' });
  assert.deepEqual(b.journal, [{ space: 'bw', date: '2026-09-27', entries: [{ time: '09:12', crew: 'c1', name: '루나', text: '끝' }] }]);
  assert.equal(mapBoard(base, { orgKey: key, decidable: new Set() }).approvals[0].canDecide, false);
});

// 이유(P2): 크루 공용 문서(msgr_org_docs rules/·glossary/·projects/)는 마크다운 — 오피스는 HTML 문자열 없이 편집기 문서 모양으로만 그린다.
test('공용 문서: 마크다운 → 문서(제목·목록·문단), 빈 줄은 건너뜀, 굵게 표시는 글자만', async () => {
  const { mdToDoc } = await import('../src/core/board.js');
  assert.deepEqual(mdToDoc('# 규칙\n\n- **존댓말** 쓰기\n- 결재 먼저\n본문 한 줄').content, [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '규칙' }] },
    { type: 'bulletList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '존댓말 쓰기' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '결재 먼저' }] }] }] },
    { type: 'paragraph', content: [{ type: 'text', text: '본문 한 줄' }] },
  ]);
});

test('공용 문서 목록: 일지는 빼고 폴더·공간을 붙인다', async () => {
  const { mapBoard } = await import('../src/core/board.js');
  const docs = [{ id: 'x1', org_id: 'o1', channel_id: null, path: 'rules/manners.md', title: '예절', updated_at: 't' }, { id: 'x2', org_id: 'o1', channel_id: 'ch', path: 'journal/2026-09-27.md', title: 'j', updated_at: 't' }];
  assert.deepEqual(mapBoard({ docs }, { orgKey: new Map([['o1', 'bw']]), decidable: new Set() }).docs, [{ id: 'x1', space: 'bw', folder: 'rules', title: '예절', path: 'rules/manners.md', updated: 't', channel: '' }]);
});

// 이유(유건 9/30): 결정 기록의 '결정한 사람'이 늘 '—'였다 — decided_by를 조직 멤버 이름으로. 산출물은 눌러서 열 수 있게 저장 경로·종류를 싣는다.
test('결정한 사람은 조직 멤버 이름으로, 산출물은 저장 경로·종류를 싣는다', () => {
  const b = mapBoard({ ...base,
    decisions: [{ id: 'd2', org_id: ORG, channel_id: 'ch1', crew_id: 'c1', action: 'rm -rf x', reason: '정리', risk: 'high', status: 'rejected', decided_by: 'u9', decided_at: 't5', created_at: 't4' }],
    files: [{ id: 'f2', org_id: ORG, name: '보고.md', bytes: 3, mime: null, storage_path: 'o1/ch1/보고.md', created_at: 't4', msg: { channel_id: 'ch1', crew_id: 'c1' } }],
    members: [{ org_id: ORG, user_id: 'u9', display_name: '유건' }] }, { orgKey: key, decidable: new Set() });
  assert.deepEqual(b.decisions[0], { id: 'd2', space: 'bw', crew: 'c1', plain: '정리', action: 'rm -rf x', risk: 'high', result: 'rejected', by: '유건', at: 't5', asked: 't4', channel: '영업' });
  assert.deepEqual([b.outputs[0].path, b.outputs[0].mime], ['o1/ch1/보고.md', '']);
});
