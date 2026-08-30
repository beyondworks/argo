// 기억 그래프 2D 구성(순수) — 옵시디언식 계약을 값으로 잠근다(유건 지시 2026-08-21).
//  ① 기본 엣지는 [[링크]]만 — 크루(작성자) 계층은 토글 전까지 없다(폭죽 모양의 원인이었다)
//  ② 링크 표기 3종(전체 stem·파일명 stem·제목)을 전부 해석한다
//  ③ 고아(링크 0) 기억은 기본 숨김, 토글로 포함
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('링크 없는 기억만 있으면 노드 0 + hiddenOrphans 전수 — 빈 하늘 안내의 전제', () => {
  // 신규 회사의 실제 첫 상태 — 이 조합(nodes 0, hiddenOrphans N)이 Graph2D의 빈 하늘 안내를 띄우고
  // 안내의 "연결 없는 기억 N건" 수치가 hiddenOrphans에서 나온다.
  const lone = [
    { rel: 'notes/첫-기억.md', dir: 'notes', title: '첫 기억', links: [] },
    { rel: 'journal/2026-08-30-pepper.md', dir: 'journal', title: '일지', links: [] },
  ];
  const g = buildGraph2D({ docs: lone, agents });
  assert.equal(g.nodes.length, 0, '기본 보기(고아 숨김·크루 꺼짐)에서 노드가 하나도 없다');
  assert.equal(g.hiddenOrphans, 2, '안내에 싣는 숨긴 기억 수 = 고아 전수');
});

test('토글: 고아 포함 · 크루 연결(작성자 엣지)', () => {
  const g = buildGraph2D({ docs, agents, showOrphans: true, showCrew: true });
  assert.ok(g.nodes.some((n) => n.id === 'journal/2026-08-21-pepper'), '고아 포함');
  const agent = g.nodes.findIndex((n) => n.type === 'agent');
  assert.ok(agent >= 0, '크루 노드');
  const j = g.nodes.findIndex((n) => n.id === 'journal/2026-08-21-pepper');
  assert.ok(g.edges.some(([a, b]) => (a === agent && b === j) || (a === j && b === agent)), '작성자 → 일지 엣지');
});

// ── 빈 하늘 안내 — JSX는 렌더 하네스가 없어 소스 구간 불변식으로 잠근다(선례: display-zoom-layout §③).
//    함수 단위 핀은 핸들러 우회에 초록이라(MEMORY 교훈) 구간 경계 + 표현식 전체를 앵커로 잡는다.
const jsx = readFileSync(new URL('../app/c/[ws]/graph2d.jsx', import.meta.url), 'utf8');

test('빈 하늘 구간: 노드 0 분기가 조기 공백(clearRect+return)으로 되돌아가지 못한다', () => {
  const start = jsx.indexOf('if (graph.nodes.length === 0)');
  const end = jsx.indexOf('const sim = createSim2D(graph)');
  assert.ok(start > 0 && end > start, '노드 0 분기 ~ 본 경로 진입 구간이 존재');
  const seg = jsx.slice(start, end);
  assert.ok(seg.includes('setEmptySky(true)'), '빈 분기가 안내 오버레이 상태를 켠다');
  assert.ok(seg.includes('paintDust('), '빈 분기가 별먼지를 그린다(완전 공백 금지)');
  assert.ok(seg.includes('new ResizeObserver'), '리사이즈 시 다시 그린다');
  assert.ok(seg.includes("removeEventListener('argo:theme', drawSky)") && seg.includes("removeEventListener('argo:theme', syncThemeRgb)"), '정리 함수가 테마 리스너 둘을 모두 제거(누수 금지)');
  assert.ok(seg.includes("canvas.style.cursor = 'default'"), '잡을 노드가 없으니 grab 어포던스 제거');
  assert.ok(seg.includes('setEmptySky(false)') && seg.includes("canvas.style.cursor = 'grab'"), '노드가 생기면 안내를 끄고 커서를 복귀');
});

test('빈 하늘 JSX: 오버레이 3문구는 t() 사전 경유, 고아 줄·조작 힌트는 조건 게이트', () => {
  assert.ok(jsx.includes('{emptySky && ('), '오버레이는 emptySky 조건부 렌더');
  for (const k of ['graph.emptySkyTitle', 'graph.emptySkyBody', 'graph.emptySkyOrphans']) {
    assert.ok(jsx.includes(`t('${k}'`), `${k}를 t()로 참조(하드코딩 금지 — 다국어 절대 규칙)`);
  }
  assert.ok(jsx.includes('{hiddenOrphans > 0 && ('), '고아 수 줄은 표현식 전체(hiddenOrphans > 0)로 게이트');
  assert.ok(jsx.includes('{!compact && !emptySky && ('), '조작 힌트는 빈 하늘에서 숨긴다');
  assert.ok(!/className="microlabel"[^\n]*emptySky/.test(jsx.slice(jsx.indexOf('{emptySky && ('))), '오버레이 본문에 microlabel 금지 — 영어에서 9.5px 모노 대문자가 된다(검수 MEDIUM-2)');
});

test('emptySky는 이펙트 의존성이 아니다(자기 재실행 루프 금지)', () => {
  assert.ok(jsx.includes('}, [docs, agents, showCrew, showOrphans, root, compact, focusRel, localRoot]);'), '의존성 배열은 원래 8개 그대로 — emptySky가 끼면 빈 분기 진입마다 이펙트가 재실행된다');
});
