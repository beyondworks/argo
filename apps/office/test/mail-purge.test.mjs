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
function mailWith(state, { mode = 'signedIn', answer = () => [200, {}] } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => { const op = /\/api\/mail\/(\w+)/.exec(url)[1], body = init?.body ? JSON.parse(init.body) : null; calls.push([op, body]); const [status, data] = answer(op, body); return { ok: status < 400, status, json: async () => data, headers: { get: () => null } }; };
  const M = run('mail.js', { getClient: async () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) } }), getMode: () => mode, ME: { id: 'u' },
    update: (fn) => Object.assign(state, fn(state)), getState: () => state, outbox: { has: () => false }, VIEWABLE: {}, isDesktop: () => false, apiUrl: (u) => u, saveAttachment() {},
    restore: (_k, d) => d, persist() {}, forget() {}, scopedStorageKey: (k) => k, getStorageScope: () => 'u', mergeList: MM.mergeList, applySync: MM.applySync, newArrivals: MM.newArrivals,
    byDate: MM.byDate, replySubject: MM.replySubject, CAP: 1, t: (k) => k, registerDict() {}, MAIL_DICT: {} });
  return { M, calls };
}
const mail = (id, o = {}) => ({ id, gid: id.split('.')[1], account: id.split('.')[0], folder: 'trash', at: '2026-10-09T00:00:00Z', ...o });

// 이유: 휴지통 비우기 = 그 계정의 Gmail 휴지통 전체 — 캐시에서는 그 계정의 휴지통 메일만 뺀다(다른 계정 휴지통·받은편지함은 그대로).
test('휴지통 비우기: 그 계정의 휴지통 메일만 캐시에서 뺀다', async () => {
  const state = { mails: [mail('a1.g1'), mail('a1.g2'), mail('a1.i1', { folder: 'inbox' }), mail('a2.g3')] };
  const { M, calls } = mailWith(state, { answer: () => [200, { deleted: 2 }] });
  assert.deepEqual(await M.purgeMail({ account: 'a1' }), { deleted: 2 });
  assert.deepEqual(calls, [['purge', { account: 'a1', confirm: 'purge' }]]);
  assert.deepEqual(state.mails.map((m) => m.id), ['a1.i1', 'a2.g3']);
});
// 이유: 고른 메일 영구 삭제 — 서버가 실제로 지운 것(지금 휴지통에 있던 것)만 뺀다.
test('고른 메일 영구 삭제: 서버가 지운 것만 뺀다', async () => {
  const state = { mails: [mail('a1.g1'), mail('a1.g2'), mail('a1.g3')] };
  const { M, calls } = mailWith(state, { answer: () => [200, { deleted: 1, ids: ['g1'] }] });
  await M.purgeMail({ account: 'a1', mails: [state.mails[0], state.mails[1]] });
  assert.deepEqual(calls[0][1], { account: 'a1', confirm: 'purge', ids: ['g1', 'g2'] });
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
