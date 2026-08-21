// 기억 그래프 2D 구성(순수) — 옵시디언식 계약을 값으로 잠근다(유건 지시 2026-08-21).
//  ① 기본 엣지는 [[링크]]만 — 크루(작성자) 계층은 토글 전까지 없다(폭죽 모양의 원인이었다)
//  ② 링크 표기 3종(전체 stem·파일명 stem·제목)을 전부 해석한다
//  ③ 고아(링크 0) 기억은 기본 숨김, 토글로 포함
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph2D } from '../app/c/[ws]/graph2d-core.mjs';

const docs = [
  { rel: 'notes/브랜드-전략.md', dir: 'notes', title: '브랜드 전략', links: ['notes/콘텐츠-캘린더', '뉴스레터-운영'] },
  { rel: 'notes/콘텐츠-캘린더.md', dir: 'notes', title: '콘텐츠 캘린더', links: ['브랜드 전략'] },
  { rel: 'notes/뉴스레터-운영.md', dir: 'notes', title: '뉴스레터 운영', links: [] },
  { rel: 'journal/2026-08-21-pepper.md', dir: 'journal', title: '일지', links: [] },
];
const agents = [{ slug: 'pepper', name: '페퍼' }];

test('기본: 링크 엣지만 · 고아 숨김 · 3표기 해석', () => {
  const g = buildGraph2D({ docs, agents });
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ['notes/뉴스레터-운영', 'notes/브랜드-전략', 'notes/콘텐츠-캘린더'], '일지(고아)는 빠진다');
  assert.equal(g.edges.length, 2, '전체 stem·파일명 stem·제목 표기 모두 엣지가 되고 중복은 1회');
  assert.equal(g.hiddenOrphans, 1);
  assert.ok(!g.nodes.some((n) => n.type === 'agent'), '크루 노드는 기본 없음');
});

test('토글: 고아 포함 · 크루 연결(작성자 엣지)', () => {
  const g = buildGraph2D({ docs, agents, showOrphans: true, showCrew: true });
  assert.ok(g.nodes.some((n) => n.id === 'journal/2026-08-21-pepper'), '고아 포함');
  const agent = g.nodes.findIndex((n) => n.type === 'agent');
  assert.ok(agent >= 0, '크루 노드');
  const j = g.nodes.findIndex((n) => n.id === 'journal/2026-08-21-pepper');
  assert.ok(g.edges.some(([a, b]) => (a === agent && b === j) || (a === j && b === agent)), '작성자 → 일지 엣지');
});
