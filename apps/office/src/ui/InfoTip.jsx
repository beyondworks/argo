// 기준 설명 — (i)를 누를 때만 보인다. 바깥을 누르거나 Esc면 닫힌다(유건 9/29: 설명 문장을 화면에 늘어놓지 않는다)
import { useEffect, useRef } from 'react';
import { Icon } from './Icon.jsx';
import { t } from '../core/i18n.js';

export function InfoTip({ text, end = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const close = (event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (event.type === 'scroll' ? el.querySelector('.info-pop')?.style.position === 'fixed' : event.type === 'keydown' ? event.key === 'Escape' : !el.contains(event.target)) el.open = false;
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    document.addEventListener('scroll', close, { capture: true, passive: true }); // 화면에 붙여 띄운 풍선은 스크롤하면 닫는다
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); document.removeEventListener('scroll', close, { capture: true }); };
  }, []);
  // 열릴 때 화면 밖으로 나가면 안쪽으로 밀어 넣는다(폰 폭에서 오른쪽 끝을 넘던 문제)
  // 높이를 정한 모듈 카드는 본문이 스크롤 영역이라 풍선이 잘린다 — 그 안에서는 화면에 붙여 띄운다(유건 10/1 가장자리 끌기)
  const fit = (event) => {
    const tip = event.currentTarget, pop = tip.querySelector('.info-pop');
    if (!pop) return;
    Object.assign(pop.style, { translate: '', position: '', top: '', left: '', right: '' });
    if (!tip.open) return;
    if (tip.closest('.module.sized-h')) {
      const s = tip.firstElementChild.getBoundingClientRect();
      Object.assign(pop.style, { position: 'fixed', top: `${s.bottom + 6}px`, left: `${s.left - 8}px`, right: 'auto' });
      if (end) pop.style.left = `${s.right + 8 - pop.offsetWidth}px`;
    }
    const r = pop.getBoundingClientRect(), edge = 8;
    const shift = r.right > innerWidth - edge ? innerWidth - edge - r.right : r.left < edge ? edge - r.left : 0;
    if (shift) pop.style.translate = `${shift}px 0`;
  };
  return <details ref={ref} className={`info-tip${end ? ' end' : ''}`} onToggle={fit}>
    <summary aria-label={t('info.basis')}><Icon name="info" size={14} /></summary>
    <div className="info-pop" role="note">{text}</div>
  </details>;
}
