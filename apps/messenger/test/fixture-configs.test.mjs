import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from 'vite';

// 브라우저 픽스처 설정(test/*.config.mjs)은 사람이 vite CLI로 띄울 때만 실행돼 CI가 열어 보지 않았다.
// vite.config.js가 발행 관문(scripts/cloud-config-gate.mjs)으로 콜백 설정이 되자 mergeConfig(base, …)로 쓴 설정 12개가
// "Cannot merge config in form of callback"으로 실행되지 않은 채 남아 있었다(2026-10-04 발견).
// apps/messenger에서 `vite --config test/<이름>.config.mjs`를 실행할 때와 같은 방식으로 풀어 본다 — 서버는 띄우지 않는다.
const root = fileURLToPath(new URL('..', import.meta.url));
const dir = fileURLToPath(new URL('.', import.meta.url));
const configs = readdirSync(dir).filter((name) => name.endsWith('.config.mjs'));

test('every browser fixture config resolves the way `vite --config` loads it', async (t) => {
  assert.ok(configs.length > 0, 'no test/*.config.mjs found');
  for (const name of configs) {
    await t.test(name, () => resolveConfig({ configFile: join(dir, name), root, logLevel: 'silent' }, 'serve', 'development'));
  }
});
