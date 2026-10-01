// "오픈클로 다시 연결"을 누를 때마다 같은 이름 봇이 새로 생기던 결함(UX 점검 D, 2026-10-01 QA DB에서 재현 —
// 앱 밖(브라우저)에서는 에이전트 목록이 없어 external_id 없이 봇을 만들고, 그 길은 기존 봇을 찾지 않고 늘 새로 만들었다).
// 검수 #797 MEDIUM-1: 재사용은 "다시 연결"(hermes·openclaw 수동 경로)에서만 — "다른 에이전트"(custom)와 "하나 더 추가"는 늘 새로 만든다
// (회전하면 이미 연결된 봇의 토큰이 무효가 된다). 찾는 기준은 화면 언어·표시 이름에 흔들리지 않게 두 언어의 기본 이름을 모두 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findReusableBot, canReconnect } from '../src/bot-reuse.mjs';
import { t } from '../src/i18n.js';

const ME = 'u-me'; const OTHER = 'u-other';
const NAMES = ['유건의 오픈클로', "유건's OpenClaw"]; // 호출하는 쪽이 만든 두 언어 기본 이름
let n = 0;
const bot = (o) => ({ id: `b${++n}`, kind: 'openclaw', name: '유건의 오픈클로', created_by: ME, external_id: null, revoked_at: null, created_at: '2026-10-01T00:00:00Z', ...o });

test('external_id가 있으면 같은 설치·같은 에이전트의 내 봇(기존 동작)', () => {
  const bots = [bot({ id: '1', external_id: 'x1' }), bot({ id: '2', external_id: 'x2' })];
  assert.equal(findReusableBot(bots, { kind: 'openclaw', uid: ME, extId: 'x2' })?.id, '2');
  assert.equal(findReusableBot(bots, { kind: 'openclaw', uid: ME, extId: 'zz' }), null);
});

test('external_id 없는 수동 연결 — 이름 목록(names)을 주면 그 이름의 내 봇을 다시 쓴다', () => {
  assert.equal(findReusableBot([bot({ id: '1' })], { kind: 'openclaw', uid: ME, extId: null, names: NAMES })?.id, '1');
});

test('이름 목록을 안 주면(custom "다른 에이전트"·"하나 더 추가") 이름이 같아도 절대 재사용하지 않는다', () => {
  const bots = [bot({ id: '1', name: '외부', kind: 'custom' }), bot({ id: '2', name: 'VPS Aesop' })];
  assert.equal(findReusableBot(bots, { kind: 'custom', uid: ME, extId: null }), null);
  assert.equal(findReusableBot(bots, { kind: 'custom', uid: ME, extId: null, names: [] }), null);
  assert.equal(findReusableBot(bots, { kind: 'openclaw', uid: ME, extId: null }), null);
});

test('화면 언어를 바꿔도(다른 언어 기본 이름으로 만든 봇) 찾는다 — 중복 생성 없음', () => {
  assert.equal(findReusableBot([bot({ id: 'en', name: "유건's OpenClaw" })], { kind: 'openclaw', uid: ME, extId: null, names: NAMES })?.id, 'en');
});

test('수동 연결에서 재사용하면 안 되는 것 — 해제됨, 남의 봇, 다른 종류, 이름이 다른 봇("하나 더 추가"로 만든 것), external_id가 있는 봇(앱이 이 컴퓨터에 연결해 둔 것)', () => {
  const want = { kind: 'openclaw', uid: ME, extId: null, names: NAMES };
  assert.equal(findReusableBot([bot({ revoked_at: '2026-10-01T00:00:00Z' })], want), null);
  assert.equal(findReusableBot([bot({ created_by: OTHER })], want), null);
  assert.equal(findReusableBot([bot({ kind: 'hermes' })], want), null);
  assert.equal(findReusableBot([bot({ name: 'VPS 오픈클로' })], want), null);
  assert.equal(findReusableBot([bot({ external_id: 'x1' })], want), null);
});

test('같은 조건이 여럿이면 가장 최근에 만든 봇 하나', () => {
  const bots = [bot({ id: 'old', created_at: '2026-09-01T00:00:00Z' }), bot({ id: 'new', created_at: '2026-10-01T00:00:00Z' }), bot({ id: 'mid', created_at: '2026-09-15T00:00:00Z' })];
  assert.equal(findReusableBot(bots, { kind: 'openclaw', uid: ME, extId: null, names: NAMES })?.id, 'new');
});

test('canReconnect — 버튼 라벨이 실제 재사용 판정과 같다: 브라우저는 재사용할 봇이 있을 때만, 데스크톱 앱은 내 봇이 하나라도 있으면', () => {
  const manual = bot({ id: 'm' }); const viaApp = bot({ id: 'a', external_id: 'x1' }); const other = bot({ id: 'o', name: 'VPS Aesop' });
  const web = (bots) => canReconnect(bots, { kind: 'openclaw', uid: ME, names: NAMES, desktop: false });
  assert.equal(web([manual]), true);
  assert.equal(web([viaApp]), false, '브라우저는 앱이 연결한 봇을 회전하지 않는다');
  assert.equal(web([other]), false, '이름이 다른 봇은 "다시 연결" 대상이 아니다');
  assert.equal(web([]), false);
  assert.equal(canReconnect([viaApp], { kind: 'openclaw', uid: ME, names: NAMES, desktop: true }), true);
  assert.equal(canReconnect([bot({ created_by: OTHER })], { kind: 'openclaw', uid: ME, names: NAMES, desktop: true }), false);
});

test('회전했을 때의 안내는 "만들었습니다"가 아니라 토큰 재발급·이전 설정 무효(ko·en)', () => {
  assert.match(t('org.agents.rotated.again', 'ko'), /토큰을 새로 발급했습니다/); assert.match(t('org.agents.rotated.again', 'ko'), /이전 설정은 더 이상 동작하지 않습니다/);
  assert.match(t('org.agents.rotated.again', 'en'), /reissued/i); assert.match(t('org.agents.rotated.again', 'en'), /no longer work/i);
});

test('앱: 재사용은 hermes·openclaw 수동 경로에서만 켜고, custom·하나 더 추가는 늘 새로 만들며, 회전하면 재발급 안내를 낸다', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /const mkOrRotate = async \(kind, name, extId, reuseNames = null\) =>/);
  assert.match(app, /const cur = findReusableBot\(bots, \{ kind, uid, extId, names: reuseNames \}\);/);
  assert.match(app, /return \{ id: cur\.id, crewId: cur\.crew_id, token: r\.data, name: cur\.name, rotated: true \};/);
  assert.match(app, /await mkOrRotate\(kind, [^\n]*, null, kind === 'custom' \? null : defaultBotNames\(kind\)\)/, '수동 연결: custom은 이름 목록 없음');
  assert.match(app, /onNote\(t\(made\.rotated \? 'org\.agents\.rotated\.again' : 'org\.agents\.made'\)\)/);
  assert.match(app, /const made = await mkOrRotate\(kind, name, null\);/, '"하나 더 추가"는 4번째 인자 없음 — 늘 새로 만든다');
  assert.match(app, /const reconnect = \(kind\) => canReconnect\(bots, \{ kind, uid, names: defaultBotNames\(kind\), desktop: isDesktopTauri\(\) \}\);/);
  assert.match(app, /\{reconnect\('openclaw'\) \? t\('org\.agents\.reconnect'/);
  assert.doesNotMatch(app, /mineOf\(/, '라벨은 mineOf가 아니라 재사용 판정과 같은 함수');
});
