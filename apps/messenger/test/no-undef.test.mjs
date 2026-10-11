// 정의되지 않은 이름 0 — 한 줄 코드 중간의 `//` 주석이 뒤의 선언을 삼키면(#950 재검수: `const shownCrews`가 주석이 됨)
// 문자열 단언 시험은 통과하고 화면을 여는 순간 ReferenceError가 난다. 빌드(vite)도 이걸 잡지 않으므로 여기서 no-undef로 막는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Linter } = require('eslint');
const globals = require('globals');

export function undefinedNames(source, filename = 'x.jsx') {
  const linter = new Linter({ configType: 'flat' });
  const config = [{
    files: ['**/*.jsx', '**/*.mjs', '**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } }, globals: { ...globals.browser, ...globals.es2021 } },
    rules: { 'no-undef': 'error' },
  }];
  return linter.verify(source, config, { filename })
    .filter((m) => m.ruleId === 'no-undef' || m.fatal)
    .map((m) => `${filename}:${m.line} ${m.message}`);
}

test('메신저 src — 정의되지 않은 이름(no-undef)·구문 오류 0', () => {
  const dir = new URL('../src/', import.meta.url);
  const files = readdirSync(dir).filter((f) => /\.(jsx|mjs|js)$/.test(f));
  assert.ok(files.includes('App.jsx'));
  const found = files.flatMap((f) => undefinedNames(readFileSync(new URL(f, dir), 'utf8'), f));
  assert.deepEqual(found, []);
});

test('검사기가 주석에 삼켜진 선언을 실제로 잡는다', () => {
  const src = 'export function A() { const a = 1; // 설명 const b = 2;\n  return a + b; }\n';
  assert.equal(undefinedNames(src).length, 1);
});
