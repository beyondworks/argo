'use client';

import { useLang } from '@/lib/i18n';

// Argo만의 후킹 포인트 4 — 히어로 직후 최상단 강조 (2026-07-14 유건 지정)
const CORES = ['core1', 'core2', 'core3', 'core4'];

export default function CoreFour() {
  const { t } = useLang();
  return (
    <section className="core-section">
      <div className="core-head">
        <span className="mono-label">{t('core.kicker')}</span>
        <span className="mono-label mono-dim">01 — 04</span>
      </div>
      <div className="core-grid">
        {CORES.map((key, i) => (
          <div key={key} className="core-cell">
            <span className="core-num">{String(i + 1).padStart(2, '0')}</span>
            <h3 className="core-title">{t(`${key}.title`)}</h3>
            <p className="core-body">{t(`${key}.body`)}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
