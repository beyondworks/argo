'use client';

import { useEffect, useRef } from 'react';
import { useLang } from '@/lib/i18n';
import Icon from '@/components/family/Icon';

// "지금은 이렇게 일한다 → 이렇게 바뀐다" — 스크롤 진행률(--p, 0→1)로 흩어진 창들이 한 곳으로 모인다.
// 진행률은 CSS 변수 하나(transform·opacity만 움직임), 계산은 스크롤 때 rAF로 한 번.
// 창 위치: from [x, y, 기울기(deg)] → to [x, y] — 무대 가운데 기준 px.
export default function ProblemScroll({ ns, windows, children }) {
  const { t } = useLang();
  const root = useRef(null);

  useEffect(() => {
    const el = root.current;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.style.setProperty('--p', '1');
      el.dataset.phase = 'after';
      return undefined;
    }
    let raf = 0;
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const span = r.height - window.innerHeight;
      const p = span > 0 ? Math.min(1, Math.max(0, -r.top / span)) : 1;
      el.style.setProperty('--p', p.toFixed(3));
      el.dataset.phase = p < 0.55 ? 'before' : 'after';
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <section className="prob" ref={root} data-phase="before" aria-label={t(`${ns}.prob.kicker`)}>
      <div className="prob-sticky">
        <div className="prob-copy">
          <span className="mono-label">{t(`${ns}.prob.kicker`)}</span>
          <div className="prob-heads">
            <h2 className="fam-title prob-h before">{t(`${ns}.prob.before`)}</h2>
            <h2 className="fam-title prob-h after" aria-hidden="true">{t(`${ns}.prob.after`)}</h2>
          </div>
          <ol className="prob-pains">
            {[1, 2, 3].map((n) => (
              <li key={n}>
                <span className="mark"><Icon name="check" size={13} /></span>
                <span className="txt">
                  <span className="pain">{t(`${ns}.prob.pain${n}`)}</span>
                  <span className="fix">{t(`${ns}.prob.fix${n}`)}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>

        <div className="prob-stage" aria-hidden="true">
          {windows.map((w, i) => (
            <div
              key={w.id}
              className="prob-win"
              style={{ '--x0': w.from[0], '--y0': w.from[1], '--r0': w.from[2], '--x1': w.to[0], '--y1': w.to[1], '--i': i }}
            >
              <div className="pw-bar"><i /><i /><i /><span>{t(`${ns}.prob.w.${w.id}`)}</span></div>
              <div className="pw-body">
                {Array.from({ length: w.lines }, (_, n) => (
                  <p key={n} className={n % 2 ? 'ai' : 'me'}>{t(`${ns}.prob.w.${w.id}.${n + 1}`)}</p>
                ))}
              </div>
            </div>
          ))}
          {['c1', 'c2', 'c3'].map((c, i) => (
            <span key={c} className={`prob-chip ${c}`} style={{ '--i': i }}>{t(`${ns}.prob.${c}`)}</span>
          ))}
          <div className="prob-merged">{children}</div>
        </div>
      </div>
    </section>
  );
}
