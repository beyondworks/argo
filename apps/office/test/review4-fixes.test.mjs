// 10/5 3차 분리 검수(69f2cf76) 반영 — R3-L1~L8. 화면 연결(배선)은 실제 컴포넌트를 노드에서 그려 확인한다(R3-L7: 순수 함수만 잠그면 연결 줄을 되돌려도 초록).
// 화면 파일(.jsx)은 필요한 최상위 선언만 꺼내 가짜 의존과 함께 실행한다(review3-fixes와 같은 방식).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parse } from '@babel/parser';
import { transformSync } from 'esbuild';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { mapBoard, decidableSet } from '../src/core/board.js';
import * as L from '../src/core/crew-list.js';
import * as A from '../src/core/crew-assign.js';
import * as CM from '../src/core/crew-model.js';
import * as MM from '../src/pages/mail-model.js';

const require = createRequire(import.meta.url);
const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
const h = React.createElement, Nil = () => null;
const tick = () => new Promise((r) => setTimeout(r, 0));

function pick(file, names, deps) {
  const s = src(file);
  const body = parse(s, { sourceType: 'module', plugins: ['jsx'] }).program.body.map((n) => (n.type === 'ExportNamedDeclaration' && n.declaration ? n.declaration : n));
  const parts = names.map((name) => {
    const n = body.find((x) => (x.type === 'FunctionDeclaration' && x.id?.name === name) || (x.type === 'VariableDeclaration' && x.declarations.some((d) => d.id.name === name)));
    return n ? s.slice(n.start, n.end) : `const ${name} = undefined;`;
  });
  const code = transformSync(parts.join('\n'), { loader: 'jsx', jsx: 'automatic', format: 'cjs' }).code;
  return new Function('require', ...Object.keys(deps), `${code}\nreturn { ${names.join(', ')} };`)(require, ...Object.values(deps));
}
function run(file, deps, rewrite = (x) => x) {
  const source = rewrite(src(file).replace(/^import .*;$/gm, ''));
  const module = { exports: {} };
  new Function(...Object.keys(deps), 'module', 'exports', transformSync(source, { loader: 'js', format: 'cjs' }).code)(...Object.values(deps), module, module.exports);
  return module.exports;
}
const row = (id, org, extra = {}) => ({ id, org, space: org ? `k-${org}` : 'me', owner: 'me', agent: 'P', name: '페퍼', job: '비서', access: 'ok', status: 'idle', on: true, ...extra });
const SPACES = [{ key: 'me', kind: 'me' }, { key: 'k-O1', kind: 'org', id: 'O1', name: '가나' }, { key: 'k-O2', kind: 'org', id: 'O2', name: '다라' }];

/* ── 에이전트 상세(CrewBody) — R3-L1 꺼짐 안내, R3-L7 m19 기록 행 ── */
function crewBody(state, crew, space) {
  const X = pick('pages/Crews.jsx', ['EMPTY', 'jobOf', 'ownerOf', 'STATUS_BADGE', 'Status', 'useCrewTasks', 'Fact', 'None', 'Sec', 'SHOW', 'useRecentReplies', 'CrewBody'], {
    useStore: (sel) => sel(state), useMemo: React.useMemo, useState: React.useState, useEffect: React.useEffect, t: (k) => k, ago: () => '방금', Icon: Nil, Face: Nil, setUi() {}, navigate() {},
    baseOf: (s) => `/${s}`, ME: { id: 'me' }, SPACES, getMode: () => 'signedIn', nameIn: () => '나', isMine: L.isMine, ...CM, getClient: async () => null, useTasks: () => ({ rows: [] }),
    fmtBytes: String, openExternal() {}, FAMILY: {}, LoadFail: () => h('p', null, 'load.readFail'), pullBoard: async () => {} });
  return renderToStaticMarkup(h(X.CrewBody, { crew, space, close() {} }));
}
const boardOf = (extra) => ({ boardError: null, crews: [], work: [], approvals: [], decisions: [], outputs: [], journal: [], ...extra });

// 이유(R3-L1): 기록판을 못 읽는 동안 상태 배지는 '확인 못 함'인데 같은 상세에 지난 값으로 '지금 꺼져 있어요'가 남았다
test('R3-L1: 기록판 실패 중에는 에이전트 상세·맡기기 창에 꺼짐 안내가 없다', () => {
  const off = row('o1', 'O1', { on: false, status: 'off' });
  assert.match(crewBody(boardOf({ crews: [off] }), off, 'k-O1'), /crew\.offNote/, '읽었고 꺼짐 = 안내');
  const failed = crewBody(boardOf({ crews: [off], boardError: Date.now() }), off, 'k-O1');
  assert.doesNotMatch(failed, /crew\.offNote/);
  assert.match(failed, /crew\.status\.rest/);
  assert.match(sheetHtml([off], { boardError: null }), /crew\.offNote/);
  assert.doesNotMatch(sheetHtml([off], { boardError: Date.now() }), /crew\.offNote/);
});

// 이유(R3-L7 m19): 상세가 detailIds를 쓰지 않아도 테스트가 초록이었다 — 조직 공간 상세에 다른 조직 행의 결재가 섞이는지 실제로 그려 본다
test('R3-L7(m19): 조직 공간 상세에는 같은 에이전트의 다른 조직 결재가 없고, 내 공간 상세에는 있다', () => {
  const o1 = row('o1', 'O1'), o2 = row('o2', 'O2');
  const state = boardOf({ crews: [o1, o2], approvals: [{ id: 'ap', crew: 'o2', space: 'k-O2', plain: '다라 조직 결재', at: '2026-10-05', risk: 'low' }] });
  assert.doesNotMatch(crewBody(state, o1, 'k-O1'), /다라 조직 결재/);
  assert.match(crewBody(state, { ...o1, ids: ['o1', 'o2'] }, 'me'), /다라 조직 결재/);
});

/* ── 맡기기 창(AssignSheet) — R3-L1 꺼짐 안내, R3-L7 m17 '@' 후보 ── */
function sheetHtml(crews, { boardError = null, atOpen = false } = {}) {
  const stub = (tag) => ({ children, title }) => h(tag, null, title, children);
  // '@' 목록이 열린 장면 — 처음 값이 null인 상태는 '@' 자리(at) 하나뿐이다(crew는 함수로 처음 값을 준다)
  const useState = (init) => React.useState(atOpen && init === null ? { start: 0, q: '', caret: 1 } : init);
  const deps = { useLang() {}, useUi: () => ({ assign: { space: 'me', crew: 'o1', items: [] } }), useState, useEffect: React.useEffect, useRef: React.useRef, useMemo: React.useMemo,
    SPACES, getMode: () => 'signedIn', rpc: async () => ({}), useStore: (sel) => sel({ crews, boardError }), crewsIn: L.crewsIn, ME: { id: 'me' },
    ...A, setUi() {}, assign() {}, showToast() {}, t: (k) => k, getState: () => ({}), readMail: async () => ({}), loadPageContent: async () => {}, sendToCrew() {},
    Sheet: stub('section'), Face: Nil, Icon: Nil, imeGuardWith: () => ({}), hideAllOn: () => false, openExternal() {}, FAMILY: {} };
  const { AssignSheet } = pick('ui/Dialogs.jsx', ['TASKS', 'AssignSheet'], deps);
  return renderToStaticMarkup(h(AssignSheet));
}
test('R3-L7(m17): 맡기기 창 \'@\' 목록 — 준비 여부를 모르는 봇 쌍둥이는 같은 조직 후보, 개인 1:1은 넘길 수 없다는 안내', () => {
  const org = row('o1', 'O1', { space: 'k-O1' }), peer = row('w1', 'O1', { space: 'k-O1', agent: 'W', name: '울프' });
  const bot = sheetHtml([org, peer, row('tw', null, { personal: true, hosting: 'bot' })], { atOpen: true });
  assert.match(bot, /울프/);
  const one = sheetHtml([org, peer, row('tw', null, { personal: true, hosting: 'local' })], { atOpen: true });
  assert.doesNotMatch(one, /울프/);
  assert.match(one, /crew\.mention\.one/);
});

/* ── R3-L2: 고정 저장 일부 실패 — 모든 저장이 끝난 뒤 한 번만 다시 읽는다 ── */
test('R3-L2: 한 조직 저장이 먼저 실패해도 다시 읽기는 다른 조직 저장이 끝난 뒤 한 번', async () => {
  const state = { crews: [row('o1', 'O1', { pinned: true, pinPos: 0 }), row('o2', 'O2', { pinned: true, pinPos: 0 })] };
  const log = [];
  let release;
  const slow = new Promise((r) => { release = r; });
  const P = run('core/crew-prefs.js', { ME: { id: 'me' }, getMode: () => 'signedIn', update: (fn) => Object.assign(state, fn(state)), getState: () => state,
    rpc: async (_fn, a) => { if (a.p_org === 'O1') { log.push('O1 실패'); throw new Error('denied'); } await slow; log.push('O2 저장'); },
    pullBoard: async () => { log.push('다시 읽기'); }, moveIds: L.moveIds, reslot: L.reslot });
  const done = P.pinCrew(L.crewsIn(state.crews, 'me', 'me')[0], false).then(() => 'ok', (e) => e.message);
  await tick(); await tick();
  assert.deepEqual(log, ['O1 실패'], '다른 조직 저장이 끝나기 전에는 다시 읽지 않는다');
  release();
  assert.equal(await done, 'denied', '실패는 알린다');
  assert.deepEqual(log, ['O1 실패', 'O2 저장', '다시 읽기']);
});

/* ── R3-L3: 얼굴 모듈 조각 받기 실패는 기록판 실패가 아니다 ── */
test('R3-L3: 얼굴 모듈을 못 받아도 크루 행을 읽었으면 기록판을 그리고, 같은 에이전트 묶음은 주인·작업 공간·이름으로', async () => {
  const state = {};
  const crewRow = (id, org) => ({ id, org_id: org, owner_user_id: 'alice', ws_id: 'w1', slug: 'pep', status: 'active', display_name: '페퍼', last_seen_at: null });
  const answer = (t) => (t === 'msgr_crews' ? { data: [crewRow('o1', 'O1'), crewRow('o2', 'O2')], error: null }
    : t === 'rpc:office_crew_list' ? { data: [{ id: 'o1', org_id: 'O1', owner_user_id: 'alice', display_name: '페퍼' }, { id: 'o2', org_id: 'O2', owner_user_id: 'alice', display_name: '페퍼' }], error: null }
      : { data: [], error: null });
  const q = (table) => { const it = { then: (ok, no) => Promise.resolve(answer(table)).then(ok, no) }; for (const k of ['select', 'eq', 'in', 'is', 'not', 'or', 'order', 'limit', 'like', 'gte']) it[k] = () => it; return it; };
  const pull = run('core/pull.js', { getStorageScope: () => 'alice', ME: { id: 'alice' }, SPACES: [{ key: 'k-O1', id: 'O1', kind: 'org' }, { key: 'k-O2', id: 'O2', kind: 'org' }],
    getClient: async () => ({ from: q, rpc: (fn) => q(`rpc:${fn}`) }), getState: () => state, update: (fn) => Object.assign(state, fn(state)), outbox: { has: () => false },
    mergePages() {}, mapBoard, decidableSet, getUi: () => ({}), setUi() {} }, (s) => s.replace("import('@msgr/crew-face')", "Promise.reject(new Error('chunk 404'))"));
  await pull.pullBoard();
  assert.equal(state.boardError, null);
  const [a, b] = state.crews;
  assert.ok(a.agent && a.agent === b.agent, `같은 에이전트(${a.agent}, ${b.agent})`);
});

/* ── R3-L4: 충돌 '새로 불러오기' — 서버에 없으면 지우지 않는다 ── */
test('R3-L4: 서버에 없는 페이지면 보관본·보낼 목록을 지우지 않고 알리며, 사본은 내 공간 맨 위에 만든다', async () => {
  const log = [];
  const X = pick('pages/PageView.jsx', ['reloadServer', 'dropMine', 'copyPlace'], { loadPageContent: async () => null, forget: (k) => log.push(`forget ${k}`), heldKey: (id) => `held:${id}`,
    outbox: { drop: async (k) => log.push(`drop ${k}`) }, setUi: (p) => log.push(`ui ${JSON.stringify(p)}`), canManage: () => false });
  await assert.rejects(X.reloadServer('p1'), (e) => e.missing === true);
  assert.deepEqual(log, []);
  assert.ok(X.copyPlace, 'copyPlace가 있어야 한다');
  assert.deepEqual(X.copyPlace({ id: 'p1', space: 'k-O1', parent: null }, true), ['me', null], '없는 페이지 아래에는 만들 수 없다');
  assert.deepEqual(X.copyPlace({ id: 'p1', space: 'k-O1', parent: null }, false), ['k-O1', 'p1'], '종전: 최상위를 못 만드는 사람은 원본 아래');
});

/* ── 메일 — R3-L5 회복 경로, R3-L6 만료 ── */
function mailWith(state, answer) {
  globalThis.fetch = async (url, init) => {
    const op = /\/api\/mail\/(\w+)/.exec(url)[1], body = init?.body ? JSON.parse(init.body) : null;
    const [status, data] = answer(op, body);
    return { ok: status < 400, status, json: async () => data, headers: { get: () => null } };
  };
  const sb = { auth: { getSession: async () => ({ data: { session: null } }) } };
  return run('core/mail.js', { getClient: async () => sb, getMode: () => 'signedIn', ME: { id: 'u' }, update: (fn) => Object.assign(state, fn(state)), getState: () => state,
    outbox: { has: () => false }, VIEWABLE: {}, isDesktop: () => false, apiUrl: (u) => `http://x${u}`, saveAttachment() {}, restore: (_k, d) => d, persist() {}, forget() {},
    scopedStorageKey: (k) => k, getStorageScope: () => 'u', mergeList: MM.mergeList, applySync: MM.applySync, newArrivals: MM.newArrivals, byDate: MM.byDate, replySubject: MM.replySubject, CAP: 1,
    t: (k) => k, registerDict() {}, MAIL_DICT: {} });
}
// 이유(R3-L5): 자동 갱신(sync)이 계속 성공해도 받은편지함 목록은 다시 받지 않아 한 번의 실패가 세션 내내 홈에 남았다 — 실패 중일 때만 받은편지함을 다시 받는다
test('R3-L5: 실패 표시가 있을 때 자동 갱신이 되면 받은편지함을 다시 받아 회복한다(실패가 없으면 목록을 받지 않는다)', async () => {
  const state = { mailAccounts: [{ id: 'a1', status: 'ok' }], mails: [] };
  const calls = [];
  const m = mailWith(state, (op, b) => { calls.push(op === 'list' ? `list ${b.folder}` : op); return op === 'sync' ? [200, { results: [{ account: 'a1', historyId: '9', primed: true }] }] : [200, { items: [] }]; });
  state.mailError = Date.now();
  await m.syncMail();
  assert.equal(state.mailError, null);
  assert.deepEqual(calls, ['sync', 'list inbox']);
  calls.length = 0;
  await m.syncMail();
  assert.deepEqual(calls, ['sync'], '정상일 때는 sync만');
  globalThis.location = { search: '?view=sent' };
  assert.equal(m.firstView?.(['inbox', 'sent']), 'sent', '주소로 받은 메일함이 먼저(마지막에 본 메일함 = 받은편지함보다)');
  globalThis.location = { search: '' };
  assert.equal(m.firstView(['inbox', 'sent']), 'inbox');
  delete globalThis.location;
});

// 이유(R3-L6): 계정이 만료되면 받지 못했는데도 홈이 '모두 확인'이었다
test('R3-L6: 연결한 계정이 만료면 실패가 아니라 다시 연결 필요(expired)', async () => {
  const all = { mailAccounts: [{ id: 'a1', status: 'expired' }], mails: [] };
  await mailWith(all, () => [200, { items: [] }]).pullMail('inbox');
  assert.equal(all.mailError, 'expired');
  const mid = { mailAccounts: [{ id: 'a1', status: 'ok' }], mails: [] };
  await mailWith(mid, () => [401, { error: 'expired' }]).pullMail('inbox');
  assert.equal(mid.mailError, 'expired', '받는 중에 만료');
  const mixed = { mailAccounts: [{ id: 'a1', status: 'ok' }, { id: 'a2', status: 'expired' }], mails: [] };
  await mailWith(mixed, () => [502, { error: 'google' }]).pullMail('inbox');
  assert.ok(mixed.mailError > 0, '받기 실패가 함께 있으면 실패가 먼저');
});

function homeWith(state) {
  const deps = { useMemo: React.useMemo, Suspense: React.Suspense, lazy: React.lazy, useStore: (sel) => sel(state), useSession: () => 'signedIn', LoadFail: ({ text }) => h('p', { className: 'load-fail' }, text ?? 'load.readFail'),
    pullBoard: async () => {}, t: (k) => k, ago: () => 'ago', Link: ({ to, children }) => h('a', { href: to }, children), menuProps: () => ({}), mailMenu: () => [], looksLikeAddr: () => false,
    useTasks: () => ({ error: null }), useTaskRows: () => [], useTaskDay: () => '2026-10-05', approvalsIn: () => () => true, baseOf: () => '/me', crewsIn: () => [], ME: { id: 'u' },
    groupTasks: () => ({ overdue: [], today: [], week: [], later: [], none: [] }), fmtBytes: () => '0' };
  return pick('pages/modules.jsx', ['Empty', 'wait', 'Mail', 'inSpace', 'WEEK', 'recent', 'useStatValues'], deps);
}
const blank = { approvals: [], work: [], mails: [], decisions: [], pages: [], todosDone: {}, crews: [], outputs: [], boardError: null };
test('R3-L5·L6: 홈 메일 카드 — 실패는 받은편지함으로 열고, 만료는 다시 연결, 모듈도 다시 연결 안내', () => {
  const card = (mailError) => { const H = homeWith({ ...blank, mailError }); let v; renderToStaticMarkup(h(() => { v = H.useStatValues('me'); return null; })); return v.mail; };
  assert.equal(card(Date.now()).to, '/me/mail?view=inbox');
  const ex = card('expired');
  assert.deepEqual([ex.n, ex.badge.tone, ex.badge.text, ex.main], ['—', 'warn', 'mailc.reconnect', 'mailc.statusExpired']);
  const H = homeWith({ ...blank, mailError: 'expired' });
  const html = renderToStaticMarkup(h(H.Mail));
  assert.match(html, /mailc\.statusExpired/);
  assert.doesNotMatch(html, /mod\.empty|load\.readFail/);
});

/* ── R3-L7: 화면 연결 잠그기 ── */
test('R3-L7(m05): 계정 저장소를 열면 메일은 확인 전(undefined)에서 시작한다(지난번 값을 이어 오지 않는다)', () => {
  const store = run('core/store.js', { S: { PAGES: [], MAILS: [], APPROVALS: [], DECISIONS: [], WORK: [], CREWS: [], OUTPUTS: [], JOURNAL: [] }, useSyncExternalStore() {},
    restore: () => ({ mailError: null, boardError: 5 }), persist() {}, scopedStorageKey: (k) => k, getStorageScope: () => 'alice', setLegacyRecovery() {}, t: (k) => k, queue() {}, between() {}, SPACES: [] });
  store.activateDraftScope('alice');
  assert.equal(store.getState().mailError, undefined);
  assert.equal(store.getState().boardError, null);
});

test('R3-L7(m26): 접속을 모를 때 문구는 \'확인 못 함\'(대기 중과 헷갈리지 않게)', async () => {
  globalThis.document ??= { documentElement: {} };
  const I = await import('../src/core/i18n.js');
  I.setLang('ko');
  assert.equal(I.t('crew.status.rest'), '확인 못 함');
  assert.notEqual(I.t('crew.status.rest'), I.t('crew.status.idle'));
});

// m15: 플러그인 편집 창이 같은 에이전트 행 전부(가게의 크루)를 보지 않으면 다른 조직 행 배정이 꺼져 보인다
test('R3-L7(m15): 조직 공간 플러그인 편집 창 — 다른 조직 행으로 배정한 것도 같은 에이전트 줄에 체크', () => {
  const all = [row('p1', 'O1'), row('p2', 'O2')];
  const { Editor } = pick('pages/Tools.jsx', ['KINDS', 'Editor'], { useId: React.useId, t: (k) => k, Modal: ({ children }) => h('div', null, children), showToast() {}, useStore: (sel) => sel({ crews: all }), ...A });
  const html = renderToStaticMarkup(h(Editor, { edit: { title: 'x', body: '', scope: 'me', spec: { tool_kind: 'service', url: '', enabled: true, crews: ['p2'] } }, setEdit() {}, crews: [all[0]], readOnly: false, write() {} }));
  assert.match(html, /checked=""[^>]*\/?>페퍼|<input[^>]*checked=""[^>]*>페퍼/);
});

/* ── 좌측 크루 목록(CrewSection) — R3-L7 m12·m13, R3-L8 조직 경계 ── */
function side(crews, space = 'me') {
  const rows = [];
  const CrewRow = (p) => { rows.push({ id: p.crew.id, group: p.group, movable: p.movable }); return h('i', { 'data-id': p.crew.id }); };
  // 조직 이름 순서(가나 → 다라)가 id 순서(O2 → O1)와 다르게 — 덩어리 순서가 이름순인지 본다
  const SPACES = [{ key: 'me', kind: 'me' }, { key: 'k-O2', kind: 'org', id: 'O2', name: '가나' }, { key: 'k-O1', kind: 'org', id: 'O1', name: '다라' }];
  const { CrewSection } = pick('ui/Sidebar.jsx', ['FOLD_KEY', 'rank', 'CrewSection'], { useStore: (sel) => sel({ crewsReady: true, boardError: null }), useState: React.useState, restore: (_k, d) => d, persist() {},
    useMemo: React.useMemo, groupCrews: L.groupCrews, byOrg: L.byOrg, ME: { id: 'me' }, t: (k) => k, Icon: Nil, SortableContext, verticalListSortingStrategy, CrewRow, getMode: () => 'signedIn',
    openExternal() {}, FAMILY: {}, SPACES });
  const html = renderToStaticMarkup(h(CrewSection, { space, crews, handle: {} }));
  return { html, rows };
}
// 이유(R3-L8): 내 공간 고정 목록이 보이지 않는 조직 경계로 나뉘었고, 덩어리 순서는 조직 uuid 순이었다
test('R3-L8·m12·m13: 내 공간 고정 목록 — 조직 이름 순 덩어리, 덩어리마다 조직 이름, 같은 조직끼리만 끌기, 개인 공간 행은 끌지 않음', () => {
  const crews = [row('b', 'O2', { name: '울프', agent: 'B', pinned: true, pinPos: 0 }), row('a', 'O1', { name: '오길비', agent: 'A', pinned: true, pinPos: 5 }),
    row('c', 'O1', { name: '페퍼', agent: 'C', pinned: true, pinPos: 1 }), row('p', null, { name: '솔로', agent: 'D', personal: true, pinned: true, pinPos: 9 })];
  const { html, rows } = side(crews);
  assert.deepEqual(rows.map((r) => r.id), ['b', 'c', 'a', 'p'], '가나(O2) → 다라(O1), 조직 안은 고정 순서, 개인 공간은 끝');
  assert.ok(html.indexOf('다라') < html.indexOf('crew.group.personal'), '개인 공간 덩어리는 끝 — 이름은 개인 공간(내 공간 아님)');
  assert.ok(html.indexOf('가나') < html.indexOf('다라') && html.indexOf('가나') > -1, '덩어리마다 조직 이름');
  const g = Object.fromEntries(rows.map((r) => [r.id, r.group]));
  assert.equal(g.c, g.a, '같은 조직 = 같은 끌기 영역');
  assert.notEqual(g.a, g.b, '다른 조직 = 다른 끌기 영역');
  assert.equal(rows.find((r) => r.id === 'p').movable, false, '개인 공간 행은 저장할 곳이 없어 끌지 않는다');
  assert.equal(rows.find((r) => r.id === 'c').movable, true);
  const one = side([row('x', 'O1', { pinned: true, agent: 'X' }), row('y', 'O1', { pinned: true, agent: 'Y' })]);
  assert.doesNotMatch(one.html, /crew-org/, '조직이 하나면 머리줄 없음');
  const solo = side([row('x', 'O1', { pinned: true, agent: 'X' }), row('p', null, { agent: 'D', personal: true, pinned: true, pinPos: 9 })]);
  assert.doesNotMatch(solo.html, /crew-org/, '조직 하나 + 개인 전용은 머리줄 없음(조직 덩어리가 둘 이상일 때만)');
});

// 맡기기 거절 사유 문구를 맡기기 조각 사전(CREW_ASSIGN_DICT)으로 옮겼다(첫 화면 상한) — 전송함은 그 조각을 받은 뒤 알린다(키 그대로 보이지 않게)
test('전송함: 맡기기 거절 알림은 맡기기 조각의 사전을 받은 뒤 사유 문구로', async () => {
  const dict = {}, toasts = [];
  let reject;
  run('core/transport.js', { setTransport: (_, r) => { reject = r; }, getState: () => ({}), update() {}, getMode: () => 'signedIn', SPACES: [], ME: { id: 'alice' }, getStorageScope: () => 'alice',
    getClient: async () => ({}), classify: (e) => e, setUi() {}, getUi: () => ({}), showToast: (m) => toasts.push(m), t: (k) => dict[k] ?? k, persist() {}, heldKey: (id) => id,
    scopedStorageKey: (k) => k, apiUrl: (u) => u, announce() {}, apStale: () => null, openExternal() {}, FAMILY: {},
    __imp: async () => { Object.assign(dict, (await import('../src/core/crew-assign-i18n.js')).CREW_ASSIGN_DICT['crew.fail.locked'] ? { 'crew.fail.locked': '잠김' } : {}); } },
  (s) => s.replace("import('./crew-assign.js').catch", '__imp().catch'));
  reject({ payload: { type: 'crew.assign', ownerUid: 'alice' } }, { assign: 'locked' });
  await tick(); await tick(); await tick();
  assert.deepEqual(toasts, ['잠김']);
});
