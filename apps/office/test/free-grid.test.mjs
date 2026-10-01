// 자유 격자(유건 10/1 저녁 확정 — 추가사항 1·2). 규칙마다 이유 한 줄. node --test test/*.test.mjs
// 앞 절반은 바꾸기 전에 잠근 인접 행동(정규화·숨김·새 모듈·옛 줄 규칙)이다 — 자유 격자를 넣어도 그대로여야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLayout, rowsOf, rowInfo, spanOf } from '../src/core/layout.js';
import { normalizeModuleItems } from '../src/core/module-items.js';
import { normalizeDashboards } from '../src/business/dashboard-model.js';
import { LIBRARY_MODULES } from '../src/core/module-registry.js';

const REG = [
  { id: 'a', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'm', spaces: ['me'] },
  { id: 'b', sizes: ['m', 'full'], defaultSize: 'full', spaces: ['me'] },
  { id: 'n', sizes: ['s', 'm'], defaultSize: 's', spaces: ['me'] },
  { id: 'top', sizes: ['full'], defaultSize: 'full', spaces: ['me'], intro: 'top' },
  { id: 'r', sizes: ['s', 'm'], defaultSize: 's', spaces: ['me'], repeatable: true },
];

// ── 바꾸기 전에 잠근 인접 행동 ──

// 이유: 저장값 정규화 규칙(등록부 없는 모듈 버림·중복 id 버림·허용 크기 밖은 기본값·cfg·숨김 보존·새 모듈은 숨김으로 뒤에·도입 모듈은 맨 위)은 자유 격자에서도 그대로다.
test('잠금: 배치 병합 정규화 규칙', () => {
  const saved = { items: [{ id: 'gone', size: 'm' }, { id: 'b', size: 's', cfg: { k: 1 } }, { id: 'a', size: 'l', hidden: true }, { id: 'a', size: 'm' }, { id: 'r1', moduleId: 'r', size: 'm' }] };
  assert.deepEqual(mergeLayout(saved, REG, 'me', []), [
    { id: 'top', size: 'full', hidden: false },
    { id: 'b', size: 'full', hidden: false, cfg: { k: 1 } },
    { id: 'a', size: 'l', hidden: true },
    { id: 'r1', moduleId: 'r', size: 'm', hidden: false },
    { id: 'n', size: 's', hidden: true },
  ]);
});

// 이유: 페이지 안 모듈·업무 대시보드 정규화는 모르는 필드를 지킨다 — 새 필드(x·y)도 그대로 지나가야 저장한 자리가 남는다.
test('잠금: 페이지 모듈·대시보드 정규화는 다른 필드를 지킨다', () => {
  assert.deepEqual(normalizeModuleItems([{ id: 'calendar', size: 'zz', x: 6, y: 1, extra: 1 }])[0], { id: 'calendar', moduleId: 'calendar', size: 'm', x: 6, y: 1, extra: 1, hidden: false });
  const [d] = normalizeDashboards([{ id: 'd', name: 'D', widgets: [{ id: 'w', type: 'kpi', metric: 'sales', size: 's', x: 3, y: 0 }] }]);
  assert.deepEqual(d.widgets[0], { id: 'w', type: 'kpi', metric: 'sales', size: 's', x: 3, y: 0 });
});

// 이유: 자리(x·y)가 없는 옛 저장값은 지금처럼 그린다 — 줄 나누기·줄 높이 공유 규칙이 그대로여야 바꾼 직후 홈이 달라 보이지 않는다.
test('잠금: 옛 저장값의 줄 규칙(순서·열 수·줄 높이 공유)', () => {
  const home = mergeLayout(null, LIBRARY_MODULES, 'me', [{ id: 'stats', size: 'full' }, { id: 'approvals', size: 'm' }, { id: 'mail', size: 'm' }, { id: 'todos', size: 'l' }, { id: 'pages', size: 's' }, { id: 'calendar', size: 'm' }, { id: 'work', size: 'm' }]);
  const visible = home.filter((it) => !it.hidden);
  assert.deepEqual(rowsOf(visible).map((r) => r.map((it) => `${it.id}:${spanOf(it)}`)), [['stats:12'], ['approvals:6', 'mail:6'], ['todos:8', 'pages:4'], ['calendar:6', 'work:6']]);
  const info = rowInfo([{ id: 'a', size: 'm', h: 320 }, { id: 'b', size: 'm' }], () => ({}));
  assert.deepEqual([info.get('a').h, info.get('b').h, info.get('b').first], [320, 320, false]);
});
