// Shared module metadata. Rendering belongs to each surface.
const BUSINESS_ICONS = { customers: 'person', catalog: 'tag', orders: 'deal', inventory: 'box', payments: 'receipt', analytics: 'chart', marketing: 'megaphone', performance: 'target' };
export const OFFICE_MODULES = [
  { id: 'stats', title: 'mod.stats', icon: 'layout', sizes: ['l', 'full'], defaultSize: 'full', spaces: ['me', 'org'], intro: 'top' },
  { id: 'approvals', title: 'mod.approvals', icon: 'stamp', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'm', spaces: ['me', 'org'], link: '/approvals' },
  { id: 'mail', title: 'mod.mail', icon: 'mail', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'm', spaces: ['me'], link: '/mail' },
  { id: 'todos', title: 'mod.todos', icon: 'check', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'm', spaces: ['me'] },
  { id: 'pages', title: 'mod.pages', icon: 'doc', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'm', spaces: ['me', 'org'] },
  { id: 'work', title: 'mod.work', icon: 'run', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'm', spaces: ['me', 'org'], link: '/work' },
  { id: 'outputs', title: 'mod.outputs', icon: 'file', sizes: ['m', 'l', 'full'], defaultSize: 'l', spaces: ['org'], link: '/outputs' },
  { id: 'journal', title: 'mod.journal', icon: 'book', sizes: ['s', 'm', 'l', 'full'], defaultSize: 's', spaces: ['org'], link: '/journal' },
  { id: 'decisions', title: 'mod.decisions', icon: 'check', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'full', spaces: ['org'], link: '/decisions' },
  ...['customers', 'catalog', 'orders', 'inventory', 'payments', 'analytics', 'marketing', 'performance'].map((businessTab) => ({
    id: `biz-${businessTab}`, businessTab, title: `bizui.${businessTab}`, icon: BUSINESS_ICONS[businessTab],
    sizes: ['s', 'm', 'l', 'full'], defaultSize: 'm', spaces: ['me', 'org'], link: `/business/${businessTab}`,
  })),
];

export const BUSINESS_MODULES = OFFICE_MODULES.filter((module) => module.businessTab);
export const CHART_MODULES = ['kpi', 'line', 'bar', 'donut', 'table'].map((id) => ({
  id, title: `biz.chart.${id}`, sizes: ['s', 'm', 'l', 'full'], defaultSize: id === 'table' ? 'full' : ['kpi', 'donut'].includes(id) ? 's' : 'l', icon: 'chart',
}));

export const LIBRARY_MODULES = [...OFFICE_MODULES, ...CHART_MODULES.map((chart) => ({
  ...chart, id: `chart-${chart.id}`, chartType: chart.id, spaces: ['me', 'org'], repeatable: true,
}))];
