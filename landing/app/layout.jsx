import './globals.css';
import { LanguageProvider } from '@/lib/i18n';
import SmoothScroll from '@/components/SmoothScroll';
import LightboxProvider from '@/components/Lightbox';

export const metadata = {
  metadataBase: new URL('https://argo.ceo'),
  title: 'Argo — 모든 맥락을 기억하고 끊기지 않는 AI 에이전트',
  description:
    '폴더째 기억하는 장기기억으로 대화가 끊기지 않습니다. 기기가 바뀌어도, 며칠이 지나도 하던 맥락 그대로 이어가는 AI 에이전트 — 프롬프트 한 줄로 시작하는 Argo.',
  applicationName: 'Argo',
  keywords: [
    'AI 에이전트',
    'AI 에이전트 회사',
    'AI 크루',
    '맥락 기억 AI',
    '장기 기억 AI 에이전트',
    '프롬프트로 AI 직원 만들기',
    'Argo',
    'AI agent',
    'persistent memory AI agent',
  ],
  alternates: { canonical: '/' },
  robots: { index: true, follow: true },
  openGraph: {
    type: 'website',
    url: 'https://argo.ceo',
    siteName: 'Argo',
    locale: 'ko_KR',
    alternateLocale: ['en_US'],
    title: 'Argo — 모든 맥락을 기억하고, 절대 끊기지 않는 AI 에이전트',
    description:
      '폴더째 기억하는 장기기억으로 대화가 끊기지 않습니다. 기기가 바뀌어도, 며칠이 지나도 하던 맥락 그대로.',
    images: [
      {
        url: '/assets/og.png',
        width: 2400,
        height: 1260,
        alt: '별을 향해 항해하는 아르고호 — 모든 맥락을 기억하고 끊기지 않는 AI 에이전트 Argo',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Argo — 모든 맥락을 기억하고, 절대 끊기지 않는 AI 에이전트',
    description: '폴더째 기억하는 장기기억으로 대화가 끊기지 않는 AI 에이전트. 프롬프트 한 줄로 시작.',
    images: ['/assets/og.png'],
  },
};

export const viewport = {
  themeColor: '#000000',
};

const JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Argo',
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'macOS, Web',
  url: 'https://argo.ceo',
  description:
    '프롬프트 한 줄로 AI 직원 회사를 만들고, 폴더 단위 기억으로 모든 맥락을 기억하며, 기기가 바뀌어도 끊기지 않는 AI 에이전트 SaaS.',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  publisher: { '@type': 'Organization', name: 'Argo', url: 'https://argo.ceo' },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
        />
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&family=Caveat:wght@500;600&family=Nanum+Pen+Script&display=swap"
        />
      </head>
      <body>
        <LanguageProvider>
          <SmoothScroll>
            <LightboxProvider>{children}</LightboxProvider>
          </SmoothScroll>
        </LanguageProvider>
      </body>
    </html>
  );
}
