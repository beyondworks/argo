import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

// 메신저와 같은 방식 — 공용 모듈은 복사하지 않고 별칭으로 함께 쓴다(크루 얼굴 규칙의 정본은 메신저).
const shared = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

/** 로컬 개발: /api/<dir>/<op> → api/<dir>/[op].js의 GET/POST(Vercel과 같은 파일·같은 Request/Response). 운영은 Vercel이 직접 연결한다 */
function localApi() {
  return {
    name: 'office-local-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const m = /^\/api\/([\w-]+)\/([\w-]+)/.exec(req.url ?? '');
        const file = m && fileURLToPath(new URL(`./api/${m[1]}/[op].js`, import.meta.url));
        if (!m || !existsSync(file)) return next();
        try {
          const mod = await server.ssrLoadModule(file);
          const fn = mod[req.method];
          if (!fn) { res.statusCode = 405; return res.end(); }
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
          const out = await fn(request);
          res.statusCode = out.status;
          out.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await out.arrayBuffer()));
        } catch (e) { next(e); }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // 서버 함수가 읽을 env(.env.local의 OFFICE_*·VITE_SUPABASE_*) — 브라우저 번들에는 VITE_ 접두사만 들어간다
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''), { ...process.env });
  return {
    plugins: [react(), localApi()],
    server: {
      cors: { origin: [/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/, 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'] },
      watch: { ignored: ['**/src-tauri/**'] },
    },
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: { '@msgr/crew-face': shared('apps/messenger/src/crew-face.mjs') },
    },
    build: { target: 'es2022' },
  };
});
