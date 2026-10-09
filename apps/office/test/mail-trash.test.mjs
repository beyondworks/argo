// 메일 휴지통(유건 10/9 "휴지통 삭제도 이어서 만들어줘") — Gmail 휴지통으로 옮기기·되돌리기. 영구 삭제는 하지 않는다(Gmail이 30일 뒤 지운다).
// core/mail.js·transport.js는 Vite 환경값을 읽는 모듈을 들여와 노드에서 바로 못 불러오므로, 가져오기 줄을 지우고 가짜를 넣어 그대로 실행한다(names-decide 테스트와 같은 방식).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as MM from '../src/pages/mail-model.js';
import { bulkTargets } from '../src/pages/mail-bulk.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const run = (file, deps) => {
  const source = readFileSync(new URL(`../src/core/${file}`, import.meta.url), 'utf8').replace(/^import .*;$/gm, '');
  const module = { exports: {} };
  new Function(...Object.keys(deps), 'module', 'exports', transformSync(source, { loader: 'js', format: 'cjs' }).code)(...Object.values(deps), module, module.exports);
  return module.exports;
};

/** core/mail.js — update(fn, ops)의 ops를 모은다. pending = 보낼 목록에 있는 키 */
function mailWith(state, { pending = new Set(), sending = new Set(), answer = () => [200, {}] } = {}) {
  const ops = [];
  globalThis.fetch = async (url, init) => {
    const op = /\/api\/mail\/(\w+)/.exec(url)[1], body = init?.body ? JSON.parse(init.body) : null;
    const [status, data] = answer(op, body);
    return { ok: status < 400, status, json: async () => data, headers: { get: () => null } };
  };
  const sb = { auth: { getSession: async () => ({ data: { session: null } }) } };
  const M = run('mail.js', { getClient: async () => sb, getMode: () => 'signedIn', ME: { id: 'u' }, update: (fn, o = []) => { Object.assign(state, fn(state)); ops.push(...o); }, getState: () => state,
    outbox: { has: (k) => pending.has(k), drop: (k) => { if (!sending.has(k)) pending.delete(k); return Promise.resolve(); } }, VIEWABLE: {}, isDesktop: () => false, apiUrl: (u) => `http://x${u}`, saveAttachment() {}, restore: (_k, d) => d, persist() {}, forget() {},
    scopedStorageKey: (k) => k, getStorageScope: () => 'u', mergeList: MM.mergeList, applySync: MM.applySync, newArrivals: MM.newArrivals, byDate: MM.byDate, replySubject: MM.replySubject, CAP: 1,
    t: (k) => k, registerDict() {}, MAIL_DICT: {} });
  return { M, ops };
}
const mail = (o = {}) => ({ id: 'a1:g1', gid: 'g1', account: 'a1', folder: 'inbox', unread: false, subject: '견적', at: '2026-10-09T00:00:00Z', ...o });

// 이유: 보관처럼 화면에서 먼저 빼고(받은편지함에서 사라진다) 보낼 목록으로 Gmail에 반영한다. 되돌리기는 원래 메일함으로 + untrash.
test('휴지통: 화면에서 빼고 trash 하나, 되돌리기는 원래 메일함과 untrash', () => {
  const state = { mails: [mail({ folder: 'archive' })], mailAccounts: [] };
  const { M, ops } = mailWith(state);
  const undo = M.trashMail(state.mails[0]);
  assert.equal(state.mails[0].folder, 'trash');
  assert.equal(MM.inView(state.mails[0], 'archive', 'all'), false, '어느 메일함에도 안 보인다');
  assert.deepEqual(ops, [['trash:a1:g1', { type: 'mail.trash', id: 'a1:g1', account: 'a1', gid: 'g1', on: true }]]);
  undo();
  assert.equal(state.mails[0].folder, 'archive', '보관함에서 지웠으면 보관함으로');
  assert.equal(state.mails[0].trashedFrom, undefined);
  assert.deepEqual(ops.slice(1), [['trash:a1:g1', { type: 'mail.trash', id: 'a1:g1', account: 'a1', gid: 'g1', on: false }]], '보관함으로는 untrash만(받은편지함 라벨과 상관없이 결과가 같다)');
});

// 이유: 휴지통으로 간 메일은 동기화가 목록에서 치운다 — 그 뒤 되돌리기를 눌러도 메일이 돌아와야 한다(되돌리기가 조용히 아무 일도 안 하면 메일을 잃은 것처럼 보인다).
test('휴지통: 동기화가 치운 뒤 되돌려도 메일이 돌아온다', () => {
  const state = { mails: [mail()], mailAccounts: [] };
  const { M } = mailWith(state);
  const undo = M.trashMail(state.mails[0]);
  state.mails = []; // applySync가 휴지통 메일을 뺐다
  undo();
  assert.deepEqual(state.mails.map((m) => [m.id, m.folder]), [['a1:g1', 'inbox']]);
});

// 이유: 예시 메일(계정 없음)은 서버가 없다 — 이 기기에서만 빼고 되돌린다(별표·보관과 같다).
test('휴지통: 예시 메일은 보낼 것이 없다', () => {
  const state = { mails: [mail({ account: undefined, gid: undefined, id: 'm1' })], mailAccounts: [] };
  const { M, ops } = mailWith(state);
  M.trashMail(state.mails[0])();
  assert.deepEqual(ops, []);
  assert.equal(state.mails[0].folder, 'inbox');
});

// 이유: 휴지통이 아직 Gmail에 안 갔을 때(보낼 목록에 있음) 받은 목록이 그 메일을 받은편지함으로 돌려주면, 이 기기 값(휴지통)을 지킨다 — 지운 메일이 다시 뜨지 않게.
test('휴지통: 보내는 중이면 받은 목록이 되살리지 않는다', async () => {
  const state = { mails: [mail({ folder: 'trash' })], mailAccounts: [{ id: 'a1', status: 'ok' }] };
  const answer = (op) => (op === 'list' ? [200, { items: [mail({ folder: 'inbox' })], next: null }] : op === 'sync' ? [200, { results: [] }] : [200, {}]);
  const { M } = mailWith(state, { pending: new Set(['trash:a1:g1']), answer });
  await M.pullMail('inbox');
  assert.ok(!state.mails.some((m) => MM.inView(m, 'inbox', 'all')), '받은편지함에 다시 뜨지 않는다(휴지통 값을 지킨 뒤 목록 합치기가 휴지통 메일을 치운다)');
});

// 이유: 전송 — 보낸 계정·Gmail 메시지 id로 /api/mail/trash. 메일이 목록에서 빠졌어도(되돌리기 전 동기화) 보낼 목록 값만으로 보낸다.
test('전송: mail.trash → /api/mail/trash { account, id: gid, on }', async () => {
  let send;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([url, JSON.parse(init.body), init.headers.authorization]); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  run('transport.js', { setTransport: (s) => { send = s; }, getState: () => ({ mails: [] }), update() {}, getMode: () => 'signedIn', SPACES: [], ME: { id: 'alice' }, getStorageScope: () => 'alice',
    getClient: async () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: 'alice' }, access_token: 'tok' } }, error: null }) } }),
    classify: (e) => e, setUi() {}, getUi: () => ({}), showToast() {}, t: (k) => k, persist() {}, heldKey: (id) => id, scopedStorageKey: (k) => k, apiUrl: (u) => u, announce() {}, apStale() {}, openExternal() {}, FAMILY: {} });
  await send({ payload: { type: 'mail.trash', ownerUid: 'alice', id: 'a1:g1', account: 'a1', gid: 'g1', on: true } });
  await send({ payload: { type: 'mail.trash', ownerUid: 'alice', id: 'a1:g1', account: 'a1', gid: 'g1', on: false } });
  assert.deepEqual(calls, [['/api/mail/trash', { account: 'a1', id: 'g1', on: true }, 'Bearer tok'], ['/api/mail/trash', { account: 'a1', id: 'g1', on: false }, 'Bearer tok']]);
  globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => ({ error: 'gmail' }) });
  await assert.rejects(send({ payload: { type: 'mail.trash', ownerUid: 'alice', id: 'a1:g1', account: 'a1', gid: 'g1', on: true } }), (e) => e.transient === true, '502는 다시 보낸다');
  await tick();
});

// 이유: 일괄 휴지통 — 초안은 따로 '임시 보관함 메일 지우기'(확인 창)가 있어 빼고, 나머지는 메일함과 상관없이(보관함·보낸편지함도) 휴지통으로.
test('일괄 휴지통 대상: 초안 빼고 전부', () => {
  const list = [mail({ id: 'a' }), mail({ id: 'b', folder: 'archive' }), mail({ id: 'c', folder: 'sent' }), mail({ id: 'd', folder: 'drafts' })];
  assert.deepEqual(bulkTargets(list, 'inbox').trash.map((m) => m.id), ['a', 'b', 'c']);
  assert.deepEqual(bulkTargets(list, 'archive').trash.map((m) => m.id), ['a', 'b', 'c']);
  assert.deepEqual(bulkTargets([mail({ id: 'd', folder: 'drafts' })], 'drafts').trash, []);
});

// 이유(재검수 #899 MEDIUM): 보낼 목록에 있다 ≠ Gmail에 아직 안 갔다(응답만 잃고 다시 보낼 차례인 요청). 되돌리기는 늘 untrash를 보낸다 —
// 아직 안 나간 휴지통이면 보낼 목록이 같은 키를 합쳐 untrash 한 번만 나간다(Gmail에 없는 휴지통을 되돌려도 결과는 같다).
test('휴지통: 되돌리기는 보낼 목록에 남아 있어도 untrash를 보낸다(빼지 않는다)', () => {
  const state = { mails: [mail()], mailAccounts: [] }, pending = new Set();
  const { M, ops } = mailWith(state, { pending });
  const undo = M.trashMail(state.mails[0]);
  pending.add('trash:a1:g1'); // 한 번 보냈다가 일시 오류로 다시 기다리는 중일 수 있다
  undo();
  assert.equal(pending.has('trash:a1:g1'), true, '보낼 목록에서 빼지 않는다');
  assert.deepEqual(ops.slice(1).map(([k, p]) => `${k}:${p.on ?? p.type}`), ['trash:a1:g1:false', 'mail:a1:g1:mail.flag'], '받은편지함으로는 untrash 뒤 받은편지함 라벨도');
});
// 이유(재검수 #899 LOW): 뒤로 가기로 휴지통 메일을 다시 열어 #를 누르면 휴지통 전 메일함이 'trash'로 덮였다 — 휴지통 메일은 다시 지우지 않는다.
test('휴지통: 이미 휴지통인 메일은 다시 지우지 않는다', () => {
  const state = { mails: [mail({ folder: 'trash', trashedFrom: 'inbox' })], mailAccounts: [] };
  const { M, ops } = mailWith(state);
  M.trashMail(state.mails[0])();
  assert.deepEqual(ops, []);
  assert.deepEqual([state.mails[0].folder, state.mails[0].trashedFrom], ['trash', 'inbox']);
});

// 이유(검수 #899 MEDIUM): 전송이 끝난 휴지통 메일이 캐시에 남아 ⌘K 검색에 다시 나왔다 — 보낼 목록에 없는 휴지통 메일은 목록 합치기·바뀐 것 받기가 치운다.
test('목록 합치기·바뀐 것 받기: 보내는 중이 아닌 휴지통 메일은 치운다', () => {
  const cache = [mail({ id: 'x', folder: 'trash' }), mail({ id: 'y', folder: 'trash' }), mail({ id: 'z' })];
  const busy = (id) => id === 'y';
  assert.deepEqual(MM.mergeList(cache, [], { view: 'inbox', busy }).map((m) => m.id), ['y', 'z']);
  assert.deepEqual(MM.applySync(cache, [], new Set(), busy).map((m) => m.id), ['y', 'z']);
});

// 이유(검수 #899 LOW): 보관(e) 직후 #로 휴지통에 넣으면, 보관 변경이 휴지통 상태에서 나가 받은편지함 라벨을 빼지 않았다 — 휴지통 전 메일함으로 보낸다.
test('전송: 휴지통에 있는 동안 나간 읽음·보관은 휴지통 전 메일함 기준', async () => {
  let send;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([url, JSON.parse(init.body)]); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  const state = { mails: [mail({ folder: 'trash', trashedFrom: 'archive' })] };
  run('transport.js', { setTransport: (s) => { send = s; }, getState: () => state, update() {}, getMode: () => 'signedIn', SPACES: [], ME: { id: 'alice' }, getStorageScope: () => 'alice',
    getClient: async () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: 'alice' }, access_token: 'tok' } }, error: null }) } }),
    classify: (e) => e, setUi() {}, getUi: () => ({}), showToast() {}, t: (k) => k, persist() {}, heldKey: (id) => id, scopedStorageKey: (k) => k, apiUrl: (u) => u, announce() {}, apStale() {}, openExternal() {}, FAMILY: {} });
  await send({ payload: { type: 'mail.flag', ownerUid: 'alice', id: 'a1:g1', patch: { folder: 'archive' } } });
  assert.deepEqual(calls, [['/api/mail/modify', { account: 'a1', id: 'g1', add: [], remove: ['UNREAD', 'INBOX'] }]]);
});
