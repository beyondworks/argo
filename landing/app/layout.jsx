import './globals.css';
import { LanguageProvider } from '@/lib/i18n';
import SmoothScroll from '@/components/SmoothScroll';
import LightboxProvider from '@/components/Lightbox';

export const metadata = {
  metadataBase: new URL('https://argo.ceo'),
  title: 'Argo — The AI agent that remembers everything and never loses the thread',
  description:
    'Folder-scale long-term memory keeps every conversation intact. Switch devices or come back days later — your AI agent picks up exactly where you left off. Start with a single prompt.',
  applicationName: 'Argo',
  keywords: [
    'llm wiki',
    'AI agent that remembers my files',
    'self-updating wiki for AI agents',
    'AI knowledge base that grows on its own',
    'AI agent with folder-scale memory',
    'AI chief of staff',
    'pick up AI conversation on Telegram',
    'AI crew that works while you sleep',
    'Argo',
    'AI 에이전트',
  ],
  alternates: { canonical: '/' },
  robots: { index: true, follow: true },
  openGraph: {
    type: 'website',
    url: 'https://argo.ceo',
    siteName: 'Argo',
    locale: 'en_US',
    alternateLocale: ['ko_KR'],
    title: 'Argo — Remembers everything. Never loses the thread.',
    description:
      'Folder-scale memory holds every context. Switch devices or come back days later — your AI agent picks up exactly where you left off.',
    images: [
      {
        url: '/assets/og.png',
        width: 2400,
        height: 1260,
        alt: 'The ship Argo sailing toward a guiding star — Argo, the AI agent that remembers everything and never loses the thread',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Argo — Remembers everything. Never loses the thread.',
    description:
      'An AI agent with folder-scale memory that never drops context. Start with a single prompt.',
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
    'An AI agent SaaS that builds a company of AI crew from a single prompt, remembers every context with folder-scale memory, and never loses the thread across devices.',
  featureList: [
    'Built-in LLM wiki — memories link like wiki pages and update themselves',
    'Folder-scale long-term memory — remembers whole folders, not one note',
    'Pick up any conversation on Telegram or a new device, context intact',
    'AI chief of staff and specialist crew from a single prompt',
    'Scheduled routines that run while you sleep, zero idle cost',
  ],
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
