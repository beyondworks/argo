'use client';
// 별자리 — 완전한 3D 지식 그래프. 회사(허브)→크루(작성자)→기억(대화·노트)→기억↔기억 [[링크]]
// 전부 실제 관계 엣지다. 3D 포스 시뮬레이션 + 원근 투영 + 잉크 할로, 모달은 드래그 회전·휠 줌.
import { useEffect, useRef, useState } from 'react';
import { useLang } from '../../i18n';

// 캔버스는 CSS 변수를 직접 못 읽으므로 테마 토큰(--ink-rgb/--paper-rgb)을 여기로 동기화한다.
// rAF 루프가 매 프레임 이 값을 읽어 그리므로, 값만 갈아끼우면 다음 프레임부터 테마가 반영된다.
let INK = '37, 39, 30';        // 폴백 = argo --ink-rgb (엣지·라벨 — 구조)
let PAPER = '233, 235, 221';   // 폴백 = argo --paper-rgb (노트 코어 배경)
let ACCENT = '37, 39, 30';     // 폴백 = argo --accent-rgb (노드·할로 — 계기 액센트)
function syncThemeRgb() {
  const s = getComputedStyle(document.documentElement);
  INK = s.getPropertyValue('--ink-rgb').trim() || INK;
  PAPER = s.getPropertyValue('--paper-rgb').trim() || PAPER;
  ACCENT = s.getPropertyValue('--accent-rgb').trim() || ACCENT;
}

/* ─── 그래프 구성 — 실제 연결 관계만 엣지로 ─── */
function buildGraph({ company, agents = [], docs = [], delegations = [] }) {
  const nodes = [];
  const idx = new Map();
  const add = (n) => { idx.set(n.id, nodes.length); nodes.push(n); };

  if (company) add({ id: '@co', type: 'company', label: company.name });
  const teams = [...new Set(agents.map((a) => a.team).filter(Boolean))];
  for (const t of teams) add({ id: `@team:${t}`, type: 'team', label: t });
  for (const a of agents) add({ id: `@ag:${a.slug}`, type: 'agent', label: a.name, slug: a.slug });
  for (const d of docs) {
    add({ id: d.rel.replace(/\.md$/, ''), type: d.dir === 'notes' ? 'note' : 'doc', label: d.title, rel: d.rel });
  }

  const edges = [];
  const E = (a, b) => {
    const i = idx.get(a), j = idx.get(b);
    if (i !== undefined && j !== undefined && i !== j) edges.push([i, j]);
  };
  if (company) for (const t of teams) E('@co', `@team:${t}`);              // 회사 → 팀
  for (const a of agents) {                                                // 팀 → 크루 (팀 없으면 회사 직결)
    if (a.team) E(`@team:${a.team}`, `@ag:${a.slug}`);
    else if (company) E('@co', `@ag:${a.slug}`);
  }
  for (const d of docs) {                                                   // 크루 → 기억 (작성자)
    const slug = d.rel
      .replace(/^(conversations|notes|journal)\//, '')
      .replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, '')
      .replace(/^\d{4}-\d{2}-\d{2}-/, '') // 일지: journal/YYYY-MM-DD-<slug>
      .replace(/\.md$/, '');
    E(`@ag:${slug}`, d.rel.replace(/\.md$/, ''));
  }
  const dseen = new Set();
  for (const g of delegations) {                                            // 크루 ↔ 크루 (위임 실적)
    const id = [g.from, g.to].sort().join('→');
    if (dseen.has(id)) continue;
    dseen.add(id);
    E(`@ag:${g.from}`, `@ag:${g.to}`);
  }
  const seen = new Set();
  for (const d of docs) {                                                   // 기억 ↔ 기억 ([[링크]])
    const from = d.rel.replace(/\.md$/, '');
    for (const l of d.links) {
      const id = [from, l].sort().join('→');
      if (seen.has(id)) continue;
      seen.add(id);
      E(from, l);
    }
  }
  const deg = nodes.map((_, i) => edges.filter(([a, b]) => a === i || b === i).length);
  nodes.forEach((n, i) => { n.deg = deg[i]; });
  return { nodes, edges };
}

/* ─── 3D 포스 시뮬레이션 ─── */
function createSim({ nodes, edges }) {
  const pts = nodes.map((n, i) => {
    if (n.type === 'company') return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
    // 피보나치 구 + 지터로 초기 배치
    const N = Math.max(nodes.length - 1, 1);
    const y = 1 - ((i % N) / N) * 2;
    const r = Math.sqrt(Math.max(1 - y * y, 0.05));
    const th = i * 2.39996;
    const R = 90 + (i % 3) * 25;
    return {
      x: Math.cos(th) * r * R, y: y * R * 0.9, z: Math.sin(th) * r * R,
      vx: 0, vy: 0, vz: 0,
    };
  });
  const tick = () => {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      for (let j = i + 1; j < pts.length; j++) {
        const b = pts[j];
        let dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
        let d2 = dx * dx + dy * dy + dz * dz || 1;
        const f = 5200 / d2;
        const d = Math.sqrt(d2);
        dx /= d; dy /= d; dz /= d;
        a.vx += dx * f; a.vy += dy * f; a.vz += dz * f;
        b.vx -= dx * f; b.vy -= dy * f; b.vz -= dz * f;
      }
      a.vx -= a.x * 0.003; a.vy -= a.y * 0.003; a.vz -= a.z * 0.003;
    }
    for (const [i, j] of edges) {
      const a = pts[i], b = pts[j];
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      const f = (d - 85) * 0.014;
      a.vx += (dx / d) * f; a.vy += (dy / d) * f; a.vz += (dz / d) * f;
      b.vx -= (dx / d) * f; b.vy -= (dy / d) * f; b.vz -= (dz / d) * f;
    }
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (nodes[i].type === 'company') { p.x = p.y = p.z = 0; continue; } // 허브 고정
      p.vx *= 0.8; p.vy *= 0.8; p.vz *= 0.8;
      p.x += p.vx; p.y += p.vy; p.z += p.vz;
    }
  };
  for (let k = 0; k < 120; k++) tick(); // 워밍업 — 첫 프레임부터 자리 잡힌 상태
  return { pts, tick };
}

/* ─── 공용 렌더러 — 회전·투영·잉크 할로 ─── */
function makeRenderer(canvas, graph, sim, opts) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W = 0, H = 0;
  const fit = () => {
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  fit();

  const view = { rotY: 0.5, rotX: 0.28, zoom: opts.zoom ?? 1 };
  const project = (p) => {
    const cy = Math.cos(view.rotY), sy = Math.sin(view.rotY);
    let x = p.x * cy + p.z * sy;
    let z = -p.x * sy + p.z * cy;
    const cx = Math.cos(view.rotX), sx = Math.sin(view.rotX);
    let y = p.y * cx - z * sx;
    z = p.y * sx + z * cx;
    const f = 460;
    const k = f / (f + z + 260);
    const base = (Math.min(W, H) / 320) * view.zoom;
    return { x: W / 2 + x * k * base * 1.5, y: H / 2 + y * k * base * 1.5, k, z };
  };

  const R_BY_TYPE = { company: 8, team: 6, agent: 5.5, doc: 4, note: 4 };

  const draw = (hover) => {
    ctx.clearRect(0, 0, W, H);
    const P = sim.pts.map(project);

    // 엣지 — 깊이 페이드, 호버 시 연결 추적 하이라이트
    for (const [i, j] of graph.edges) {
      const a = P[i], b = P[j];
      const k = (a.k + b.k) / 2;
      const hi = hover !== null && (i === hover || j === hover);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = `rgba(${INK}, ${hi ? 0.85 : 0.1 + 0.3 * k * k})`;
      ctx.lineWidth = hi ? 1.6 : 0.8 + 0.5 * k;
      ctx.stroke();
    }

    // 노드 — 뒤에서 앞 순서로 (깊이 정렬), 할로 글로우 + 코어
    const order = P.map((q, i) => [q.z, i]).sort((a, b) => b[0] - a[0]);
    for (const [, i] of order) {
      const n = graph.nodes[i];
      const q = P[i];
      const r = (R_BY_TYPE[n.type] + Math.min(n.deg, 6) * 0.35) * q.k * (opts.mini ? 0.8 : 1) * Math.min(view.zoom, 1.4);
      const hi = hover === i;
      const alpha = 0.3 + 0.7 * q.k;

      // 액센트 할로 (레퍼런스의 글로우를 테마 액센트 톤으로)
      ctx.beginPath(); ctx.arc(q.x, q.y, r * 3, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${ACCENT}, ${(hi ? 0.16 : 0.06) * q.k})`; ctx.fill();
      ctx.beginPath(); ctx.arc(q.x, q.y, r * 1.8, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${ACCENT}, ${(hi ? 0.28 : 0.12) * q.k})`; ctx.fill();

      // 코어
      ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
      if (n.type === 'note') {
        ctx.fillStyle = `rgba(${PAPER}, 0.95)`; ctx.fill();
        ctx.strokeStyle = `rgba(${ACCENT}, ${alpha})`; ctx.lineWidth = 1.4; ctx.stroke();
      } else if (n.type === 'company') {
        ctx.fillStyle = `rgba(${ACCENT}, ${alpha})`; ctx.fill();
        ctx.beginPath(); ctx.arc(q.x, q.y, r + 3.5, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${ACCENT}, ${0.5 * q.k})`; ctx.lineWidth = 1; ctx.setLineDash([2, 3]); ctx.stroke(); ctx.setLineDash([]);
      } else {
        ctx.fillStyle = `rgba(${ACCENT}, ${alpha})`; ctx.fill();
      }
      if (hi) {
        ctx.beginPath(); ctx.arc(q.x, q.y, r + 6, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${ACCENT}, 0.6)`; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
      }

      // 라벨 — 회사·크루는 항상, 기억은 호버 시 (미니는 호버 없음)
      if (!opts.mini && (n.type === 'company' || n.type === 'team' || n.type === 'agent' || hi)) {
        const t = n.label.length > 24 ? `${n.label.slice(0, 24)}…` : n.label;
        ctx.font = `${hi || n.type === 'company' ? 600 : 400} ${n.type === 'company' ? 11.5 : 10.5}px "IBM Plex Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.fillStyle = `rgba(${INK}, ${hi ? 0.95 : 0.4 + 0.4 * q.k})`;
        ctx.fillText(t, q.x, q.y + r + 15);
      }
    }
    return P;
  };

  return { ctx, view, project, draw, fit, getSize: () => ({ W, H }) };
}

/* ─── 미니 3D 별자리 ─── */
export function Constellation3D({ company, agents, docs, delegations, height = 200, onOpen }) {
  const { t } = useLang();
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !docs) return;
    syncThemeRgb();
    window.addEventListener('argo:theme', syncThemeRgb);
    const graph = buildGraph({ company, agents, docs, delegations });
    if (graph.nodes.length === 0) return () => window.removeEventListener('argo:theme', syncThemeRgb);
    const sim = createSim(graph);
    const r = makeRenderer(canvas, graph, sim, { mini: true, zoom: 0.92 });

    let speed = 0.004, targetSpeed = 0.004, targetTilt = 0.28;
    const onMove = (e) => {
      const b = canvas.getBoundingClientRect();
      targetSpeed = 0.004 + ((e.clientX - b.left) / b.width - 0.5) * 0.014;
      targetTilt = 0.28 + ((e.clientY - b.top) / b.height - 0.5) * 0.6;
    };
    const onLeave = () => { targetSpeed = 0.004; targetTilt = 0.28; };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);

    let raf;
    const frame = () => {
      sim.tick();
      speed += (targetSpeed - speed) * 0.05;
      r.view.rotY += speed;
      r.view.rotX += (targetTilt - r.view.rotX) * 0.05;
      r.draw(null);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const ro = new ResizeObserver(r.fit);
    ro.observe(canvas);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('argo:theme', syncThemeRgb);
    };
  }, [company, agents, docs, delegations]);

  return (
    <canvas
      ref={ref}
      onClick={onOpen}
      style={{ width: '100%', height, display: 'block', cursor: 'zoom-in' }}
      title={t('graph.clickToEnlarge')}
    />
  );
}

/* ─── 전체화면 3D 그래프 — 드래그 회전 · 휠 줌 · 노드 클릭 = 열기 ─── */
export function GraphModal({ company, agents, docs, delegations, onClose, onSelect }) {
  const { t } = useLang();
  const ref = useRef(null);
  const [hoverLabel, setHoverLabel] = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !docs) return;
    syncThemeRgb();
    const graph = buildGraph({ company, agents, docs, delegations });
    const sim = createSim(graph);
    const r = makeRenderer(canvas, graph, sim, { mini: false, zoom: 1.3 });

    let hover = null, dragging = false, moved = 0, px = 0, py = 0;
    let idleAt = 0; // 마지막 조작 시각 — 잠시 후 자동 회전 재개
    let P = [];

    const pick = (sx, sy) => {
      let best = null, bd = 16;
      P.forEach((q, i) => {
        const d = Math.hypot(q.x - sx, q.y - sy);
        if (d < bd) { bd = d; best = i; }
      });
      return best;
    };
    const pos = (e) => {
      const b = canvas.getBoundingClientRect();
      return [e.clientX - b.left, e.clientY - b.top];
    };

    const down = (e) => { [px, py] = pos(e); dragging = true; moved = 0; idleAt = performance.now(); };
    const move = (e) => {
      const [sx, sy] = pos(e);
      if (dragging) {
        r.view.rotY += (sx - px) * 0.006;
        r.view.rotX = Math.min(Math.max(r.view.rotX + (sy - py) * 0.004, -1.3), 1.3);
        moved += Math.hypot(sx - px, sy - py);
        idleAt = performance.now();
      } else {
        hover = pick(sx, sy);
        const n = hover !== null ? graph.nodes[hover] : null;
        setHoverLabel(n ? n.label : '');
        canvas.style.cursor = n && n.rel ? 'pointer' : 'grab';
      }
      px = sx; py = sy;
    };
    const up = (e) => {
      if (dragging && moved < 5) {
        const [sx, sy] = pos(e);
        const i = pick(sx, sy);
        const n = i !== null ? graph.nodes[i] : null;
        if (n?.rel) onSelect(n.rel);
      }
      dragging = false;
    };
    const wheel = (e) => {
      e.preventDefault();
      r.view.zoom = Math.min(Math.max(r.view.zoom * Math.exp(-e.deltaY * 0.0012), 0.45), 3);
      idleAt = performance.now();
    };
    canvas.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    canvas.addEventListener('wheel', wheel, { passive: false });

    let raf;
    const frame = (t) => {
      sim.tick();
      if (!dragging && t - idleAt > 2600) r.view.rotY += 0.0022; // 유휴 시 자동 회전
      P = r.draw(hover);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const ro = new ResizeObserver(r.fit);
    ro.observe(canvas);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('mousedown', down);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      canvas.removeEventListener('wheel', wheel);
    };
  }, [company, agents, docs, delegations, onSelect]);

  const conv = docs?.filter((d) => d.dir !== 'notes').length ?? 0;
  const notes = docs?.filter((d) => d.dir === 'notes').length ?? 0;

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}
      className="fade-up"
    >
      <div className="topbar" style={{ flex: 'none' }}>
        <span className="topbar-title">{t('graph.title')}</span>
        <span className="microlabel" style={{ marginLeft: 4 }}>Constellation 3D</span>
        <div style={{ flex: 1 }} />
        <span className="chip"><span className="dot" />{t('graph.hubCrew', { n: 1 + (agents?.length ?? 0) })}</span>
        <span className="chip"><span className="dot" />{t('graph.conversation', { n: conv })}</span>
        <span className="chip"><span style={{ width: 5, height: 5, borderRadius: 999, border: '1px solid currentColor' }} />{t('graph.note', { n: notes })}</span>
        <span className="chip">{t('graph.controlsHint')}</span>
        <button className="btn sm" onClick={onClose}>{t('graph.closeEsc')}</button>
      </div>
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block', cursor: 'grab' }} />
        {hoverLabel && (
          <span className="chip" style={{ position: 'absolute', left: 20, bottom: 18, background: 'var(--card)' }}>{hoverLabel}</span>
        )}
      </div>
    </div>
  );
}
