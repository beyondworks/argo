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
      if (event.type === 'keydown' ? event.key === 'Escape' : !el.contains(event.target)) el.open = false;
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); };
  }, []);
  // 열릴 때 화면 밖으로 나가면 안쪽으로 밀어 넣는다(폰 폭에서 오른쪽 끝을 넘던 문제)
  const fit = (event) => {
    const pop = event.currentTarget.querySelector('.info-pop');
    if (!pop) return;
    pop.style.translate = '';
    if (!event.currentTarget.open) return;
    const r = pop.getBoundingClientRect(), edge = 8;
    const shift = r.right > innerWidth - edge ? innerWidth - edge - r.right : r.left < edge ? edge - r.left : 0;
    if (shift) pop.style.translate = `${shift}px 0`;
  };
  return <details ref={ref} className={`info-tip${end ? ' end' : ''}`} onToggle={fit}>
    <summary aria-label={t('info.basis')}><Icon name="info" size={14} /></summary>
    <div className="info-pop" role="note">{text}</div>
  </details>;
}
