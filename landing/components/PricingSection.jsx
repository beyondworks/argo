'use client';

import { useLang } from '@/lib/i18n';

// 레몬스퀴지 체크아웃 — 공개 링크(시크릿 아님). 앱 릴리스 빌드에 주입되는 것과 같은 상품
// (Argo Pro $12/월 · $120/년, 2026-08-05 라이브 승인). 유건 지시 2026-08-06: 랜딩에서도 결제.
const LS_MONTHLY = 'https://argo-agent.lemonsqueezy.com/checkout/buy/8ec2b79d-6d8b-415e-bae0-4563cc07cb83?enabled=2079807';
const LS_YEARLY = 'https://argo-agent.lemonsqueezy.com/checkout/buy/a68219ba-6885-4613-83b9-68045af86241?enabled=2079849'; // buy/ 뒤 값 = 변형(연간 a68219ba). 월간 값을 쓰면 US$12가 담긴다(2026-09-26 에드나 확정)

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
