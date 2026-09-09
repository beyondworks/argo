#!/usr/bin/env node
// HTTP smoke of the exact Vite distribution served by the desktop webview.
// Native rendering/OAuth remain separate acceptance checks on each desktop platform.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { preview } from '../apps/messenger/node_modules/vite/dist/node/index.js';
const server = await preview({ root: resolve('apps/messenger'), preview: { host: '127.0.0.1', port: 0, strictPort: true, open: false } });
try {
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const response = await fetch(base);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /id="root"/);
  const assets = [...html.matchAll(/(?:src|href)="([^"?#]+\.(?:js|css))"/g)].map(match => match[1]);
  assert(assets.some(asset => asset.endsWith('.js')), 'Missing application entry');
  assert(assets.some(asset => asset.endsWith('.css')), 'Missing application styles');
  for (const asset of assets) {
    const result = await fetch(new URL(asset, base));
    assert.equal(result.status, 200, asset);
    assert((await result.text()).length > 0, `Empty asset: ${asset}`);
  }
  assert.equal(html, await readFile(resolve('apps/messenger/dist/index.html'), 'utf8'));
  console.log(`Messenger distribution HTTP smoke OK: entry + ${assets.length} referenced assets`);
} finally { await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve())); }
