// 직접 배치(custom) 정렬 — 유건 확정 2026-09-29: DM 탭·"내 에이전트" 레일 둘 다 같은 순수 함수를 쓴다.
// 저장된 순서(sort_pos)가 있는 항목은 그 순서대로, 새로 생긴 항목(sort_pos 없음)은 맨 아래(그 안에서는 이름순).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sortDms, sortByCustomOrder, DM_SORTS } from '../src/dm-sort.mjs';

const items = [{ id: 'a', name: '나' }, { id: 'b', name: '가' }, { id: 'c', name: '다' }, { id: 'd', name: '라' }];
const ids = (l) => l.map((x) => x.id).join('');

test('sortByCustomOrder — 저장된 sort_pos 오름차순', () => {
  assert.equal(ids(sortByCustomOrder(items, { a: 2, b: 0, c: 1, d: 3 })), 'bcad');
});

test('sortByCustomOrder — sort_pos 없는 새 항목은 맨 아래(그 안은 이름순), 입력을 바꾸지 않는다', () => {
  const copy = [...items];
  assert.equal(ids(sortByCustomOrder(items, { a: 1, b: 0 })), 'bacd', 'c·d는 sort_pos 없어 맨 아래, 이름순(다<라)');
  assert.deepEqual(items, copy);
});

test('sortByCustomOrder — 아무도 sort_pos가 없으면 전부 이름순', () => {
  assert.equal(ids(sortByCustomOrder(items, {})), 'bacd');
});

test('DM_SORTS에 custom 포함, sortDms(sort:"custom")는 sortByCustomOrder와 같다', () => {
  assert.ok(DM_SORTS.includes('custom'));
  const sortPos = { a: 1, b: 0 };
  assert.equal(ids(sortDms(items, { sort: 'custom', sortPos, nameOf: (x) => x.name })), ids(sortByCustomOrder(items, sortPos, (x) => x.name)));
});

// 배선 — DM 탭·rail 정렬 메뉴에 '직접 배치' 옵션, App.jsx가 sortByCustomOrder를 쓴다, i18n 두 언어
test('배선 — dm.sort 메뉴와 rail.sort 메뉴에 custom 옵션, sort_pos 저장', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /sortByCustomOrder/, 'App.jsx가 공용 순수 함수를 쓴다');
  assert.match(src, /\['name', 'added', 'custom'\]/, 'rail 정렬 메뉴에 직접 배치 추가');
  const dict = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
  for (const k of ['dm.sort.custom', 'rail.sort.custom']) assert.match(dict, new RegExp(`'${k.replace(/\./g, '\\.')}': \\[["'][^"']+["'], ["'][^"']+["']\\]`), `${k} ko/en`);
});
