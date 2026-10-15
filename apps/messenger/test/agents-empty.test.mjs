// D7(링크 감사 2-1) — 개인 공간에 에이전트가 0명이면 '에이전트' 구역과 계정 단서를 보인다. 인접 행동(에이전트 있음·조직 공간·멈춤)은 종전 그대로.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { railAgentsView, phoneAgentsEmpty, ownAgentsEmptyOf } from '../src/agents-empty.mjs';
import { t } from '../src/i18n.js';

const email = 'other@audit.test';
test('인접 핀: 개인 공간에 에이전트가 있으면 구역만, 안내 없음(종전)', () => {
  assert.deepEqual(railAgentsView({ isPersonal: true, shown: 2, email }), { section: true, hint: null });
});
test('인접 핀: 조직 공간은 종전 — 조직이 있으면 구역, 비면 phone.agents.none, 막힌 조직이면 구역 없음', () => {
  assert.deepEqual(railAgentsView({ isPersonal: false, orgReady: true, shown: 0, email }), { section: true, hint: { key: 'phone.agents.none', vars: {} } });
  assert.deepEqual(railAgentsView({ isPersonal: false, orgReady: true, shown: 3 }), { section: true, hint: null });
  assert.deepEqual(railAgentsView({ isPersonal: false, orgReady: true, shown: 0, available: 1 }), { section: true, hint: null });
  assert.deepEqual(railAgentsView({ isPersonal: false, orgReady: false }), { section: false, hint: null });
});
test('인접 핀: 꺼 둔·멈춘 에이전트만 있으면 종전처럼 구역을 숨긴다(멈춤 이유 안내가 따로 있다 — 같은 계정이므로 계정 단서는 틀린 말)', () => {
  assert.deepEqual(railAgentsView({ isPersonal: true, shown: 0, paused: 2, ownEmpty: true, email }), { section: false, hint: null });
  assert.deepEqual(railAgentsView({ isPersonal: true, shown: 0, available: 1, ownEmpty: true, email }), { section: false, hint: null });
});
test('D7: 개인 공간 0명(다른 계정 포함) → 구역 + 이 계정 이메일이 든 안내', () => {
  assert.deepEqual(railAgentsView({ isPersonal: true, shown: 0, ownEmpty: true, email }), { section: true, hint: { key: 'agents.none.account', vars: { email } } });
  assert.deepEqual(railAgentsView({ isPersonal: true, shown: 0, ownEmpty: true, email: null }), { section: true, hint: { key: 'agents.none.account.noemail', vars: {} } });
});
test('폰 에이전트 탭: 비면 계정 단서, 멈춘 에이전트가 있으면 종전 문구', () => {
  assert.deepEqual(phoneAgentsEmpty({ ownEmpty: true, email }), { key: 'agents.none.account', vars: { email } });
  assert.deepEqual(phoneAgentsEmpty({ paused: 1, ownEmpty: true, email }), { key: 'phone.agents.none', vars: {} });
});
test('오프라인·옛 서버: 내 에이전트 목록을 못 읽었으면(ownEmpty false) 계정 단서를 띄우지 않고 종전 그대로', () => {
  assert.deepEqual(railAgentsView({ isPersonal: true, shown: 0, ownEmpty: false, email }), { section: false, hint: null });
  assert.deepEqual(phoneAgentsEmpty({ ownEmpty: false, email }), { key: 'phone.agents.none', vars: {} });
});

test('문구: ko·en, 이메일이 들어간다', () => {
  for (const lang of ['ko', 'en']) {
    assert.match(t('agents.none.account', lang, { email }), /other@audit\.test/);
    assert.ok(t('agents.none.account.noemail', lang) !== 'agents.none.account.noemail');
  }
});

test('검수 2 #1037: 꺼 둔(available) 에이전트만 있으면 — 앱 배선 값 그대로(개인 공간 로더는 myAvailable 0, paused 0) 종전 화면', () => {
  const own = { rows: [{ id: 'c1', org_id: null, status: 'available' }, { id: 'c2', org_id: 'o1', status: 'available' }] }; // readOwnCrews는 active·available을 읽는다
  const ownEmpty = ownAgentsEmptyOf(own);
  assert.equal(ownEmpty, false, '꺼 둔 행이 있으면 내 에이전트가 없는 것이 아니다');
  assert.deepEqual(railAgentsView({ isPersonal: true, shown: 0, available: 0, paused: 0, ownEmpty, email }), { section: false, hint: null });
  assert.deepEqual(phoneAgentsEmpty({ paused: 0, ownEmpty, email }), { key: 'phone.agents.none', vars: {} });
  assert.equal(ownAgentsEmptyOf({ rows: [] }), true, '행이 하나도 없을 때만 빈 것');
  assert.equal(ownAgentsEmptyOf(null), false, '못 읽었으면 모른다');
});
