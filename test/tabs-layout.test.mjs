// 설정·크루 카드 가로 탭 — 순수 판정(resolveTab) + 소스 구간 불변식(카드마다 정확히 한 탭, 딥링크 → 탭, 다단 배치, i18n).
// JSX 배선은 구간 불변식으로만 잠긴다(argo-graph-empty-sky 교훈) — 여기서는 "탭 pane 안에 정확히 한 번"을 센다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveTab } from '../app/tabs-state.mjs';

const load = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('resolveTab — ?tab= > 저장값 > 기본, 목록 밖 값은 조용히 다음 후보로', () => {
  const ids = ['general', 'ai', 'danger'];
  assert.equal(resolveTab({ query: 'ai', stored: 'danger', ids, fallback: 'general' }), 'ai');
  assert.equal(resolveTab({ query: null, stored: 'danger', ids, fallback: 'general' }), 'danger');
  assert.equal(resolveTab({ query: 'nope', stored: 'zzz', ids, fallback: 'general' }), 'general', '둘 다 목록 밖 → 기본');
  assert.equal(resolveTab({ query: undefined, stored: null, ids, fallback: 'gone' }), 'general', '기본조차 목록 밖 → 첫 탭');
  assert.equal(resolveTab({ query: 42, stored: {}, ids, fallback: 'general' }), 'general', '문자열 아닌 값 무시');
});

/** pane 별 본문 추출 — `data-tab-pane="<id>"` 컨테이너 시작부터 다음 pane(또는 끝)까지 */
function panes(src, ids) {
  const out = {};
  for (const id of ids) {
    const re = new RegExp(`data-tab-pane="${id}"`, 'g');
    const m = [...src.matchAll(re)];
    assert.equal(m.length, 1, `pane ${id}는 정확히 한 번`);
    const start = m[0].index;
    const rest = src.slice(start + 1);
    const next = rest.search(/data-tab-pane="/);
    out[id] = next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
  }
  return out;
}

test('설정 — 카드 17개가 정확히 한 탭에만, 순서는 작은 카드 → 전폭(.wide)', async () => {
  const src = await load('../app/c/[ws]/settings/page.jsx');
  const ids = ['general', 'ai', 'connections', 'devices', 'danger'];
  assert.match(src, /const SETTINGS_TABS = \['general', 'ai', 'connections', 'devices', 'danger'\];/);
  assert.match(src, /useRememberedTab\('argo-settings-tab', SETTINGS_TABS, 'general', wantTab\)/, '마지막 탭 기억 + 딥링크');
  assert.match(src, /const wantTab = sp\.get\('ai'\) \? 'ai' : sp\.get\('tab'\);/, '?ai= 딥링크는 AI 탭, ?tab=은 그 탭');
  assert.doesNotMatch(src, /scrollIntoView/, '스크롤 딥링크 잔재 없음(탭 활성화로 대체)');
  const p = panes(src, ids);
  const cards = {
    general: ["onSubmit={saveName}", "t('settings.spec')", '<LanguageCard />', '<CrewLanguageCard', '<ZoomCard />', '<ThemeCard />'],
    ai: ['<AiConnectionCard'],
    connections: ['kind="telegram"', 'kind="slack"', '<ConnectorsCard'],
    devices: ['<DevicesCard', '<UpdateCard />', '<SystemPermissionsCard />', '<ExportCard', '<TrashCard', '<WorkRootsCard', '<SyncCard', '<E2eeCard />', '<ImportCard'],
    danger: ["t('settings.archive.title')"],
  };
  for (const [id, list] of Object.entries(cards)) {
    for (const c of list) {
      const inPane = ids.filter((k) => p[k].includes(c));
      assert.deepEqual(inPane, [id], `${c} → ${id} 탭에만`);
    }
  }
  assert.equal(Object.values(cards).flat().length, 20, '카드 목록 점검용 상수(17 카드 + 회사 정보·제원·보관 = 20 항목)');
  // 행 묶음: 변동이 큰 카드(연결·커넥터·외부 폴더·동기화·E2EE·가져오기·테마·AI)는 혼자 한 행 — 이웃을 늘리지 않는다
  const rows = src.split('<div className="cardrow">').slice(1).map((chunk) => chunk.slice(0, chunk.indexOf('\n      </div>\n') === -1 ? undefined : chunk.indexOf('\n      </div>\n')));
  const cardCount = (chunk) => (chunk.match(/<[A-Z][A-Za-z0-9]+Card\b|<ConnectionCard\b|className="card"/g) ?? []).length; // form도 className="card"로 센다
  for (const solo of ['kind="telegram"', 'kind="slack"', '<ConnectorsCard', '<WorkRootsCard', '<SyncCard', '<E2eeCard />', '<ImportCard', '<ThemeCard />', '<AiConnectionCard']) {
    const row = rows.find((r) => r.includes(solo)); assert.ok(row, `${solo}는 row 안`);
    assert.equal(cardCount(row), 1, `${solo} 행에는 카드 하나`);
  }
  // 짝지은 행: 회사 정보+제원(2), 언어·크루 언어·배율(3), 기기·업데이트·권한(3), 내보내기·보관함(2)
  assert.equal(cardCount(rows.find((r) => r.includes('onSubmit={saveName}'))), 2, '회사 정보·제원 한 행');
  assert.equal(cardCount(rows.find((r) => r.includes('<LanguageCard />'))), 3, '언어·크루 언어·배율 한 행');
  assert.equal(cardCount(rows.find((r) => r.includes('<DevicesCard'))), 3, '기기·업데이트·권한 한 행');
  assert.equal(cardCount(rows.find((r) => r.includes('<ExportCard'))), 2, '내보내기·보관함 한 행');
  assert.match(src, /<Tabs label=\{t\('settings\.tab\.label'\)\} value=\{tab\} onChange=\{setTab\} className="settings-tabs"/, '공용 Tabs 배선');
  assert.equal((src.match(/<div className="cardcols" data-tab-pane="/g) ?? []).length, 5, '탭 본문 5개 전부 행 묶음(.cardcols > .cardrow)');
  assert.equal((src.match(/<div className="cardrow">/g) ?? []).length, 14, '행 수: 일반 3·AI 1·연결 3·기기 6·위험 1');
  assert.doesNotMatch(src, /gridColumn: '1 \/ -1'/, '카드 안 전폭 인라인 잔재 없음(행이 폭을 정한다)');
  assert.doesNotMatch(src, /function Section\(/, '옛 Section 래퍼 제거');
});

test('크루 카드 — 구간 11개가 탭 4개에 정확히 한 번, 모달 고정 높이 + 푸터 고정', async () => {
  const src = await load('../app/c/[ws]/crew/[slug]/page.jsx');
  const ids = ['overview', 'ability', 'style', 'link'];
  assert.match(src, /const CARD_TABS = \['overview', 'ability', 'style', 'link'\];/);
  assert.match(src, /useRememberedTab\('argo-card-tab', CARD_TABS, 'overview'\)/);
  const p = panes(src, ids);
  const sections = {
    overview: ["t('chat.recentWork')", "t('chat.card.engine')", '<StatsBlock'],
    ability: ["t('chat.card.scopeSkills')", "t('chat.card.scopeMcp')", "t('chat.card.mcpCliWarn')"],
    style: ["t('chat.card.rules')", "t('chat.boss.title')"],
    link: ["t('chat.tg.title')", "t('settings.conn.pairCodeLabel')", "t('chat.card.raw')"],
  };
  for (const [id, list] of Object.entries(sections)) for (const c of list) assert.deepEqual(ids.filter((k) => p[k].includes(c)), [id], `${c} → ${id}`);
  assert.match(src, /className="card card-float fade-up crew-card-modal" style=\{\{ width: 'min\(680px, 100%\)', height: 'calc\(86vh \/ var\(--z, 1\)\)'/, '모달 높이 고정(maxHeight 아님)');
  // 푸터(저장·편집·해고)는 스크롤 본문 밖 — 마지막 pane 닫힘 뒤에 온다
  const footer = src.indexOf("{t('chat.editInfo')}");
  const lastPaneClose = src.lastIndexOf('</div>)}', footer);
  assert.ok(lastPaneClose !== -1 && lastPaneClose < footer, '푸터는 pane 밖');
  assert.match(src, /overflowY: 'auto' \}\}>\n\s*\{tab === 'overview'/, '본문 스크롤 컨테이너 안에 pane');
  assert.match(src, /\{ id: 'ability', label: t\('chat\.card\.tab\.ability'\), count: profile\.skills\.length \+ profile\.mcp\.length \|\| undefined \}/, '능력 탭 개수');
});

test('공용 Tabs — ui.jsx 정의·크루 서랍과 같은 룩의 CSS·다단 배치·i18n ko/en', async () => {
  const ui = await load('../app/ui.jsx');
  assert.match(ui, /export function Tabs\(\{ tabs, value, onChange, label, right, className = '' \}\)/);
  assert.match(ui, /role="tablist"/); assert.match(ui, /role="tab" className="tab" aria-selected=\{value === tb\.id\} data-tone=\{tb\.tone \|\| undefined\}/);
  assert.match(ui, /export function useRememberedTab\(key, ids, fallback, queryTab\)/);
  assert.match(ui, /try \{ localStorage\.setItem\(key, id\); \} catch/, '저장 실패 무시');
  const css = await load('../app/globals.css');
  assert.match(css, /\.tabbar \{[^}]*overflow-x: auto;[^}]*\}/, '좁은 폭 가로 스크롤');
  assert.match(css, /\.tabbar \.tab\[aria-selected="true"\] \{ background: var\(--card-2\); color: var\(--fg\); \}/, '활성 탭 룩 = 크루 서랍 탭');
  assert.match(css, /\.crew-tab\.active \{ background: var\(--card-2\); color: var\(--fg\); \}/, '크루 서랍 탭 룩 유지(동일 값)');
  assert.match(css, /\.tabbar \.tab\[data-tone="danger"\]\[aria-selected="true"\] \{ color: var\(--danger\); \}/);
  // 행 묶음 배치 — 행 안 stretch로 바닥 정렬, 폭이 좁으면 auto-fit으로 접힘
  assert.match(css, /\.cardcols \{ display: grid; gap: 14px; \}/);
  assert.doesNotMatch(css, /\.cardcols \.row\b|\.cols \.row\b/, '목록 행(.row)과 이름 충돌 금지 — 행 사이 가는 선(실측)');
  assert.match(css, /\.cardrow \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\(min\(300px, 100%\), 1fr\)\); gap: 14px; align-items: stretch; \}/);
  assert.doesNotMatch(ui, /export function Cols\(/, 'JS 측정형 배치 없음(순수 CSS)');
  const i18n = await load('../app/i18n.jsx');
  for (const k of ['settings.tab.general', 'settings.tab.ai', 'settings.tab.connections', 'settings.tab.devices', 'settings.tab.danger', 'settings.tab.label', 'chat.card.tab.overview', 'chat.card.tab.ability', 'chat.card.tab.style', 'chat.card.tab.link', 'chat.card.tab.label']) {
    const m = i18n.match(new RegExp(`'${k.replace(/\./g, '\\.')}': \\['([^']+)', '([^']+)'\\]`));
    assert.ok(m, `${k} ko/en 등록`);
    assert.doesNotMatch(m[2], /[가-힣]/, `${k} 영어에 한글 없음`);
  }
});
