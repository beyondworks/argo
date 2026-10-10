'use client';

import { useLang } from '@/lib/i18n';

// Pro 결제는 /checkout에서 Argo 계정 로그인부터 한다(2026-10-10) — 로그인한 계정 id를 붙인 LS 체크아웃으로 보내야
// 결제 이메일이 달라도, 결제를 먼저 해도 Pro가 그 계정에 연결된다. LS 주소는 lib/checkout.js만 안다.
const PLANS = [
  { id: 'p1', features: ['f1', 'f2', 'f3'] },
  { id: 'p2', features: ['f0', 'f1', 'f2'], hot: true }, // 유료 = 동기화·우선지원만, 나머지는 무료 동일(유건 확정 2026-08-07)
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
                <a className="price-cta hot" href="/checkout?plan=monthly">{t('pricing.p2.cta')}</a>
                <a className="price-cta ghost" href="/checkout?plan=yearly">{t('pricing.p2.ctaYear')}</a>
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
