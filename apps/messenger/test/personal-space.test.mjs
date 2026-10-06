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
  assert.match(src, /supabase\.rpc\('msgr_dm_personal_list', \{ include_groups: true \}\)/); // 인자 없으면 서버가 그룹을 빼고 준다(옛 앱 호환)
});

test('loadOrgs가 개인 공간(PERSONAL)을 유지한다', () => {
  assert.match(src, /setOrgId\(\(cur\) => pickStartSpace\(\{ personal: PERSONAL, cur, orgIds, last: readLastOrg\(\), personalHasContent \}\)\);/, '시작 공간 규칙은 pickStartSpace(순수 함수, test/start-space.test.mjs가 행동을 잠근다)');
});

test('조직 전환 메뉴에 개인 항목이 맨 위에 있다', () => {
  const menuStart = src.indexOf('msgr-menu-pop', src.indexOf('className={`msgr-org${orgMenu')); // 데스크톱 레일 조직 메뉴(폰 OrgMenuCard 부품은 앞쪽에 정의돼 있다)
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
  const eff = src.slice(src.indexOf('if (!org || !uid) { setInboxNet([]); return; }'));
  assert.ok(eff.length > 0, '알림함 집계');
  const personal = eff.indexOf('if (isPersonal || isPhone) { setInboxNet([]); return; }'), orgQuery = eff.indexOf("supabase.from('msgr_messages')");
  assert.ok(personal > 0 && orgQuery > personal, '개인 공간(과 알림함이 없는 폰)은 조직 질의 전에 돌아간다(S15·기능 점검 D2)');
  assert.match(src, /return \[\.\.\.inboxNet, \.\.\.friendItems\(\)\]/, '친구 요청은 조회 없이 합친다(개인 공간 벨·탭 배지)');
});

test('개인 공간도 붙여넣기·끌어 놓기 첨부를 받는다(2026-10-02 — 개인 경로 p/<방>/<글>/<파일>)', () => {
  assert.match(src, /if \(!pasted\.length \|\| busy\) return;/);
  assert.match(src, /if \(!busy\) addFiles\(e\.dataTransfer\?\.files\);/);
  assert.match(src, /composerTransport\(supabase, \{ orgId, chId, uid, personal: isPersonal,/, '개인 방이면 전송 경로가 p/로 바뀐다');
});

test('개인 공간에서 실시간은 dm:<채널> 토픽을 구독한다', () => {
  assert.match(src, /supabase\.channel\(`dm:\$\{id\}`/);
  assert.match(src, /roomTopicIds\(channels, chId, isPersonal, 50, lastAt\)/);
});

test('개인 공간에서 채널 절·멤버 절은 감춰지고, 내 에이전트 절은 보인다(2026-09-30 개인 공간 에이전트)', () => {
  assert.match(src, /\{!isPersonal && !orgBlocked && <RailSection id=\{orgId \? 'channels' : 'start'\}/, '조직 없으면 시작하기 절(D46) — 검수 M-5·3차 L-3으로 동의 게이트·로딩 조건도 같이 본다(orgBlocked)');
  assert.match(src, /\{!isPersonal && !orgBlocked && org && members\.length > 0/);
  assert.match(src, /\{\(isPersonal \? railVisible\.length > 0 : !orgBlocked && org\) && \(<RailSection id="mine"/, '개인 공간은 내 개인 크루가 있으면 보인다 — 조직은 비어도 구역과 연결 단추(UXM-08)');
});

test('개인 공간에서 업무 버튼은 감춰지고 첨부 버튼은 조직과 같이 보인다(2026-10-02)', () => {
  assert.match(src, /\{!isPersonal && <button type="button" className="btn sm msgr-work-button"/);
  assert.doesNotMatch(src, /\{!isPersonal && <button type="button" className="tb" onMouseDown.*msg\.attach/);
  assert.match(src, /<button type="button" className="tb" onMouseDown=\{\(e\) => e\.preventDefault\(\)\} onClick=\{\(\) => fileRef\.current\?\.click\(\)\}/);
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
