import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// 메신저와 같은 방식 — 공용 모듈은 복사하지 않고 별칭으로 함께 쓴다(크루 얼굴 규칙의 정본은 메신저).
const shared = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: { '@msgr/crew-face': shared('apps/messenger/src/crew-face.mjs') },
  },
  build: { target: 'es2022' },
});
