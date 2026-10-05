// 10/5 2차 분리 검수(238dcc93) 반영 — 메일 실패 표시(M1·M2·L7), 고정은 같은 에이전트의 조직 행 전부(M3·L1·L2), 끌기는 같은 조직 안에서만,
// 조직 공간 플러그인 묶음 판정(L3), 맡기기 창 '@' 배선(L4), 없는 페이지 표시 설정·해제(L5), 조직 공간 상세 기록(L6), 크루 행 읽기 실패(L8),
// 충돌 '새로 불러오기' 순서(L10), 결재 연타.
// 화면 파일(.jsx)은 노드에서 바로 못 열어, 필요한 최상위 선언만 꺼내 가짜 의존과 함께 실행한다(header-session 테스트와 같은 방식).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parse } from '@babel/parser';
import { transformSync } from 'esbuild';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mapBoard, decidableSet } from '../src/core/board.js';
import * as L from '../src/core/crew-list.js';
import * as A from '../src/core/crew-assign.js';
import * as MM from '../src/pages/mail-model.js';

const require = createRequire(import.meta.url);
const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));
const h = React.createElement;

/** 파일의 최상위 선언(함수·const)만 꺼내 가짜 의존과 함께 실행 */
function pick(file, names, deps) {
  const s = src(file);
  const body = parse(s, { sourceType: 'module', plugins: ['jsx'] }).program.body.map((n) => (n.type === 'ExportNamedDeclaration' && n.declaration ? n.declaration : n));
  const parts = names.map((name) => {
    const n = body.find((x) => (x.type === 'FunctionDeclaration' && x.id?.name === name) || (x.type === 'VariableDeclaration' && x.declarations.some((d) => d.id.name === name)));
    if (!n) return `const ${name} = undefined;`; // 고치기 전 코드에 없는 선언 — 시험이 실패로 알린다
    return s.slice(n.start, n.end);
  });
  const code = transformSync(parts.join('\n'), { loader: 'jsx', jsx: 'automatic', format: 'cjs' }).code;
  return new Function('require', ...Object.keys(deps), `${code}\nreturn { ${names.join(', ')} };`)(require, ...Object.values(deps));
}
/** 모듈 전체 — 가져오기 줄만 지우고 실행(load-states 테스트와 같은 방식) */
function run(file, deps, rewrite = (x) => x) {
  const source = rewrite(src(file).replace(/^import .*;$/gm, ''));
  const module = { exports: {} };
  new Function(...Object.keys(deps), 'module', 'exports', transformSync(source, { loader: 'js', format: 'cjs' }).code)(...Object.values(deps), module, module.exports);
  return module.exports;
}

/* ── M1·L7: 메일 실패 표시는 받은편지함 목록 받기 결과로만 쓰고 지운다 ── */
function mailWith(state, answer) {
  globalThis.fetch = async (url, init) => {
    const op = /\/api\/mail\/(\w+)/.exec(url)[1], body = init?.body ? JSON.parse(init.body) : null;
    const [status, data] = answer(op, body);
    return { ok: status < 400, status, json: async () => data, headers: { get: () => null } };
  };
  const sb = { auth: { getSession: async () => ({ data: { session: null } }) }, from: () => ({ select: () => ({ order: async () => answer('accounts')[1] }) }) };
  return run('core/mail.js', { getClient: async () => sb, getMode: () => 'signedIn', ME: { id: 'u' }, update: (fn) => Object.assign(state, fn(state)), getState: () => state,
    outbox: { has: () => false }, VIEWABLE: {}, isDesktop: () => false, apiUrl: (u) => `http://x${u}`, saveAttachment() {}, restore: (_k, d) => d, persist() {}, forget() {},
    scopedStorageKey: (k) => k, getStorageScope: () => 'u', mergeList: MM.mergeList, applySync: MM.applySync, newArrivals: MM.newArrivals, byDate: MM.byDate, replySubject: MM.replySubject, CAP: 1, t: (k) => k, registerDict() {}, MAIL_DICT: {} });
}

// 이유(2차 검수 M1): 바뀐 것만 받기(sync) 성공이 실패 표시를 지우고, 보낸편지함 결과로도 다시 썼다 — 메일 화면은 '불러오지 못했습니다'인데 홈은 '모두 확인'
test('M1: 받은편지함 받기 실패 표시는 sync·다른 메일함 성공으로 지워지지 않고, 받은편지함을 다시 받아야 지워진다', async () => {
  const state = { mailAccounts: [{ id: 'a1', status: 'ok' }], mails: [] };
  let inbox = 500;
  const m = mailWith(state, (op, b) => (op === 'list' ? (b.folder === 'inbox' ? [inbox, inbox === 200 ? { items: [] } : { error: 'server' }] : [200, { items: [] }])
    : op === 'sync' ? [200, { results: [{ account: 'a1', historyId: '9', primed: true }] }] : [200, {}]));
  assert.equal(state.mailError, undefined, '처음 = 확인 전');
  await m.pullMail('inbox');
  assert.ok(state.mailError > 0, '받은편지함 실패');
  await m.syncMail();
  assert.ok(state.mailError > 0, 'sync 성공으로 지우지 않는다');
  await m.pullMail('sent');
  assert.ok(state.mailError > 0, '보낸편지함 성공으로 지우지 않는다');
  inbox = 200; await m.pullMail('inbox');
  assert.equal(state.mailError, null, '받은편지함을 받으면 지운다');
});

// 이유(2차 검수 L7): 요청 제한(429)을 실패에서 빼 캐시가 빈 첫 받기가 제한되면 홈이 '모두 확인'이었다 — 홈 카드는 429도 '확인 못 함'
test('L7: 받은편지함 받기가 요청 제한(429)이어도 실패 표시, 계정이 없으면 확인한 것으로', async () => {
  const state = { mailAccounts: [{ id: 'a1', status: 'ok' }], mails: [] };
  const m = mailWith(state, () => [429, { error: 'rate_limited', retryAfter: 1 }]);
  await m.pullMail('inbox');
  assert.ok(state.mailError > 0);
  const none = { mailAccounts: [], mails: [] };
  await mailWith(none, () => [200, {}]).pullMail('inbox');
  assert.equal(none.mailError, null, '연결한 계정이 없으면 기다릴 것이 없다(확인 전에 머물지 않는다)');
});

test('M1: 홈·다시 시도의 받은편지함 받기 — 계정 목록부터 못 받아도 실패 표시', async () => {
  const state = { mailAccounts: [], mails: [] };
  const m = mailWith(state, (op) => (op === 'accounts' ? [0, { data: null, error: { message: 'down' } }] : [200, { items: [] }]));
  assert.ok(m.pullInbox, 'pullInbox가 있어야 한다');
  await assert.rejects(m.pullInbox());
  assert.ok(state.mailError > 0);
});

/* ── M2·M1 화면: 홈 '안 읽은 메일' 모듈과 현황 카드 ── */
function homeWith(state, live = true) {
  const useStore = (sel) => sel(state);
  const LoadFail = ({ text }) => h('p', { className: 'load-fail' }, text ?? 'load.readFail');
  const deps = { useMemo: React.useMemo, Suspense: React.Suspense, lazy: React.lazy, useStore, useSession: () => (live ? 'signedIn' : 'sample'), LoadFail, pullBoard: async () => {},
    t: (k) => k, ago: () => 'ago', Link: ({ children }) => h('a', null, children), menuProps: () => ({}), mailMenu: () => [], looksLikeAddr: () => false,
    useTasks: () => ({ error: null }), useTaskRows: () => [], useTaskDay: () => '2026-10-05', approvalsIn: () => () => true, baseOf: () => '/me', crewsIn: () => [], ME: { id: 'u' },
    groupTasks: () => ({ overdue: [], today: [], week: [], later: [], none: [] }), fmtBytes: () => '0' };
  return pick('pages/modules.jsx', ['Empty', 'wait', 'Mail', 'inSpace', 'WEEK', 'recent', 'useStatValues'], deps);
}
const blank = { approvals: [], work: [], mails: [], decisions: [], pages: [], todosDone: {}, crews: [], outputs: [], boardError: null };

// 이유(2차 검수 M2): 받기 실패 중에도 홈 '안 읽은 메일' 모듈이 '비어 있습니다' — 실패면 다시 시도, 아직 안 받았으면 기다림
test('M2: 홈 안 읽은 메일 모듈 — 실패면 다시 시도, 확인 전이면 기다림, 받았고 없으면 비어 있음', () => {
  const html = (mailError, mails = []) => { const H = homeWith({ ...blank, mails, mailError }); return renderToStaticMarkup(h(H.Mail)); };
  assert.match(html(Date.now()), /load\.readFail/);
  assert.match(html(undefined), /…/);
  assert.match(html(null), /mod\.empty/);
  assert.match(html(Date.now(), [{ id: 'm1', folder: 'inbox', unread: true, subject: '견적 회신', from: '한빛', at: '2026-10-05' }]), /load\.readFail.*견적 회신/, '받아 둔 메일은 그대로, 그 위에 다시 시도');
});

test('M1: 홈 현황 안 읽은 메일 카드 — 확인 전 = …, 실패 = 확인 못 함, 받았고 없음 = 모두 확인', () => {
  const card = (mailError) => { const H = homeWith({ ...blank, mailError }); let v; renderToStaticMarkup(h(() => { v = H.useStatValues('me'); return null; })); return v.mail; };
  assert.equal(card(undefined).n, '…', '받은편지함을 아직 안 받았으면 모두 확인이 아니다');
  assert.equal(card(Date.now()).badge.text, 'stat.b.fail');
  assert.equal(card(null).main, 'stat.mailDone');
});

/* ── L8: 크루 행(msgr_crews)을 못 읽으면 기록판 실패 — 모든 에이전트를 '대기'로 그리지 않는다 ── */
const fakeSb = (answer) => {
  const q = (table) => { const it = { then: (ok, no) => Promise.resolve(answer(table)).then(ok, no), maybeSingle: async () => answer(table) }; for (const k of ['select', 'eq', 'in', 'is', 'not', 'or', 'order', 'limit', 'like', 'gte']) it[k] = () => it; return it; };
  return { from: q, rpc: (fn) => q(`rpc:${fn}`) };
};
const ui = { missingPage: null };
const pullWith = (answer, state = { pages: [{ id: 'p', title: 't' }] }) => run('core/pull.js', {
  getStorageScope: () => 'alice', ME: { id: 'alice' }, SPACES: [{ key: 'acme', id: 'o1', kind: 'org', role: 'member' }], getClient: async () => fakeSb(answer),
  getState: () => state, update: (fn) => Object.assign(state, fn(state)), outbox: { has: () => false }, mergePages() {}, mapBoard, decidableSet,
  getUi: () => ui, setUi: (p) => Object.assign(ui, p),
}, (s) => s.replace("import('@msgr/crew-face')", 'Promise.resolve({ agentLooks: () => new Map() })'));

// 이유(2차 검수 L8): 조직이 있는 계정은 크루 행 읽기 실패를 넘겨 모든 에이전트가 '대기'(대기 중과 한 글자 차이)로 보였다
test('L8: 조직이 있어도 크루 행을 못 읽으면 기록판 실패(다시 시도), 상태를 지어내지 않는다', async () => {
  const state = {};
  const pull = pullWith((t) => (t === 'msgr_crews' ? { data: null, error: { message: 'down' } } : { data: [], error: null }), state);
  await assert.rejects(pull.pullBoard());
  assert.ok(state.boardError > 0);
  assert.equal(state.crews, undefined, '실패한 읽기로 크루 목록을 덮지 않는다');
});

/* ── L5: 없는 페이지 표시는 본문 읽기가 직접 켜고 끈다(어느 경로로 읽어도) ── */
test('L5: 서버에 없으면 missingPage를 켜고, 다른 경로로라도 본문을 받으면 그 자리에서 끈다', async () => {
  let gone = true;
  const pull = pullWith((t) => (t === 'rpc:office_page_access' ? { data: 'edit' } : { data: gone ? null : { title: 'x', content: {}, version: 2 }, error: null }));
  ui.missingPage = null;
  assert.equal(await pull.loadPageContent('p'), null);
  assert.equal(ui.missingPage, 'p');
  gone = false;
  await pull.loadPageContent('p');
  assert.equal(ui.missingPage, null);
});

/* ── M3·L1·L2: 고정은 같은 에이전트의 조직 행 전부에 같은 값 ── */
function prefsWith(state) {
  const calls = [];
  const P = run('core/crew-prefs.js', { ME: { id: 'me' }, getMode: () => 'signedIn', update: (fn) => Object.assign(state, fn(state)), getState: () => state,
    rpc: async (fn, args) => { calls.push(args); }, pullBoard: async () => {}, moveIds: L.moveIds, reslot: L.reslot });
  return { P, calls };
}
const row = (id, org, extra = {}) => ({ id, org, space: org ? `k-${org}` : 'me', owner: 'me', agent: 'P', name: '페퍼', access: 'ok', ...extra });

// 이유(2차 검수 M3·L1): 두 조직에 고정된 에이전트를 내 공간에서 풀면 대표 행 하나만 풀려 그대로 고정으로 보였고, 다시 고정하면 저장 조직이 바뀌었다
test('M3: 두 조직 고정 → 풀기 → 둘 다 풀림 → 다시 고정 → 둘 다 고정(조직마다 저장)', async () => {
  const state = { crews: [row('o1', 'O1', { pinned: true, pinPos: 0 }), row('o2', 'O2', { pinned: true, pinPos: 4 }), row('tw', null, { personal: true })] };
  const { P, calls } = prefsWith(state);
  const rep = () => L.crewsIn(state.crews, 'me', 'me')[0]; // 내 공간 줄(oneEach 대표 — ids = 묶인 행)
  await P.pinCrew(rep(), false);
  assert.deepEqual(state.crews.map((c) => !!c.pinned), [false, false, false]);
  assert.deepEqual(calls.map((c) => [c.p_org, c.p_ids, c.p_on]), [['O1', ['o1'], false], ['O2', ['o2'], false]]);
  assert.equal(rep().pinned, false, '내 공간 줄도 풀림');
  calls.length = 0;
  await P.pinCrew(rep(), true);
  assert.deepEqual(state.crews.map((c) => !!c.pinned), [true, true, false], '개인 공간 행은 고정 저장 대상이 아니다(서버 함수가 조직을 요구)');
  assert.deepEqual(calls.map((c) => [c.p_org, c.p_on]), [['O1', true], ['O2', true]]);
});

// 이유(2차 검수 L2): 대표 규칙이 고정을 회사 크루 여부보다 먼저 봐, 고정한 회사 크루 행이 대표면 내 목록에서 줄이 통째로 빠졌다
test('L2: 고정했어도 회사 크루 행은 대표가 아니다', () => {
  const [one] = L.oneEach([row('c', 'O1', { company: true, pinned: true }), row('o', 'O2')]);
  assert.equal(one.id, 'o');
});

// 끌어 순서 바꾸기: 서버 pin_order·sort는 조직 안에서만 — 내 공간에서는 같은 조직 행끼리만 바꾸고, 다른 조직 자리에는 놓지 않는다
test('끌기: 묶음 안의 줄은 조직별로 모이고(조직 안 순서 그대로), 끌 수 있는 단위는 같은 조직의 줄', () => {
  assert.ok(L.byOrg, 'byOrg가 있어야 한다');
  const list = [row('a', 'O2', { pinPos: 0 }), row('b', 'O1', { pinPos: 1 }), row('c', 'O2', { pinPos: 2 }), row('d', null, { pinPos: 3 }), row('e', 'O1', { pinPos: 0 })];
  const { groups } = L.groupCrews(list.map((c) => ({ ...c, pinned: true })), { me: 'me' });
  assert.deepEqual(groups[0].crews.map((c) => c.id), ['e', 'b', 'a', 'c', 'd'], '조직마다 모이고 조직 안은 고정 순서, 개인 공간 행은 끝');
  assert.deepEqual(L.byOrg(groups[0].crews).map((r) => [r.org, r.crews.map((c) => c.id)]), [['O1', ['e', 'b']], ['O2', ['a', 'c']], [null, ['d']]]);
});

/* ── L3: 조직 공간의 '내 플러그인' 편집도 같은 에이전트로 묶어 판정 ── */
// 이유(2차 검수 L3): 조직 공간 편집 창의 줄에는 ids가 없어 다른 조직 행(c-pep-2)으로 배정한 것이 꺼져 보이고, 켜면 중복 배정이 다시 생겼다
test('L3: 조직 공간 줄(ids 없음)도 같은 에이전트 행 전부로 판정·끄기, 저장 때 한 번만', () => {
  const all = [row('p1', 'O1'), row('p2', 'O2'), row('tw', null, { personal: true }), row('w1', 'O1', { agent: 'W', name: '울프' })];
  const c = all[0];
  assert.equal(A.toolCrewOn(['p2'], c, all), true);
  assert.deepEqual(A.toggleToolCrew(['p2', 'w1'], c, all), ['w1']);
  assert.deepEqual(A.oncePerAgent(['p2', 'p1', 'w1'], [c, all[3]], all), ['p2', 'w1']);
});

/* ── L4: 맡기기 창 '@' 안내 배선 — 봇 쌍둥이는 준비 여부를 모르면 조직 1:1일 수 있어 후보·안내를 그대로 ── */
function sheetHtml(crews) {
  const stub = (tag) => ({ children, title }) => h(tag, null, title, children);
  const deps = { useLang() {}, useUi: () => ({ assign: { space: 'me', crew: 'o1', items: [] } }), useState: React.useState, useEffect: React.useEffect, useRef: React.useRef, useMemo: React.useMemo,
    SPACES: [{ key: 'me', kind: 'me' }, { key: 'k-O1', kind: 'org', id: 'O1' }], getMode: () => 'signedIn', rpc: async () => ({}), useStore: (sel) => sel({ crews }), crewsIn: L.crewsIn, ME: { id: 'me' },
    ...A, setUi() {}, assign() {}, showToast() {}, t: (k) => k, getState: () => ({}), readMail: async () => ({}), loadPageContent: async () => {}, sendToCrew() {},
    Sheet: stub('section'), Face: () => null, Icon: () => null, imeGuardWith: () => ({}), hideAllOn: () => false, openExternal() {}, FAMILY: {} };
  const { AssignSheet } = pick('ui/Dialogs.jsx', ['TASKS', 'AssignSheet'], deps);
  return renderToStaticMarkup(h(AssignSheet));
}
// 이유(2차 검수 L4): one이 봇·준비 여부를 안 봐, 준비 안 된 봇 쌍둥이(실제로는 조직 1:1)에도 '1:1에서는 넘길 수 없습니다'와 빈 후보
test('L4: 맡기기 창 — 개인 1:1로 가는 내 에이전트는 @ 안내를 빼고, 봇 쌍둥이·개인 행 없음은 종전 안내', () => {
  const org = row('o1', 'O1', { space: 'k-O1' });
  assert.match(sheetHtml([org, row('tw', null, { personal: true, hosting: 'local' })]), /crew\.morePhOne/);
  assert.doesNotMatch(sheetHtml([org, row('tw', null, { personal: true, hosting: 'bot' })]), /PhOne/, '준비 여부를 모르는 봇 쌍둥이');
  assert.doesNotMatch(sheetHtml([org]), /PhOne/, '개인 행 없음 = 조직 1:1');
});

/* ── L6: 조직 공간의 에이전트 상세는 그 조직 행 기록만 ── */
// 이유(2차 검수 L6): 조직 공간 상세에 다른 조직 기록이 조직 표시 없이 섞였다 — 같은 에이전트 행 묶기는 내 공간에서만
test('L6: 상세 기록 행 — 내 공간은 같은 에이전트 행 전부, 조직 공간은 그 행 하나', async () => {
  const M = await import('../src/core/crew-model.js');
  assert.ok(M.detailIds, 'detailIds가 있어야 한다');
  const all = [row('p1', 'O1'), row('p2', 'O2'), row('tw', null, { personal: true })];
  assert.deepEqual(M.detailIds(all[0], all, 'me', 'me'), ['p1', 'p2', 'tw']);
  assert.deepEqual(M.detailIds(all[0], all, 'k-O1', 'me'), ['p1']);
});

/* ── L10: 충돌 '새로 불러오기'는 서버 본문을 받은 뒤에만 이 기기의 보관본·보낼 목록을 지운다 ── */
// 이유(2차 검수 L10): 먼저 지우고 읽어, 읽기 실패 뒤 새로고침하면 내 변경이 없어졌다
test('L10: 새로 불러오기 — 읽기 실패면 보관본·보낼 목록을 그대로, 성공하면 지우고 충돌 안내를 닫는다', async () => {
  const log = [];
  let fail = true;
  const { reloadServer } = pick('pages/PageView.jsx', ['reloadServer'], { loadPageContent: async () => { log.push('load'); if (fail) throw new Error('down'); }, forget: (k) => log.push(`forget ${k}`),
    heldKey: (id) => `held:${id}`, outbox: { drop: async (k) => log.push(`drop ${k}`) }, setUi: (p) => log.push(`ui ${JSON.stringify(p)}`) });
  assert.ok(reloadServer, 'reloadServer가 있어야 한다');
  await assert.rejects(reloadServer('p1'));
  assert.deepEqual(log, ['load']);
  fail = false; log.length = 0;
  await reloadServer('p1');
  assert.deepEqual(log, ['load', 'forget held:p1', 'drop page:p1', 'ui {"conflict":null}']);
});

/* ── 결재 연타: 상태를 읽는 동안 같은 결재를 다시 누르면 무시 ── */
test('결재 연타: 승인 뒤 상태를 읽는 사이 거절을 눌러도 결정은 한 번', async () => {
  const decided = [], toasts = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const sb = { from: () => ({ select: () => ({ in: async () => { await gate; return { data: [{ id: 'a1', status: 'pending' }], error: null }; } }) }) };
  const R = pick('pages/Records.jsx', ['freshStatus', 'staleToast', 'deciding', 'decideAp'], { getMode: () => 'signedIn', getClient: async () => sb, apStale: (await import('../src/core/board.js')).apStale,
    showToast: (m) => toasts.push(m), t: (k) => k, pullBoard: async () => {}, decide: (...a) => decided.push(a), nameIn: () => '나' });
  const first = R.decideAp({ id: 'a1', space: 'k-O1' }, 'approved');
  const second = R.decideAp({ id: 'a1', space: 'k-O1' }, 'rejected');
  release(); await Promise.all([first, second]); await tick();
  assert.deepEqual(decided.map((d) => d.slice(0, 2)), [['a1', 'approved']]);
});

// 화면 확인(10/5): 크루 행을 못 읽은 채 지난번 받아 둔 목록이 남으면 '대기 중'·'꺼져 있음'이 그대로 보였다 — 기록판을 못 읽는 동안 접속은 '확인 못 함'
test('L8: 기록판을 못 읽는 동안 에이전트 상태는 확인 못 함(에이전트 화면·좌측 목록)', () => {
  const html = (boardError) => {
    const { Status } = pick('pages/Crews.jsx', ['STATUS_BADGE', 'Status'], { useStore: (sel) => sel({ boardError }), t: (k) => k });
    return renderToStaticMarkup(h(Status, { c: { status: 'idle' } }));
  };
  assert.match(html(null), /crew\.status\.idle/);
  assert.match(html(Date.now()), /crew\.status\.rest/);
  const side = (boardError) => {
    const { CrewRow } = pick('ui/Sidebar.jsx', ['CrewRow'], { useSortable: () => ({}), getMode: () => 'signedIn', isMine: () => true, ME: { id: 'me' }, useDroppable: () => ({}), useDndContext: () => ({}),
      useState: React.useState, t: (k) => k, SPACES: [], nameIn: () => '나', menuProps: () => ({}), crewMenu: () => [], setUi() {}, CSS: { Translate: { toString: () => '' } }, mergeHandlers: () => ({}),
      dragHasFiles: () => false, filesFromTransfer: () => [], Face: () => null, ACCEPTS: [], useStore: (sel) => sel({ boardError }) });
    return renderToStaticMarkup(h(CrewRow, { crew: { id: 'c', name: '페퍼', status: 'idle' }, space: 'me', group: 'g', order: ['c'], mode: 'pin', movable: true }));
  };
  assert.match(side(null), /class="dot idle"/);
  assert.match(side(Date.now()), /class="dot rest"/);
});
