// 탭 복귀 다시 읽기(16차)가 응답을 적용하기 직전에 '안 저장한 편집'을 다시 본다 — 판 번호·본문을 읽는 사이에 친 글자(편집기 0.8초 대기)는
// 보낼 목록에 아직 없어서, 예전에는 서버 본문이 덮고 편집기가 다시 떠 글자가 없어졌다(16차 분리 검수 M1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const load = (file, dependencies) => {
  const source = readFileSync(new URL(`../src/core/${file}`, import.meta.url), 'utf8').replace(/^import .*;$/gm, '');
  const module = { exports: {} };
  const globals = { ...dependencies, module, exports: module.exports };
  new Function(...Object.keys(globals), transformSync(source, { loader: 'js', format: 'cjs' }).code)(...Object.values(globals));
  return module.exports;
};

function fixture() {
  const state = { pages: [{ id: 'p', title: '노트', content: { type: 'doc', content: [{ type: 'paragraph' }] }, version: 1 }] };
  const row = { title: '노트', content: { type: 'doc', content: [{ type: 'heading' }] }, version: 2, updated_at: 'now', owner_user_id: 'alice', org_id: null };
  const query = { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: row, error: null }) };
  const pull = load('pull.js', { getStorageScope: () => 'alice', ME: { id: 'alice' }, SPACES: [], getClient: async () => ({ from: () => query, rpc: async () => ({ data: 'edit' }) }),
    getState: () => state, update: (fn) => Object.assign(state, fn(state)), outbox: { has: () => false }, mergePages() {}, mapBoard() {} });
  return { state, pull };
}

test('reload skips applying the server body when the page became busy while reading', async () => {
  const { state, pull } = fixture();
  const before = state.pages[0];
  await pull.loadPageContent('p', { skip: () => true });
  assert.equal(state.pages[0], before);
});

test('reload applies the server body when nothing is pending', async () => {
  const { state, pull } = fixture();
  await pull.loadPageContent('p', { skip: () => false });
  assert.equal(state.pages[0].version, 2);
  assert.equal(state.pages[0].content.content[0].type, 'heading');
});

test('force reload (conflict "load latest") ignores skip', async () => {
  const { state, pull } = fixture();
  await pull.loadPageContent('p', { force: true, skip: () => true });
  assert.equal(state.pages[0].version, 2);
});

test('PageView tab-return reload passes the busy check through to the apply step', () => {
  const src = readFileSync(new URL('../src/pages/PageView.jsx', import.meta.url), 'utf8');
  assert.match(src, /loadPageContent\(id, \{ skip: \(\) => pageBusy\(id\) \}\)/);
});
