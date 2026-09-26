// 2026-09-25 cloud-config-gate(b3ac2f16)가 vite.config.js를 콜백 형태로 바꾸자 mergeConfig(base, …)로 합치던 브라우저 QA 픽스처 설정
// 17개가 전부 "Cannot merge config in form of callback"으로 기동 실패했고, 하루 넘게 아무도 몰랐다(하네스는 손으로만 띄우므로).
// 여기서 각 설정을 vite가 실제로 불러오는 방식 그대로 불러와, 기본 설정(react 플러그인·@argo 별칭)과 픽스처 대역이 함께 합쳐졌는지 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile } from 'vite';

const dir = fileURLToPath(new URL('.', import.meta.url));
const configs = readdirSync(dir).filter((f) => f.endsWith('.config.mjs'));

test('픽스처 설정 목록이 비어 있지 않다', () => assert.ok(configs.length > 0));

for (const file of configs) {
  test(`${file} — 콜백형 기본 설정을 풀어서 합친다`, async () => {
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, `${dir}${file}`, undefined, 'silent');
    const cfg = loaded.config;
    assert.equal(typeof cfg, 'object', '설정이 객체로 풀려야 한다');
    const names = cfg.plugins.flat(Infinity).filter(Boolean).map((p) => p.name);
    assert.ok(names.some((n) => n.startsWith('vite:react')), `기본 설정의 react 플러그인이 빠졌다: ${names}`);
    assert.ok(names.some((n) => n.startsWith('isolated-') || n.startsWith('mobile-scroll')), `픽스처 대역 플러그인이 빠졌다: ${names}`);
    assert.ok(cfg.resolve?.alias?.['@argo/ui'], '기본 설정의 @argo/ui 별칭이 빠졌다');
    assert.equal(cfg.server?.host, '127.0.0.1');
    assert.equal(typeof cfg.server?.port, 'number');
  });
}
