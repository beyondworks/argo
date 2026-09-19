// --mark 바탕 위 글자는 테마 토큰 --mark-fg로만 — graphite-light에서 --mark가 #1a1a1a라 글자 #1a1a1a 고정 4곳이 안 보였다(D12, 2026-09-19 전수 점검).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('background: var(--mark) 규칙은 글자색을 고정하지 않는다(--mark-fg 사용)', async () => {
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  const rules = css.match(/[^{}]+\{[^{}]*background:\s*var\(--mark\)[^{}]*\}/g) ?? [];
  assert.ok(rules.length >= 8, `--mark 바탕 규칙을 찾음: ${rules.length}`);
  const fixed = rules.filter((r) => /(^|[;{\s])color:\s*(#|rgb)/.test(r));
  assert.deepEqual(fixed.map((r) => r.trim().slice(0, 60)), [], '--mark 바탕 위 고정 글자색');
});
