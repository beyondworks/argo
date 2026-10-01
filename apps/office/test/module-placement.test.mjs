import test from 'node:test';
import assert from 'node:assert/strict';
import { addModuleItem, appendPageModule, canEditModulePage, createModuleItem } from '../src/core/module-placement-model.js';
import { mergeLayout, mergePages } from '../src/core/layout.js';
import { LIBRARY_MODULES } from '../src/core/module-registry.js';

test('library restores an existing functional module without changing its identity or width', () => {
  const existing = [{ id: 'mail', size: 's', hidden: true, cfg: { count: 3 } }];
  const next = addModuleItem(existing, createModuleItem('mail', {}, () => 'new'));
  assert.deepEqual(next, [{ ...existing[0], hidden: false }]);
  assert.equal(existing[0].hidden, true);
});

test('multiple chart instances and their metrics survive a home layout reload', () => {
  const first = createModuleItem('chart-kpi', { metric: 'sales' }, () => 'first');
  const second = createModuleItem('chart-kpi', { metric: 'paid' }, () => 'second');
  const items = addModuleItem([first], second);
  const restored = mergeLayout(JSON.parse(JSON.stringify({ items })), LIBRARY_MODULES, 'me', []);
  assert.deepEqual(restored.filter(item => item.moduleId === 'chart-kpi'), items);
  assert.equal(restored.some(item => item.id === 'chart-line'), false);
});

test('page module addition retains headings, rich text and existing module configuration', () => {
  const original = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Quarterly plan' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Keep this text', marks: [{ type: 'bold' }] }] },
  ] };
  const before = structuredClone(original);
  const mail = createModuleItem('mail', {}, () => 'mail-instance');
  const withMail = appendPageModule(original, mail);
  const withChart = appendPageModule(withMail, createModuleItem('chart-kpi', {}, () => 'chart-instance'));
  assert.deepEqual(original, before);
  assert.deepEqual(withChart.content.slice(0, 2), before.content);
  assert.equal(withChart.content.filter(node => node.type === 'moduleGrid').length, 1);
  assert.deepEqual(withChart.content[2].attrs.items[0], mail);
  assert.equal(withChart.content[2].attrs.items.length, 2);
});

test('missing document is rejected rather than overwritten by an empty module page', () => {
  for (const doc of [undefined, null, {}, { type: 'doc' }]) {
    assert.throws(() => appendPageModule(doc, createModuleItem('mail')), /library.loadFailed/);
  }
});

test('library destination excludes read-only, other-space, trash and template pages', () => {
  const page = { space: 'me', access: 'full' };
  assert.equal(canEditModulePage(page, 'me'), true);
  assert.equal(canEditModulePage({ ...page, access: 'edit' }, 'me'), true);
  for (const patch of [{ access: 'view' }, { access: undefined }, { template: true }, { trashedAt: '2026-09-28' }, { space: 'org' }]) {
    assert.equal(canEditModulePage({ ...page, ...patch }, 'me'), false);
  }
});

test('unknown module and incompatible chart metric are rejected', () => {
  assert.throws(() => createModuleItem('unknown'), /library.invalid/);
  assert.throws(() => createModuleItem('chart-line', { metric: 'unknown' }), /library.invalid/);
});

test('same-version page refresh preserves the editor snapshot identity; newer content invalidates it', () => {
  const local = [{ id: 'page', version: 3, loadedAt: 123, content: { type: 'doc', content: [] } }];
  const options = { before: new Set(), pendingNow: new Set(), spaceOf: () => 'me' };
  const same = mergePages([{ id: 'page', version: 3, access: 'full' }], local, options).pages[0];
  assert.equal(same.loadedAt, 123);
  assert.deepEqual(same.content, local[0].content);
  const newer = mergePages([{ id: 'page', version: 4, access: 'full' }], local, options).pages[0];
  assert.equal(newer.loadedAt, undefined);
  assert.equal(newer.content, undefined);
});

// 이유(유건 10/1 5차 추가사항 3): 캘린더·할 일도 그래프처럼 '모듈 추가'로 여러 번 놓는다 — 사본마다 자기 cfg(보기·디자인·필터)를 따로 기억하고,
// 원본(id = 모듈 id)은 지금처럼 기본 배치에 한 개 있다. 사본을 숨기거나 기본 배치로 되돌려도 다른 모듈·원본은 그대로.
const HOME = [{ id: 'stats', size: 'full' }, { id: 'calendar', size: 'm' }, { id: 'todos', size: 'm' }];
const homeOf = (saved) => mergeLayout(saved, LIBRARY_MODULES, 'me', HOME);
test('캘린더·할 일은 여러 번 추가되고 사본마다 cfg가 따로다', () => {
  let items = homeOf(undefined);
  const base = structuredClone(items);
  items = addModuleItem(items, createModuleItem('calendar', {}, () => 'cal-2'));
  items = addModuleItem(items, createModuleItem('calendar', {}, () => 'cal-3'));
  items = addModuleItem(items, createModuleItem('todos', {}, () => 'todo-2'));
  assert.deepEqual(items.slice(0, base.length), base, '원본은 그대로(숨김이던 원본을 되살리지도 않는다)');
  assert.deepEqual(items.filter((x) => x.moduleId === 'calendar').map((x) => x.id), ['cal-2', 'cal-3']);
  // 사본마다 다른 보기·디자인·필터 — 저장(JSON)했다 다시 읽어도 각자 그대로
  items = items.map((x) => (x.id === 'cal-2' ? { ...x, cfg: { views: { view: 'month', filter: { kind: 'event' } }, cal: { design: 'accent' } } } : x.id === 'cal-3' ? { ...x, cfg: { views: { view: 'week' }, cal: { design: 'basic' } } } : x.id === 'todo-2' ? { ...x, cfg: { views: { view: 'kanban' } } } : x));
  const back = homeOf(JSON.parse(JSON.stringify({ items })));
  assert.deepEqual(back.filter((x) => ['stats', 'calendar', 'todos'].includes(x.moduleId ?? x.id)).map((x) => x.id), ['stats', 'calendar', 'todos', 'cal-2', 'cal-3', 'todo-2']);
  assert.deepEqual(back.find((x) => x.id === 'cal-2').cfg, { views: { view: 'month', filter: { kind: 'event' } }, cal: { design: 'accent' } });
  assert.deepEqual(back.find((x) => x.id === 'cal-3').cfg, { views: { view: 'week' }, cal: { design: 'basic' } });
  assert.deepEqual(back.find((x) => x.id === 'todo-2').cfg, { views: { view: 'kanban' } });
  assert.equal(back.find((x) => x.id === 'calendar').cfg, undefined, '원본 cfg는 건드리지 않는다');
});

test('사본을 숨겨도 되돌릴 수 있고, 기본 배치로 되돌리면 사본은 없어지고 원본만 남는다', () => {
  let items = addModuleItem(homeOf(undefined), createModuleItem('calendar', {}, () => 'cal-2'));
  items = items.map((x) => (x.id === 'cal-2' ? { ...x, cfg: { views: { view: 'mini' } }, hidden: true } : x));
  const hidden = homeOf(JSON.parse(JSON.stringify({ items }))).find((x) => x.id === 'cal-2');
  assert.deepEqual([hidden.hidden, hidden.cfg], [true, { views: { view: 'mini' } }], '숨겨도 설정은 남는다');
  const restored = items.map((x) => (x.id === 'cal-2' ? { ...x, hidden: false } : x));
  assert.equal(homeOf({ items: restored }).find((x) => x.id === 'cal-2').hidden, false);
  const reset = homeOf({ items: [] });
  assert.deepEqual(reset.filter((x) => (x.moduleId ?? x.id) === 'calendar').map((x) => x.id), ['calendar']);
  assert.deepEqual(reset.filter((x) => !x.hidden).map((x) => x.id), ['stats', 'calendar', 'todos']);
});

test('저장된 배치에 원본이 없어도(예전 저장값) 원본은 숨김으로 붙고, 사본만 있으면 더 붙지 않는다', () => {
  const legacy = homeOf({ items: [{ id: 'stats', size: 'full' }] });
  assert.deepEqual(legacy.filter((x) => ['calendar', 'todos'].includes(x.id)).map((x) => [x.id, x.hidden]), [['calendar', true], ['todos', true]]);
  const copiesOnly = homeOf({ items: [{ id: 'a1', moduleId: 'calendar', size: 'm' }, { id: 'b1', moduleId: 'todos', size: 'm' }] });
  assert.deepEqual(copiesOnly.map((x) => x.id).filter((id) => ['calendar', 'todos'].includes(id)), [], '원본을 다시 만들지 않는다');
  assert.equal(copiesOnly.filter((x) => x.moduleId === 'calendar').length, 1);
});

test('다른 기능 모듈은 지금처럼 한 개만 — 숨긴 걸 되살린다', () => {
  for (const id of ['mail', 'work', 'pages', 'approvals']) assert.ok(!LIBRARY_MODULES.find((m) => m.id === id).repeatable, id);
  assert.deepEqual(LIBRARY_MODULES.filter((m) => m.repeatable && !m.chartType).map((m) => m.id), ['calendar', 'todos']);
});
