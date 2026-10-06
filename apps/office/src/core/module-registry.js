// Shared module metadata. Rendering belongs to each surface.
// stack = 항목이 쌓이는 모듈 — 정한 높이가 없으면 고정 높이(base.css .module.fixed-h, 320px)로 그리고 안에서 스크롤한다.
// repeatable = 여러 번 놓을 수 있다(사본마다 자기 cfg — 보기·디자인·필터). anchor = 그래도 원본 한 개(id = 모듈 id)는 배치에 늘 있다(없으면 숨김으로 붙는다). 그래프는 원본 없이 사본만.
const BUSINESS_ICONS = { customers: 'person', catalog: 'tag', orders: 'deal', inventory: 'box', payments: 'receipt', analytics: 'chart', marketing: 'megaphone', performance: 'target' };
export const OFFICE_MODULES = [
  { id: 'stats', title: 'mod.stats', icon: 'layout', sizes: ['l', 'full'], defaultSize: 'full', spaces: ['me', 'org'], intro: 'top' },
  { id: 'attention', title: 'mod.attention', icon: 'pin', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'm', spaces: ['me', 'org'] }, // 챙길 것(18차) — 종 모양 알림함 대신(유건 결정 3)
  { id: 'approvals', title: 'mod.approvals', icon: 'stamp', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'm', spaces: ['me', 'org'], stack: 1, link: '/approvals' },
  { id: 'mail', title: 'mod.mail', icon: 'mail', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'm', spaces: ['me'], stack: 1, link: '/mail' },
  { id: 'calendar', title: 'mod.calendar', icon: 'calendar', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'm', spaces: ['me', 'org'], link: '/calendar', minBody: 200, repeatable: true, anchor: true }, // minBody = 높이를 줄일 때 본문 최소(px) — 달력·그래프가 알아볼 수 있게
  { id: 'todos', title: 'mod.todos', icon: 'check', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'm', spaces: ['me', 'org'], stack: 1, repeatable: true, anchor: true },
  { id: 'pages', title: 'mod.pages', icon: 'doc', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'm', spaces: ['me', 'org'], stack: 1 },
  { id: 'work', title: 'mod.work', icon: 'run', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'm', spaces: ['me', 'org'], stack: 1, link: '/work' },
  { id: 'outputs', title: 'mod.outputs', icon: 'file', sizes: ['m', 'l', 'full'], defaultSize: 'l', spaces: ['org'], stack: 1, link: '/outputs' },
  { id: 'journal', title: 'mod.journal', icon: 'book', sizes: ['s', 'm', 'l', 'full'], defaultSize: 's', spaces: ['org'], stack: 1, link: '/journal' },
  { id: 'decisions', title: 'mod.decisions', icon: 'check', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'full', spaces: ['org'], stack: 1, link: '/decisions' },
  ...['customers', 'catalog', 'orders', 'inventory', 'payments', 'analytics', 'marketing', 'performance'].map((businessTab) => ({
    id: `biz-${businessTab}`, businessTab, title: `bizui.${businessTab}`, icon: BUSINESS_ICONS[businessTab],
    sizes: ['s', 'm', 'l', 'full'], defaultSize: 'm', spaces: ['me', 'org'], link: `/business/${businessTab}`,
  })),
];

export const BUSINESS_MODULES = OFFICE_MODULES.filter((module) => module.businessTab);
// 홈 기본 배치 — 저장된 배치가 없는 공간에만 쓴다(저장된 배치에 새 모듈은 숨긴 채 뒤에 붙는다 — layout.js mergeLayout).
// 배치를 저장한 적 없는 기존 공간도 이 순서를 그대로 받으므로 기존 순서는 바꾸지 않고 '챙길 것'(18차)만 현황 바로 뒤에 끼운다(검수 LOW 2)
export const HOME_DEFAULTS = {
  me: [{ id: 'stats', size: 'full' }, { id: 'attention', size: 'm' }, { id: 'approvals', size: 'm' }, { id: 'mail', size: 'm' }, { id: 'todos', size: 'l' }, { id: 'pages', size: 's' }, { id: 'calendar', size: 'm' }, { id: 'work', size: 'm' }],
  org: [{ id: 'stats', size: 'full' }, { id: 'attention', size: 'm' }, { id: 'approvals', size: 'm' }, { id: 'work', size: 'm' }, { id: 'outputs', size: 'l' }, { id: 'journal', size: 's' }, { id: 'decisions', size: 'full' }, { id: 'calendar', size: 'm' }, { id: 'todos', size: 'm' }],
};
export const CHART_MODULES = ['kpi', 'line', 'bar', 'donut', 'table'].map((id) => ({
  id, title: `biz.chart.${id}`, sizes: ['s', 'm', 'l', 'full'], defaultSize: id === 'table' ? 'full' : ['kpi', 'donut'].includes(id) ? 's' : 'l', icon: 'chart',
  ...({ line: { minBody: 168 }, bar: { minBody: 168 }, donut: { minBody: 176 } })[id], // 그래프 120px + 데이터 표 줄 + 여백
}));

export const LIBRARY_MODULES = [...OFFICE_MODULES, ...CHART_MODULES.map((chart) => ({
  ...chart, id: `chart-${chart.id}`, chartType: chart.id, spaces: ['me', 'org'], repeatable: true,
}))];
