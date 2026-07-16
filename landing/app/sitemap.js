export default function sitemap() {
  const base = 'https://argo.ceo';
  return [
    { url: base, lastModified: '2026-07-16', changeFrequency: 'weekly', priority: 1 },
    { url: `${base}/docs`, lastModified: '2026-07-16', changeFrequency: 'monthly', priority: 0.6 },
    { url: `${base}/terms`, lastModified: '2026-07-16', changeFrequency: 'yearly', priority: 0.2 },
    { url: `${base}/privacy`, lastModified: '2026-07-16', changeFrequency: 'yearly', priority: 0.2 },
  ];
}
