'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLang } from '@/lib/i18n';
import { useLenis } from '@/components/SmoothScroll';
import { DL, detectTarget } from '@/lib/downloads';
import BrandMark from '@/components/BrandMark';

// 소스 레포 링크·스타 게이트 제거(2026-09-07 유건 지시: 레포 프라이빗 전환, 다운로드는 파일로만).
// 상단 DOWNLOAD = 기기 맞춤 설치파일 직다운로드(argo-agent 릴리스 자산 — 페이지가 아니라 파일).

export default function Nav() {
  const { t, toggle } = useLang();
  const { lenis } = useLenis();
  const pathname = usePathname();
  const onLanding = pathname === '/';

  const scrollTo = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    // 설치 섹션이 풀스크린 센터 정렬로 바뀌어(챕터 문법) 오프셋 불필요 — 섹션 상단 = 화면 상단
    if (lenis) lenis.scrollTo(el, { duration: 1.6 });
    else el.scrollIntoView({ behavior: 'smooth' });
  };
  const toTop = () => {
    if (lenis) lenis.scrollTo(0, { duration: 1.4 });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // 랜딩에선 부드러운 스크롤, 다른 페이지에선 홈 앵커(/#id)로 이동
  const anchorProps = (id) =>
    onLanding
      ? { href: `#${id}`, onClick: (e) => { e.preventDefault(); scrollTo(id); } }
      : { href: `/#${id}` };

  const brandInner = (
    <>
      <BrandMark />
      <span className="nav-wordmark">ARGO</span>
    </>
  );

  return (
    <header className="nav">
      <div className="nav-brand">
        {onLanding ? (
          <button type="button" className="nav-brand-btn" onClick={toTop} aria-label="Argo — 맨 위로">
            {brandInner}
          </button>
        ) : (
          <Link className="nav-brand-btn" href="/" aria-label="Argo — 홈">
            {brandInner}
          </Link>
        )}
      </div>

      <nav className="nav-actions">
        <span className="nav-links">
          <Link className="nav-link" href="/docs">
            {t('nav.docs')}
          </Link>
          <a className="nav-link" {...anchorProps('install')}>
            {t('nav.install')}
          </a>
          <a className="nav-link" {...anchorProps('contact')}>
            {t('nav.contact')}
          </a>
        </span>

        <button className="nav-lang" onClick={toggle} title="cmd+/">
          {t('nav.lang')}
        </button>
        <a className="nav-cta" href={DL.silicon} onClick={(e) => { e.preventDefault(); window.location.assign(DL[detectTarget()]); }}>
          {t('nav.cta')}
        </a>
      </nav>
    </header>
  );
}
