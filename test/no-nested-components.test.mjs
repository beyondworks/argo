// 컴포넌트 안에서 정의한 컴포넌트 금지 — 렌더마다 새 타입이 되어 React가 하위 DOM을 통째로 재마운트한다
// (실사고 2026-09-03: 설정 회사 정보 카드의 휴대폰 구획 래퍼 `const Wrap = cond ? ({children}) => <div…` → 주소
// 드롭다운이 닫히고 드래그 선택이 풀림 — 빌드·lint·육안 어디에도 안 걸린다). 들여쓰기된(=함수 본문 안) 대문자 이름의
// 화살표/함수 선언 중 JSX를 돌려주는 형태(`=> (` / `=> <`)를 red로 잡는다. 문자열 헬퍼(`const L = (href) => withSide(...)`)는 대상 아님.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './helpers/strip-comments.mjs';

const APP = fileURLToPath(new URL('../app', import.meta.url));
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const NESTED = /^[ \t]+(?:const|let|var)\s+[A-Z][A-Za-z0-9]*\s*=\s*(?:[^=\n]*?=>\s*(?:\(|<)|[^\n]*?\?\s*\([^)]*\)\s*=>)/;
const NESTED_FN = /^[ \t]+function\s+[A-Z][A-Za-z0-9]*\s*\(/;

test('app/**/*.jsx — 함수 본문 안에서 JSX 컴포넌트를 정의하지 않는다(재마운트 결함)', () => {
  const hits = [];
  for (const f of walk(APP).filter((x) => x.endsWith('.jsx'))) {
    const lines = stripComments(readFileSync(f, 'utf8')).split('\n');
    lines.forEach((line, i) => { if (NESTED.test(line) || NESTED_FN.test(line)) hits.push(`${f.slice(APP.length + 1)}:${i + 1}: ${line.trim().slice(0, 90)}`); });
  }
  assert.deepEqual(hits, [], '컴포넌트 안 컴포넌트 정의 — 모듈 수준으로 올릴 것');
});
