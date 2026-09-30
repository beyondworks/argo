'use client';

import { useEffect, useRef, useState } from 'react';

// 왼쪽 목록 + 오른쪽 무대 — 6초마다 다음 항목으로 넘어가고(진행 막대), 누르면 바로 바뀐다. 마우스를 올려도 멈추지 않는다
// (9/30 유건: 보는 동안 마우스가 무대 위에 있으면 멈춰 있어 스크롤해야만 넘어가는 것처럼 보였다).
// 무대는 항목이 바뀔 때마다 key로 다시 붙어 CSS 장면이 처음부터 재생된다. 화면 밖이면 넘기지 않는다.
export default function StageTabs({ items, renderStage, ms = 6000, label, layout }) {
  const [active, setActive] = useState(0);
  const [run, setRun] = useState(0);
  const [lap, setLap] = useState(0); // 진행 막대·넘김 타이머의 한 바퀴 — 쉬었다 이어지면 둘 다 처음부터
  const [inView, setInView] = useState(false);
  const root = useRef(null);

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => { setInView(e.isIntersecting); if (e.isIntersecting) setLap((l) => l + 1); }, { threshold: 0.3 });
    io.observe(root.current);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!inView || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const id = setTimeout(() => { setActive((a) => (a + 1) % items.length); setRun((r) => r + 1); }, ms);
    return () => clearTimeout(id);
  }, [active, run, lap, inView, items.length, ms]);

  const pick = (i) => { setActive(i); setRun((r) => r + 1); };

  return (
    <div
      className={`stage-tabs${layout ? ` ${layout}` : ''}${!inView ? ' paused' : ''}`}
      ref={root}
      style={{ '--tab-ms': `${ms}ms` }}
    >
      <div className="st-list" role="tablist" aria-label={label}>
        {items.map((it, i) => (
          <button
            key={it.id}
            type="button"
            role="tab"
            aria-selected={i === active}
            className={`st-item${i === active ? ' on' : ''}`}
            onClick={() => pick(i)}
          >
            <span className="st-num mono-label">0{i + 1}</span>
            <span className="st-text">
              <span className="st-title">{it.title}</span>
              <span className="st-body"><span>{it.body}</span></span>
            </span>
            {i === active && <span className="st-progress" key={`${run}-${lap}`} />}
          </button>
        ))}
      </div>
      <div className="st-stage" role="tabpanel">
        <div className="st-scene" key={`${items[active].id}-${run}`}>
          {renderStage(items[active].id)}
        </div>
      </div>
    </div>
  );
}
