// 패널 폭 조절 손잡이 — 본체 split-pane 방식(포인터 끌기, 최소·최대 클램프, 폭은 이 기기에 저장). 화살표 키로도 조절된다.
import { useState } from 'react';
import { restore, persist } from '../core/save.js';

export function useWidth(key, initial, min, max) {
  const [w, setW] = useState(() => Math.min(max, Math.max(min, restore(key, initial))));
  const set = (v) => { const c = Math.min(max, Math.max(min, Math.round(v))); setW(c); persist(key, c); };
  return [w, set];
}

export function SplitHandle({ width, onChange, label }) {
  const onPointerDown = (e) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = width;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add('split-resizing');
    const move = (ev) => onChange(w0 + ev.clientX - x0);
    const up = () => { document.body.classList.remove('split-resizing'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  return <div className="split" role="separator" aria-orientation="vertical" aria-label={label} aria-valuenow={width} tabIndex={0}
    onPointerDown={onPointerDown} onKeyDown={(e) => { if (e.key === 'ArrowLeft') onChange(width - 16); if (e.key === 'ArrowRight') onChange(width + 16); }} />;
}
