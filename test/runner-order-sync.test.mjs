// 러너를 추가할 때 함께 고쳐야 하는 **화면 배선**을 잠근다.
// PICK_ORDER(자동 선택 순서)는 이미 잠겨 있었지만 RUNNER_ORDER(설정·온보딩 렌더 목록)는
// 무방비였다 — grok을 추가하고 여기를 빠뜨려 "코드는 다 있는데 카드가 안 뜨는" 상태가
// 분리 검수에서 적발됐다(2026-08-03). 빌드·타입·기존 테스트 전부 초록이었다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RUNNER_AUTH } from '../src/runners/catalog.mjs';

const src = await readFile(new URL('../app/runner-connect.jsx', import.meta.url), 'utf8');
const order = JSON.parse(
  (src.match(/const RUNNER_ORDER = (\[[^\]]*\]);/) ?? [])[1].replace(/'/g, '"'),
);

test('RUNNER_ORDER ↔ RUNNER_AUTH — 목록에 없는 러너는 화면에서 유령이 된다', () => {
  assert.deepEqual([...order].sort(), Object.keys(RUNNER_AUTH).sort());
});

test('이름표도 함께 — 이름이 없으면 카드 제목이 빈칸으로 뜬다', () => {
  const names = src.match(/const RUNNER_NAMES = \{([^}]*)\}/)[1];
  for (const id of Object.keys(RUNNER_AUTH)) assert.match(names, new RegExp(`\\b${id}:`), `${id} 이름표 누락`);
});
