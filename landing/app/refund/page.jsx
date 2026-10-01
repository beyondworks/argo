'use client';

import DocShell from '@/components/DocShell';
import { useLang } from '@/lib/i18n';

export default function RefundPage() {
  const { t } = useLang();
  return (
    <DocShell kicker={t('legal.kicker')} title={t('refund.title')} updated={t('refund.effective')}>
      <p>{t('refund.operator')}</p>
      {[1, 2, 3, 4, 5, 6].map((section) => (
        <section className="doc-section" key={section}>
          <h2>{t(`refund.${section}.title`)}</h2>
          <p>{t(`refund.${section}.body`)}</p>
          {section === 5 && (
            <p>
              <a href="mailto:lean8kim@gmail.com">lean8kim@gmail.com</a>
              {' · '}
              <a href="https://paddle.net/">{t('refund.paddleSupport')}</a>
            </p>
          )}
          {section === 6 && (
            <p><a href="https://www.paddle.com/legal/refund-policy">{t('refund.paddlePolicy')}</a></p>
          )}
        </section>
      ))}
    </DocShell>
  );
}
