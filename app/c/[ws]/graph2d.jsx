'use client';
// 기억 그래프 2D — 옵시디언식(유건 지시 2026-08-21: "3D 별자리는 데크 위젯에만, 기억 페이지는 2D").
// 기본은 **[[링크]] 엣지만** 그린다 — 크루(작성자)→기억 계층 엣지는 크루 11명이 기억 2천 건의 허브가
// 되어 폭죽 모양으로 지식 구조를 덮었다(실측). 계층은 토글, 링크 없는 고아 기억도 토글(기본 숨김).
// 인터랙션은 전부 이징으로 — 줌·팬·호버 점등·포커스 전환이 프레임마다 목표값으로 수렴한다
// ("부드럽고 감각적" — 유건 기준). 노드 드래그는 시뮬을 잠깐 재가열해 이웃이 따라 움직인다.
import { useEffect, useRef, useState } from 'react';
import { forceSimulation, forceManyBody, forceLink, forceX, forceY } from 'd3-force';
import { useLang } from '../../i18n';
import { buildGraph2D, stem } from './graph2d-core.mjs'; // 구성은 JSX 없는 코어(테스트가 직접 임포트)
import { zoomedEvPos } from './zoom-math.mjs'; // 표시 배율 좌표 환산 — JSX 없는 코어(테스트가 직접 임포트)
export { buildGraph2D };

// 성도(星圖) 문법 — 허브 기억 = 큰 별(십자 빛살), 일반 기억 = 작은 네 꼭지 별, 크루 = 다이아몬드(유건 승인 시안
// 2026-08-21). 색·글꼴은 **테마를 따른다**: 배경·잉크 = --paper-rgb/--ink-rgb, 별 포인트 = --accent-rgb
// (무채색 테마면 푸른 계열로 대체 — 유건 2026-08-21), 글꼴 = --font(앱 전체와 같은 글꼴, 별도 세리프 금지).
let INK = '37, 39, 30', PAPER = '233, 235, 221';
let ACCENT = '196, 160, 70', LABEL_ACCENT = '150, 118, 40';
let FONT = 'Pretendard, -apple-system, sans-serif';
function syncThemeRgb() {
  const st = getComputedStyle(document.documentElement);
  INK = st.getPropertyValue('--ink-rgb').trim() || INK;
  PAPER = st.getPropertyValue('--paper-rgb').trim() || PAPER;
  FONT = st.getPropertyValue('--font').trim() || FONT;
  const [pr, pg, pb] = PAPER.split(',').map(Number);
  const light = (pr * 299 + pg * 587 + pb * 114) / 1000 > 128;
  // 별 포인트 = 테마의 '점·노드 강조색'. linen 가족은 --accent가 차콜(무채색)이고 옐로를 --mark로 분리했으므로 --mark-rgb를 먼저 본다(메신저 활동 그래프·기억 그래프 룩 통일, 2026-09-04)
  const chroma = (v) => { const a = (v || '').split(',').map(Number); return a.length === 3 && !a.some(Number.isNaN) && Math.max(...a) - Math.min(...a) >= 40 ? a : null; };
  // --graph-rgb: 그래프 전용 포인트색(있으면 최우선). 메신저 linen은 옐로가 그레이지 캔버스에서 묻혀 러스트로 지정(유건 지적 2026-09-04). 아르고 본체는 미정의라 종전 그대로.
  let acc = chroma(st.getPropertyValue('--graph-rgb').trim()) ?? chroma(st.getPropertyValue('--mark-rgb').trim()) ?? (st.getPropertyValue('--accent-rgb').trim() || '').split(',').map(Number);
  if (acc.length !== 3 || acc.some(Number.isNaN) || Math.max(...acc) - Math.min(...acc) < 40) acc = light ? [62, 130, 247] : [120, 170, 255]; // 무채색 포인트면 푸른 계열
  ACCENT = acc.join(', ');
  // 라벨은 배경 대비로 한 단계 — 밝은 종이엔 짙게, 어두운 종이엔 밝게
  LABEL_ACCENT = (light ? acc.map((v) => Math.round(v * 0.72)) : acc.map((v) => Math.round(v + (255 - v) * 0.35))).join(', ');
}
/** 별먼지 — 결정적 난수(seed 고정)라 리사이즈·재마운트마다 같은 하늘. 본 그래프와 빈 하늘이 공유한다(한쪽만 고치면 조용히 어긋나는 자리). */
function makeDust(W, H, compact) {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const n = compact ? 40 : Math.round((W * H) / 5000);
  return Array.from({ length: n }, () => ({ x: rnd() * W, y: rnd() * H, r: rnd() < 0.1 ? 1.1 : 0.6, a: 0.08 + rnd() * 0.25 }));
}
function paintDust(ctx, dust) {
  for (const d of dust) { ctx.fillStyle = `rgba(${INK}, ${d.a * 0.5})`; ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill(); }
}

/** 네 꼭지 별 경로 — 일반 기억도 "별"로 읽히게(원은 옵시디언 그대로라 정체성이 없다 — 유건 2026-08-21) */
function star4(path, x, y, r) {
  const k = r * 0.38;
  path.moveTo(x, y - r); path.lineTo(x + k, y - k); path.lineTo(x + r, y); path.lineTo(x + k, y + k);
  path.lineTo(x, y + r); path.lineTo(x - k, y + k); path.lineTo(x - r, y); path.lineTo(x - k, y - k); path.closePath();
}

/** 2D 포스 — d3-force(Barnes-Hut 반발, O(N log N)). 직접 짠 격자 해시 근사는 실데이터 2,000노드에서
    워밍업이 5분을 넘겨 페이지를 얼렸다(벤치 실측 2026-08-21 — 격자 셀 한 곳에 노드가 몰리면 N²로 퇴화).
    검증된 쿼드트리를 쓰고, 워밍업은 동기로 돌리지 않는다 — 프레임 루프가 시간 예산 안에서 틱을 나눠
    돌려 첫 페인트가 즉시 뜨고 자리 잡는 과정이 화면에 살아 움직인다(감각적 진입). */
function createSim2D({ nodes, edges }) {
  const pts = nodes.map((_, i) => {
    const a = i * 2.39996, r = 14 * Math.sqrt(i + 1);
    return { index: i, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0 };
  });
  const links = edges.map(([a, b]) => ({ source: a, target: b }));
  const adj = nodes.map(() => []);
  for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }
  const sim = forceSimulation(pts)
    .force('charge', forceManyBody().strength(-28).theta(0.9).distanceMax(420))
    .force('link', forceLink(links).distance(42).strength(0.55))
    .force('x', forceX(0).strength(0.018))
    .force('y', forceY(0).strength(0.018))
    .alphaDecay(0.028)
    .velocityDecay(0.38)
    .stop(); // 틱은 프레임 루프가 시간 예산으로 돌린다
  // 시간 예산(ms) 안에서 가능한 만큼 틱 — 큰 그래프는 여러 프레임에 걸쳐 수렴, 작은 그래프는 한 프레임에 끝난다
  const step = (budgetMs) => {
    const end = performance.now() + budgetMs;
    while (sim.alpha() > sim.alphaMin() && performance.now() < end) sim.tick();
    return sim.alpha();
  };
  const reheat = (a = 0.5) => sim.alpha(Math.max(sim.alpha(), a));
  return { pts, adj, step, reheat, alive: () => sim.alpha() > sim.alphaMin() };
}

/**
 * 2D 그래프 캔버스 — 줌·팬·노드 드래그·호버 로컬 포커스·더블클릭 로컬 그래프.
 * props: docs, agents, onSelectDoc(rel), focusRel(선택 문서 — 있으면 깊이 2 로컬 그래프로 수렴), compact(뷰어 우측 미니)
 */
export function Graph2D({ docs, agents = [], onSelectDoc, focusRel = null, compact = false, height = '100%', nodeShape = 'star' }) { // nodeShape: 'star'(성도 — 아르고 기억) | 'circle'(옵시디언식 원 — 메신저 활동, 유건 지시 2026-09-04)
  const { t } = useLang();
  const ref = useRef(null);
  const cb = useRef({}); cb.current = { onSelectDoc };
  const shapeRef = useRef(nodeShape); shapeRef.current = nodeShape; // 프레임마다 읽는다 — 의존 배열(8개 고정, 재실행 루프 핀)에 안 끼운다
  const [showCrew, setShowCrew] = useState(false);
  const [showOrphans, setShowOrphans] = useState(false);
  const [hiddenOrphans, setHiddenOrphans] = useState(0);
  const [emptySky, setEmptySky] = useState(false); // 노드 0 — 빈 하늘 안내(신규 회사: 링크 없는 기억뿐이면 그래프가 통째로 공백이었다)
  const [localRoot, setLocalRoot] = useState(null); // 더블클릭 로컬 그래프(깊이 2) — ESC로 복귀
  const root = focusRel ? stem(focusRel) : localRoot;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !docs) return;
    syncThemeRgb();
    // 인스턴스별 래퍼 — 모듈 전역 참조를 그대로 등록하면 동일 참조라 실제 등록이 1개로 접혀,
    // 2분할 동시 마운트에서 한쪽 정리가 남은 인스턴스의 테마 갱신까지 끊는다(PR #339 검수 발견).
    const onTheme = () => syncThemeRgb();
    window.addEventListener('argo:theme', onTheme);
    const full = buildGraph2D({ docs, agents, showCrew, showOrphans });
    setHiddenOrphans(full.hiddenOrphans);
    // 로컬 그래프 — root에서 깊이 2까지만 남긴다(옵시디언 로컬 그래프)
    let graph = full;
    if (root) {
      const ri = full.nodes.findIndex((n) => n.id === root);
      if (ri >= 0) {
        const adj = full.nodes.map(() => []);
        for (const [a, b] of full.edges) { adj[a].push(b); adj[b].push(a); }
        const keep = new Set([ri]);
        let frontier = [ri];
        for (let d = 0; d < 2; d++) {
          const next = [];
          for (const i of frontier) for (const j of adj[i]) if (!keep.has(j)) { keep.add(j); next.push(j); }
          frontier = next;
        }
        const remap = new Map();
        const nodes = [];
        full.nodes.forEach((n, i) => { if (keep.has(i)) { remap.set(i, nodes.length); nodes.push(n); } });
        const edges = full.edges.filter(([a, b]) => keep.has(a) && keep.has(b)).map(([a, b]) => [remap.get(a), remap.get(b)]);
        graph = { nodes, edges, hiddenOrphans: 0 };
      }
    }
    if (graph.nodes.length === 0) {
      // 빈 하늘 — 종전엔 clearRect 후 조기 반환이라 신규 회사(링크 없는 기억뿐)의 첫 화면이 통째로
      // 공백 = "고장"으로 읽혔다. 별먼지만 캔버스에 깔고, 안내 문구는 오버레이(DOM)가 맡는다
      // — 캔버스 글자와 달리 i18n(t)·테마 색·줄바꿈이 공짜다.
      setEmptySky(true);
      canvas.style.cursor = 'default'; // 잡을 노드가 없다 — grab 커서는 거짓 어포던스
      canvas.title = ''; // 직전 그래프에서 호버로 남은 노드 라벨 툴팁 청소
      const ctx = canvas.getContext('2d');
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const drawSky = () => {
        const W = canvas.clientWidth, H = canvas.clientHeight;
        canvas.width = W * dpr; canvas.height = H * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        paintDust(ctx, makeDust(W, H, compact)); // 본 그래프와 같은 하늘 — 노드가 생겨도 배경은 이어진다
      };
      drawSky();
      const ro = new ResizeObserver(drawSky);
      ro.observe(canvas);
      window.addEventListener('argo:theme', drawSky); // 먼저 등록된 onTheme이 색을 갱신한 뒤 다시 그린다
      return () => {
        ro.disconnect();
        window.removeEventListener('argo:theme', drawSky);
        window.removeEventListener('argo:theme', onTheme);
      };
    }
    setEmptySky(false);
    canvas.style.cursor = 'grab';
    const sim = createSim2D(graph);
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0, H = 0;
    let dust = [];
    const fit = () => {
      W = canvas.clientWidth; H = canvas.clientHeight; canvas.width = W * dpr; canvas.height = H * dpr;
      // 별먼지 — 화면 좌표에 고정(줌·팬에 안 따라온다: 먼 배경). 빈 하늘과 같은 makeDust라 상태가 바뀌어도 같은 하늘.
      dust = makeDust(W, H, compact);
    };
    fit();

    // 뷰 상태 — 목표(target)와 현재(cur)를 분리해 프레임마다 수렴(이징). 줌은 커서 기준.
    const view = { x: 0, y: 0, s: 1 };
    const target = { x: 0, y: 0, s: 1 };
    let autoFit = true;
    const fitToGraph = (animate = true) => {
      let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      for (const p of sim.pts) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
      const bw = Math.max(maxX - minX, 60), bh = Math.max(maxY - minY, 60);
      // compact(뷰어 레일 300px)는 라벨이 좌우로 삐져나가므로 여백을 더 준다(실측: 좌측 라벨 절단)
      const s = Math.min((W * (compact ? 0.62 : 0.84)) / bw, (H * (compact ? 0.66 : 0.8)) / bh, compact ? 2.2 : 3.2);
      target.s = s;
      target.x = W / 2 - ((minX + maxX) / 2) * s;
      target.y = H / 2 - ((minY + maxY) / 2) * s;
      if (!animate) { view.x = target.x; view.y = target.y; view.s = target.s; }
    };
    // 진입 연출 — 멀리서 부드럽게 들어온다
    fitToGraph(false);
    view.s = target.s * 0.72; view.x = W / 2 - (W / 2 - view.x) * 0.72; view.y = H / 2 - (H / 2 - view.y) * 0.72;

    const toWorld = (sx, sy) => ({ x: (sx - view.x) / view.s, y: (sy - view.y) / view.s });
    const toScreen = (p) => ({ x: p.x * view.s + view.x, y: p.y * view.s + view.y });

    // 호버 점등 — 0/1 스텝이 아니라 노드별 포커스 값이 프레임마다 수렴(부드러운 점등·소등)
    const focus = new Float32Array(graph.nodes.length).fill(1);
    let hover = null, drag = null, downAt = null, panning = null, moved = false;
    let frameNo = 0;
    const rootIdx = root ? graph.nodes.findIndex((n) => n.id === root) : -1;

    // 점은 작게 — 2,000건 실데이터에서 큰 점은 덩어리가 된다(유건 2026-08-21 "점들이 너무 크고 오밀조밀"). 허브만 로그로 조금 큼
    const nodeRadius = (n) => (compact ? 1.4 : 1.8) + Math.log2(1 + n.deg) * (compact ? 0.8 : 1.1) + (n.type === 'agent' ? 1.5 : 0);
    const pick = (sx, sy) => {
      let best = null, bd = 12 * 12;
      for (let i = 0; i < sim.pts.length; i++) {
        const q = toScreen(sim.pts[i]);
        const dx = q.x - sx, dy = q.y - sy, d2 = dx * dx + dy * dy;
        const r = nodeRadius(graph.nodes[i]) * Math.min(view.s, 2) + 4;
        if (d2 < Math.max(bd, r * r) && d2 < bd * 2) { bd = d2; best = i; }
      }
      return best;
    };
    // 라벨 — 허브(연결 상위)는 상시, 나머지는 줌인·호버·이웃일 때
    const degSorted = [...graph.nodes.keys()].sort((a, b) => graph.nodes[b].deg - graph.nodes[a].deg);
    const hubs = new Set(degSorted.slice(0, compact ? 4 : 14).filter((i) => graph.nodes[i].deg >= 2)); // 연결 1개짜리는 허브가 아니다(작은 회사에서 전부 골드가 되던 것)

    const dashed = graph.edges.length <= 1500; // 점선은 엣지가 많으면 비싸다 — 큰 그래프는 실선 희미하게
    const draw = () => {
      // 이징 — 줌·팬
      view.x += (target.x - view.x) * 0.12; view.y += (target.y - view.y) * 0.12; view.s += (target.s - view.s) * 0.12;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H); // 배경은 컨테이너(테마 종이색)가 칠한다
      paintDust(ctx, dust);
      const nb = hover !== null ? sim.adj[hover] : null;
      const nbSet = nb ? new Set(nb) : null;
      const anyFocus = hover !== null;
      for (let i = 0; i < focus.length; i++) {
        const want = !anyFocus ? 1 : (i === hover || nbSet.has(i)) ? 1 : 0.12;
        focus[i] += (want - focus[i]) * 0.18;
      }
      const P = sim.pts.map(toScreen);
      // 아스트롤라베 — 로컬 그래프(원점 있음)일 때만: 포커스 문서가 원점, 깊이가 동심원으로 읽힌다
      if (rootIdx >= 0 && !compact) {
        const c = P[rootIdx];
        ctx.setLineDash([2, 6]); ctx.lineWidth = 1; ctx.strokeStyle = `rgba(${ACCENT}, 0.12)`;
        for (const rr of [90, 180, 290]) { ctx.beginPath(); ctx.arc(c.x, c.y, rr * view.s, 0, Math.PI * 2); ctx.stroke(); }
        ctx.setLineDash([]); ctx.strokeStyle = `rgba(${ACCENT}, 0.16)`;
        ctx.beginPath(); ctx.moveTo(c.x - 330 * view.s, c.y); ctx.lineTo(c.x + 330 * view.s, c.y); ctx.moveTo(c.x, c.y - 330 * view.s); ctx.lineTo(c.x, c.y + 330 * view.s); ctx.stroke();
      }
      // 엣지 3종 — 허브끼리 골드 실선(뼈대), 일반 은청 점선(별자리 선), 크루 연결 종이색 점선. 호버 이웃만 골드 강조.
      const spine = new Path2D(), twig = new Path2D(), crewE = new Path2D(), hi = new Path2D();
      for (const [a, b] of graph.edges) {
        const A = P[a], B = P[b];
        const isHi = anyFocus && (a === hover || b === hover);
        const na = graph.nodes[a], nbn = graph.nodes[b];
        const path = isHi ? hi : (na.type === 'agent' || nbn.type === 'agent') ? crewE : (hubs.has(a) && hubs.has(b)) ? spine : twig;
        path.moveTo(A.x, A.y); path.lineTo(B.x, B.y);
      }
      const dense = Math.min(1, 900 / Math.max(graph.edges.length, 1)); // 선 밀도 보정 — 엣지가 많을수록 옅게
      const dimE = (anyFocus ? 0.35 : 1) * Math.max(dense, 0.25);
      ctx.setLineDash(dashed ? [3, 5] : []); ctx.lineWidth = 0.7; ctx.strokeStyle = `rgba(${INK}, ${0.16 * dimE})`; ctx.stroke(twig);
      ctx.setLineDash(dashed ? [1, 5] : []); ctx.strokeStyle = `rgba(${INK}, ${0.3 * dimE})`; ctx.stroke(crewE);
      ctx.setLineDash([]); ctx.lineWidth = 1.1; ctx.strokeStyle = `rgba(${ACCENT}, ${0.55 * dimE})`; ctx.stroke(spine);
      if (anyFocus) { ctx.lineWidth = 1.2; ctx.strokeStyle = `rgba(${ACCENT}, 0.9)`; ctx.stroke(hi); }
      // 노드 — 일반 기억은 한 경로로, 허브·크루·포커스는 개별
      const rs = Math.min(Math.max(view.s, 0.7), 1.15); // 화면 고정 크기에 가깝게 — 줌인해도 점이 부풀지 않는다(옵시디언과 같은 규칙)
      const plain = new Path2D();
      const specials = [];
      const off = (q) => q.x < -24 || q.x > W + 24 || q.y < -24 || q.y > H + 24; // 뷰포트 컬링
      for (let i = 0; i < graph.nodes.length; i++) {
        const n = graph.nodes[i], q = P[i];
        if (off(q)) continue;
        const r = nodeRadius(n) * rs;
        const f = focus[i];
        if (n.type === 'agent' || hubs.has(i) || i === rootIdx || (anyFocus && f > 0.5)) { specials.push([i, q, r, f]); continue; }
        if (shapeRef.current === 'circle') { plain.moveTo(q.x + r * 1.1, q.y); plain.arc(q.x, q.y, r * 1.1, 0, Math.PI * 2); } else star4(plain, q.x, q.y, r * 1.35);
      }
      const dim = anyFocus ? 0.22 : 1;
      ctx.fillStyle = `rgba(${INK}, ${0.5 * dim})`; ctx.fill(plain);
      for (const [i, q, r, f] of specials) {
        const n = graph.nodes[i];
        const a = anyFocus ? Math.max(f, 0.22) : 1;
        if (n.type === 'agent') { // 크루 = 다이아몬드 표식(별과 모양으로 구분 — 색을 더 안 쓴다)
          ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(Math.PI / 4);
          ctx.fillStyle = `rgba(${INK}, ${0.9 * a})`; ctx.fillRect(-r * 0.9, -r * 0.9, r * 1.8, r * 1.8); ctx.restore();
          continue;
        }
        const isRoot = i === rootIdx;
        const big = isRoot || hubs.has(i);
        if (big || (anyFocus && f > 0.5)) { // 골드 별 — 헤일로 + 링 + 십자 빛살
          const g = ctx.createRadialGradient(q.x, q.y, r * 0.5, q.x, q.y, r * 2.4);
          g.addColorStop(0, `rgba(${ACCENT}, ${0.18 * a})`); g.addColorStop(1, `rgba(${ACCENT}, 0)`);
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(q.x, q.y, r * 2.4, 0, Math.PI * 2); ctx.fill();
          ctx.lineWidth = 0.7; ctx.strokeStyle = `rgba(${ACCENT}, ${0.4 * a})`; ctx.beginPath(); ctx.arc(q.x, q.y, r * 1.9, 0, Math.PI * 2); ctx.stroke();
          if (shapeRef.current !== 'circle') { // 십자 빛살은 별에만 — 원형은 헤일로·링만(옵시디언 룩)
            const L = r * (isRoot ? 2.8 : 2.3);
            ctx.lineWidth = 1; ctx.strokeStyle = `rgba(${ACCENT}, ${0.9 * a})`;
            ctx.beginPath(); ctx.moveTo(q.x - L, q.y); ctx.lineTo(q.x + L, q.y); ctx.moveTo(q.x, q.y - L); ctx.lineTo(q.x, q.y + L); ctx.stroke();
          }
          ctx.fillStyle = `rgba(${ACCENT}, ${0.95 * a})`;
        } else ctx.fillStyle = `rgba(${INK}, ${0.5 * a})`;
        const sp = new Path2D();
        if (shapeRef.current === 'circle') { const rr = r * (big ? 1.45 : 1.1); sp.moveTo(q.x + rr, q.y); sp.arc(q.x, q.y, rr, 0, Math.PI * 2); } else star4(sp, q.x, q.y, r * (big ? 1.5 : 1.35));
        ctx.fill(sp);
      }
      // 라벨 — 성도의 별 이름처럼 세리프. compact는 중심·호버만, 같은 제목 허브는 프레임당 한 번.
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const drawn = new Set();
      const placed = []; // 라벨 충돌 회피 — 허브가 뭉친 실데이터(2,000건)에서 라벨끼리 겹쳐 못 읽던 것. 가까운 자리엔 안 쓴다
      const crowded = (x, y, h) => placed.some((q) => Math.abs(q.y - y) < (h + q.h) / 2 && Math.abs(q.x - x) < 170);
      for (let i = 0; i < graph.nodes.length; i++) {
        const n = graph.nodes[i];
        const isHover = i === hover, isNb = !compact && nbSet?.has(i);
        const show = isHover || isNb || i === rootIdx || (!compact && !anyFocus && (hubs.has(i) || view.s > 2.6));
        if (!show) continue;
        if (!isHover && i !== rootIdx) { if (drawn.has(n.label)) continue; drawn.add(n.label); }
        const q = P[i], r = nodeRadius(n) * rs;
        if (off(q)) continue;
        const em = isHover || i === rootIdx;
        const twoLine = !compact && !anyFocus && hubs.has(i) && !em; // 허브는 '연결 N' 둘째 줄까지 차지한다
        const lh = twoLine ? 34 : 18;
        if (!em && crowded(q.x + r * 2.6 + 6, q.y + (twoLine ? 8 : 0), lh)) continue;
        placed.push({ x: q.x + r * 2.6 + 6, y: q.y + (twoLine ? 8 : 0), h: lh });
        const txt = n.label.length > 28 ? `${n.label.slice(0, 28)}…` : n.label;
        ctx.font = `${em ? 600 : 500} ${compact ? 10.5 : em ? 13 : 12}px ${FONT}`;
        const a = em || isNb ? 0.95 : Math.min(0.8, 0.45 + (view.s - 1) * 0.4);
        const col = (hubs.has(i) || em) && n.type !== 'agent' ? LABEL_ACCENT : INK;
        ctx.fillStyle = `rgba(${col}, ${a * (anyFocus && !isHover && !isNb ? 0.3 : 1)})`;
        ctx.fillText(txt, q.x + r * 2.6 + 6, q.y + 1);
        if (twoLine) { // 허브엔 연결 수 한 줄
          ctx.font = `10.5px ${FONT}`; ctx.fillStyle = `rgba(${LABEL_ACCENT}, 0.8)`;
          ctx.fillText(t('graph.linksN', { n: n.deg }), q.x + r * 2.6 + 6, q.y + 16);
        }
      }
    };

    let raf;
    const frame = () => {
      // 시뮬은 프레임당 6ms 예산 — 2천 노드도 첫 페인트가 즉시 뜨고 여러 프레임에 걸쳐 자리 잡는다
      if (sim.alive()) sim.step(6);
      frameNo++;
      if (autoFit && (sim.alive() ? frameNo % 4 === 0 : frameNo % 30 === 0)) fitToGraph(true);
      draw();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    // 배율(표시 zoom) 보정 — rect는 배율이 곱해진 뷰포트 px, 캔버스 좌표계는 CSS px(clientWidth 기준).
    // 배율 1이면 k=1이라 종전과 완전 동일(검수 HIGH-2: 1.25에서 노드 클릭이 최대 ~150px 어긋났다).
    const evPos = (e) => zoomedEvPos(canvas.getBoundingClientRect(), canvas.clientWidth, e.clientX, e.clientY);
    const onDown = (e) => {
      const [sx, sy] = evPos(e);
      const i = pick(sx, sy);
      downAt = { sx, sy }; moved = false;
      if (i !== null) { drag = i; sim.pts[i].fx = sim.pts[i].x; sim.pts[i].fy = sim.pts[i].y; canvas.style.cursor = 'grabbing'; }
      else panning = { sx, sy, vx: view.x, vy: view.y };
    };
    const onMove = (e) => {
      const [sx, sy] = evPos(e);
      if (downAt && Math.hypot(sx - downAt.sx, sy - downAt.sy) > 3) moved = true;
      if (drag !== null) {
        const w = toWorld(sx, sy);
        sim.pts[drag].fx = w.x; sim.pts[drag].fy = w.y; // d3 고정점 — 시뮬이 이 좌표를 존중한다
        sim.reheat(0.35); autoFit = false; // 재가열 — 이웃이 따라 움직인다
        return;
      }
      if (panning) {
        autoFit = false;
        target.x = panning.vx + (sx - panning.sx); target.y = panning.vy + (sy - panning.sy);
        view.x = target.x; view.y = target.y; // 팬은 즉답(지연되면 끌리는 느낌)
        return;
      }
      hover = pick(sx, sy);
      const n = hover !== null ? graph.nodes[hover] : null;
      canvas.style.cursor = n ? 'pointer' : 'grab';
      canvas.title = n ? n.label : '';
    };
    const onUp = (e) => {
      if (drag !== null) {
        const i = drag; drag = null;
        sim.pts[i].fx = null; sim.pts[i].fy = null; // 놓으면 다시 흐른다(고정하고 싶으면 더블클릭으로 로컬 그래프)
        canvas.style.cursor = 'pointer';
        if (!moved && graph.nodes[i].rel) cb.current.onSelectDoc?.(graph.nodes[i].rel);
      } else if (panning) {
        panning = null; canvas.style.cursor = 'grab';
      }
      downAt = null;
    };
    const onDbl = (e) => {
      const [dx, dy] = evPos(e);
      const i = pick(dx, dy);
      if (i !== null && !focusRel) setLocalRoot(graph.nodes[i].id);
    };
    const onWheel = (e) => {
      e.preventDefault();
      autoFit = false;
      const [sx, sy] = evPos(e);
      const k = Math.exp(-e.deltaY * 0.0016);
      const ns = Math.min(Math.max(target.s * k, 0.15), 6);
      // 커서 아래 점이 제자리에 머물도록 보정
      target.x = sx - (sx - target.x) * (ns / target.s);
      target.y = sy - (sy - target.y) * (ns / target.s);
      target.s = ns;
    };
    const onLeave = () => { hover = null; if (!drag) canvas.style.cursor = 'grab'; };
    const onKey = (e) => { if (e.key === 'Escape' && localRoot) setLocalRoot(null); };
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('dblclick', onDbl);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mouseleave', onLeave);
    window.addEventListener('keydown', onKey);
    const ro = new ResizeObserver(() => { fit(); if (autoFit) fitToGraph(true); });
    ro.observe(canvas);
    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('dblclick', onDbl);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('argo:theme', onTheme);
    };
  }, [docs, agents, showCrew, showOrphans, root, compact, focusRel, localRoot]);

  return (
    <div style={{ position: 'relative', width: '100%', height, minHeight: 0 }}>
      <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block', cursor: 'grab' }} />
      {emptySky && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', pointerEvents: 'none', padding: '0 18px' }}>
          <div>
            {/* 본문은 일반 서체로 — microlabel은 라틴 대문자 계기판 라벨용이라 영어에서 히어로 카피가 9.5px 모노 대문자가 된다(검수 MEDIUM-2) */}
            <div style={{ fontSize: compact ? 12.5 : 15, fontWeight: 600, opacity: 0.78 }}>{t('graph.emptySkyTitle')}</div>
            <div style={{ marginTop: 6, fontSize: compact ? 11 : 12.5, opacity: 0.7, lineHeight: 1.6, whiteSpace: 'pre-line' }}>{t('graph.emptySkyBody')}</div>
            {hiddenOrphans > 0 && (
              <div style={{ marginTop: 5, fontSize: compact ? 10.5 : 11.5, opacity: 0.55 }}>{t('graph.emptySkyOrphans', { n: hiddenOrphans })}</div>
            )}
          </div>
        </div>
      )}
      {!compact && (
        <div style={{ position: 'absolute', top: 10, right: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
          {localRoot && !focusRel && (
            <button className="chip" onClick={() => setLocalRoot(null)} style={{ cursor: 'pointer' }}>{t('graph.backToAll')}</button>
          )}
          <button className={`chip${showCrew ? ' on' : ''}`} onClick={() => setShowCrew((v) => !v)} style={{ cursor: 'pointer', opacity: showCrew ? 1 : 0.7 }}>{t('graph.toggleCrew')}</button>
          <button className={`chip${showOrphans ? ' on' : ''}`} onClick={() => setShowOrphans((v) => !v)} style={{ cursor: 'pointer', opacity: showOrphans ? 1 : 0.7 }}>
            {showOrphans ? t('graph.hideOrphans') : t('graph.showOrphans', { n: hiddenOrphans })}
          </button>
        </div>
      )}
      {!compact && !emptySky && ( /* 빈 하늘엔 조작 힌트가 무의미 — 안내 문구만 남긴다 */
        <span className="microlabel" style={{ position: 'absolute', left: 14, bottom: 10, opacity: 0.7 }}>{t('graph.hint2d')}</span>
      )}
    </div>
  );
}
