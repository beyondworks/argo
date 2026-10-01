// "오픈클로 다시 연결"을 누를 때마다 같은 이름 봇이 새로 생기던 결함(UX 점검 D, 2026-10-01 QA DB에서 재현 —
// 앱 밖(브라우저)에서는 에이전트 목록이 없어 external_id 없이 봇을 만들고, 그 길은 기존 봇을 찾지 않고 늘 새로 만들었다).
// 검수 #797 MEDIUM-1: 재사용은 "다시 연결"(hermes·openclaw 수동 경로)에서만 — "다른 에이전트"(custom)와 "하나 더 추가"는 늘 새로 만든다
// (회전하면 이미 연결된 봇의 토큰이 무효가 된다). 찾는 기준은 화면 언어·표시 이름에 흔들리지 않게 두 언어의 기본 이름을 모두 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findReusableBot, canReconnect, botDefaultNames } from '../src/bot-reuse.mjs';
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

// 재검수 #797 LOW-A — 두 언어 이름을 모두 넘긴다는 것을 잠근다(['ko','en'] → ['ko'] 변이가 살아남던 것)
test('botDefaultNames — 화면 언어와 무관하게 한국어·영어 기본 이름을 둘 다 돌려준다', () => {
  const names = botDefaultNames(t, { who: '유건', kind: 'openclaw' });
  assert.equal(names.length, 2);
  assert.equal(names[0], t('org.agents.name.mine', 'ko', { who: '유건', kind: '오픈클로' }));
  assert.equal(names[1], t('org.agents.name.mine', 'en', { who: '유건', kind: 'OpenClaw' }));
  assert.notEqual(names[0], names[1]);
  assert.match(names[0], /유건의 오픈클로/); assert.match(names[1], /OpenClaw/);
  assert.match(botDefaultNames(t, { who: '민수', kind: 'hermes' })[1], /Hermes/);
});

test('botDefaultNames로 만든 영어 이름의 봇도 영어로 바꾼 뒤 다시 연결에서 찾는다', () => {
  const names = botDefaultNames(t, { who: '유건', kind: 'openclaw' });
  assert.equal(findReusableBot([bot({ id: 'en', name: names[1] })], { kind: 'openclaw', uid: ME, extId: null, names })?.id, 'en');
});

// 재검수 #797 LOW-B·C
test('데스크톱 "다시 연결" 툴팁은 중복 생성이 없다고 단정하지 않고, 브라우저 툴팁은 그대로(재사용이 확실한 경우)', () => {
  for (const lang of ['ko', 'en']) {
    const d = t('org.agents.reconnect.title.desktop', lang); const w = t('org.agents.reconnect.title', lang);
    assert.ok(d.length > 10 && d !== w, lang);
    assert.doesNotMatch(d, /중복 생성 없음|no duplicate/i, `${lang}: ${d}`);
  }
  assert.match(t('org.agents.reconnect.title.desktop', 'ko'), /이 컴퓨터의 에이전트/); assert.match(t('org.agents.reconnect.title.desktop', 'ko'), /토큰만 새로 발급/);
  assert.match(t('org.agents.reconnect.title.desktop', 'en'), /this computer/i);
  assert.match(t('org.agents.reconnect.title', 'ko'), /중복 생성 없음/);
});

test('회전 안내에 대상 봇의 이름과 만든 날짜가 들어간다(ko·en)', () => {
  const vars = { name: '유건의 오픈클로', when: '9월 30일 오후 3:20' };
  for (const lang of ['ko', 'en']) { const m = t('org.agents.rotated.again', lang, vars); assert.ok(m.includes(vars.name), m); assert.ok(m.includes(vars.when), m); assert.doesNotMatch(m, /\{name\}|\{when\}/); }
});

test('앱: 기본 이름은 순수 함수에서, 툴팁은 데스크톱 문구 분기, 회전 안내는 봇 이름·만든 날짜를 넘긴다', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /const defaultBotNames = \(kind\) => botDefaultNames\(tm, \{ who: nameOfUser\(uid\), kind \}\);/);
  assert.match(app, /title=\{reconnect\('openclaw'\) \? t\(isDesktopTauri\(\) \? 'org\.agents\.reconnect\.title\.desktop' : 'org\.agents\.reconnect\.title'\) : undefined\}/);
  assert.match(app, /rotated: true, createdAt: cur\.created_at \};/);
  assert.match(app, /t\(made\.rotated \? 'org\.agents\.rotated\.again' : 'org\.agents\.made', made\.rotated \? \{ name: made\.name, when: fmtDate\(made\.createdAt, lang\) \} : undefined\)/);
});

test('앱: 재사용은 hermes·openclaw 수동 경로에서만 켜고, custom·하나 더 추가는 늘 새로 만들며, 회전하면 재발급 안내를 낸다', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /const mkOrRotate = async \(kind, name, extId, reuseNames = null\) =>/);
  assert.match(app, /const cur = findReusableBot\(bots, \{ kind, uid, extId, names: reuseNames \}\);/);
  assert.match(app, /return \{ id: cur\.id, crewId: cur\.crew_id, token: r\.data, name: cur\.name, rotated: true, createdAt: cur\.created_at \};/);
  assert.match(app, /await mkOrRotate\(kind, [^\n]*, null, kind === 'custom' \? null : defaultBotNames\(kind\)\)/, '수동 연결: custom은 이름 목록 없음');
  assert.match(app, /const made = await mkOrRotate\(kind, name, null\);/, '"하나 더 추가"는 4번째 인자 없음 — 늘 새로 만든다');
  assert.match(app, /const reconnect = \(kind\) => canReconnect\(bots, \{ kind, uid, names: defaultBotNames\(kind\), desktop: isDesktopTauri\(\) \}\);/);
  assert.match(app, /\{reconnect\('openclaw'\) \? t\('org\.agents\.reconnect'/);
  assert.doesNotMatch(app, /mineOf\(/, '라벨은 mineOf가 아니라 재사용 판정과 같은 함수');
});
