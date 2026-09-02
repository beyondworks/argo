// 기억 그래프 2D — 구성(순수 함수). JSX 없는 모듈로 분리해 node 테스트가 직접 임포트한다.
// 렌더러(graph2d.jsx)와 데크·기억 페이지가 이 하나를 쓴다.
export const stem = (rel) => rel.replace(/\.md$/, '');
const authorOf = (rel) => rel
  .replace(/^(conversations|notes|journal)\//, '')
  .replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, '')
  .replace(/^\d{4}-\d{2}-\d{2}-/, '')
  .replace(/\.md$/, '');

/** 그래프 구성(순수) — docs의 [[링크]]가 엣지. 링크 표기 3종(전체 stem·파일명 stem·제목) 전부 해석한다. */
export function buildGraph2D({ docs = [], agents = [], showCrew = false, showOrphans = false }) {
  const nodes = [];
  const idx = new Map();
  const add = (n) => { idx.set(n.id, nodes.length); nodes.push(n); };
  const byBase = new Map(), byTitle = new Map();
  for (const d of docs) {
    const id = stem(d.rel);
    add({ id, type: d.dir === 'notes' ? 'note' : 'doc', label: d.title, rel: d.rel });
    byBase.set(id.split('/').pop(), id);
    byTitle.set(d.title, id);
  }
  const resolve = (l) => (idx.has(l) ? l : byBase.get(l) ?? byTitle.get(l) ?? null);
  const edges = [];
  const seen = new Set();
  for (const d of docs) {
    const from = stem(d.rel);
    for (const l of d.links ?? []) {
      const to = resolve(l);
      if (!to || to === from) continue;
      const key = [from, to].sort().join('→');
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([idx.get(from), idx.get(to)]);
    }
  }
  if (showCrew) {
    for (const a of agents) add({ id: `@ag:${a.slug}`, type: 'agent', label: a.name, slug: a.slug });
    for (const d of docs) {
      const j = idx.get(`@ag:${authorOf(d.rel)}`);
      if (j !== undefined) edges.push([j, idx.get(stem(d.rel))]);
    }
  }
  const deg = new Array(nodes.length).fill(0);
  for (const [a, b] of edges) { deg[a]++; deg[b]++; }
  nodes.forEach((n, i) => { n.deg = deg[i]; });
  if (showOrphans) return { nodes, edges, hiddenOrphans: 0 };
  // 고아 제거 — 인덱스 재매핑
  const keep = nodes.map((n, i) => deg[i] > 0 || n.type === 'agent');
  const remap = new Map();
  const nodes2 = [];
  nodes.forEach((n, i) => { if (keep[i]) { remap.set(i, nodes2.length); nodes2.push(n); } });
  const edges2 = edges.filter(([a, b]) => keep[a] && keep[b]).map(([a, b]) => [remap.get(a), remap.get(b)]);
  return { nodes: nodes2, edges: edges2, hiddenOrphans: nodes.length - nodes2.length };
}

/** 데크 지표 — 고유 연결 쌍 수(links), 링크가 1개 이상인 기억 수(linked), 고립 기억 수(isolated), 문서별 차수(deg: rel → 수).
    그래프와 같은 해석(표기 3종·양방향 중복 제거·자기 링크 제외)이라 기억 그래프의 "고아 N개 숨김"과 합이 맞는다.
    스캐폴드 안내 노트(doc.guide)는 기억이 아니라 안내문 — 노드·엣지째 지표 밖이다(deg에도 없다). 링크가 없으면 분모를
    (n−1)/n에 묶고, 링크가 붙으면(옛 자동 링크가 안내 노트에 붙곤 했다) 실제보다 부풀리므로 어느 쪽도 세지 않는다(검수 MEDIUM-1).
    예전 데크의 자체 셈(전체 stem만 해석)은 그래프와 숫자가 갈라졌다. */
export function linkStats(docs) {
  const pool = docs.filter((d) => !d.guide);
  const { nodes, edges } = buildGraph2D({ docs: pool, showOrphans: true });
  const deg = new Map(nodes.map((n) => [n.rel, n.deg]));
  const linked = nodes.filter((n) => n.deg > 0).length;
  return { links: edges.length, linked, isolated: nodes.length - linked, deg };
}
