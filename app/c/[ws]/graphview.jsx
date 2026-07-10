'use client';
// 별자리 3D + 전체화면 그래프 — 잉크 온 페이퍼 톤의 기억 시각화.
// Constellation3D: 기억 노드가 3D 점구름으로 회전(더스트 파티클 + 마우스 틸트).
// GraphModal: 옵시디언식 포스 그래프 — 줌·팬·노드 드래그·클릭 이동.
import { useEffect, useRef, useState } from 'react';

const INK = '37, 39, 30'; // --fg #25271e

function buildEdges(docs) {
  const byKey = new Map(docs.map((d, i) => [d.rel.replace(/\.md$/, ''), i]));
  const edges = [];
  const seen = new Set();
  docs.forEach((d, i) => {
    for (const l of d.links) {
      const j = byKey.get(l);
      if (j === undefined || j === i) continue;
      const id = [i, j].sort((a, b) => a - b).join('-');
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push([i, j]);
    }
  });
  return edges;
}

/* ─── 미니 3D 별자리 ─── */
export function Constellation3D({ docs, height = 190, onOpen }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!docs || docs.length === 0) return;
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let W = 0, H = 0;
    const fit = () => {
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();

    // 기억 노드 — 피보나치 구 분포
    const N = docs.length;
    const nodes = docs.map((d, i) => {
      const y = N === 1 ? 0 : 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(Math.max(1 - y * y, 0));
      const th = i * 2.39996;
      return { x: Math.cos(th) * r, y: y * 0.8, z: Math.sin(th) * r, note: d.dir === 'notes' };
    });
    const edges = buildEdges(docs);

    // 더스트 — 구름 질감용 미세 잉크 입자 (결정적 의사난수 — 리렌더에도 동일)
    let seed = 7;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const dust = Array.from({ length: 130 }, () => {
      const u = rand() * 2 - 1;
      const th = rand() * Math.PI * 2;
      const rr = 0.55 + rand() * 0.65;
      const r = Math.sqrt(1 - u * u) * rr;
      return { x: Math.cos(th) * r, y: u * rr * 0.85, z: Math.sin(th) * r, s: 0.5 + rand() * 0.9 };
    });

    let rotY = 0.6, tiltX = 0.12;
    let targetTilt = 0.12, targetSpeed = 0.0035, speed = 0.0035;
    const onMove = (e) => {
      const b = canvas.getBoundingClientRect();
      const nx = (e.clientX - b.left) / b.width - 0.5;
      const ny = (e.clientY - b.top) / b.height - 0.5;
      targetSpeed = 0.0035 + nx * 0.012; // 좌우 = 회전 속도·방향
      targetTilt = 0.12 + ny * 0.5;      // 상하 = 기울기
    };
    const onLeave = () => { targetSpeed = 0.0035; targetTilt = 0.12; };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);

    const project = (p) => {
      const c = Math.cos(rotY), s = Math.sin(rotY);
      let x = p.x * c + p.z * s;
      let z = -p.x * s + p.z * c;
      const ct = Math.cos(tiltX), st = Math.sin(tiltX);
      let y = p.y * ct - z * st;
      z = p.y * st + z * ct;
      const f = 3.2;
      const k = f / (f + z);
      const R = Math.min(W, H) * 0.42;
      return { x: W / 2 + x * k * R, y: H / 2 + y * k * R, k, z };
    };

    let raf;
    const frame = () => {
      speed += (targetSpeed - speed) * 0.05;
      tiltX += (targetTilt - tiltX) * 0.05;
      rotY += speed;
      ctx.clearRect(0, 0, W, H);

      // 더스트
      for (const d of dust) {
        const q = project(d);
        ctx.beginPath();
        ctx.arc(q.x, q.y, d.s * q.k, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${INK}, ${0.07 + 0.13 * q.k * q.k})`;
        ctx.fill();
      }
      // 링크 선
      const P = nodes.map(project);
      for (const [a, b] of edges) {
        const ka = (P[a].k + P[b].k) / 2;
        ctx.beginPath();
        ctx.moveTo(P[a].x, P[a].y);
        ctx.lineTo(P[b].x, P[b].y);
        ctx.strokeStyle = `rgba(${INK}, ${0.12 + 0.3 * ka * ka})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      // 기억 노드
      nodes.forEach((n, i) => {
        const q = P[i];
        const r = 2 + 2.4 * q.k;
        ctx.beginPath();
        ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
        if (n.note) {
          ctx.fillStyle = 'rgba(233, 235, 221, 0.9)';
          ctx.fill();
          ctx.strokeStyle = `rgba(${INK}, ${0.35 + 0.65 * q.k})`;
          ctx.lineWidth = 1.3;
          ctx.stroke();
        } else {
          ctx.fillStyle = `rgba(${INK}, ${0.35 + 0.65 * q.k})`;
          ctx.fill();
        }
      });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const ro = new ResizeObserver(fit);
    ro.observe(canvas);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
    };
  }, [docs]);

  if (!docs) return null;
  return (
    <canvas
      ref={ref}
      onClick={onOpen}
      style={{ width: '100%', height, display: 'block', cursor: 'zoom-in' }}
      title="클릭하면 크게 봅니다"
    />
  );
}

/* ─── 전체화면 포스 그래프 (옵시디언식) ─── */
export function GraphModal({ docs, onClose, onSelect }) {
  const ref = useRef(null);
  const [hoverTitle, setHoverTitle] = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !docs) return;
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0, H = 0;
    const fit = () => {
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();

    const edges = buildEdges(docs);
    const deg = docs.map((_, i) => edges.filter(([a, b]) => a === i || b === i).length);
    const nodes = docs.map((d, i) => {
      const th = i * 2.39996;
      const r = 60 + 40 * Math.sqrt(i);
      return {
        x: Math.cos(th) * r, y: Math.sin(th) * r, vx: 0, vy: 0,
        rel: d.rel, title: d.title, note: d.dir === 'notes', deg: deg[i],
      };
    });

    // 노드가 적을수록 초기 줌을 키워 화면을 채운다
    let scale = Math.min(Math.max(2.1 - docs.length * 0.09, 0.7), 1.7);
    let ox = 0, oy = 0; // 뷰 변환 (월드→화면: 화면중심 + (p+o)*scale)
    const toScreen = (p) => ({ x: W / 2 + (p.x + ox) * scale, y: H / 2 + (p.y + oy) * scale });
    const toWorld = (sx, sy) => ({ x: (sx - W / 2) / scale - ox, y: (sy - H / 2) / scale - oy });

    let dragNode = null, panning = false, moved = 0;
    let px = 0, py = 0, hover = null;

    const pick = (sx, sy) => {
      const w = toWorld(sx, sy);
      let best = null, bd = 14 / scale;
      for (const n of nodes) {
        const d = Math.hypot(n.x - w.x, n.y - w.y);
        if (d < bd) { bd = d; best = n; }
      }
      return best;
    };

    const down = (e) => {
      const b = canvas.getBoundingClientRect();
      px = e.clientX - b.left; py = e.clientY - b.top; moved = 0;
      dragNode = pick(px, py);
      panning = !dragNode;
    };
    const move = (e) => {
      const b = canvas.getBoundingClientRect();
      const sx = e.clientX - b.left, sy = e.clientY - b.top;
      if (dragNode) {
        const w = toWorld(sx, sy);
        dragNode.x = w.x; dragNode.y = w.y; dragNode.vx = 0; dragNode.vy = 0;
        moved += Math.hypot(sx - px, sy - py);
      } else if (panning) {
        ox += (sx - px) / scale; oy += (sy - py) / scale;
        moved += Math.hypot(sx - px, sy - py);
      } else {
        hover = pick(sx, sy);
        setHoverTitle(hover ? hover.title : '');
        canvas.style.cursor = hover ? 'pointer' : 'grab';
      }
      px = sx; py = sy;
    };
    const up = () => {
      if (moved < 5 && dragNode) { onSelect(dragNode.rel); }
      dragNode = null; panning = false;
    };
    const wheel = (e) => {
      e.preventDefault();
      const b = canvas.getBoundingClientRect();
      const sx = e.clientX - b.left, sy = e.clientY - b.top;
      const before = toWorld(sx, sy);
      scale = Math.min(Math.max(scale * Math.exp(-e.deltaY * 0.0012), 0.35), 3.5);
      const after = toWorld(sx, sy);
      ox += after.x - before.x; oy += after.y - before.y;
    };
    canvas.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    canvas.addEventListener('wheel', wheel, { passive: false });

    let raf;
    const frame = () => {
      // 포스 시뮬레이션 — 반발 + 링크 스프링 + 중심 인력
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy || 1;
          const f = 2600 / d2;
          const d = Math.sqrt(d2);
          dx /= d; dy /= d;
          a.vx += dx * f; a.vy += dy * f;
          b.vx -= dx * f; b.vy -= dy * f;
        }
        a.vx -= a.x * 0.004; a.vy -= a.y * 0.004;
      }
      for (const [i, j] of edges) {
        const a = nodes[i], b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const f = (d - 110) * 0.012;
        a.vx += (dx / d) * f; a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      }
      for (const n of nodes) {
        if (n === dragNode) continue;
        n.vx *= 0.82; n.vy *= 0.82;
        n.x += n.vx; n.y += n.vy;
      }

      ctx.clearRect(0, 0, W, H);
      // 링크
      for (const [i, j] of edges) {
        const a = toScreen(nodes[i]), b = toScreen(nodes[j]);
        const hi = hover && (nodes[i] === hover || nodes[j] === hover);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = `rgba(${INK}, ${hi ? 0.75 : 0.3})`;
        ctx.lineWidth = hi ? 1.5 : 1;
        ctx.stroke();
      }
      // 노드 + 라벨
      ctx.textAlign = 'center';
      for (const n of nodes) {
        const s = toScreen(n);
        const r = (5 + n.deg * 1.6) * Math.min(scale, 1.4);
        const hi = hover === n;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        if (n.note) {
          ctx.fillStyle = 'rgba(233, 235, 221, 1)';
          ctx.fill();
          ctx.strokeStyle = `rgba(${INK}, ${hi ? 1 : 0.8})`;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        } else {
          ctx.fillStyle = `rgba(${INK}, ${hi ? 1 : 0.85})`;
          ctx.fill();
        }
        if (hi) {
          ctx.beginPath();
          ctx.arc(s.x, s.y, r + 5, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${INK}, 0.5)`;
          ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        if (scale > 0.55) {
          const t = n.title.length > 22 ? `${n.title.slice(0, 22)}…` : n.title;
          ctx.font = `${hi ? 600 : 400} 10.5px "IBM Plex Mono", monospace`;
          ctx.fillStyle = `rgba(${INK}, ${hi ? 0.95 : 0.55})`;
          ctx.fillText(t, s.x, s.y + r + 14);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const ro = new ResizeObserver(fit);
    ro.observe(canvas);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('mousedown', down);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      canvas.removeEventListener('wheel', wheel);
    };
  }, [docs, onSelect]);

  const conv = docs?.filter((d) => d.dir !== 'notes').length ?? 0;
  const notes = docs?.filter((d) => d.dir === 'notes').length ?? 0;

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}
      className="fade-up"
    >
      <div className="topbar" style={{ flex: 'none' }}>
        <span className="topbar-title">기억 그래프</span>
        <span className="microlabel" style={{ marginLeft: 4 }}>Constellation</span>
        <div style={{ flex: 1 }} />
        <span className="chip"><span className="dot" />대화 {conv}</span>
        <span className="chip"><span style={{ width: 5, height: 5, borderRadius: 999, border: '1px solid currentColor' }} />노트 {notes}</span>
        <span className="chip">드래그 이동 · 휠 줌 · 노드 클릭 = 열기</span>
        <button className="btn sm" onClick={onClose}>닫기 ESC</button>
      </div>
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block', cursor: 'grab' }} />
        {hoverTitle && (
          <span className="chip" style={{ position: 'absolute', left: 20, bottom: 18, background: 'var(--card)' }}>{hoverTitle}</span>
        )}
      </div>
    </div>
  );
}
