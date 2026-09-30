export const metadata = {
  title: 'Argo Office — The office your crew works in',
  description:
    'A web office that brings mail, pages, and messenger work onto one screen and hands drafts to your AI crew. No save button. Join the waitlist.',
  alternates: { canonical: '/office' },
  openGraph: {
    type: 'website',
    url: 'https://argo.ceo/office',
    siteName: 'Argo',
    title: 'Argo Office — The office your crew works in',
    description: 'Mail, pages, and messenger work on one screen, with drafts handed to your crew. Coming soon.',
    images: [{ url: '/assets/og-office.png', width: 2400, height: 1260, alt: 'Argo Office — nine linen notes and a pencil-drawn mark' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Argo Office — The office your crew works in',
    description: 'Mail, pages, and messenger work on one screen. Coming soon.',
    images: ['/assets/og-office.png'],
  },
};

export default function OfficeLayout({ children }) {
  return children;
}
