'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLang } from '@/lib/i18n';
import { useLenis } from '@/components/SmoothScroll';
import { DL, useStarGate } from '@/components/StarModal';

// 공개 배포 repo — 스타가 쌓이는 곳
const GITHUB_URL = 'https://github.com/beyondworks/argo-agent';

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

function GitHubMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.26 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
    </svg>
  );
}

export default function Nav() {
  const { t, toggle } = useLang();
  const { lenis } = useLenis();
  const pathname = usePathname();
  const onLanding = pathname === '/';
  const { gate, modal } = useStarGate(); // 상단 DOWNLOAD = 스타 게이트 → 기기 맞춤 직다운로드

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
      <StarMark />
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

        {GITHUB_URL ? (
          <a
            className="nav-icon"
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub"
          >
            <GitHubMark />
          </a>
        ) : (
          <span
            className="nav-icon nav-icon-soon"
            title={t('nav.githubSoon')}
            aria-label="GitHub (준비 중)"
          >
            <GitHubMark />
          </span>
        )}

        <button className="nav-lang" onClick={toggle} title="cmd+/">
          {t('nav.lang')}
        </button>
        <a className="nav-cta" href={DL.silicon} onClick={(e) => gate(e)}>
          {t('nav.cta')}
        </a>
      </nav>
      {modal}
    </header>
  );
}
