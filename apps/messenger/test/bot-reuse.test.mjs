// "오픈클로 다시 연결"을 누를 때마다 같은 이름 봇이 새로 생기던 결함(UX 점검 D, 2026-10-01 QA DB에서 재현 —
// 앱 밖(브라우저)에서는 에이전트 목록이 없어 external_id 없이 봇을 만들고, 그 길은 기존 봇을 찾지 않고 늘 새로 만들었다).
// findReusableBot: 다시 연결이 토큰만 새로 받을 기존 봇을 고른다. 다른 사람·다른 종류·해제된 봇·이름 다른 수동 봇은 건드리지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findReusableBot } from '../src/bot-reuse.mjs';

const ME = 'u-me'; const OTHER = 'u-other';
const bot = (o) => ({ id: 'b', kind: 'openclaw', name: '유건의 오픈클로', created_by: ME, external_id: null, revoked_at: null, ...o });

test('external_id가 있으면 같은 설치·같은 에이전트의 내 봇(기존 동작)', () => {
  const bots = [bot({ id: '1', external_id: 'x1' }), bot({ id: '2', external_id: 'x2' })];
  assert.equal(findReusableBot(bots, { kind: 'openclaw', uid: ME, name: 'n', extId: 'x2' })?.id, '2');
  assert.equal(findReusableBot(bots, { kind: 'openclaw', uid: ME, name: 'n', extId: 'zz' }), null);
});

test('external_id 없는 수동 연결 — 같은 기본 이름의 내 봇이 있으면 그것을 다시 쓴다(새로 만들지 않는다)', () => {
  const bots = [bot({ id: '1' })];
  assert.equal(findReusableBot(bots, { kind: 'openclaw', uid: ME, name: '유건의 오픈클로', extId: null })?.id, '1');
});

test('수동 연결에서 재사용하면 안 되는 것 — 해제됨, 남의 봇, 다른 종류, 이름이 다른 봇("다른 에이전트 추가"로 만든 것), external_id가 있는 봇(앱이 이 컴퓨터에 연결해 둔 것)', () => {
  const want = { kind: 'openclaw', uid: ME, name: '유건의 오픈클로', extId: null };
  assert.equal(findReusableBot([bot({ revoked_at: '2026-10-01T00:00:00Z' })], want), null);
  assert.equal(findReusableBot([bot({ created_by: OTHER })], want), null);
  assert.equal(findReusableBot([bot({ kind: 'hermes' })], want), null);
  assert.equal(findReusableBot([bot({ name: 'VPS 오픈클로' })], want), null);
  assert.equal(findReusableBot([bot({ external_id: 'x1' })], want), null);
});

test('같은 조건이 여럿이면 가장 먼저 만든 것 하나(목록 순서)', () => {
  assert.equal(findReusableBot([bot({ id: 'old' }), bot({ id: 'new' })], { kind: 'openclaw', uid: ME, name: '유건의 오픈클로', extId: null })?.id, 'old');
});

test('앱: mkOrRotate가 봇 찾기를 findReusableBot 한 곳에서 한다', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /const cur = findReusableBot\(bots, \{ kind, uid, name, extId \}\);/);
  assert.doesNotMatch(app, /const cur = extId \? botOf\(kind, extId\) : null;/);
});
