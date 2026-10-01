import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const shared = (path) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const fake = fileURLToPath(new URL('./auth-providers.supabase.mjs', import.meta.url));
export default defineConfig({
  root,
  envDir: false,
  plugins: [react(), {
    name: 'offline-auth-provider-fixture', enforce: 'pre',
    resolveId(source) { if (source === './supabase.js') return fake; },
  }],
  resolve: { dedupe: ['react', 'react-dom'], alias: {
    '@argo/slash-match': shared('app/c/[ws]/slash-match.mjs'),
    '@argo/globals.css': shared('app/globals.css'),
    '@argo/theme': shared('app/theme.jsx'),
    '@argo/ui': shared('app/ui.jsx'),
    '@argo/i18n': shared('app/i18n.jsx'),
    '@argo/graph2d-core': shared('app/c/[ws]/graph2d-core.mjs'),
    '@argo/splash': shared('public/splash/north-star.mjs'),
  } },
  server: { host: '127.0.0.1', port: 5229, strictPort: true, fs: { allow: [shared('.')] } },
});
