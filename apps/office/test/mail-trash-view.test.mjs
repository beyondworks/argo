// 메일 휴지통 메일함(유건 10/9 "휴지통 메일함도 만들어줘") — 휴지통 메일을 보고 꺼낸다. 영구 삭제·휴지통 비우기는 없다(Gmail이 30일 뒤 지운다).
// core/mail.js는 Vite 환경값을 읽는 모듈을 들여와 노드에서 바로 못 불러오므로, 가져오기 줄을 지우고 가짜를 넣어 그대로 실행한다(mail-trash 테스트와 같은 방식).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as MM from '../src/pages/mail-model.js';
import { bulkTargets } from '../src/pages/mail-bulk.js';
import { folderOf, FOLDER_QUERY } from '../server/gmail.js';

const run = (file, deps) => {
  const source = readFileSync(new URL(`../src/core/${file}`, import.meta.url), 'utf8').replace(/^import .*;$/gm, '');
  const module = { exports: {} };
  new Function(...Object.keys(deps), 'module', 'exports', transformSync(source, { loader: 'js', format: 'cjs' }).code)(...Object.values(deps), module, module.exports);
  return module.exports;
};
function mailWith(state, { answer = () => [200, {}] } = {}) {
  const ops = [];
  globalThis.fetch = async (url, init) => { const op = /\/api\/mail\/(\w+)/.exec(url)[1]; const [status, data] = answer(op, init?.body ? JSON.parse(init.body) : null); return { ok: status < 400, status, json: async () => data, headers: { get: () => null } }; };
  const M = run('mail.js', { getClient: async () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }), getMode: () => 'signedIn', ME: { id: 'u' }, update: (fn, o = []) => { Object.assign(state, fn(state)); ops.push(...o); }, getState: () => state,
    outbox: { has: () => false }, VIEWABLE: {}, isDesktop: () => false, apiUrl: (u) => u, saveAttachment() {}, restore: (_k, d) => d, persist() {}, forget() {},
    scopedStorageKey: (k) => k, getStorageScope: () => 'u', mergeList: MM.mergeList, applySync: MM.applySync, newArrivals: MM.newArrivals, byDate: MM.byDate, replySubject: MM.replySubject, CAP: 1,
    t: (k) => k, registerDict() {}, MAIL_DICT: {} });
  return { M, ops };
}
const mail = (o = {}) => ({ id: 'a1:g1', gid: 'g1', account: 'a1', folder: 'inbox', unread: false, at: '2026-10-09T00:00:00Z', ...o });

// 이유: 휴지통 메일은 휴지통 메일함에만 보인다(다른 메일함·안 읽음·별표에는 그대로 없다). 스팸은 휴지통에 섞지 않는다.
test('메일함: 휴지통 메일은 휴지통에만, 스팸은 어디에도 없다', () => {
  assert.ok(MM.VIEWS.includes('trash'));
  assert.equal(MM.VIEWS.at(-1), 'trash', '보관함 아래(맨 끝)');
  assert.equal(MM.inView(mail({ folder: 'trash' }), 'trash'), true);
  assert.equal(MM.inView(mail({ folder: 'trash', starred: true }), 'starred'), false);
  assert.equal(MM.inView(mail({ folder: 'trash', labels: ['TRASH', 'SENT'] }), 'sent'), false);
  assert.equal(MM.inView(mail(), 'trash'), false, '받은편지함 메일은 휴지통에 없다');
  assert.equal(MM.inView(mail({ folder: 'spam' }), 'trash'), false);
  assert.equal(MM.inView(mail({ folder: 'spam' }), 'inbox'), false);
});

// 이유: Gmail 라벨 → 메일함. 스팸을 'trash'로 묶으면 휴지통 메일함에 스팸이 섞인다 — 'spam'으로 나눈다. 휴지통 목록은 TRASH 라벨로 받는다.
test('서버: 스팸은 spam, 휴지통 목록은 TRASH 라벨', () => {
  assert.equal(folderOf(['TRASH', 'INBOX']), 'trash');
  assert.equal(folderOf(['SPAM', 'INBOX']), 'spam');
});

// 이유: 휴지통 메일함을 볼 때는 받은 휴지통 메일을 넣고, 30초 동기화도 지우지 않는다. 다른 메일함에서는 지금처럼 휴지통 메일을 넣지 않는다.
test('목록 합치기·바뀐 것 받기: 휴지통 보기에서만 휴지통 메일을 둔다', () => {
  const got = [mail({ id: 't1', folder: 'trash' }), mail({ id: 's1', folder: 'spam' })];
  assert.deepEqual(MM.mergeList([], got, { view: 'trash' }).map((m) => m.id), ['t1']);
  assert.deepEqual(MM.mergeList([], got, { view: 'inbox' }).map((m) => m.id), []);
  const cache = [mail({ id: 't1', folder: 'trash' }), mail({ id: 'i1' })];
  assert.deepEqual(MM.applySync(cache, [mail({ id: 't2', folder: 'trash' })], new Set(), () => false, true).map((m) => m.id).sort(), ['i1', 't1', 't2']);
  assert.deepEqual(MM.applySync(cache, [mail({ id: 't2', folder: 'trash' })], new Set(), () => false).map((m) => m.id), ['i1'], '휴지통 보기가 아니면 지금처럼 치운다');
});

// 이유: 꺼낸 메일이 갈 곳 — 이 기기에서 지운 메일은 지우기 전 메일함, 그 밖에는 Gmail 라벨(임시 보관함 > 받은편지함 > 보낸편지함 > 보관함, 서버 folderOf와 같은 순서).
test('꺼낼 곳', () => {
  const { M } = mailWith({ mails: [] });
  assert.equal(M.restoredFolder(mail({ folder: 'trash', trashedFrom: 'archive', labels: ['TRASH', 'INBOX'] })), 'archive');
  assert.equal(M.restoredFolder(mail({ folder: 'trash', labels: ['TRASH', 'INBOX'] })), 'inbox');
  assert.equal(M.restoredFolder(mail({ folder: 'trash', labels: ['TRASH', 'SENT'] })), 'sent');
  assert.equal(M.restoredFolder(mail({ folder: 'trash', labels: ['TRASH', 'DRAFT'] })), 'drafts');
  assert.equal(M.restoredFolder(mail({ folder: 'trash', labels: ['TRASH'] })), 'archive');
  assert.equal(M.restoredFolder(mail({ folder: 'trash' })), 'archive', '라벨을 모르면 보관함');
});

// 이유: 꺼내기 = untrash(받은편지함으로 갈 때만 받은편지함 라벨도 — 되돌리기와 같은 규칙, #899). 되돌리면 다시 휴지통.
test('꺼내기: untrash, 받은편지함이면 라벨도, 되돌리면 다시 휴지통', () => {
  const state = { mails: [mail({ folder: 'trash', labels: ['TRASH', 'INBOX'] })] };
  const { M, ops } = mailWith(state);
  const undo = M.restoreMail(state.mails[0]);
  assert.equal(state.mails[0].folder, 'inbox');
  assert.deepEqual(ops.map(([k, p]) => `${k}:${p.on ?? p.type}`), ['trash:a1:g1:false', 'mail:a1:g1:mail.flag']);
  undo();
  assert.equal(state.mails[0].folder, 'trash');
  assert.deepEqual(ops.at(-1), ['trash:a1:g1', { type: 'mail.trash', id: 'a1:g1', account: 'a1', gid: 'g1', on: true }]);
  const s2 = { mails: [mail({ folder: 'trash', labels: ['TRASH', 'SENT'] })] };
  const r2 = mailWith(s2);
  r2.M.restoreMail(s2.mails[0]);
  assert.deepEqual(r2.ops.map(([k]) => k), ['trash:a1:g1'], '보낸편지함으로는 untrash만');
  assert.equal(typeof mailWith({ mails: [] }).M.restoreMail(mail())(), 'undefined', '휴지통이 아닌 메일은 그대로');
});

// 이유: 휴지통 메일함의 일괄 동작은 꺼내기 하나 — 읽음·별표·보관·휴지통·맡기기는 꺼낸 뒤에.
test('일괄: 휴지통 보기에서는 꺼내기만', () => {
  const list = [mail({ id: 'a', folder: 'trash', unread: true }), mail({ id: 'b', folder: 'trash' })];
  const b = bulkTargets(list, 'trash');
  assert.deepEqual(b.restore.map((m) => m.id), ['a', 'b']);
  assert.deepEqual([b.read, b.unread, b.star, b.unstar, b.archive, b.trash], [[], [], [], [], [], []]);
  assert.deepEqual(bulkTargets([mail({ id: 'c' })], 'inbox').restore, []);
});

// 이유(검수 #903 MEDIUM): 휴지통 메일함을 보는 중에 다른 목록 받기(앱을 열 때 받은편지함·보낸 뒤 보낸편지함·검색 지우기)나 '더 보기'가 끝나면 휴지통 목록이 비었다.
// 휴지통을 보고 있는지는 받는 메일함이 아니라 화면(동기화를 원하는 화면이 휴지통)으로 정한다.
test('목록 합치기: 휴지통을 보는 동안은 어느 메일함을 받아도 휴지통 메일을 지우지 않는다', () => {
  const cache = [mail({ id: 't1', folder: 'trash' }), mail({ id: 't2', folder: 'trash' })];
  assert.deepEqual(MM.mergeList(cache, [mail({ id: 'i1' })], { view: 'inbox', trash: true }).map((m) => m.id), ['t1', 't2', 'i1']);
  assert.deepEqual(MM.mergeList(cache, [mail({ id: 't3', folder: 'trash' })], { view: 'trash', append: true, trash: true }).map((m) => m.id), ['t1', 't2', 't3'], '더 보기는 첫 쪽을 남긴다');
  assert.deepEqual(MM.mergeList(cache, [mail({ id: 'i1' })], { view: 'inbox' }).map((m) => m.id), ['i1'], '휴지통을 안 보면 지금처럼 치운다');
});
test('목록 받기: 휴지통 메일함 화면이 있으면 받은편지함을 받아도 휴지통 목록이 남는다', async () => {
  const state = { mails: [mail({ id: 'a1.t1', gid: 't1', folder: 'trash' })], mailAccounts: [{ id: 'a1', status: 'ok' }] };
  const { M } = mailWith(state, { answer: (op) => (op === 'list' ? [200, { items: [mail({ id: 'a1.i1', gid: 'i1' })], next: null }] : [200, { results: [] }]) });
  const stop = M.wantSync('mail', { ms: 30_000, view: 'trash' });
  await M.pullMail('inbox');
  assert.deepEqual(state.mails.map((m) => m.id).sort(), ['a1.i1', 'a1.t1']);
  stop();
  await M.pullMail('inbox');
  assert.deepEqual(state.mails.map((m) => m.id), ['a1.i1'], '휴지통 화면을 닫으면 지금처럼 치운다');
});

// 이유(검수 #903 LOW): 휴지통 메일 줄을 끌어 에이전트에게 맡길 수 있었다 · 휴지통에서 검색하면(결과는 휴지통이 아닌 메일) 막대에 동작이 없었다.
test('휴지통 검색 결과는 일반 일괄 동작', () => {
  const b = bulkTargets([mail({ id: 'c' })], 'search');
  assert.deepEqual(b.archive.map((m) => m.id), ['c']);
  assert.deepEqual(b.restore, []);
});

// 이유(검토 #903 미검증 → 방어): Gmail이 labelIds=TRASH만으로 휴지통 메일을 주는지 확인하지 못했다 — includeSpamTrash도 같이 보내 어느 쪽이든 받는다.
test('서버: 휴지통 목록은 휴지통을 포함해 받는다', () => {
  assert.deepEqual(FOLDER_QUERY.trash, { labelIds: 'TRASH', includeSpamTrash: 'true' });
});
