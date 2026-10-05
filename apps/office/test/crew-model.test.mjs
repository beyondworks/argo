// 크루 화면(17차 A) — 조직도 묶기·크루별 맡은 일·상세 기록·맡기기 자리. 기록판 데이터 모양(board.js mapBoard)을 그대로 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupByDept, crewMadeBy, crewWork, crewRecords, crewAccess } from '../src/core/crew-model.js';

const crew = (id, dept, extra = {}) => ({ id, name: id, dept, ...extra });

// 이유(PARITY-agents O1): 조직의 크루를 부서·팀별로 모아 본다 — 부서 없는 크루가 섞여 사라지면 안 되고, 손으로 적는 칸이라 공백 차이로 부서가 갈리면 안 된다
test('조직도: 부서 이름순, 부서 없는 크루는 맨 뒤 한 묶음, 앞뒤 공백은 같은 부서', () => {
  const g = groupByDept([crew('하나', '지원팀'), crew('루나', '사업팀 '), crew('미오', ''), crew('페퍼', '사업팀'), crew('오토', undefined)]);
  assert.deepEqual(g.map((x) => x.dept), ['사업팀', '지원팀', '']);
  assert.deepEqual(g[0].crews.map((c) => c.id), ['루나', '페퍼'], '부서 안은 이름순');
  assert.deepEqual(g[2].crews.map((c) => c.id), ['미오', '오토']);
  assert.deepEqual(groupByDept([]), []);
});

// 이유(PARITY-agents D8, 서버 office_tasks 담당자 검사): 할 일 담당자는 사람만 — 크루 도구가 남긴 출처(source.kind 'crew')로만 '크루가 만든 일'을 안다
test('할 일을 만든 크루: 크루 도구 출처만, 사람이 만든 일·모양이 다른 출처는 null', () => {
  assert.equal(crewMadeBy({ source: { kind: 'crew', crew: 'c1', name: '오토' } }), 'c1');
  assert.equal(crewMadeBy({ source: { kind: 'page', page_id: 'p1' } }), null);
  assert.equal(crewMadeBy({ source: { kind: 'crew', crew: 7 } }), null);
  assert.equal(crewMadeBy({ source: null }), null);
  assert.equal(crewMadeBy({}), null);
});

test('크루별 맡은 일: 이끄는 진행 중인 일(멈춘 일 먼저·최근순) + 만든 열린 할 일(기한 가까운 순, 기한 없음은 뒤)', () => {
  const work = [
    { id: 'w1', lead: 'c1', status: 'running', started: '2026-10-01T00:00:00Z' },
    { id: 'w2', lead: 'c1', status: 'running', started: '2026-10-03T00:00:00Z' },
    { id: 'w3', lead: 'c1', status: 'blocked', started: '2026-09-01T00:00:00Z' },
    { id: 'w4', lead: 'c2', status: 'running', started: '2026-10-04T00:00:00Z' },
  ];
  const src = { kind: 'crew', crew: 'c1' };
  const tasks = [
    { id: 't1', source: src, due_on: null, created_at: '2026-10-01T00:00:00Z' },
    { id: 't2', source: src, due_on: '2026-10-09' },
    { id: 't3', source: src, due_on: '2026-10-05' },
    { id: 't4', source: src, due_on: '2026-10-01', done_at: '2026-10-02T00:00:00Z' }, // 끝낸 일은 맡은 일이 아니다
    { id: 't5', source: src, cancelled_at: '2026-10-02T00:00:00Z' },
    { id: 't6', source: { kind: 'crew', crew: 'c2' }, due_on: '2026-10-01' },
    { id: 't7', assignee: 'c1', due_on: '2026-10-01' }, // 담당자 칸은 사람 id — 크루 id와 같아도 출처가 아니면 묶지 않는다
  ];
  const r = crewWork('c1', { work, tasks });
  assert.deepEqual(r.runs.map((w) => w.id), ['w3', 'w2', 'w1']);
  assert.deepEqual(r.tasks.map((x) => x.id), ['t3', 't2', 't1']);
  assert.deepEqual(crewWork('c9', { work, tasks }), { runs: [], tasks: [] });
  assert.deepEqual(crewWork('c1', {}), { runs: [], tasks: [] }, '할 일을 아직 못 받았으면 빈 목록');
});

test('상세 기록: 결재 대기는 전부, 결정·산출물·일지는 최근 limit건 — 일지는 날짜·시각순으로 여러 날을 섞는다', () => {
  const at = (d) => `2026-10-0${d}T00:00:00Z`;
  const rows = {
    approvals: [{ id: 'a1', crew: 'c1', at: at(1) }, { id: 'a2', crew: 'c1', at: at(3) }, { id: 'a3', crew: 'c2', at: at(4) }],
    decisions: [1, 2, 3, 4].map((d) => ({ id: `d${d}`, crew: 'c1', at: at(d) })),
    outputs: [{ id: 'f1', crew: 'c1', at: at(2) }, { id: 'f2', crew: null, at: at(5) }],
    journal: [
      { date: '2026-10-04', space: 'org', entries: [{ time: '09:00', crew: 'c1', text: '오늘 1' }, { time: '15:00', crew: 'c1', text: '오늘 2' }, { time: '16:00', crew: 'c2', text: '남' }] },
      { date: '2026-10-03', space: 'org', entries: [{ time: '18:00', crew: 'c1', text: '어제' }] },
    ],
  };
  const r = crewRecords('c1', rows, 2);
  assert.deepEqual(r.approvals.map((x) => x.id), ['a2', 'a1'], '결재 대기는 잘라내지 않는다');
  assert.deepEqual(r.decisions.map((x) => x.id), ['d4', 'd3']);
  assert.deepEqual(r.outputs.map((x) => x.id), ['f1'], '사람이 올린 파일(crew null)은 빠진다');
  assert.deepEqual(r.journal.map((e) => e.text), ['오늘 2', '오늘 1']);
  assert.deepEqual(crewRecords('c1', rows, 5).journal.map((e) => [e.day, e.space]), [['2026-10-04', 'org'], ['2026-10-04', 'org'], ['2026-10-03', 'org']], '일지 줄에 날짜·공간을 붙인다(화면이 그 공간으로 간다)');
});

// 이유(메신저 규칙·맡기기 창): 1:1 맡기기는 내 크루와만 열린다 — 남의 크루는 상세는 보되 맡기기 단추 대신 채널 안내, 꺼진 내 크루는 '지금 못 맡김'
test('맡기기 자리: 예시 모드는 모두 1:1, 로그인은 쓸 수 있는 내 크루만 1:1, 꺼진 내 크루 off, 남의·회사 크루 channel', () => {
  assert.equal(crewAccess({ id: 'x' }, 'me', 'sample'), 'direct');
  assert.equal(crewAccess({ id: 'x', owner: 'me', access: 'ok' }, 'me', 'signedIn'), 'direct');
  assert.equal(crewAccess({ id: 'x', owner: 'me', access: 'disabled' }, 'me', 'signedIn'), 'off');
  assert.equal(crewAccess({ id: 'x', owner: 'other', access: 'ok' }, 'me', 'signedIn'), 'channel');
  assert.equal(crewAccess({ id: 'x', owner: 'me', company: true, access: 'ok' }, 'me', 'signedIn'), 'channel', '회사 크루는 주인이 나여도 1:1이 아니다(좌측 목록·맡기기 창과 같은 규칙)');
});
