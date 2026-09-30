'use client';

import { useEffect, useRef } from 'react';
import { FrameSequence } from '@/lib/sequence';

// manifest가 null이면 휴면 (poster는 부모 레이어가 렌더).
// Phase 2에서 manifest만 넘기면 스크러빙이 켜진다 — progressRef.current(0..1)를 부모 ScrollTrigger가 갱신.
export default function ScrollSequence({ manifest, progressRef, className }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!manifest) return undefined;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { alpha: false });
    const seq = new FrameSequence(manifest);
    let raf;
    let lastIndex = -1;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      lastIndex = -1;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    seq.load();

    const loop = () => {
      const p = progressRef?.current ?? 0;
      const idx = Math.round(p * (manifest.count - 1));
      if (idx !== lastIndex && seq.drawFrame(ctx, p)) lastIndex = idx;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      seq.dispose();
    };
  }, [manifest, progressRef]);

  if (!manifest) return null;
  return <canvas ref={canvasRef} className={className} />;
}
