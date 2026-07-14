'use client';

import { useLang } from '@/lib/i18n';

export default function Footer() {
  const { t } = useLang();
  return (
    <footer className="footer">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
          <path
            d="M12 1 L14.2 9.8 L23 12 L14.2 14.2 L12 23 L9.8 14.2 L1 12 L9.8 9.8 Z"
            fill="currentColor"
          />
        </svg>
        <p className="footer-line">{t('footer.line')}</p>
      </div>
      <span className="mono-label">{t('footer.copy')}</span>
    </footer>
  );
}
