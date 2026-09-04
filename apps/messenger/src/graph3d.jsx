// 기억 그래프 3D — 옵시디언식 구 배치·부드러운 궤도 회전·원형 노드(유건 지시 2026-09-04).
// 의존성 없음: 3D 힘 배치(반발·스프링·중심)와 원근 투영을 캔버스 2D로 그린다. 구성은 아르고 graph2d-core(순수)를 그대로 쓴다(사본 금지).
// 카메라(요·피치·거리·중심)는 전부 목표값으로 이징(ease-out) — 드래그 관성·휠 줌·줌 버튼·더블클릭 집중이 한 프레임 루프에서 매끄럽게 이어진다.
// 정지 상태에서도 노드가 미세하게 부유하고, 호버하면 이웃이 서서히 밝아지며 연결선을 따라 점이 흐른다. 동작 축소 설정이면 전부 멈춘다.
import { useEffect, useRef } from 'react';
import { buildGraph2D, stem } from '@argo/graph2d-core';

const rgbVar = (name, fb) => { const a = getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(',').map(Number); return a.length === 3 && !a.some(Number.isNaN) ? a : fb; };
const chroma = (a) => Math.max(...a) - Math.min(...a) >= 40;
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const TAU = Math.PI * 2;

export function Graph3D({ docs, agents = [], focusRel = null, onSelectDoc, height = '100%', hint = '', labels = {} }) {
  const ref = useRef(null); const cb = useRef({}); cb.current = { onSelectDoc };
  const api = useRef({});
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const { nodes, edges } = buildGraph2D({ docs, agents, showCrew: true, showOrphans: true });
    const adj = nodes.map(() => new Set()); for (const [a, b] of edges) { adj[a].add(b); adj[b].add(a); }
    const focusId = focusRel ? stem(focusRel) : null; const fi = focusId ? nodes.findIndex((x) => x.id === focusId) : -1;
    const n = nodes.length;
    const near = fi >= 0 ? new Set([fi, ...adj[fi]]) : null;
    // 초기 배치 — 결정적 난수로 구 안에(재마운트마다 같은 하늘)
    let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const P = nodes.map(() => { const u = rnd() * 2 - 1, th = rnd() * TAU, r = 50 + rnd() * 90, s = Math.sqrt(1 - u * u); return { x: r * s * Math.cos(th), y: r * s * Math.sin(th), z: r * u, vx: 0, vy: 0, vz: 0 }; });
    const PH = P.map(() => rnd() * TAU); // 부유 위상 — 노드마다 달라야 무리가 한 덩어리로 흔들리지 않는다
    const glow = new Float32Array(n).fill(1); // 강조 밝기(목표값으로 이징 — 호버가 툭 끊기지 않게)
    // ponytail: 반발은 O(n²) 전수 — 조직 그래프는 수백 노드 이하. 넘으면 옥트리(Barnes-Hut)로
    const tick = (alpha) => {
      for (let i = 0; i < n; i++) { const a = P[i]; for (let j = i + 1; j < n; j++) { const b = P[j]; const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; const d2 = dx * dx + dy * dy + dz * dz + 1; const d = Math.sqrt(d2); const f = (1500 / d2) * alpha; const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f; a.vx += fx; a.vy += fy; a.vz += fz; b.vx -= fx; b.vy -= fy; b.vz -= fz; } }
      for (const [i, j] of edges) { const a = P[i], b = P[j]; const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z; const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01; const f = (d - 52) * 0.05 * alpha; const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f; a.vx += fx; a.vy += fy; a.vz += fz; b.vx -= fx; b.vy -= fy; b.vz -= fz; }
      for (const a of P) { a.vx -= a.x * 0.016 * alpha; a.vy -= a.y * 0.016 * alpha; a.vz -= a.z * 0.016 * alpha; a.vx *= 0.82; a.vy *= 0.82; a.vz *= 0.82; a.x += a.vx; a.y += a.vy; a.z += a.vz; }
    };
    for (let k = 0; k < 260; k++) tick(1 - k / 280);
    let radius = 40; for (const a of P) radius = Math.max(radius, Math.hypot(a.x, a.y, a.z));
    // 카메라 — 현재값과 목표값
    const home = fi >= 0 ? { x: P[fi].x, y: P[fi].y, z: P[fi].z } : { x: 0, y: 0, z: 0 };
    const fitDist = fi >= 0 ? radius * 1.6 : radius * 2.4;
    const clampD = (d) => Math.max(radius * 1.15, Math.min(radius * 9, d)); // 하한은 노드가 카메라 뒤로 넘어가지 않는 선
    const cam = { yaw: 0.6, pitch: 0.35, dist: fitDist * 1.6, cx: home.x, cy: home.y, cz: home.z };
    const tgt = { yaw: 0.6, pitch: 0.35, dist: fitDist, cx: home.x, cy: home.y, cz: home.z };
    let vyaw = 0, vpitch = 0, idleAt = performance.now(), dragging = false, moved = 0, last = null, hover = -1, raf = 0, frame = 0, RED = reduced();
    let INK = [42, 40, 36], PAPER = [233, 230, 223], ACC = [176, 82, 30], LAB = ACC, light = true;
    const colors = () => {
      INK = rgbVar('--ink-rgb', INK);
      // 판 색 — 그래프가 앉는 면과 같아야 한다(노드 테두리 링도 이 색). 메신저는 베이지 판이라 --graph-paper-rgb로 따로 준다.
      PAPER = rgbVar('--graph-paper-rgb', null) || rgbVar('--paper-rgb', PAPER);
      light = (PAPER[0] * 299 + PAPER[1] * 587 + PAPER[2] * 114) / 1000 > 128;
      const g = rgbVar('--graph-rgb', null), m = rgbVar('--mark-rgb', null), a = rgbVar('--accent-rgb', null);
      ACC = g || (m && chroma(m) && m) || (a && chroma(a) && a) || (light ? [62, 130, 247] : [120, 170, 255]); // --graph-rgb는 그래프 전용 명시 지정 — 흑백(무채색)이어도 의도이므로 채도 검사를 걸지 않는다
      LAB = light ? ACC.map((v) => Math.round(v * 0.72)) : ACC.map((v) => Math.round(v + (255 - v) * 0.35));
    };
    colors();
    let W = 0, H = 0, dpr = 1;
    const size = () => { const box = canvas.parentElement.getBoundingClientRect(); W = Math.max(1, box.width); H = Math.max(1, box.height); dpr = Math.min(2, window.devicePixelRatio || 1); canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); canvas.style.width = `${W}px`; canvas.style.height = `${H}px`; };
    size();
    const ro = new ResizeObserver(size); ro.observe(canvas.parentElement);
    const proj = new Array(n);
    const project = (t) => {
      const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
      const F = (fitDist * Math.min(W, H) * 0.42) / radius; // 초점 고정 — 여기에 cam.dist를 곱하면 다가가도 배율이 상쇄돼 줌이 먹지 않는다
      const dr = RED ? 0 : 1.5; // 부유 진폭(배치 좌표계)
      for (let i = 0; i < n; i++) {
        const a = P[i]; const ph = PH[i];
        const ax = a.x + dr * Math.sin(t * 0.00042 + ph), ay = a.y + dr * Math.cos(t * 0.00037 + ph * 1.7), az = a.z + dr * Math.sin(t * 0.00051 + ph * 0.6);
        const x0 = ax - cam.cx, y0 = ay - cam.cy, z0 = az - cam.cz;
        const x1 = x0 * cy - z0 * sy, z1 = x0 * sy + z0 * cy; // 요(Y축)
        const y2 = y0 * cp - z1 * sp, z2 = y0 * sp + z1 * cp; // 피치(X축)
        const zc = cam.dist + z2; const f = F / Math.max(zc, 1);
        proj[i] = { x: W / 2 + x1 * f, y: H / 2 + y2 * f, s: fitDist / Math.max(zc, 1), z: z2 };
      }
    };
    const nodeR = (i, s) => 3.2 + Math.min(nodes[i].deg, 8) * 0.8 * s * 0.9 + 0.001;
    const draw = (t) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = `rgb(${PAPER.join(',')})`; ctx.fillRect(0, 0, W, H);
      ctx.font = `11.5px ${getComputedStyle(document.documentElement).getPropertyValue('--font') || 'Pretendard, sans-serif'}`;
      const intro = Math.min(1, frame / 26); // 진입 페이드
      const depthA = (z) => (0.45 + 0.55 * (1 - Math.min(1, Math.max(0, (z + radius) / (2 * radius))))) * intro;
      const want = (i) => ((hover < 0 ? (near ? near.has(i) : true) : (i === hover || adj[hover].has(i))) ? 1 : 0.2);
      for (let i = 0; i < n; i++) glow[i] += (want(i) - glow[i]) * 0.16;
      // 연결선 — 두 끝 노드의 밝기 평균을 따른다
      for (const [i, j] of edges) {
        const a = proj[i], b = proj[j]; const g = (glow[i] + glow[j]) / 2; const on = g > 0.6;
        const al = depthA((a.z + b.z) / 2) * (0.06 + 0.3 * Math.max(0, (g - 0.2) / 0.8));
        ctx.strokeStyle = `rgba(${(on ? ACC : INK).join(',')}, ${al})`; ctx.lineWidth = on && hover >= 0 ? 1.3 : 1;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      // 호버한 노드에서 이웃으로 흐르는 점 — 어디로 이어지는지 눈으로 따라간다
      if (hover >= 0 && !RED) {
        const p = (t % 1500) / 1500;
        for (const [i, j] of edges) {
          if (i !== hover && j !== hover) continue;
          const from = proj[i === hover ? i : j], to = proj[i === hover ? j : i];
          ctx.beginPath(); ctx.arc(from.x + (to.x - from.x) * p, from.y + (to.y - from.y) * p, 1.7, 0, TAU);
          ctx.fillStyle = `rgba(${ACC.join(',')}, ${0.5 * (1 - p) * intro})`; ctx.fill();
        }
      }
      // 노드 — 먼 것부터
      const order = [...Array(n).keys()].sort((i, j) => proj[j].z - proj[i].z);
      for (const i of order) {
        const q = proj[i]; const r = nodeR(i, q.s); const g = glow[i]; const al = depthA(q.z) * g;
        if (g > 0.6 && (nodes[i].deg >= 4 || i === fi || i === hover)) { ctx.beginPath(); ctx.arc(q.x, q.y, r * 1.9, 0, TAU); ctx.strokeStyle = `rgba(${ACC.join(',')}, ${al * 0.4})`; ctx.lineWidth = 1; ctx.stroke(); }
        if (i === hover) { ctx.beginPath(); ctx.arc(q.x, q.y, r * 2.6 + (RED ? 0 : Math.sin(t * 0.0035) * 1.8), 0, TAU); ctx.strokeStyle = `rgba(${ACC.join(',')}, ${0.28 * intro})`; ctx.lineWidth = 1; ctx.stroke(); }
        ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, TAU); ctx.fillStyle = `rgba(${(g > 0.6 ? ACC : INK).join(',')}, ${al})`; ctx.fill();
        if (i === hover || i === fi) { ctx.beginPath(); ctx.arc(q.x, q.y, r + 2.5, 0, TAU); ctx.strokeStyle = `rgba(${PAPER.join(',')}, ${0.9 * intro})`; ctx.lineWidth = 1.5; ctx.stroke(); }
      }
      // 라벨 — 허브·집중·호버·이웃(호버 중)만
      for (const i of order) {
        const q = proj[i]; const show = i === hover || i === fi || (hover >= 0 && adj[hover].has(i)) || (hover < 0 && (near ? near.has(i) : nodes[i].deg >= 3));
        if (!show) continue;
        const r = nodeR(i, q.s); const al = depthA(q.z) * (i === hover || i === fi ? 1 : 0.8) * glow[i];
        ctx.fillStyle = `rgba(${(i === hover || i === fi || nodes[i].deg >= 4 ? LAB : INK).join(',')}, ${al})`; ctx.textBaseline = 'middle';
        ctx.fillText(nodes[i].label, q.x + r + 6, q.y);
      }
    };
    const loop = (now) => {
      raf = requestAnimationFrame(loop); frame++;
      if (frame % 30 === 0) { colors(); RED = reduced(); }
      if (!dragging) { tgt.yaw += vyaw; tgt.pitch = Math.max(-1.25, Math.min(1.25, tgt.pitch + vpitch)); vyaw *= 0.92; vpitch *= 0.92; if (Math.abs(vyaw) < 1e-4) vyaw = 0; if (Math.abs(vpitch) < 1e-4) vpitch = 0; }
      if (!dragging && hover < 0 && !RED && now - idleAt > 2500) tgt.yaw += 0.0012; // 쉬는 동안 천천히 돈다
      const k = 0.11; cam.yaw += (tgt.yaw - cam.yaw) * k; cam.pitch += (tgt.pitch - cam.pitch) * k; cam.dist += (tgt.dist - cam.dist) * k; cam.cx += (tgt.cx - cam.cx) * k; cam.cy += (tgt.cy - cam.cy) * k; cam.cz += (tgt.cz - cam.cz) * k;
      if (frame < 200) tick(0.25 * (1 - frame / 200)); // 마운트 뒤 잠깐 더 자리를 잡는다
      project(now); draw(now);
    };
    raf = requestAnimationFrame(loop);
    api.current = { // 줌 버튼 — 휠·트랙패드가 없어도 확대·축소가 되어야 한다(유건 지시)
      zoom: (f) => { tgt.dist = clampD(tgt.dist * f); idleAt = performance.now(); },
      fit: () => { tgt.cx = home.x; tgt.cy = home.y; tgt.cz = home.z; tgt.dist = fitDist; idleAt = performance.now(); },
    };
    const pos = (e) => { const b = canvas.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
    const pick = (p) => { let best = -1, bd = 1e9; for (let i = 0; i < n; i++) { const q = proj[i]; const d = Math.hypot(q.x - p.x, q.y - p.y); const lim = nodeR(i, q.s) + 6; if (d < lim && q.z < bd) { best = i; bd = q.z; } } return best; };
    const onDown = (e) => { if (e.button !== 0) return; dragging = true; moved = 0; last = pos(e); vyaw = 0; vpitch = 0; idleAt = performance.now(); canvas.setPointerCapture?.(e.pointerId); };
    const onMove = (e) => {
      const p = pos(e); idleAt = performance.now();
      if (dragging && last) { const dx = p.x - last.x, dy = p.y - last.y; moved += Math.abs(dx) + Math.abs(dy); tgt.yaw += dx * 0.006; tgt.pitch = Math.max(-1.25, Math.min(1.25, tgt.pitch - dy * 0.006)); vyaw = dx * 0.0025; vpitch = -dy * 0.0025; last = p; return; }
      const h = pick(p); if (h !== hover) { hover = h; canvas.style.cursor = h >= 0 ? 'pointer' : 'grab'; }
    };
    const onUp = (e) => { if (!dragging) return; dragging = false; last = null; if (moved < 4) { const h = pick(pos(e)); if (h >= 0 && nodes[h].rel) cb.current.onSelectDoc?.(nodes[h].rel); } };
    const onDbl = (e) => { e.preventDefault(); const h = pick(pos(e)); if (h >= 0) { tgt.cx = P[h].x; tgt.cy = P[h].y; tgt.cz = P[h].z; tgt.dist = radius * 1.2; idleAt = performance.now(); } else api.current.fit(); };
    const onWheel = (e) => { e.preventDefault(); tgt.dist = clampD(tgt.dist * Math.pow(e.ctrlKey ? 1.02 : 1.0028, e.deltaY)); idleAt = performance.now(); }; // ctrl+휠 = 트랙패드 핀치
    const onLeave = () => { hover = -1; canvas.style.cursor = 'grab'; };
    canvas.style.cursor = 'grab'; canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointermove', onMove); canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointercancel', onUp); canvas.addEventListener('pointerleave', onLeave); canvas.addEventListener('dblclick', onDbl); canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => { cancelAnimationFrame(raf); ro.disconnect(); api.current = {}; canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp); canvas.removeEventListener('pointerleave', onLeave); canvas.removeEventListener('dblclick', onDbl); canvas.removeEventListener('wheel', onWheel); };
  }, [docs, agents, focusRel]);
  return (
    <div className="g3" style={{ position: 'relative', width: '100%', height }}>
      <canvas ref={ref} style={{ display: 'block' }} />
      <div className="g3-zoom">
        <button type="button" onClick={() => api.current.zoom?.(1 / 1.35)} title={labels.zoomIn} aria-label={labels.zoomIn}>+</button>
        <button type="button" onClick={() => api.current.zoom?.(1.35)} title={labels.zoomOut} aria-label={labels.zoomOut}>−</button>
        <button type="button" onClick={() => api.current.fit?.()} title={labels.fit} aria-label={labels.fit}>◎</button>
      </div>
      {hint && <div className="g3-hint">{hint}</div>}
    </div>
  );
}
