// 개인 공간 — 소스 핀 테스트(단위): App.jsx·i18n.js에서 핵심 배선을 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');

test('PERSONAL 상수가 정의되어 있고 __personal__이다', () => {
  assert.match(src, /export const PERSONAL = '__personal__'/);
});

test('isPersonal 파생 변수가 orgId === PERSONAL로 정의된다', () => {
  assert.match(src, /const isPersonal = orgId === PERSONAL/);
});

test('loadPersonal 함수가 msgr_dm_personal_list RPC를 호출한다', () => {
  assert.match(src, /supabase\.rpc\('msgr_dm_personal_list'\)/);
});

test('loadOrgs가 개인 공간(PERSONAL)을 유지한다', () => {
  assert.match(src, /cur === PERSONAL \? cur :/);
});

test('조직 전환 메뉴에 개인 항목이 맨 위에 있다', () => {
  const menuStart = src.indexOf('msgr-menu-pop');
  const personalBtn = src.indexOf("setOrgId(PERSONAL)", menuStart);
  const orgMap = src.indexOf("orgs.map", menuStart);
  assert.ok(personalBtn > 0 && orgMap > 0 && personalBtn < orgMap, '개인 버튼이 조직 목록보다 앞');
});

test('openPersonalDm 함수가 msgr_dm_personal RPC를 호출한다', () => {
  assert.match(src, /supabase\.rpc\('msgr_dm_personal', \{ target: targetUserId \}\)/);
});

test('개인 공간에서 봇 조회를 건너뛴다', () => {
  assert.match(src, /orgId === PERSONAL\) \{ setBotKinds\(\[\]\)/);
});

test('개인 공간의 안 읽음은 org=null로 센다(건너뛰지 않는다 — 검수 L-1)', () => {
  assert.match(src, /rpc\('msgr_unread', \{ org: orgId === PERSONAL \? null : orgId \}\)/, '개인 공간은 org를 null로 물어본다');
  assert.doesNotMatch(src, /loadUnread = useCallback\(async \(\) => \{ if \(!orgId \|\| orgId === PERSONAL/, '개인 공간을 조기 반환으로 건너뛰지 않는다');
});

test('개인 공간에서는 알림함 조직 질의를 쏘지 않는다(가상 org id는 uuid가 아니다 — 검수 M-2)', () => {
  assert.match(src, /if \(!org \|\| !uid \|\| isPersonal\) \{ setInbox\(\[\]\); return; \}/);
});

test('개인 공간에서는 붙여넣기 첨부도 막는다(검수 L-4)', () => {
  assert.match(src, /if \(!pasted\.length \|\| busy \|\| isPersonal\) return;/);
});

test('개인 공간에서 실시간은 dm:<채널> 토픽을 구독한다', () => {
  assert.match(src, /supabase\.channel\(`dm:\$\{chId\}`/);
});

test('개인 공간에서 채널 절·멤버 절·크루 절이 감춰진다', () => {
  assert.match(src, /\{!isPersonal && <RailSection id="channels"/);
  assert.match(src, /\{!isPersonal && org && members\.length > 0/);
  assert.match(src, /\{!isPersonal && org && \(myAvailable\.length > 0/);
});

test('개인 공간에서 업무 버튼·첨부 버튼이 감춰진다', () => {
  assert.match(src, /\{!isPersonal && <button type="button" className="btn sm msgr-work-button"/);
  assert.match(src, /\{!isPersonal && <button type="button" className="tb" onMouseDown.*msg\.attach/);
});

test('Channel 컴포넌트가 isPersonal prop을 받는다', () => {
  assert.match(src, /function Channel\(\{.*isPersonal = false/);
});

test('i18n에 개인 공간 문자열이 등록되어 있다', () => {
  assert.match(i18n, /'personal': \['개인', 'Personal'\]/);
  assert.match(i18n, /'personal\.space': \['개인 공간', 'Personal space'\]/);
  assert.match(i18n, /'personal\.empty':/);
  assert.match(i18n, /'personal\.badge':/);
  assert.match(i18n, /'friends\.dm':/);
});

test('FriendsCard가 onPersonalDm prop을 받는다', () => {
  assert.match(src, /function FriendsCard\(\{.*onPersonalDm/);
});

test('채널 헤더에 소속 표지가 있다', () => {
  assert.match(src, /msgr-scope-badge/);
  assert.match(src, /channel\.org_id === null.*personal\.badge/);
});
