'use client';
// 기억 그래프 2D — 옵시디언식(유건 지시 2026-08-21: "3D 별자리는 데크 위젯에만, 기억 페이지는 2D").
// 기본은 **[[링크]] 엣지만** 그린다 — 크루(작성자)→기억 계층 엣지는 크루 11명이 기억 2천 건의 허브가
// 되어 폭죽 모양으로 지식 구조를 덮었다(실측). 계층은 토글, 링크 없는 고아 기억도 토글(기본 숨김).
// 인터랙션은 전부 이징으로 — 줌·팬·호버 점등·포커스 전환이 프레임마다 목표값으로 수렴한다
// ("부드럽고 감각적" — 유건 기준). 노드 드래그는 시뮬을 잠깐 재가열해 이웃이 따라 움직인다.
import { useEffect, useRef, useState } from 'react';
import { useLang } from '../../i18n';

let INK = '37, 39, 30', PAPER = '233, 235, 221', ACCENT = '37, 39, 30';
function syncThemeRgb() {
  const s = getComputedStyle(document.documentElement);
  INK = s.getPropertyValue('--ink-rgb').trim() || INK;
  PAPER = s.getPropertyValue('--paper-rgb').trim() || PAPER;
  ACCENT = s.getPropertyValue('--accent-rgb').trim() || ACCENT;
}

const stem = (rel) => rel.replace(/\.md$/, '');
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

/** 2D 포스 — 반발(노드 수 비례 상수) + 스프링 + 중심 인력. 수렴하면 멈추고, 드래그 시 재가열. */
function createSim2D({ nodes, edges }) {
  const N = nodes.length;
  const pts = nodes.map((_, i) => {
    const a = i * 2.39996, r = 18 * Math.sqrt(i + 1);
    return { x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0, pinned: false };
  });
  const REP = 1400 * Math.min(1, Math.max(0.2, N / 200));
  const LEN = 46;
  const adj = nodes.map(() => []);
  for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }
  // 격자 해시로 반발 근사 — 2천 노드 N²(4백만/틱)를 피한다. 셀 너비 = 반발이 무시되는 거리.
  const CELL = 140;
  const tick = () => {
    const grid = new Map();
    for (let i = 0; i < N; i++) {
      const p = pts[i];
      const k = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`;
      (grid.get(k) ?? grid.set(k, []).get(k)).push(i);
    }
    for (let i = 0; i < N; i++) {
      const a = pts[i];
      const cx = Math.floor(a.x / CELL), cy = Math.floor(a.y / CELL);
      for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const cell = grid.get(`${gx},${gy}`);
        if (!cell) continue;
        for (const j of cell) {
          if (j <= i) continue;
          const b = pts[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 > CELL * CELL) continue;
          if (d2 < 1) { dx = (Math.random() - 0.5); dy = (Math.random() - 0.5); d2 = 1; }
          const f = REP / d2;
          const d = Math.sqrt(d2);
          dx /= d; dy /= d;
          a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
        }
      }
      a.vx -= a.x * 0.0025; a.vy -= a.y * 0.0025;
    }
    for (const [i, j] of edges) {
      const a = pts[i], b = pts[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - LEN) * 0.02;
      a.vx += (dx / d) * f; a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    let energy = 0;
    for (const p of pts) {
      if (p.pinned) { p.vx = p.vy = 0; continue; }
      p.vx *= 0.82; p.vy *= 0.82;
      p.x += p.vx; p.y += p.vy;
      energy += p.vx * p.vx + p.vy * p.vy;
    }
    return energy / Math.max(N, 1);
  };
  for (let k = 0; k < 160; k++) tick();
  return { pts, tick, adj };
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
    syncThemeRgb();
    window.addEventListener('argo:theme', syncThemeRgb);
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
      return () => window.removeEventListener('argo:theme', syncThemeRgb);
    }
    const sim = createSim2D(graph);
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0, H = 0;
    const fit = () => { W = canvas.clientWidth; H = canvas.clientHeight; canvas.width = W * dpr; canvas.height = H * dpr; };
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
    let settle = 0, energy = 1;
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
    const hubs = new Set(degSorted.slice(0, compact ? 4 : 14));

    const draw = () => {
      // 이징 — 줌·팬
      view.x += (target.x - view.x) * 0.12; view.y += (target.y - view.y) * 0.12; view.s += (target.s - view.s) * 0.12;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const nb = hover !== null ? sim.adj[hover] : null;
      const nbSet = nb ? new Set(nb) : null;
      const anyFocus = hover !== null;
      for (let i = 0; i < focus.length; i++) {
        const want = !anyFocus ? 1 : (i === hover || nbSet.has(i)) ? 1 : 0.12;
        focus[i] += (want - focus[i]) * 0.18;
      }
      const P = sim.pts.map(toScreen);
      // 엣지 — 옅게, 호버 이웃만 액센트. 한 경로에 모아 stroke 2회.
      const base = new Path2D(), hi = new Path2D();
      for (const [a, b] of graph.edges) {
        const A = P[a], B = P[b];
        const isHi = anyFocus && (a === hover || b === hover);
        const path = isHi ? hi : base;
        path.moveTo(A.x, A.y); path.lineTo(B.x, B.y);
      }
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = `rgba(${INK}, ${anyFocus ? 0.05 : 0.13})`;
      ctx.stroke(base);
      if (anyFocus) { ctx.lineWidth = 1.2; ctx.strokeStyle = `rgba(${ACCENT}, 0.85)`; ctx.stroke(hi); }
      // 노드 — 평면 원 + 포커스 시 글로우. fillStyle은 타입별 3종만 세팅(노드마다 파싱 금지).
      const rs = Math.min(Math.max(view.s, 0.6), 2.4);
      const groups = { note: new Path2D(), doc: new Path2D(), agent: new Path2D() };
      const glows = [];
      for (let i = 0; i < graph.nodes.length; i++) {
        const n = graph.nodes[i], q = P[i];
        const r = nodeRadius(n) * rs;
        const f = focus[i];
        if (f > 0.5 && anyFocus) { glows.push([q, r, f]); continue; }
        if (i === rootIdx) { glows.push([q, r, 1]); continue; }
        groups[n.type].moveTo(q.x + r, q.y); groups[n.type].arc(q.x, q.y, r, 0, Math.PI * 2);
      }
      const dim = anyFocus ? 0.18 : 1;
      ctx.fillStyle = `rgba(${ACCENT}, ${0.9 * dim})`; ctx.fill(groups.note);
      ctx.fillStyle = `rgba(${INK}, ${0.55 * dim})`; ctx.fill(groups.doc);
      ctx.fillStyle = `rgba(${PAPER}, ${0.95 * dim})`; ctx.fill(groups.agent);
      ctx.lineWidth = 1.2; ctx.strokeStyle = `rgba(${ACCENT}, ${0.9 * dim})`; ctx.stroke(groups.agent);
      for (const [q, r, f] of glows) {
        const g = ctx.createRadialGradient(q.x, q.y, r * 0.5, q.x, q.y, r * 3.2);
        g.addColorStop(0, `rgba(${ACCENT}, ${0.45 * f})`); g.addColorStop(1, `rgba(${ACCENT}, 0)`);
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(q.x, q.y, r * 3.2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(${ACCENT}, ${0.95 * f})`; ctx.beginPath(); ctx.arc(q.x, q.y, r * 1.15, 0, Math.PI * 2); ctx.fill();
      }
      // 라벨
      ctx.textAlign = 'center';
      for (let i = 0; i < graph.nodes.length; i++) {
        const n = graph.nodes[i];
        const isHover = i === hover, isNb = nbSet?.has(i);
        const show = isHover || isNb || i === rootIdx || (!anyFocus && (hubs.has(i) || view.s > 1.7)) || (anyFocus && false);
        if (!show) continue;
        const q = P[i], r = nodeRadius(n) * rs;
        const txt = n.label.length > 28 ? `${n.label.slice(0, 28)}…` : n.label;
        ctx.font = `${isHover || i === rootIdx ? 600 : 400} ${compact ? 10 : 11}px "IBM Plex Mono", monospace`;
        const a = isHover || isNb || i === rootIdx ? 0.95 : Math.min(0.75, 0.35 + (view.s - 1) * 0.4);
        ctx.fillStyle = `rgba(${INK}, ${a * (anyFocus && !isHover && !isNb ? 0.3 : 1)})`;
        ctx.fillText(txt, q.x, q.y + r + 12);
      }
    };

    let raf;
    const frame = () => {
      if (energy > 0.002 || settle < 30) { energy = sim.tick(); settle++; }
      if (autoFit && settle % 6 === 0) fitToGraph(true);
      draw();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const onDown = (e) => {
      const b = canvas.getBoundingClientRect();
      const sx = e.clientX - b.left, sy = e.clientY - b.top;
      const i = pick(sx, sy);
      downAt = { sx, sy }; moved = false;
      if (i !== null) { drag = i; sim.pts[i].pinned = true; canvas.style.cursor = 'grabbing'; }
      else panning = { sx, sy, vx: view.x, vy: view.y };
    };
    const onMove = (e) => {
      const b = canvas.getBoundingClientRect();
      const sx = e.clientX - b.left, sy = e.clientY - b.top;
      if (downAt && Math.hypot(sx - downAt.sx, sy - downAt.sy) > 3) moved = true;
      if (drag !== null) {
        const w = toWorld(sx, sy);
        sim.pts[drag].x = w.x; sim.pts[drag].y = w.y;
        energy = 1; settle = 0; autoFit = false; // 재가열 — 이웃이 따라 움직인다
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
        sim.pts[i].pinned = false; // 놓으면 다시 흐른다(고정하고 싶으면 더블클릭으로 로컬 그래프)
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
      window.removeEventListener('argo:theme', syncThemeRgb);
    };
  }, [docs, agents, showCrew, showOrphans, root, compact, focusRel, localRoot]);

  return (
    <div style={{ position: 'relative', width: '100%', height, minHeight: 0 }}>
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
