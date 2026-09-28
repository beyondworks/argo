// 훅 순서 핀 — 2026-09-29: 조직 로딩 조기 반환 뒤에 useRef를 추가해 로딩이 끝나는 순간 "Rendered more hooks" 로 앱 전체가 멈췄다.
// 소스·순수 함수 테스트는 통과했고 브라우저에서만 드러났다. 이 반환 뒤(같은 컴포넌트 안)에는 훅 호출이 없어야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('App 셸 — 조직 로딩 조기 반환 뒤에 훅을 부르지 않는다', async () => {
  const src = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const lines = src.split('\n');
  const at = lines.findIndex((l) => l.startsWith('  if (orgs === null) return '));
  assert.ok(at > 0, '조기 반환 줄을 찾지 못했다 — 테스트를 새 구조에 맞춰 갱신할 것');
  const end = lines.findIndex((l, i) => i > at && l.startsWith('function '));
  const after = lines.slice(at + 1, end).map((l, i) => [at + 2 + i, l]).filter(([, l]) => /(^|[^\w.])use[A-Z]\w*\(/.test(l.replace(/\/\/.*$/, '')));
  assert.deepEqual(after.map(([n, l]) => `${n}: ${l.trim().slice(0, 80)}`), []);
});
