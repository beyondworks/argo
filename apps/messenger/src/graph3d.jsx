// 활동 그래프 3D — 옵시디언식 구 배치·부드러운 궤도 회전·원형 노드(유건 지시 2026-09-04).
// 의존성 없음: 3D 힘 배치(반발·스프링·중심)와 원근 투영을 캔버스 2D로 그린다. 구성은 아르고 graph2d-core(순수)를 그대로 쓴다(사본 금지).
// 카메라(요·피치·거리·중심)는 전부 목표값으로 이징(ease-out) — 드래그 관성·휠 줌·더블클릭 집중이 한 프레임 루프에서 매끄럽게 이어진다.
import { useEffect, useRef } from 'react';
import { buildGraph2D, stem } from '@argo/graph2d-core';

const rgbVar = (name, fb) => { const a = getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(',').map(Number); return a.length === 3 && !a.some(Number.isNaN) ? a : fb; };
const chroma = (a) => Math.max(...a) - Math.min(...a) >= 40;
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Graph3D({ docs, agents = [], focusRel = null, onSelectDoc, compact = false, height = '100%', hint = '' }) {
  const ref = useRef(null); const cb = useRef({}); cb.current = { onSelectDoc };
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let { nodes, edges } = buildGraph2D({ docs, agents, showCrew: true, showOrphans: true });
    let adj = nodes.map(() => new Set()); for (const [a, b] of edges) { adj[a].add(b); adj[b].add(a); }
    const focusId = focusRel ? stem(focusRel) : null; let fi = focusId ? nodes.findIndex((x) => x.id === focusId) : -1;
    // 대상 탭(compact+focus) = 옵시디언 로컬 그래프: 집중 노드와 이웃만 남겨 크게 그린다(전체를 작게 넣으면 겹치고 읽히지 않는다 — 유건 제보 2026-09-04)
    const local = compact && fi >= 0;
    if (local) {
      const keep = [fi, ...adj[fi]]; const map = new Map(keep.map((i, k) => [i, k]));
      nodes = keep.map((i) => nodes[i]); edges = edges.filter(([a, b]) => map.has(a) && map.has(b)).map(([a, b]) => [map.get(a), map.get(b)]);
      adj = nodes.map(() => new Set()); for (const [a, b] of edges) { adj[a].add(b); adj[b].add(a); }
      fi = 0;
    }
    const n = nodes.length;
    const near = fi >= 0 && !local ? new Set([fi, ...adj[fi]]) : null;
    // 초기 배치 — 결정적 난수로 구 안에(재마운트마다 같은 하늘)
    let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const P = nodes.map(() => { const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, r = 50 + rnd() * 90, s = Math.sqrt(1 - u * u); return { x: r * s * Math.cos(th), y: r * s * Math.sin(th), z: r * u, vx: 0, vy: 0, vz: 0 }; });
    // ponytail: 반발은 O(n²) 전수 — 조직 그래프는 수백 노드 이하. 넘으면 옥트리(Barnes-Hut)로
    const tick = (alpha) => {
      for (let i = 0; i < n; i++) { const a = P[i]; for (let j = i + 1; j < n; j++) { const b = P[j]; const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; const d2 = dx * dx + dy * dy + dz * dz + 1; const d = Math.sqrt(d2); const f = (1500 / d2) * alpha; const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f; a.vx += fx; a.vy += fy; a.vz += fz; b.vx -= fx; b.vy -= fy; b.vz -= fz; } }
      for (const [i, j] of edges) { const a = P[i], b = P[j]; const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z; const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01; const f = (d - (local ? 78 : 52)) * 0.05 * alpha; const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f; a.vx += fx; a.vy += fy; a.vz += fz; b.vx -= fx; b.vy -= fy; b.vz -= fz; }
      for (const a of P) { a.vx -= a.x * 0.016 * alpha; a.vy -= a.y * 0.016 * alpha; a.vz -= a.z * 0.016 * alpha; a.vx *= 0.82; a.vy *= 0.82; a.vz *= 0.82; a.x += a.vx; a.y += a.vy; a.z += a.vz; }
      if (local) { P[0].x = 0; P[0].y = 0; P[0].z = 0; } // 로컬 그래프의 집중 노드는 원점에 고정
    };
    if (local) { // 로컬 그래프는 힘 배치 대신 기하학적 고리: 집중 노드 원점, 이웃은 같은 간격의 고리(위아래 교대) — 겹침 없이 폭을 채운다
      P[0].x = P[0].y = P[0].z = 0; const m = n - 1;
      for (let k = 1; k < n; k++) { const t = ((k - 1) / Math.max(m, 1)) * Math.PI * 2 - Math.PI / 2; P[k].x = Math.cos(t) * 90; P[k].z = Math.sin(t) * 90; P[k].y = k % 2 ? 16 : -16; }
    } else for (let k = 0; k < 260; k++) tick(1 - k / 280);
    let radius = 40; for (const a of P) radius = Math.max(radius, Math.hypot(a.x, a.y, a.z));
    // 카메라 — 현재값과 목표값
    const home = fi >= 0 && !local ? { x: P[fi].x, y: P[fi].y, z: P[fi].z } : { x: 0, y: 0, z: 0 };
    const fitDist = local ? radius * 2.3 : fi >= 0 ? radius * 1.6 : radius * 2.4;
    const pitch0 = local ? 1.0 : 0.35; // 로컬 그래프는 위에서 내려다봐 이웃 고리가 가로로 펼쳐진다
    const cam = { yaw: 0.6, pitch: pitch0, dist: fitDist * 1.6, cx: home.x, cy: home.y, cz: home.z };
    const tgt = { yaw: 0.6, pitch: pitch0, dist: fitDist, cx: home.x, cy: home.y, cz: home.z };
    let vyaw = 0, vpitch = 0, idleAt = performance.now(), dragging = false, moved = 0, last = null, hover = -1, raf = 0, frame = 0;
    let INK = [42, 40, 36], PAPER = [233, 230, 223], ACC = [176, 82, 30], LAB = ACC, light = true;
    const colors = () => {
      INK = rgbVar('--ink-rgb', INK); PAPER = rgbVar('--paper-rgb', PAPER);
      light = (PAPER[0] * 299 + PAPER[1] * 587 + PAPER[2] * 114) / 1000 > 128;
      const g = rgbVar('--graph-rgb', null), m = rgbVar('--mark-rgb', null), a = rgbVar('--accent-rgb', null);
      ACC = (g && chroma(g) && g) || (m && chroma(m) && m) || (a && chroma(a) && a) || (light ? [62, 130, 247] : [120, 170, 255]);
      LAB = light ? ACC.map((v) => Math.round(v * 0.72)) : ACC.map((v) => Math.round(v + (255 - v) * 0.35));
    };
    colors();
    let W = 0, H = 0, dpr = 1;
    const size = () => { const box = canvas.parentElement.getBoundingClientRect(); W = Math.max(1, box.width); H = Math.max(1, box.height); dpr = Math.min(2, window.devicePixelRatio || 1); canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); canvas.style.width = `${W}px`; canvas.style.height = `${H}px`; };
    size();
    const ro = new ResizeObserver(size); ro.observe(canvas.parentElement);
    const proj = new Array(n);
    const project = () => {
      const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
      const F = (cam.dist * Math.min(W, H) * (local ? 0.34 : 0.42)) / radius;
      for (let i = 0; i < n; i++) {
        const a = P[i]; const x0 = a.x - cam.cx, y0 = a.y - cam.cy, z0 = a.z - cam.cz;
        const x1 = x0 * cy - z0 * sy, z1 = x0 * sy + z0 * cy; // 요(Y축)
        const y2 = y0 * cp - z1 * sp, z2 = y0 * sp + z1 * cp; // 피치(X축)
        const zc = cam.dist + z2; const f = F / Math.max(zc, 1);
        proj[i] = { x: W / 2 + x1 * f, y: H / 2 + y2 * f, s: cam.dist / Math.max(zc, 1), z: z2 };
      }
    };
    const nodeR = (i, s) => (local ? 3.4 : compact ? 2.6 : 3.2) + Math.min(nodes[i].deg, 8) * (local ? 0.7 : compact ? 0.55 : 0.8) * s * 0.9 + 0.001;
    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = `rgb(${PAPER.join(',')})`; ctx.fillRect(0, 0, W, H);
      ctx.font = `${compact ? 11 : 12}px ${getComputedStyle(document.documentElement).getPropertyValue('--font') || 'Pretendard, sans-serif'}`;
      // 기하학적 지평 — 경계 구의 적도 원(회전에 따라 타원으로 눕는다)
      if (!compact) { ctx.beginPath(); const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch); const F = (cam.dist * Math.min(W, H) * (local ? 0.34 : 0.42)) / radius;
        for (let k = 0; k <= 72; k++) { const t = (k / 72) * Math.PI * 2; const x0 = Math.cos(t) * radius * 1.15 - cam.cx, y0 = -cam.cy, z0 = Math.sin(t) * radius * 1.15 - cam.cz; const x1 = x0 * cy - z0 * sy, z1 = x0 * sy + z0 * cy; const y2 = y0 * cp - z1 * sp, z2 = y0 * sp + z1 * cp; const f = F / Math.max(cam.dist + z2, 1); const px = W / 2 + x1 * f, py = H / 2 + y2 * f; k ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
        ctx.strokeStyle = `rgba(${INK.join(',')}, ${light ? 0.07 : 0.1})`; ctx.lineWidth = 1; ctx.setLineDash([2, 5]); ctx.stroke(); ctx.setLineDash([]); }
      const depthA = (z) => 0.45 + 0.55 * (1 - Math.min(1, Math.max(0, (z + radius) / (2 * radius))));
      const lit = (i) => hover < 0 ? (near ? near.has(i) : true) : (i === hover || adj[hover].has(i));
      // 엣지
      for (const [i, j] of edges) {
        const a = proj[i], b = proj[j]; const on = hover >= 0 ? (i === hover || j === hover) : (near ? (near.has(i) && near.has(j)) : true);
        const al = depthA((a.z + b.z) / 2) * (on ? 0.38 : 0.08);
        ctx.strokeStyle = on ? `rgba(${ACC.join(',')}, ${al})` : `rgba(${INK.join(',')}, ${al})`; ctx.lineWidth = on && hover >= 0 ? 1.4 : 1;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      // 노드 — 먼 것부터
      const order = [...Array(n).keys()].sort((i, j) => proj[j].z - proj[i].z);
      for (const i of order) {
        const q = proj[i]; const r = nodeR(i, q.s); const on = lit(i); const al = depthA(q.z) * (on ? 1 : 0.22);
        const col = on ? ACC : INK;
        if (on && (nodes[i].deg >= 4 || i === fi || i === hover)) { ctx.beginPath(); ctx.arc(q.x, q.y, r * 1.9, 0, Math.PI * 2); ctx.strokeStyle = `rgba(${ACC.join(',')}, ${al * 0.45})`; ctx.lineWidth = 1; ctx.stroke(); }
        ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.fillStyle = `rgba(${col.join(',')}, ${al})`; ctx.fill();
        if (i === hover || i === fi) { ctx.beginPath(); ctx.arc(q.x, q.y, r + 2.5, 0, Math.PI * 2); ctx.strokeStyle = `rgba(${PAPER.join(',')}, 0.9)`; ctx.lineWidth = 1.5; ctx.stroke(); }
      }
      // 라벨 — 허브·집중·호버·이웃(호버 중)만
      for (const i of order) {
        const q = proj[i]; const show = i === hover || i === fi || (hover >= 0 && adj[hover].has(i)) || (hover < 0 && (near ? near.has(i) : nodes[i].deg >= (compact ? 4 : 3)));
        if (!local && (!show || (compact && i !== hover && i !== fi && nodes[i].deg < 3))) continue; // 로컬 그래프는 전원 라벨(몇 개 안 된다)
        const r = nodeR(i, q.s); const al = depthA(q.z) * (i === hover || i === fi ? 1 : 0.85);
        ctx.fillStyle = `rgba(${(i === hover || i === fi || nodes[i].deg >= 4 ? LAB : INK).join(',')}, ${al})`; ctx.textBaseline = 'middle';
        const leftSide = local && q.x < W / 2 - 4; ctx.textAlign = leftSide ? 'right' : 'left'; ctx.fillText(nodes[i].label, leftSide ? q.x - r - 6 : q.x + r + 6, q.y); ctx.textAlign = 'left';
      }
    };
    const loop = (now) => {
      raf = requestAnimationFrame(loop); frame++;
      if (frame % 30 === 0) colors();
      if (!dragging) { tgt.yaw += vyaw; tgt.pitch = Math.max(-1.25, Math.min(1.25, tgt.pitch + vpitch)); vyaw *= 0.92; vpitch *= 0.92; if (Math.abs(vyaw) < 1e-4) vyaw = 0; if (Math.abs(vpitch) < 1e-4) vpitch = 0; }
      if (!dragging && hover < 0 && !reduced() && now - idleAt > 2500) tgt.yaw += 0.0012; // 쉬는 동안 천천히 돈다
      const k = 0.11; cam.yaw += (tgt.yaw - cam.yaw) * k; cam.pitch += (tgt.pitch - cam.pitch) * k; cam.dist += (tgt.dist - cam.dist) * k; cam.cx += (tgt.cx - cam.cx) * k; cam.cy += (tgt.cy - cam.cy) * k; cam.cz += (tgt.cz - cam.cz) * k;
      if (!local && frame < 200) tick(0.25 * (1 - frame / 200)); // 마운트 뒤 잠깐 더 자리를 잡는다
      project(); draw();
    };
    raf = requestAnimationFrame(loop);
    const pos = (e) => { const b = canvas.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
    const pick = (p) => { let best = -1, bd = 1e9; for (let i = 0; i < n; i++) { const q = proj[i]; const d = Math.hypot(q.x - p.x, q.y - p.y); const lim = nodeR(i, q.s) + 6; if (d < lim && q.z < bd) { best = i; bd = q.z; } } return best; };
    const onDown = (e) => { if (e.button !== 0) return; dragging = true; moved = 0; last = pos(e); vyaw = 0; vpitch = 0; idleAt = performance.now(); canvas.setPointerCapture?.(e.pointerId); };
    const onMove = (e) => {
      const p = pos(e); idleAt = performance.now();
      if (dragging && last) { const dx = p.x - last.x, dy = p.y - last.y; moved += Math.abs(dx) + Math.abs(dy); tgt.yaw += dx * 0.006; tgt.pitch = Math.max(-1.25, Math.min(1.25, tgt.pitch - dy * 0.006)); vyaw = dx * 0.0025; vpitch = -dy * 0.0025; last = p; return; }
      const h = pick(p); if (h !== hover) { hover = h; canvas.style.cursor = h >= 0 ? 'pointer' : 'grab'; }
    };
    const onUp = (e) => { if (!dragging) return; dragging = false; last = null; if (moved < 4) { const h = pick(pos(e)); if (h >= 0 && nodes[h].rel) cb.current.onSelectDoc?.(nodes[h].rel); } };
    const onDbl = (e) => { e.preventDefault(); const h = pick(pos(e)); if (h >= 0) { tgt.cx = P[h].x; tgt.cy = P[h].y; tgt.cz = P[h].z; tgt.dist = radius * 1.2; } else { tgt.cx = home.x; tgt.cy = home.y; tgt.cz = home.z; tgt.dist = fitDist; } idleAt = performance.now(); };
    const onWheel = (e) => { e.preventDefault(); tgt.dist = Math.max(radius * 0.7, Math.min(radius * 7, tgt.dist * Math.pow(1.0015, e.deltaY))); idleAt = performance.now(); };
    const onLeave = () => { hover = -1; canvas.style.cursor = 'grab'; };
    canvas.style.cursor = 'grab'; canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointermove', onMove); canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointercancel', onUp); canvas.addEventListener('pointerleave', onLeave); canvas.addEventListener('dblclick', onDbl); canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => { cancelAnimationFrame(raf); ro.disconnect(); canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp); canvas.removeEventListener('pointerleave', onLeave); canvas.removeEventListener('dblclick', onDbl); canvas.removeEventListener('wheel', onWheel); };
  }, [docs, agents, focusRel, compact]);
  return (
    <div className="g3" style={{ position: 'relative', width: '100%', height }}>
      <canvas ref={ref} style={{ display: 'block' }} />
      {hint && !compact && <div className="g3-hint">{hint}</div>}
    </div>
  );
}
