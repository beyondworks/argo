'use client';

import { useLang } from '@/lib/i18n';

// 레몬스퀴지 체크아웃 — 공개 링크(시크릿 아님). 앱 릴리스 빌드에 주입되는 것과 같은 상품
// (Argo Pro $12/월 · $120/년, 2026-08-05 라이브 승인). 유건 지시 2026-08-06: 랜딩에서도 결제.
const LS_MONTHLY = 'https://argo-agent.lemonsqueezy.com/checkout/buy/1c3a92a4-7132-4721-8ee8-90ccc2b276df?enabled=1956350';
const LS_YEARLY = 'https://argo-agent.lemonsqueezy.com/checkout/buy/b2510d00-a537-41d0-8552-aaa1478b35e1?enabled=1956353';

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
            {plan.id === 'p1' && (
              <a className="price-cta" href="#download">{t('pricing.p1.cta')}</a>
            )}
            {plan.id === 'p2' && (
              <div className="price-cta-col">
                <a className="price-cta hot" href={LS_MONTHLY} target="_blank" rel="noreferrer">{t('pricing.p2.cta')}</a>
                <a className="price-cta ghost" href={LS_YEARLY} target="_blank" rel="noreferrer">{t('pricing.p2.ctaYear')}</a>
              </div>
            )}
            {plan.id === 'p3' && (
              <a className="price-cta" href="#contact">{t('pricing.p3.cta')}</a>
            )}
          </div>
        ))}
      </div>
      <p className="pricing-note">{t('pricing.buyNote')}</p>
      <p className="pricing-note">{t('pricing.note')}</p>
    </section>
  );
}
