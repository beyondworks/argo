// 10/5 4차 분리 검수 LOW 4건 반영 — 변이(줄을 되돌림)에 초록이던 줄을 행동으로 잠근다.
// 화면 파일(.jsx)은 필요한 선언만 꺼내 가짜 의존·작은 훅 실행기와 함께 실행한다(review4-fixes와 같은 방식). 외부 접속 없음.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parse } from '@babel/parser';
import { transformSync } from 'esbuild';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as L from '../src/core/crew-list.js';
import * as MM from '../src/pages/mail-model.js';

const require = createRequire(import.meta.url);
const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
const h = React.createElement;
const tick = () => new Promise((r) => setTimeout(r, 0));

function pickCode(file, names) {
  const s = src(file);
  const body = parse(s, { sourceType: 'module', plugins: ['jsx'] }).program.body.map((n) => (n.type === 'ExportNamedDeclaration' && n.declaration ? n.declaration : n));
  return names.map((name) => {
    const n = body.find((x) => (x.type === 'FunctionDeclaration' && x.id?.name === name) || (x.type === 'VariableDeclaration' && x.declarations.some((d) => d.id.name === name)));
    return n ? s.slice(n.start, n.end) : `const ${name} = undefined;`;
  }).join('\n');
}
function run(file, deps) {
  const source = src(file).replace(/^import .*;$/gm, '');
  const module = { exports: {} };
  new Function(...Object.keys(deps), 'module', 'exports', transformSync(source, { loader: 'js', format: 'cjs' }).code)(...Object.values(deps), module, module.exports);
  return module.exports;
}

/* ── 작은 훅 실행기 — 상태·효과(deps 비교)·비동기 뒤 다시 그리기. 정적 렌더는 효과를 돌리지 않아 '효과로 내리는 띠'를 못 본다 ── */
function mount(code, name, deps, props) {
  const slots = [];
  let idx = 0, effs = [], dirty = false;
  const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const hooks = {
    useState(init) { const k = idx++; slots[k] ??= { v: typeof init === 'function' ? init() : init }; const s = slots[k]; return [s.v, (n) => { const nv = typeof n === 'function' ? n(s.v) : n; if (!Object.is(nv, s.v)) { s.v = nv; dirty = true; } }]; },
    useRef(init) { const k = idx++; slots[k] ??= { v: { current: init } }; return slots[k].v; },
    useMemo(fn, d) { const k = idx++; if (slots[k] && same(slots[k].d, d)) return slots[k].v; slots[k] = { v: fn(), d }; return slots[k].v; },
    useEffect(fn, d) { const k = idx++; if (slots[k] && d && same(slots[k].d, d)) return; slots[k] = { d, cleanup: slots[k]?.cleanup }; effs.push([k, fn]); },
    useSyncExternalStore(_sub, get) { idx++; return get(); },
  };
  const stub = new Proxy(() => null, { get: (t, k) => (typeof k === 'symbol' || k === 'prototype' || k === '$$typeof' ? t[k] : stub), apply: () => null }); // 모르는 이름 = 아무것도 그리지 않는 부품
  const scope = new Proxy({ ...hooks, React, ...deps }, { has: (o, k) => typeof k === 'string' && (k in o || !(k in globalThis)), get: (o, k) => (k in o ? o[k] : k === Symbol.unscopables ? undefined : stub) });
  const compiled = transformSync(code, { loader: 'jsx', jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', format: 'cjs' }).code;
  const C = new Function('scope', `with (scope) { ${compiled}\nreturn ${name}; }`)(scope);
  const out = { html: '' };
  out.flush = async () => {
    for (let n = 0; n < 12; n++) {
      dirty = false; idx = 0; effs = [];
      const el = C(props);
      out.html = renderToStaticMarkup(el);
      for (const [k, fn] of effs) { slots[k].cleanup?.(); const c = fn(); slots[k].cleanup = typeof c === 'function' ? c : undefined; }
      await tick(); await tick(); await tick();
      if (!dirty) break;
    }
    return out.html;
  };
  return out;
}

/* ── mail.js 실행기(review4와 같은 가짜 서버) — calls에 요청을 모은다 ── */
function mailWith(state, answer, calls = []) {
  globalThis.fetch = async (url, init) => {
    const op = /\/api\/mail\/(\w+)/.exec(url)[1], body = init?.body ? JSON.parse(init.body) : null;
    calls.push(op === 'list' ? `list ${body.account}` : op);
    const [status, data] = answer(op, body);
    return { ok: status < 400, status, json: async () => data, headers: { get: () => null } };
  };
  const sb = { auth: { getSession: async () => ({ data: { session: null } }) } };
  return run('core/mail.js', { getClient: async () => sb, getMode: () => 'signedIn', ME: { id: 'u' }, update: (fn) => Object.assign(state, fn(state)), getState: () => state,
    outbox: { has: () => false }, VIEWABLE: {}, isDesktop: () => false, apiUrl: (u) => `http://x${u}`, saveAttachment() {}, restore: (_k, d) => d, persist() {}, forget() {},
    scopedStorageKey: (k) => k, getStorageScope: () => 'u', mergeList: MM.mergeList, applySync: MM.applySync, newArrivals: MM.newArrivals, byDate: MM.byDate, replySubject: MM.replySubject, CAP: 1,
    t: (k) => k, registerDict() {}, MAIL_DICT: {} });
}
const syncOk = (b) => [200, { results: b.accounts.map((a) => ({ account: a.account, historyId: '9', primed: true })) }];

/* ── LOW-2(d): 회복 받기 — 실패한 계정만, 2분 간격 ── */
test('LOW-2: 실패가 이어져도 정상 계정은 다시 받지 않고, 실패한 계정도 마지막 시도 2분 뒤에만 받는다', async () => {
  const realNow = Date.now; let now = realNow();
  Date.now = () => now;
  try {
    const state = { mailAccounts: [{ id: 'a1', status: 'ok' }, { id: 'a2', status: 'ok' }], mails: [] }, calls = [];
    const m = mailWith(state, (op, b) => (op === 'sync' ? syncOk(b) : b.account === 'a2' ? [502, { error: 'gmail' }] : [200, { items: [] }]), calls);
    await m.pullMail('inbox');
    assert.deepEqual(calls.filter((c) => c.startsWith('list')), ['list a1', 'list a2']);
    assert.equal(typeof state.mailError, 'number', 'a2 실패 = 실패 표시');
    calls.length = 0;
    now += 30_000; await m.syncMail();
    assert.deepEqual(calls, ['sync'], '30초 뒤 자동 갱신 — 간격 전이라 목록은 받지 않는다');
    calls.length = 0;
    now += 100_000; await m.syncMail(); // 마지막 시도로부터 130초
    assert.deepEqual(calls, ['sync', 'list a2'], '2분이 지나면 실패한 a2만(정상 a1은 다시 받지 않는다)');
    calls.length = 0;
    now += 30_000; await m.syncMail();
    assert.deepEqual(calls, ['sync'], '방금 시도했으면 다시 쉰다');
  } finally { Date.now = realNow; }
});
test('LOW-2: 받은편지함 실패 중 새로고침 한 번은 목록을 한 번만 받는다(list→sync→list 아님)', async () => {
  const state = { mailAccounts: [{ id: 'a1', status: 'ok' }], mails: [] }, calls = [];
  const m = mailWith(state, (op, b) => (op === 'sync' ? syncOk(b) : [502, { error: 'gmail' }]), calls);
  await m.pullMail('inbox'); calls.length = 0;
  await m.refreshMail('inbox');
  assert.deepEqual(calls, ['list a1', 'sync']);
});
test('LOW-2: 429 — 쉬는 동안 자동 갱신은 아무것도 보내지 않고, 갱신 중 429를 알게 되면 같은 차례의 회복 받기도 하지 않는다', async () => {
  const state = { mailAccounts: [{ id: 'a1', status: 'ok' }], mails: [], mailError: 1 }, calls = [];
  const m = mailWith(state, (op) => (op === 'sync' ? [200, { results: [{ account: 'a1', error: 'rate_limited', retryAfter: 1 }] }] : [200, { items: [] }]), calls); // 1초 — 쉬는 시간이 끝나기를 기다리며 프로세스가 매달리지 않게
  await m.syncMail();
  assert.deepEqual(calls, ['sync'], 'sync가 429를 알려도 같은 차례에 목록을 더 받지 않는다');
  assert.ok(m.limitLeft() > 0);
  calls.length = 0;
  await m.syncMail();
  assert.deepEqual(calls, [], '쉬는 동안에는 아무것도 보내지 않는다');
});

/* ── LOW-1(a): Mail 화면 — 주소 ?view=inbox 가 마지막 메일함보다 먼저, 받은편지함이 회복되면 실패 띠가 내려간다 ── */
test('LOW-1(a): 메일 화면 — ?view=inbox가 마지막 메일함(sent)보다 먼저라 받은편지함 단추가 aria-current, 회복되면 실패 띠가 사라진다', async () => {
  const store = {}; let state = { mails: [{ id: 'm1', account: 'a1', folder: 'inbox', unread: false, subject: '안녕', date: '2026-10-05T00:00:00Z' }], mailAccounts: [{ id: 'a1', status: 'ok' }], mailError: Date.now() };
  globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  globalThis.location = { search: '?view=inbox' };
  const calls = { pull: 0 };
  const M = run('core/mail.js', { getClient: async () => null, getMode: () => 'sample', ME: { id: 'u' }, update() {}, getState: () => state, outbox: { has: () => false }, VIEWABLE: {}, isDesktop: () => false, apiUrl: (u) => u,
    saveAttachment() {}, restore: (_k, d) => d, persist() {}, forget() {}, scopedStorageKey: (k) => k, getStorageScope: () => 'u', mergeList: MM.mergeList, applySync: MM.applySync, newArrivals: MM.newArrivals,
    byDate: MM.byDate, replySubject: MM.replySubject, CAP: 1, t: (k) => k, registerDict() {}, MAIL_DICT: {} });
  M.writeView('sent'); // 마지막에 본 메일함
  const code = pickCode('pages/Mail.jsx', ['ICON', 'viewName', 'Mail']);
  const deps = { ...MM, ok: (a) => a.status === 'ok', firstView: M.firstView, readView: M.readView, writeView: M.writeView, hardFails: M.hardFails, t: (k, v) => (v ? `${k}${JSON.stringify(v)}` : k), ago: () => '방금',
    useLang() {}, useSession: () => 'signedIn', useStore: (sel) => sel(state), useLimit: () => 0, useWidth: () => [360, () => {}], useSelection: () => [new Set(), () => {}], /* 실제 훅처럼 [고른 것, 바꾸기] — 메일함을 바꾸면 선택을 비우는 효과가 바꾸기를 부른다(#895) */ useUi: () => ({}), useDraggable: () => ({}),
    ME: { id: 'u', email: 'u@x' }, getState: () => state, getUi: () => ({}), setUi() {}, navigate() {}, showToast() {}, subscribeSync() {}, lastSynced: () => 0, subscribeLimit() {}, getLimitUntil: () => 0, limitLeft: () => 0,
    loadAccounts: async () => {}, seedSample() {}, wantSync: () => () => {}, hasMore: () => false, mailItems: () => [], desktopMailPending: () => false, subscribeMailPending() {},
    pullMail: async () => { calls.pull++; return { ids: ['m1'], failed: [{ account: { id: 'a1' }, code: 'gmail' }], more: false }; }, VIEWS: MM.VIEWS, inView: MM.inView, byDate: MM.byDate };
  const view = mount(code, 'Mail', deps, { id: undefined });
  let html = await view.flush();
  assert.match(html, /aria-current="true"[^>]*>(?:(?!<button).)*mail\.inbox/s, '받은편지함 단추에 aria-current');
  assert.doesNotMatch(html, /aria-current="true"[^>]*>(?:(?!<\/button>).)*mail\.sent/s, '마지막 메일함(sent)이 아니다');
  assert.match(html, /mailx\.someFail/, '받기 실패 = 띠');
  state = { ...state, mailError: null }; // 받은편지함이 회복됨(자동 갱신)
  html = await view.flush();
  assert.doesNotMatch(html, /mailx\.someFail/, '회복되면 띠가 내려간다');
  delete globalThis.location; delete globalThis.localStorage;
});

/* ── LOW-1(b)·LOW-3(1): 충돌 안내 — 버리기는 확인 한 번, 사본 저장이 강조 단추 ── */
// 요소 트리를 직접 훑는 도우미 — 훅 실행기 밖에서 마지막 렌더 요소를 얻는다
function mountTree(code, name, deps, props) {
  let last; const wrapped = mount(code.replace(`function ${name}(`, `function ${name}__(`) + `\nfunction ${name}(p) { return __capture(${name}__(p)); }`, name, { ...deps, __capture: (el) => (last = el) }, props);
  return { flush: wrapped.flush, tree: () => last };
}
function buttons(el) { const out = []; const walk = (n) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(walk); if (n.type === 'button') out.push(n); walk(n.props?.children); }; walk(el); return out; }
const label = (n) => [n.props.children].flat(9).filter((x) => typeof x === 'string').join('');
function dialogs(el) { const out = []; const walk = (n) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(walk); if (n.type && typeof n.type === 'function' && n.props?.footer) out.push(n); walk(n.props?.children); }; walk(el); return out; }

test('LOW-3(1): 서버에서 지워진 페이지 충돌 — 사본 저장이 강조, 버리기는 danger + 확인 한 번 뒤에만 지운다', async () => {
  const log = [], held = { 'held:p1': { title: '내 제목', content: { mine: true } } };
  const code = pickCode('pages/PageView.jsx', ['reloadServer', 'dropMine', 'copyPlace', 'ConflictBanner']);
  const deps = { loadPageContent: async () => null, forget: (k) => { delete held[k]; log.push(`forget ${k}`); }, heldKey: (id) => `held:${id}`, outbox: { drop: async (k) => log.push(`outbox.drop ${k}`) },
    setUi: (p) => log.push(`setUi ${JSON.stringify(p)}`), canManage: () => false, restore: (k, d) => held[k] ?? d, createPage: (...a) => { log.push(`createPage ${a[0]} ${a[1]} ${!!a[2].content.mine}`); return 'new1'; },
    navigate: (to) => log.push(`navigate ${to}`), baseOf: (sp) => (sp === 'me' ? '/me' : `/o/${sp}`), showToast: (m) => log.push(`toast ${m}`), t: (k) => k, Modal: function Modal() { return null; } };
  const v = mountTree(code, 'ConflictBanner', deps, { page: { id: 'p1', space: 'acme', parent: null, title: '원본' } });
  await v.flush();
  buttons(v.tree()).find((b) => label(b) === 'page.conflictReload').props.onClick(); // 새로 불러오기 → 서버에 없음 → gone
  await v.flush();
  const btn = (name) => buttons(v.tree()).find((b) => label(b) === name);
  assert.match(btn('page.conflictCopy').props.className, /primary/, '사본으로 저장이 강조 단추');
  assert.doesNotMatch(btn('page.conflictDrop').props.className, /primary/, '버리기는 강조가 아니다');
  log.length = 0;
  btn('page.conflictDrop').props.onClick(); await v.flush(); await tick();
  assert.deepEqual(log, [], '버리기 단추만으로는 아무것도 지우지 않는다');
  assert.ok(held['held:p1'], '보관본 남아 있음');
  const dlg = dialogs(v.tree()).find((d) => d.props.title === 'page.dropTitle');
  assert.ok(dlg, '확인 창이 뜬다');
  const confirmBtn = buttons(dlg.props.footer).find((b) => /danger/.test(b.props.className));
  assert.ok(confirmBtn, '확인 창의 버리기는 danger 단추');
  const cancel = buttons(dlg.props.footer).find((b) => !/danger/.test(b.props.className));
  cancel.props.onClick(); await v.flush();
  assert.equal(dialogs(v.tree()).length, 0, '취소하면 창이 닫히고');
  assert.ok(held['held:p1'], '보관본은 그대로');
  btn('page.conflictDrop').props.onClick(); await v.flush();
  buttons(dialogs(v.tree())[0].props.footer).find((b) => /danger/.test(b.props.className)).props.onClick(); await tick(); await tick();
  assert.deepEqual(log, ['forget held:p1', 'outbox.drop page:p1', 'setUi {"conflict":null}', 'navigate /o/acme'], '확인 뒤에야 보관본·보낼 목록을 지우고 닫는다');
});
test('LOW-1(b): 충돌 안내 — 안내 전환(새로 불러오기 → 서버에 없음), 사본 저장 뒤 보관본 지우기·내 공간 맨 위 사본', async () => {
  const log = [], held = { 'held:p1': { title: '내 제목', content: { mine: true } } };
  const code = pickCode('pages/PageView.jsx', ['reloadServer', 'dropMine', 'copyPlace', 'ConflictBanner']);
  const deps = { loadPageContent: async () => null, forget: (k) => { delete held[k]; log.push(`forget ${k}`); }, heldKey: (id) => `held:${id}`, outbox: { drop: async (k) => log.push(`outbox.drop ${k}`) },
    setUi: (p) => log.push(`setUi ${JSON.stringify(p)}`), canManage: () => false, restore: (k, d) => held[k] ?? d, createPage: (...a) => { log.push(`createPage ${a[0]} ${a[1]} ${!!a[2].content.mine}`); return 'new1'; },
    navigate: (to) => log.push(`navigate ${to}`), baseOf: (sp) => (sp === 'me' ? '/me' : `/o/${sp}`), showToast: (m) => log.push(`toast ${m}`), t: (k) => k, Modal: function Modal() { return null; } };
  const v = mountTree(code, 'ConflictBanner', deps, { page: { id: 'p1', space: 'acme', parent: null, title: '원본' } });
  await v.flush();
  assert.deepEqual(buttons(v.tree()).map(label), ['page.conflictCopy', 'page.conflictReload'], '처음: 사본 저장 · 새로 불러오기');
  buttons(v.tree()).find((b) => label(b) === 'page.conflictReload').props.onClick(); await v.flush();
  assert.deepEqual(buttons(v.tree()).map(label), ['page.conflictCopy', 'page.conflictDrop'], '서버에 없음 → 사본 저장 · 버리기로 전환');
  assert.deepEqual(log, [], '읽기 실패(서버에 없음)는 내 변경을 지우지 않는다');
  await buttons(v.tree()).find((b) => label(b) === 'page.conflictCopy').props.onClick(); await tick();
  assert.deepEqual(log, ['createPage me null true', 'forget held:p1', 'outbox.drop page:p1', 'setUi {"conflict":null}', 'navigate /me/p/new1', 'toast page.copySaved'], '내 공간 맨 위 사본을 만든 뒤에야 보관본·보낼 목록을 지운다');
});

/* ── LOW-1(c): 고정 순서 저장 일부 실패 — moveCrew도 모든 저장이 끝난 뒤 한 번만 다시 읽는다 ── */
test('LOW-1(c): moveCrew — 한 조직 저장이 실패하면 다른 조직 저장이 끝난 뒤 서버에서 한 번 다시 읽고, 실패를 알린다', async () => {
  const row = (id, org, pos) => ({ id, org, owner: 'me', pinned: true, pinPos: pos });
  const state = { crews: [row('a1', 'O1', 0), row('a2', 'O1', 1), row('b1', 'O2', 0), row('b2', 'O2', 1)] };
  const log = []; let release; const slow = new Promise((r) => { release = r; });
  const P = run('core/crew-prefs.js', { ME: { id: 'me' }, getMode: () => 'signedIn', update: (fn) => Object.assign(state, fn(state)), getState: () => state,
    rpc: async (_fn, a) => { if (a.p_org === 'O1') { log.push('O1 실패'); throw new Error('denied'); } await slow; log.push('O2 저장'); },
    pullBoard: async () => { log.push('다시 읽기'); }, moveIds: L.moveIds, reslot: L.reslot });
  const done = P.moveCrew(['a1', 'a2', 'b1', 'b2'], 'a1', 'b2', 'pin').then(() => 'ok', (e) => e.message);
  await tick(); await tick();
  assert.deepEqual(log, ['O1 실패'], '다른 조직 저장이 끝나기 전에는 다시 읽지 않는다');
  release();
  assert.equal(await done, 'denied');
  assert.deepEqual(log, ['O1 실패', 'O2 저장', '다시 읽기']);
});
