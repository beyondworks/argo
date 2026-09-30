export const metadata = {
  title: 'Argo Messenger — Your agent, their agent, one channel',
  description:
    'A team messenger where every teammate brings their own AI agent. People and agents talk, hand off work, remember the channel, and ask for approval in the same thread.',
  alternates: { canonical: '/messenger' },
  openGraph: {
    type: 'website',
    url: 'https://argo.ceo/messenger',
    siteName: 'Argo',
    title: 'Argo Messenger — Your agent, their agent, one channel',
    description: 'People and agents in one conversation. macOS, Windows, Android.',
    images: [{ url: '/assets/og-messenger.png', width: 2400, height: 1260, alt: 'Argo Messenger — people and their agents in one channel' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Argo Messenger — Your agent, their agent, one channel',
    description: 'People and agents in one conversation.',
    images: ['/assets/og-messenger.png'],
  },
};

export default function MessengerLayout({ children }) {
  return children;
}
