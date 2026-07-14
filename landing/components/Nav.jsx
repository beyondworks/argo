'use client';

import { useLang } from '@/lib/i18n';
import { useLenis } from '@/components/SmoothScroll';

function StarMark({ size = 18 }) {
  // 아르고 나침반 별 — 잉크 단색
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 1 L14.2 9.8 L23 12 L14.2 14.2 L12 23 L9.8 14.2 L1 12 L9.8 9.8 Z"
        fill="currentColor"
      />
    </svg>
  );
}

export default function Nav() {
  const { t, toggle } = useLang();
  const { lenis } = useLenis();

  const toDownload = () => {
    const el = document.getElementById('download');
    if (!el) return;
    if (lenis) lenis.scrollTo(el, { duration: 1.6 });
    else el.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <header className="nav">
      <div className="nav-brand">
        <StarMark />
        <span className="nav-wordmark">ARGO</span>
      </div>
      <div className="nav-actions">
        <button className="nav-lang" onClick={toggle} title="cmd+/">
          {t('nav.lang')}
        </button>
        <button className="nav-cta" onClick={toDownload}>
          {t('nav.cta')}
        </button>
      </div>
    </header>
  );
}
