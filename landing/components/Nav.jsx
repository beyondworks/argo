'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLang } from '@/lib/i18n';
import { useLenis } from '@/components/SmoothScroll';
import { DL, detectTarget } from '@/lib/downloads';
import BrandMark from '@/components/BrandMark';
import FamilySwitch from '@/components/FamilySwitch';
import { productOf } from '@/lib/products';

// GitHub 아이콘·스타 게이트 없음 — 다운로드는 설치파일로만(2026-09-29 운영과 동일하게 확정).
// 상단 DOWNLOAD = 기기 맞춤 설치파일 직다운로드(argo-agent 릴리스 자산 — 페이지가 아니라 파일).
// 패밀리 페이지(/messenger·/office)에선 본체 링크 대신 그 제품의 CTA 하나만(받기·대기자 신청) 둔다.
const MARK_TONE = { argo: 'gold', messenger: 'signal', office: 'pencil' };
const PAGE_CTA = { messenger: { id: 'get', key: 'msgr.nav.cta' }, office: { id: 'waitlist', key: 'office.nav.cta' } };

export default function Nav() {
  const { t, toggle } = useLang();
  const { lenis } = useLenis();
  const pathname = usePathname();
  const onLanding = pathname === '/';
  const product = productOf(pathname);
  const pageCta = PAGE_CTA[product];

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
      <BrandMark tone={MARK_TONE[product]} />
      <span className="nav-wordmark">ARGO</span>
    </>
  );

  return (
    <header className="nav">
      <div className="nav-brand">
        {onLanding || pageCta ? (
          <button type="button" className="nav-brand-btn" onClick={toTop} aria-label="Argo — 맨 위로">
            {brandInner}
          </button>
        ) : (
          <Link className="nav-brand-btn" href="/" aria-label="Argo — 홈">
            {brandInner}
          </Link>
        )}
      </div>

      <FamilySwitch />

      <div className="nav-actions">
        {!pageCta && (
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
          <Link className="nav-link" href="/refund">{t('legal.refund')}</Link>
        </span>
        )}

        <button className="nav-lang" onClick={toggle} title="cmd+/">
          {t('nav.lang')}
        </button>
        {pageCta ? (
          <a
            className="nav-cta"
            href={`#${pageCta.id}`}
            onClick={(e) => {
              e.preventDefault();
              document.getElementById(pageCta.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
          >
            {t(pageCta.key)}
          </a>
        ) : (
          <a className="nav-cta" href={DL.silicon} onClick={(e) => { e.preventDefault(); window.location.assign(DL[detectTarget()]); }}>
            {t('nav.cta')}
          </a>
        )}
      </div>
    </header>
  );
}
