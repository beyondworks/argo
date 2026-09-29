'use client';

import Link from 'next/link';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import DownloadSection from '@/components/DownloadSection';
import { useLang } from '@/lib/i18n';

// 다운로드 전용 페이지 — 설치파일 버튼만 있고 가격·결제 링크는 없다.
// 메신저 앱의 "Argo 앱 받기"가 여기로 온다(App Store 3.1.1: 앱 안 링크가 외부 결제로 이어지지 않게).
// 랜딩의 #download 섹션 바로 아래에는 가격표(결제 링크)가 있어 앱에서 그쪽으로 보내지 않는다.
export default function DownloadPage() {
  const { t } = useLang();
  return (
    <main className="doc-main download-page">
      <Nav />
      <DownloadSection />
      <p className="download-page-help">
        {t('download.page.help')}{' '}
        <Link href="/docs#quickstart">{t('download.page.docs')}</Link>
      </p>
      <Footer />
    </main>
  );
}
