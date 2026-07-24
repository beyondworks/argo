'use client';

import { useLang } from '@/lib/i18n';

const PLANS = [
  { id: 'p1', features: ['f1', 'f2', 'f3'] },
  { id: 'p2', features: ['f0', 'f1', 'f2', 'f3', 'f4'], hot: true }, // f0 = 멀티디바이스(유료 앵커) 최상단
  { id: 'p3', features: ['f1', 'f2', 'f3'] },
];

export default function PricingSection() {
  const { t } = useLang();
  return (
    <section className="pricing-section" id="pricing">
      <div className="pricing-head">
        <h2 className="pricing-title">{t('pricing.title')}</h2>
        <span className="mono-label mono-dim">{t('pricing.kicker')}</span>
      </div>
      <div className="pricing-grid">
        {PLANS.map((plan) => (
          <div key={plan.id} className={`price-card${plan.hot ? ' hot' : ''}`}>
            <span className="mono-label">
              {t(`pricing.${plan.id}.name`)}
              {plan.hot ? ` — ${t('pricing.hot')}` : ''}
            </span>
            <div className="price">
              {t(`pricing.${plan.id}.price`)}
              <span className="per"> {t(`pricing.${plan.id}.per`)}</span>
            </div>
            <ul>
              {plan.features.map((f) => (
                <li key={f}>{t(`pricing.${plan.id}.${f}`)}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="pricing-note">{t('pricing.note')}</p>
    </section>
  );
}
