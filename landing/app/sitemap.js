import { isLive } from '@/lib/products';

export default function sitemap() {
  const base = 'https://argo.ceo';
  return [
    { url: base, lastModified: '2026-07-16', changeFrequency: 'weekly', priority: 1 },
    { url: `${base}/messenger`, lastModified: '2026-09-29', changeFrequency: 'weekly', priority: 0.9 },
    ...(isLive('office') ? [{ url: `${base}/office`, lastModified: '2026-09-29', changeFrequency: 'weekly', priority: 0.8 }] : []),
    { url: `${base}/docs`, lastModified: '2026-07-16', changeFrequency: 'monthly', priority: 0.6 },
    { url: `${base}/download`, lastModified: '2026-09-26', changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/terms`, lastModified: '2026-10-05', changeFrequency: 'yearly', priority: 0.2 },
    { url: `${base}/refund`, lastModified: '2026-10-01', changeFrequency: 'yearly', priority: 0.2 },
    { url: `${base}/privacy`, lastModified: '2026-10-05', changeFrequency: 'yearly', priority: 0.2 },
  ];
}
