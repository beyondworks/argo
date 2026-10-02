import test from 'node:test';
import assert from 'node:assert/strict';
import { keyMenu } from '../src/core/company-model.js';
import { pageMenuIds } from '../src/files/model.js';

// 이유(유건 10/2 10차): 회사 정보의 '서식' 표와 문서함 머리 ⋯가 눌러도 반응이 없었다 — 누르면 할 수 있는 일이 늘 하나 이상 있어야 한다.
test('서식 표 메뉴: 서식 칸 항목은 견적서·계약서 작성 화면으로, 관리자만 칸 바꾸기', () => {
  const item = { id: 'a', key: 'name', label: '상호' };
  assert.deepEqual(keyMenu(item).map((m) => m.to ?? m.id), ['contracts?new=quote', 'contracts?new=contract']);
  assert.deepEqual(keyMenu(item, { manager: true }).map((m) => m.id), ['quote', 'contract', 'change']);
  assert.equal(keyMenu(item, { manager: true }).at(-1).edit, true);
  assert.deepEqual(keyMenu({ key: 'seal' }).map((m) => m.id), ['quote', 'contract']); // 도장도 서식에 찍힌다
  assert.deepEqual(keyMenu({ key: null }), []); // 서식 칸이 없으면 메뉴도 없다(표도 안 그린다)
  assert.deepEqual(keyMenu({ key: 'nope' }, { manager: true }), []);
});

test('문서함 머리 ⋯: 탭마다 새로고침 + 그 화면에서 할 일, 휴지통은 비울 것이 없으면 비활성', () => {
  assert.deepEqual(pageMenuIds('all', { rows: 3 }), ['refresh', 'newFolder', 'drive', 'selAll']);
  assert.deepEqual(pageMenuIds('all', { rows: 3, allSelected: true }).at(-1), 'selNone');
  assert.deepEqual(pageMenuIds('all', { rows: 0 }), ['refresh', 'newFolder', 'drive']);
  assert.deepEqual(pageMenuIds('customers'), ['refresh', 'drive']);
  assert.deepEqual(pageMenuIds('trash', { purgeable: 2 }), ['refresh', 'sep', 'emptyTrash']);
  assert.deepEqual(pageMenuIds('trash', { purgeable: 0 }), ['refresh', 'sep', 'emptyTrash:off']);
  for (const tab of ['all', 'customers', 'trash']) assert.ok(pageMenuIds(tab).length > 1, `${tab}: 새로고침 하나뿐인 메뉴 금지`);
});

// 이유(유건 9/30 금지, 10/2 재발 — 서명자 카드 왼쪽 색 막대): 카드·행 한쪽에 색 띠를 두르는 모양은 오피스 어디에도 두지 않는다.
// 1px 경계선(칸 나눔)은 띠가 아니다. 인용문(.md blockquote) 회색 선은 문서 서식이라 둔다.
import { readFileSync, readdirSync } from 'node:fs';
test('화면 css: 카드·행 한쪽 색 띠(왼쪽 막대) 금지', () => {
  const root = new URL('../src/', import.meta.url);
  const files = [];
  const walk = (u) => { for (const e of readdirSync(u, { withFileTypes: true })) { const n = new URL(e.name + (e.isDirectory() ? '/' : ''), u); if (e.isDirectory()) walk(n); else if (e.name.endsWith('.css')) files.push(n); } };
  walk(root);
  const bad = [];
  for (const f of files) {
    const css = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const rule of css.split('}')) {
      const [sel = '', body = ''] = rule.split('{');
      if (/blockquote/.test(sel)) continue;
      if (/inset\s+-?([2-9]|\d{2,})(\.\d+)?px\s+0\s+0/.test(body) || /border-(left|right|inline-start|inline-end)\s*:\s*([2-9]|\d{2,})px/.test(body)) bad.push(`${f.pathname.split('/src/')[1]}: ${sel.trim()}`);
    }
  }
  assert.deepEqual(bad, []);
});
