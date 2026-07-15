'use client';

import Link from 'next/link';
import { useLang } from '@/lib/i18n';

export default function Footer() {
  const { t } = useLang();
  return (
    <footer className="footer">
      <div className="footer-brandline">
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
          <path
            d="M12 1 L14.2 9.8 L23 12 L14.2 14.2 L12 23 L9.8 14.2 L1 12 L9.8 9.8 Z"
            fill="currentColor"
          />
        </svg>
        <p className="footer-line">{t('footer.line')}</p>
      </div>

      <nav className="footer-links" aria-label={t('footer.nav')}>
        <Link href="/docs">{t('nav.docs')}</Link>
        <a href="/#contact">{t('nav.contact')}</a>
        <Link href="/terms">{t('legal.terms')}</Link>
        <Link href="/privacy">{t('legal.privacy')}</Link>
      </nav>

      <span className="mono-label footer-copy">{t('footer.copy')}</span>
    </footer>
  );
}
