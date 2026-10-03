// 에이전트 = 한 사람(유건 2026-10-03, P2) — 내 에이전트와의 1:1은 개인 공간의 방 하나. 공간 고르기 창은 없다.
// 판정(어느 행을 여나)의 행동은 test/agent-groups.test.mjs(agentRoomTarget·personalTwinOf)가 잠근다.
// 이 파일은 App.jsx가 그 판정을 실제 진입점에 연결했는지와, 2026-10-04 TestFlight에서 본 공간 칩·공간 창이 다시 들어오지 않는지만 본다(소스 핀 — 동작 증거 아님).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('공간 칩·공간 고르기 창이 없다(폰 에이전트 탭·길게 누르기·설정 > 내 에이전트)', () => {
  for (const re of [/AgentSpaceSheet/, /agentPick/, /pickSpaceFor/, /onPickAgentSpace/, /ph-aspaces/, /ph-setspaces/, /ph-spacesheet/, /'phone\.agents\.spaces/]) assert.doesNotMatch(app, re, `App.jsx: ${re}`);
  for (const k of ['phone.agents.spaces', 'phone.agents.spaces.n', 'phone.agents.spaces.desc', 'phone.agents.spaces.here', 'phone.agents.personalShort']) assert.ok(!i18n.includes(`'${k}':`), `안 쓰는 문구 ${k}`);
  for (const re of [/\.ph-aspaces/, /\.ph-setspaces/, /\.ph-spacesheet/, /\.ph-spacedesc/, /\.ph-setagent/]) assert.doesNotMatch(css, re, `styles.css: ${re}`);
});

test('폰 에이전트 탭 줄 = agentRoomTarget(개인 행 우선) — 얼굴·상태·누르기가 같은 행', () => {
  assert.match(app, /const agentOpenRow = \(g\) => agentRoomTarget\(g, \{ uid, space: orgId, personalKey: PERSONAL \}\);/);
  assert.match(app, /const openAgentGroup = \(g\) => openAgent\(agentOpenRow\(g\)\);/);
  assert.match(app, /const def = agentOpenRow\(g\);/);
  assert.match(app, /if \(c\.status === 'available'\) \{ runInSpace\(space, \(fn\) => fn\.setSheet\(c\.id\)\); return; \}/, '파견 해제 행은 다시 켜는 카드(종전 판정)');
});

test('조직에서 내 에이전트 1:1 = 개인 공간의 방(openDm 관문) — 글은 그 방 입력창으로, 개인 행이 없으면 종전 경로', () => {
  const gate = app.slice(app.indexOf('const openDm = async (kind, id, text = \'\') => {'), app.indexOf('const openPersonalCrewDm = async'));
  assert.match(gate, /if \(kind === 'crew' && crewOf\(id\)\?\.owner_user_id === uid\) \{/, '내 크루만(남의 크루는 종전대로 주인과의 1:1)');
  assert.match(gate, /const twin = await personalTwin\(crewOf\(id\)\);[\s\S]{0,80}if \(activeOrg\.current !== here\) return null;[\s\S]{0,40}if \(twin\) \{ runInSpace\(PERSONAL, \(fn\) => fn\.openPersonalCrewDm\(twin\.id, text\)\); return null; \}/);
  assert.ok(gate.indexOf('personalTwin(crewOf(id))') < gate.indexOf("supabase.rpc('msgr_create_channel'"), '조직 1:1을 찾거나 만들기 전에 판정한다');
  assert.match(app, /return personalTwinOf\(rows\?\.find\(\(r\) => r\.id === c\.id\), rows, uid\);/, '판정은 순수 함수(agent-groups.mjs)');
  assert.match(app, /const dmWithCrew = async \(crewId, body = ''\) => \{[\s\S]{0,200}const cid = await openDm\('crew', crewId, draft\);/, '레일 메뉴·크루 카드·방 밖 멘션·전달 알림은 dmWithCrew → openDm');
  assert.match(app, /if \(picks\.length === 1\) return openDm\(picks\[0\]\.kind, picks\[0\]\.id\);/, '새 대화 시트의 한 명 고르기도 openDm');
  const open = app.slice(app.indexOf('const openPersonalCrewDm = async'), app.indexOf('const openPersonalDm = async'));
  assert.match(open, /needPersonalConsent\(\(\) => openPersonalCrewDm\(crewId, text\)\)/, '동의를 거쳐도 옮길 글이 남는다');
  assert.match(open, /if \(text\) getComposerSession\(JSON\.stringify\(\[SB_URL, uid, PERSONAL, cid\]\), composerTransport\(supabase, \{ orgId: PERSONAL, chId: cid, uid, personal: true \}\)\)\.setText\(text\);/, '그 방 입력창과 같은 세션 키·개인 통로');
});

test('설정 > 내 에이전트 — 공간 글자 없이 줄 하나, 외부 표시는 유지, 누르면 종전대로 지금 공간의 카드', () => {
  assert.match(app, /onOpenAgent=\{\(g\) => openAgentCard\(rowForSpace\(g, orgId, PERSONAL\)\)\}/);
  assert.match(app, /\{g\.ext && <span className="snip">\{t\('agentcard\.ext'\)\}<\/span>\}<\/span>\{chev\}<\/button>/);
});

test('파견 해제 확인 문구 — 조직 채널 기억이 10분 안에 PC에서 지워지고 다시 파견해도 돌아오지 않는다(P1 #816)', () => {
  assert.match(i18n, /'crew\.recall\.confirm': \['모든 채널에서 빠지고 지시를 받지 않습니다\. 이 조직 채널에서 나눈 대화 기억은 10분 안에 PC에서 지워지고, 다시 파견해도 돌아오지 않습니다\.', "Leaves every channel and stops taking instructions\. Its memory of this organization's channels is erased from your PC within 10 minutes and does not come back if you dispatch it again\."\],/);
});
