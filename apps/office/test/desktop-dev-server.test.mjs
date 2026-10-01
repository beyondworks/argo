import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

test('native API preflight passes Vite middleware only for trusted origins', async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: fileURLToPath(new URL('../vite.config.js', import.meta.url)),
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, watch: null },
  });
  try {
    await server.listen();
    const { port } = server.httpServer.address();
    for (const origin of ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', 'https://untrusted.example']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/mail/config`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
      });
      assert.equal(response.headers.get('access-control-allow-origin'), origin === 'https://untrusted.example' ? null : origin);
      if (origin !== 'https://untrusted.example') assert.equal(response.status, 204);
    }
  } finally {
    await server.close();
  }
});
