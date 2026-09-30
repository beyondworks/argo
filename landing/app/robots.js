export default function robots() {
  return {
    rules: { userAgent: '*', allow: '/' },
    sitemap: 'https://argo.ceo/sitemap.xml',
    host: 'https://argo.ceo',
  };
}
