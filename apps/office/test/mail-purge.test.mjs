// 휴지통 비우기·영구 삭제(유건 10/9 권장안) — 화면 쪽 상태. 되돌릴 수 없는 동작이라 지운 것만 캐시에서 빼고, 권한이 없으면 아무것도 바꾸지 않는다.
// core/mail.js는 Vite 환경값을 읽는 모듈을 들여와 노드에서 바로 못 불러오므로, 가져오기 줄을 지우고 가짜를 넣어 그대로 실행한다(mail-trash 테스트와 같은 방식).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as MM from '../src/pages/mail-model.js';

const run = (file, deps) => {
  const source = readFileSync(new URL(`../src/core/${file}`, import.meta.url), 'utf8').replace(/^import .*;$/gm, '');
  const module = { exports: {} };
  new Function(...Object.keys(deps), 'module', 'exports', transformSync(source, { loader: 'js', format: 'cjs' }).code)(...Object.values(deps), module, module.exports);
  return module.exports;
};
function mailWith(state, { mode = 'signedIn', answer = () => [200, {}], pending = new Set() } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => { const op = /\/api\/mail\/(\w+)/.exec(url)[1], body = init?.body ? JSON.parse(init.body) : null; calls.push([op, body]); const [status, data] = answer(op, body); return { ok: status < 400, status, json: async () => data, headers: { get: () => null } }; };
  const M = run('mail.js', { getClient: async () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) } }), getMode: () => mode, ME: { id: 'u' },
    update: (fn) => Object.assign(state, fn(state)), getState: () => state, outbox: { has: (k) => pending.has(k), flush: async () => { calls.push(['flush']); return true; } }, VIEWABLE: {}, isDesktop: () => false, apiUrl: (u) => u, saveAttachment() {},
    restore: (_k, d) => d, persist() {}, forget() {}, scopedStorageKey: (k) => k, getStorageScope: () => 'u', mergeList: MM.mergeList, applySync: MM.applySync, newArrivals: MM.newArrivals,
    byDate: MM.byDate, replySubject: MM.replySubject, CAP: 1, t: (k) => k, registerDict() {}, MAIL_DICT: {} });
  return { M, calls };
}
const mail = (id, o = {}) => ({ id, gid: id.split('.')[1], account: id.split('.')[0], folder: 'trash', at: '2026-10-09T00:00:00Z', ...o });

// 이유: 휴지통 비우기 = 그 계정의 Gmail 휴지통 전체 — 캐시에서는 그 계정의 휴지통 메일만 뺀다(다른 계정 휴지통·받은편지함은 그대로).
test('휴지통 비우기: 그 계정의 휴지통 메일만 캐시에서 뺀다', async () => {
  const state = { mails: [mail('a1.g1'), mail('a1.g2'), mail('a1.i1', { folder: 'inbox' }), mail('a2.g3')] };
  const { M, calls } = mailWith(state, { answer: () => [200, { deleted: 2, ids: ['g1', 'g2'] }] });
  assert.deepEqual(await M.purgeMail({ account: 'a1' }), { deleted: 2 });
  assert.deepEqual(calls, [['flush'], ['purge', { account: 'a1', confirm: 'purge' }]], '보낼 목록을 먼저 보낸다(꺼낸 메일의 untrash가 비우기보다 늦지 않게)');
  assert.deepEqual(state.mails.map((m) => m.id), ['a1.i1', 'a2.g3']);
});
// 이유: 고른 메일 영구 삭제 — 서버가 실제로 지운 것(지금 휴지통에 있던 것)만 뺀다.
test('고른 메일 영구 삭제: 서버가 지운 것만 뺀다', async () => {
  const state = { mails: [mail('a1.g1'), mail('a1.g2'), mail('a1.g3')] };
  const { M, calls } = mailWith(state, { answer: () => [200, { deleted: 1, ids: ['g1'] }] });
  await M.purgeMail({ account: 'a1', mails: [state.mails[0], state.mails[1]] });
  assert.deepEqual(calls[1][1], { account: 'a1', confirm: 'purge', ids: ['g1', 'g2'] });
  assert.deepEqual(state.mails.map((m) => m.id), ['a1.g2', 'a1.g3'], 'g2는 그 사이 꺼냈다(서버가 안 지움)');
});
// 이유: 영구 삭제 권한이 없으면(지금 연결 전부) 아무것도 바꾸지 않고 scope_needed를 알린다 — 화면이 그 계정만 권한을 다시 받는다.
test('영구 삭제: 권한이 없으면 캐시 그대로, scope_needed', async () => {
  const state = { mails: [mail('a1.g1')] };
  const { M } = mailWith(state, { answer: () => [403, { error: 'scope_needed' }] });
  await assert.rejects(M.purgeMail({ account: 'a1' }), (e) => e.code === 'scope_needed');
  assert.deepEqual(state.mails.map((m) => m.id), ['a1.g1']);
});
// 이유: 예시 모드는 서버가 없다 — 이 기기의 예시 휴지통만 비운다.
test('예시 모드: 서버 없이 이 기기에서만', async () => {
  const state = { mails: [mail('m1', { account: undefined, gid: undefined }), mail('m2', { account: undefined, gid: undefined, folder: 'inbox' })] };
  const { M, calls } = mailWith(state, { mode: 'sample' });
  assert.deepEqual(await M.purgeMail({ account: undefined }), { deleted: 1 });
  assert.deepEqual(calls, []);
  assert.deepEqual(state.mails.map((m) => m.id), ['m2']);
  assert.deepEqual(await M.trashCounts([undefined]), [{ account: undefined, total: 0 }]);
  // 고른 예시 메일만 — Gmail id가 없어도 고르지 않은 예시 휴지통은 남는다
  state.mails = [mail('m3', { account: undefined, gid: undefined }), mail('m4', { account: undefined, gid: undefined })];
  assert.deepEqual(await M.purgeMail({ account: undefined, mails: [state.mails[0]] }), { deleted: 1 });
  assert.deepEqual(state.mails.map((m) => m.id), ['m4']);
});
// 이유: 확인 창의 계정별 개수 — 한 계정이 실패해도 다른 계정 개수는 보인다.
test('휴지통 개수: 계정마다, 실패는 그 계정만', async () => {
  const { M } = mailWith({ mails: [] }, { answer: (op, b) => (b.account === 'a2' ? [502, { error: 'gmail' }] : [200, { total: 7 }]) });
  assert.deepEqual(await M.trashCounts(['a1', 'a2']), [{ account: 'a1', total: 7 }, { account: 'a2', error: 'gmail' }]);
});
// 이유: 권한 다시 받기 — 연결 시작에 full을 실어 영구 삭제 권한까지 요청한다(평소 연결은 그대로).
test('권한 다시 받기: start에 full', async () => {
  const { M, calls } = mailWith({ mails: [] }, { answer: () => [200, { url: 'https://accounts.example/auth' }] });
  let went = null;
  globalThis.location = { pathname: '/me/mail', assign: (u) => { went = u; } };
  globalThis.sessionStorage = { setItem() {} };
  await M.connectGoogle('a@x.com', { full: true });
  await M.connectGoogle('a@x.com');
  assert.deepEqual(calls.map(([, b]) => b), [{ hint: 'a@x.com', full: true }, { hint: 'a@x.com' }]);
  assert.equal(went, 'https://accounts.example/auth');
  delete globalThis.location; delete globalThis.sessionStorage;
});

import { purgeTargets } from '../src/pages/mail-bulk.js';
// 이유(유건 10/9 권장안 2): 비우는 범위 — 계정 고르기가 '전체'면 연결된 계정 모두, 한 계정이면 그 계정만. 고른 메일 영구 삭제는 계정별로 묶는다(휴지통 메일만).
test('비우기 대상: 전체 = 연결된 계정 모두, 한 계정 = 그 계정, 고른 메일 = 계정별', () => {
  const accounts = [{ id: 'a1' }, { id: 'a2' }];
  assert.deepEqual(purgeTargets({ accounts, pick: 'all' }), [{ account: 'a1' }, { account: 'a2' }]);
  assert.deepEqual(purgeTargets({ accounts, pick: 'a2' }), [{ account: 'a2' }]);
  assert.deepEqual(purgeTargets({ accounts: [], pick: 'all', sample: true }), [{ account: undefined }]);
  const picked = [mail('a1.g1'), mail('a2.g2'), mail('a1.g3'), mail('a1.i1', { folder: 'inbox' })];
  assert.deepEqual(purgeTargets({ picked }).map((t) => [t.account, t.mails.map((m) => m.id), t.total]), [['a1', ['a1.g1', 'a1.g3'], 2], ['a2', ['a2.g2'], 1]], '휴지통이 아닌 메일은 빠진다');
});

import { purgeable } from '../src/pages/mail-bulk.js';
// 이유(검수 #905 HIGH): 화면에서 꺼냈지만 untrash가 아직 안 나간 메일은 Gmail에선 휴지통 — keep으로 넘겨 지우지 않게 한다.
test('비우기: 꺼낸 뒤 untrash 대기 중인 메일은 keep', async () => {
  const state = { mails: [mail('a1.x', { folder: 'inbox' }), mail('a1.y', { folder: 'inbox' }), mail('a1.t')] };
  const { M, calls } = mailWith(state, { answer: () => [200, { deleted: 1, more: false }], pending: new Set(['trash:a1.x']) });
  await M.purgeMail({ account: 'a1' });
  assert.deepEqual(calls[1][1], { account: 'a1', confirm: 'purge', keep: ['x'] });
});
// 이유(검수 #905 LOW): 전체 비우기 뒤 캐시 — 휴지통으로 보내는 중(아직 Gmail 휴지통에 없음)인 메일은 남긴다.
test('비우기: 보내는 중인 휴지통 메일은 캐시에 남는다', async () => {
  const state = { mails: [mail('a1.g1'), mail('a1.z')] };
  const { M } = mailWith(state, { answer: () => [200, { deleted: 1, ids: ['g1'], more: false }], pending: new Set(['trash:a1.z']) });
  await M.purgeMail({ account: 'a1' });
  assert.deepEqual(state.mails.map((m) => m.id), ['a1.z']);
});
// 이유: 한 번에 최대 5천 통 — 서버가 more면 다시 부르고 지운 수를 더한다.
test('비우기: more면 다시 부른다', async () => {
  const state = { mails: [] };
  let n = 0;
  const { M, calls } = mailWith(state, { answer: () => [200, n++ === 0 ? { deleted: 5000, ids: [], more: true } : { deleted: 600, ids: [], more: false }] });
  assert.deepEqual(await M.purgeMail({ account: 'a1' }), { deleted: 5600 });
  assert.equal(calls.filter(([op]) => op === 'purge').length, 2);
});
// 이유(검수 #905 LOW): 중간에 실패하면 지운 수를 알리고(오류에 deleted), 휴지통 목록을 다시 받아 화면을 맞춘다.
test('비우기: 중간 실패는 지운 수와 함께, 휴지통 목록 다시 받기', async () => {
  const state = { mails: [mail('a1.g1')], mailAccounts: [{ id: 'a1', status: 'ok' }] };
  const { M, calls } = mailWith(state, { answer: (op) => (op === 'purge' ? [502, { error: 'gmail', deleted: 500 }] : [200, { items: [], next: null }]) });
  await assert.rejects(M.purgeMail({ account: 'a1' }), (e) => e.code === 'gmail' && e.deleted === 500);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(calls.some(([op, b]) => op === 'list' && b.folder === 'trash'), '휴지통 목록을 다시 받는다');
});
// 이유(검수 #905 MEDIUM): 개수를 확인하지 못한 계정은 몇 통인지 보여 주지 않은 채 지우지 않는다. 빈 휴지통은 부르지 않는다.
test('지울 계정: 개수를 안 계정 중 1통 이상만', () => {
  assert.equal(purgeable({ total: 3 }), true);
  assert.equal(purgeable({ total: 0 }), false);
  assert.equal(purgeable({ error: 'gmail' }), false);
  assert.equal(purgeable({}), false);
});

// 이유(재검수 #905 LOW): 전체 비우기도 서버가 지운 id만 캐시에서 뺀다 — 서버가 다 못 지웠는데(남은 휴지통) 화면이 비어 보이지 않게.
test('비우기: 지운 id만 뺀다(남은 휴지통은 그대로)', async () => {
  const state = { mails: [mail('a1.g1'), mail('a1.g2')] };
  const { M } = mailWith(state, { answer: () => [200, { deleted: 1, ids: ['g1'], more: false }] });
  await M.purgeMail({ account: 'a1' });
  assert.deepEqual(state.mails.map((m) => m.id), ['a1.g2']);
});
// 이유(재검수 #905 LOW): 고른 메일은 100통씩 나눠 부른다(서버 함수 한 번의 시간·요청 한도 안), 지운 수는 더한다.
test('고른 메일: 100통씩 나눠 부른다', async () => {
  const picked = Array.from({ length: 230 }, (_, i) => mail(`a1.p${i}`));
  const state = { mails: [...picked] };
  const { M, calls } = mailWith(state, { answer: (op, b) => [200, { deleted: b.ids.length, ids: b.ids }] });
  assert.deepEqual(await M.purgeMail({ account: 'a1', mails: picked }), { deleted: 230 });
  assert.deepEqual(calls.filter(([op]) => op === 'purge').map(([, b]) => b.ids.length), [100, 100, 30]);
  assert.equal(state.mails.length, 0);
});
// 이유(재검수 #905 LOW): 꺼낸 메일 중 untrash 대기가 1000통을 넘으면(서버가 받을 수 있는 keep 상한) 지우지 않고 이유를 알린다.
test('비우기: 꺼낸 메일 대기가 너무 많으면 pending_many', async () => {
  const many = Array.from({ length: 1001 }, (_, i) => mail(`a1.r${i}`, { folder: 'inbox' }));
  const { M, calls } = mailWith({ mails: many }, { pending: new Set(many.map((m) => `trash:${m.id}`)) });
  await assert.rejects(M.purgeMail({ account: 'a1' }), (e) => e.code === 'pending_many');
  assert.ok(!calls.some(([op]) => op === 'purge'));
});
// 이유(재검수 #905 LOW): 서버가 more인데 한 통도 못 지웠으면(첫 쪽들이 전부 keep) 다시 부르며 맴돌지 않는다.
test('비우기: more인데 0통이면 멈춘다', async () => {
  const { M, calls } = mailWith({ mails: [] }, { answer: () => [200, { deleted: 0, ids: [], more: true }] });
  await M.purgeMail({ account: 'a1' });
  assert.equal(calls.filter(([op]) => op === 'purge').length, 1);
});

// 이유(재검수 #905 MEDIUM): 비우는 중에 그 계정 메일을 꺼내면(알림 되돌리기 등) keep에 없어 같이 지워진다 — 비우는 동안은 꺼내기를 하지 않는다(화면은 되돌리기 알림을 치운다).
test('비우는 동안 그 계정의 꺼내기는 하지 않는다', async () => {
  const z = mail('a1.z', { labels: ['TRASH', 'INBOX'] }), state = { mails: [z, mail('a2.w', { labels: ['TRASH', 'INBOX'] })] };
  let release;
  const { M, calls } = mailWith(state, { answer: (op) => (op === 'purge' ? [200, { deleted: 0, ids: [], more: false }] : [200, {}]) });
  const gate = new Promise((r) => { release = r; });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (String(url).includes('/purge')) await gate; return realFetch(url, init); };
  const running = M.purgeMail({ account: 'a1' });
  await new Promise((r) => setTimeout(r, 0));
  M.restoreMail(state.mails[0]);
  M.restoreMail(state.mails[1]);
  assert.deepEqual(state.mails.map((m) => `${m.id}:${m.folder}`), ['a1.z:trash', 'a2.w:inbox'], '비우는 계정(a1)만 막힌다');
  release(); await running;
  M.restoreMail(state.mails[0]);
  assert.equal(state.mails[0].folder, 'inbox', '끝나면 다시 꺼낼 수 있다');
  assert.ok(calls.length > 0);
});
