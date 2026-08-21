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
export { buildGraph2D };

// 성도(星圖) 팔레트 — 테마와 무관한 Argo 고유 표면(유건 승인 2026-08-21 시안 "밤바다 성도").
// 밤바다 네이비 위에 허브 기억 = 골드 별(십자 빛살), 일반 기억 = 은청색 별, 크루 = 다이아몬드.
const NIGHT = '#0b1220', NIGHT_2 = '#13203a';
const GOLD = '216, 184, 94', STAR = '143, 165, 200', PAPER = '233, 228, 210', LABEL_GOLD = '239, 227, 184';
const SERIF = '"Iowan Old Style", "Noto Serif KR", Georgia, serif';

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
export function Graph2D({ docs, agents = [], onSelectDoc, focusRel = null, compact = false, height = '100%' }) {
  const { t } = useLang();
  const ref = useRef(null);
  const cb = useRef({}); cb.current = { onSelectDoc };
  const [showCrew, setShowCrew] = useState(false);
  const [showOrphans, setShowOrphans] = useState(false);
  const [hiddenOrphans, setHiddenOrphans] = useState(0);
  const [localRoot, setLocalRoot] = useState(null); // 더블클릭 로컬 그래프(깊이 2) — ESC로 복귀
  const root = focusRel ? stem(focusRel) : localRoot;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !docs) return;
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
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return undefined;
    }
    const sim = createSim2D(graph);
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0, H = 0;
    let dust = [];
    const fit = () => {
      W = canvas.clientWidth; H = canvas.clientHeight; canvas.width = W * dpr; canvas.height = H * dpr;
      // 별먼지 — 화면 좌표에 고정(줌·팬에 안 따라온다: 먼 배경). 결정적 난수라 리사이즈마다 같은 하늘.
      let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const n = compact ? 60 : Math.round((W * H) / 2600);
      dust = Array.from({ length: n }, () => ({ x: rnd() * W, y: rnd() * H, r: rnd() < 0.1 ? 1.1 : 0.6, a: 0.08 + rnd() * 0.25 }));
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

    const nodeRadius = (n) => (compact ? 2.2 : 2.6) + Math.log2(1 + n.deg) * (compact ? 1.4 : 1.9) + (n.type === 'agent' ? 2 : 0);
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
      // 밤바다 — 중심이 살짝 밝은 네이비
      const sky = ctx.createRadialGradient(W * 0.62, H * 0.48, 0, W * 0.62, H * 0.48, Math.max(W, H) * 0.8);
      sky.addColorStop(0, NIGHT_2); sky.addColorStop(1, NIGHT);
      ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
      for (const d of dust) { ctx.fillStyle = `rgba(${PAPER}, ${d.a})`; ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill(); }
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
        ctx.setLineDash([2, 6]); ctx.lineWidth = 1; ctx.strokeStyle = `rgba(${GOLD}, 0.12)`;
        for (const rr of [90, 180, 290]) { ctx.beginPath(); ctx.arc(c.x, c.y, rr * view.s, 0, Math.PI * 2); ctx.stroke(); }
        ctx.setLineDash([]); ctx.strokeStyle = `rgba(${GOLD}, 0.16)`;
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
      const dimE = anyFocus ? 0.35 : 1;
      ctx.setLineDash(dashed ? [3, 5] : []); ctx.lineWidth = 0.7; ctx.strokeStyle = `rgba(${STAR}, ${0.32 * dimE})`; ctx.stroke(twig);
      ctx.setLineDash(dashed ? [1, 5] : []); ctx.strokeStyle = `rgba(${PAPER}, ${0.25 * dimE})`; ctx.stroke(crewE);
      ctx.setLineDash([]); ctx.lineWidth = 1.1; ctx.strokeStyle = `rgba(${GOLD}, ${0.55 * dimE})`; ctx.stroke(spine);
      if (anyFocus) { ctx.lineWidth = 1.2; ctx.strokeStyle = `rgba(${GOLD}, 0.9)`; ctx.stroke(hi); }
      // 노드 — 일반 기억은 한 경로로, 허브·크루·포커스는 개별
      const rs = Math.min(Math.max(view.s, 0.6), 2.4);
      const plain = new Path2D();
      const specials = [];
      const off = (q) => q.x < -24 || q.x > W + 24 || q.y < -24 || q.y > H + 24; // 뷰포트 컬링
      for (let i = 0; i < graph.nodes.length; i++) {
        const n = graph.nodes[i], q = P[i];
        if (off(q)) continue;
        const r = nodeRadius(n) * rs;
        const f = focus[i];
        if (n.type === 'agent' || hubs.has(i) || i === rootIdx || (anyFocus && f > 0.5)) { specials.push([i, q, r, f]); continue; }
        plain.moveTo(q.x + r, q.y); plain.arc(q.x, q.y, r, 0, Math.PI * 2);
      }
      const dim = anyFocus ? 0.22 : 1;
      ctx.fillStyle = `rgba(${STAR}, ${0.85 * dim})`; ctx.fill(plain);
      for (const [i, q, r, f] of specials) {
        const n = graph.nodes[i];
        const a = anyFocus ? Math.max(f, 0.22) : 1;
        if (n.type === 'agent') { // 크루 = 다이아몬드 표식(별과 모양으로 구분 — 색을 더 안 쓴다)
          ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(Math.PI / 4);
          ctx.fillStyle = `rgba(${PAPER}, ${0.95 * a})`; ctx.fillRect(-r * 0.9, -r * 0.9, r * 1.8, r * 1.8); ctx.restore();
          continue;
        }
        const isRoot = i === rootIdx;
        const big = isRoot || hubs.has(i);
        if (big || (anyFocus && f > 0.5)) { // 골드 별 — 헤일로 + 링 + 십자 빛살
          const g = ctx.createRadialGradient(q.x, q.y, r * 0.5, q.x, q.y, r * 3.2);
          g.addColorStop(0, `rgba(${GOLD}, ${0.22 * a})`); g.addColorStop(1, `rgba(${GOLD}, 0)`);
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(q.x, q.y, r * 3.2, 0, Math.PI * 2); ctx.fill();
          ctx.lineWidth = 0.8; ctx.strokeStyle = `rgba(${GOLD}, ${0.45 * a})`; ctx.beginPath(); ctx.arc(q.x, q.y, r * 2.1, 0, Math.PI * 2); ctx.stroke();
          const L = r * (isRoot ? 3 : 2.6);
          ctx.lineWidth = 1; ctx.strokeStyle = `rgba(${GOLD}, ${0.9 * a})`;
          ctx.beginPath(); ctx.moveTo(q.x - L, q.y); ctx.lineTo(q.x + L, q.y); ctx.moveTo(q.x, q.y - L); ctx.lineTo(q.x, q.y + L); ctx.stroke();
          ctx.fillStyle = `rgba(${GOLD}, ${0.95 * a})`;
        } else ctx.fillStyle = `rgba(${STAR}, ${0.85 * a})`;
        ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.fill();
      }
      // 라벨 — 성도의 별 이름처럼 세리프. compact는 중심·호버만, 같은 제목 허브는 프레임당 한 번.
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const drawn = new Set();
      for (let i = 0; i < graph.nodes.length; i++) {
        const n = graph.nodes[i];
        const isHover = i === hover, isNb = !compact && nbSet?.has(i);
        const show = isHover || isNb || i === rootIdx || (!compact && !anyFocus && (hubs.has(i) || view.s > 1.7));
        if (!show) continue;
        if (!isHover && i !== rootIdx) { if (drawn.has(n.label)) continue; drawn.add(n.label); }
        const q = P[i], r = nodeRadius(n) * rs;
        if (off(q)) continue;
        const txt = n.label.length > 28 ? `${n.label.slice(0, 28)}…` : n.label;
        const em = isHover || i === rootIdx;
        ctx.font = `500 ${compact ? 10.5 : em ? 15 : 13}px ${SERIF}`;
        const a = em || isNb ? 0.95 : Math.min(0.8, 0.45 + (view.s - 1) * 0.4);
        const col = n.type === 'agent' ? PAPER : (hubs.has(i) || em) ? LABEL_GOLD : STAR;
        ctx.fillStyle = `rgba(${col}, ${a * (anyFocus && !isHover && !isNb ? 0.3 : 1)})`;
        ctx.fillText(txt, q.x + r * 2.6 + 6, q.y + 1);
        if (!compact && !anyFocus && hubs.has(i) && !em) { // 허브엔 연결 수 한 줄
          ctx.font = `10.5px ${SERIF}`; ctx.fillStyle = `rgba(${STAR}, 0.7)`;
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

    const onDown = (e) => {
      const b = canvas.getBoundingClientRect();
      const sx = e.clientX - b.left, sy = e.clientY - b.top;
      const i = pick(sx, sy);
      downAt = { sx, sy }; moved = false;
      if (i !== null) { drag = i; sim.pts[i].fx = sim.pts[i].x; sim.pts[i].fy = sim.pts[i].y; canvas.style.cursor = 'grabbing'; }
      else panning = { sx, sy, vx: view.x, vy: view.y };
    };
    const onMove = (e) => {
      const b = canvas.getBoundingClientRect();
      const sx = e.clientX - b.left, sy = e.clientY - b.top;
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
      const b = canvas.getBoundingClientRect();
      const i = pick(e.clientX - b.left, e.clientY - b.top);
      if (i !== null && !focusRel) setLocalRoot(graph.nodes[i].id);
    };
    const onWheel = (e) => {
      e.preventDefault();
      autoFit = false;
      const b = canvas.getBoundingClientRect();
      const sx = e.clientX - b.left, sy = e.clientY - b.top;
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
    };
  }, [docs, agents, showCrew, showOrphans, root, compact, focusRel, localRoot]);

  return (
    <div className="argo-sky" style={{ position: 'relative', width: '100%', height, minHeight: 0, background: NIGHT, borderRadius: compact ? 12 : 0, overflow: 'hidden' }}>
      <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block', cursor: 'grab' }} />
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
      {!compact && (
        <span className="microlabel" style={{ position: 'absolute', left: 14, bottom: 10, opacity: 0.7 }}>{t('graph.hint2d')}</span>
      )}
    </div>
  );
}
