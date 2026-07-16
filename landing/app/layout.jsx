import './globals.css';
import { LanguageProvider } from '@/lib/i18n';
import SmoothScroll from '@/components/SmoothScroll';
import LightboxProvider from '@/components/Lightbox';

export const metadata = {
  metadataBase: new URL('https://argo.ceo'),
  title: 'Argo — The AI agent that remembers everything and never loses the thread',
  description:
    'Not one markdown note — Argo remembers whole folders. Leave your PC and pick up the thread anywhere. A built-in LLM wiki links related work so knowledge compounds, repeated work becomes skills automatically, and idle time costs zero tokens.',
  applicationName: 'Argo',
  keywords: [
    'llm wiki',
    'AI agent that remembers my files',
    'self-updating wiki for AI agents',
    'AI knowledge base that grows on its own',
    'AI agent with folder-scale memory',
    'AI that turns repeated work into skills',
    'pick up AI conversation on Telegram',
    'AI agent zero idle cost',
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
      'Infinite folder-scale memory, not one markdown note. Leave your PC — the thread follows you. Knowledge compounds in a built-in LLM wiki. Idle costs zero.',
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
      'Infinite folder-scale memory. Leave your PC — the thread follows you. Knowledge compounds, repeated work becomes skills, idle costs zero.',
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
    'An AI agent with infinite folder-scale memory that never loses the thread — leave your PC and the context follows you. Knowledge compounds in a built-in LLM wiki, repeated work becomes skills automatically, and idle time costs zero tokens.',
  featureList: [
    'Infinite folder-scale memory — remembers whole folders, not a single markdown note',
    'Never loses the thread — leave your PC and pick up on Telegram or any device, context intact',
    'Built-in LLM wiki — related work links itself, so knowledge compounds over time',
    'Do it twice and it becomes a skill — repeated work turns into reusable skills automatically',
    'Zero tokens while idle — pay for work, not waiting',
    'Specialist AI crew from a single prompt',
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
