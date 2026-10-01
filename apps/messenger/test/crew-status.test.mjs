// 에이전트 시트의 "파견 중"(초록)과 "부재중"(회색)이 같이 보여 지금 쓸 수 있는지 알기 어렵던 것(UX 점검 C) —
// 상태 하나로 합친다: 지금 대화할 수 있다 / 지금은 못 한다(이유 하나).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crewAvailability } from '../src/crew-status.mjs';
import { t } from '../src/i18n.js';

const NOW = Date.parse('2026-10-01T12:00:00Z'); const AWAY = 90_000;
const seen = (msAgo) => new Date(NOW - msAgo).toISOString();
const A = (crew) => crewAvailability(crew, { now: NOW, awayMs: AWAY });

test('파견 중이고 최근에 접속했으면 지금 대화 가능', () => {
  assert.deepEqual(A({ status: 'active', last_seen_at: seen(10_000) }), { state: 'ready', ready: true });
});

test('파견 중이어도 오래 접속이 없으면 대화 불가 — 이유는 꺼져 있음(마지막 접속 포함)', () => {
  assert.deepEqual(A({ status: 'active', last_seen_at: seen(5 * 60_000) }), { state: 'away', ready: false, lastSeen: seen(5 * 60_000) });
  assert.deepEqual(A({ status: 'active', last_seen_at: null }), { state: 'away', ready: false, lastSeen: null });
});

test('파견 해제 상태는 접속 여부와 상관없이 대화 불가 — 이유는 해제', () => {
  assert.deepEqual(A({ status: 'available', last_seen_at: seen(1_000) }), { state: 'recalled', ready: false });
});

test('경계: 정확히 90초면 부재중(앱의 crewAway와 같은 >= 판정)', () => {
  assert.equal(A({ status: 'active', last_seen_at: seen(AWAY) }).ready, false);
  assert.equal(A({ status: 'active', last_seen_at: seen(AWAY - 1) }).ready, true);
});

test('문구 — 상태 세 가지가 ko·en 모두 있고 서로 다르며, 낱말 "파견 중"과 "부재중"을 한 화면에 같이 쓰지 않는다', () => {
  for (const lang of ['ko', 'en']) {
    const m = ['ready', 'away', 'recalled'].map((s) => t(`crew.state.${s}`, lang, { when: '오후 12:10' }));
    assert.equal(new Set(m).size, 3); for (const s of m) assert.ok(s.length > 4);
  }
  assert.match(t('crew.state.ready', 'ko'), /대화할 수 있/); assert.match(t('crew.state.away', 'ko'), /대화할 수 없/); assert.match(t('crew.state.recalled', 'ko'), /대화할 수 없/);
});

test('"256px" 같은 내부 수치는 사용자 문구에 없다', () => {
  assert.doesNotMatch(t('profile.avatar.note', 'ko'), /\d+px/); assert.doesNotMatch(t('profile.avatar.note', 'en'), /\d+px/);
});

test('앱: 시트에 상태 줄은 하나(파견 줄·부재중 줄을 따로 두지 않는다), 해제·파견 버튼은 그 줄에', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const sheet = app.slice(app.indexOf('function CrewSheet('), app.indexOf('/* ─── 채널 시트'));
  assert.match(sheet, /const avail = crewAvailability\(crew, \{ awayMs: AWAY_MS \}\);/);
  assert.match(sheet, /t\(`crew\.state\.\$\{avail\.state\}`/);
  assert.doesNotMatch(sheet, /t\('crew\.dispatch\.state'\)/, '"파견" 줄 제거');
  assert.doesNotMatch(sheet, /on \? t\('crew\.online'\) : t\('crew\.away'\)/, '"부재중" 줄 제거');
  assert.match(sheet, /t\('crew\.recall'\)/); assert.match(sheet, /t\('crew\.dispatch'\)/);
});
