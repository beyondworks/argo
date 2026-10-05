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

test('폰 에이전트 탭 줄 = agentRoomTarget(열 수 있는 개인 행 우선) — 얼굴·누르기가 같은 행, 상태는 agentStateRow(다시 연결 필요를 가리지 않는다)', () => {
  assert.match(app, /const agentOpenRow = \(g\) => agentRoomTarget\(g, \{ uid, space: orgId, personalKey: PERSONAL \}\);/);
  assert.match(app, /const openAgentGroup = \(g\) => openAgent\(agentOpenRow\(g\)\);/);
  assert.match(app, /const def = agentOpenRow\(g\);/);
  assert.match(app, /const groupState = \(g\) => \(g\.rows\.some\(\(r\) => agentState\(r\) === 'working'\) \? 'working' : agentState\(agentStateRow\(g, \{ uid, space: orgId, personalKey: PERSONAL \}\)\)\);/);
  assert.match(app, /if \(c\.status === 'available'\) \{ runInSpace\(space, \(fn\) => fn\.setSheet\(c\.id\)\); return; \}/, '파견 해제 행은 다시 켜는 카드(종전 판정)');
});

test('조직에서 내 에이전트 1:1 = 개인 공간의 방(openDm 관문) — 글은 그 방 입력창으로, 개인 행이 없으면 종전 경로', () => {
  const gate = app.slice(app.indexOf('const openDm = async (kind, id, text = \'\', opts = {}) => {'), app.indexOf('const openPersonalCrewDm = async'));
  assert.ok(gate.length > 500, '관문 구간을 찾았다');
  assert.match(gate, /if \(kind === 'crew' && crewOf\(id\)\?\.owner_user_id === uid\) \{/, '내 크루만(남의 크루는 종전대로 주인과의 1:1)');
  assert.match(gate, /const twin = await personalTwin\(crew\);\n\s*if \(activeOrg\.current !== here\) return null;\n\s*if \(twin\) \{/);
  assert.match(gate, /if \(twin\) \{ toPersonalTwin\(crew, twin, \{ text, source: opts\.source, here, hereCh \}\); return null; \}/, '개인 방으로 옮기고 조직 1:1은 찾지 않는다');
  assert.match(app, /const toPersonalTwin = \(crew, twin, \{ text = '', source = null, here, hereCh \}\) => \{[\s\S]{0,400}runInSpace\(PERSONAL, async \(fn\) => \{ const cid = await fn\.openPersonalCrewDm\(twin\.id, text\); if \(cid && move\) fn\.moveNotice\(\{ \.\.\.move, \.\.\.names \}\); \}\);/, '개인 방을 열고, 열렸을 때만 공간 전환 안내(옛 조직 1:1 돌리기와 같은 함수)');
  assert.ok(gate.indexOf('personalTwin(crew)') < gate.indexOf("supabase.rpc('msgr_create_channel'"), '조직 1:1을 찾거나 만들기 전에 판정한다');
  assert.match(app, /const personalTwin = \(c\) => personalRoomFor\(c, \{ uid,\n\s*ownRows: \(slug\) => q\(supabase\.from\('msgr_crews'\)\.select\('id, org_id, owner_user_id, ws_id, slug, status, hosting'\)\.eq\('owner_user_id', uid\)\.eq\('slug', slug\)\.in\('status', \['active', 'available'\]\)\),\n\s*roomCrews: \(\) => q\(supabase\.rpc\('msgr_personal_room_crews'\)\) \}\);/, '판정은 순수 async 함수(agent-groups.mjs personalRoomFor — 행동 테스트), App은 조회만 넣는다(내 행은 그 slug만, 봇 준비 상태는 msgr_personal_room_crews)');
  assert.match(app, /const dmWithCrew = async \(crewId, body = '', opts = \{\}\) => \{[\s\S]{0,200}const cid = await openDm\('crew', crewId, draft, opts\);/, '레일 메뉴·크루 카드·방 밖 멘션·전달 알림은 dmWithCrew → openDm(출처를 넘긴다)');
  assert.match(app, /if \(picks\.length === 1\) return openDm\(picks\[0\]\.kind, picks\[0\]\.id\);/, '새 대화 시트의 한 명 고르기도 openDm');
  const open = app.slice(app.indexOf('const openPersonalCrewDm = async'), app.indexOf('const openPersonalDm = async'));
  assert.match(open, /needPersonalConsent\(\(\) => openPersonalCrewDm\(crewId, text\)\)/, '동의를 거쳐도 옮길 글이 남는다');
  assert.match(open, /if \(!await loadUntilListed\(cid, \{ load: loadPersonal, here: \(\) => activeOrg\.current === PERSONAL \}\)\) return null;/, '목록 읽기가 밀리면 한 번 더 읽고 연다(픽스처 실측: 다른 방이 열렸다 — 행동은 agent-groups.test.mjs)');
  assert.ok(open.indexOf('loadUntilListed(cid') < open.indexOf('setChId(cid)'), '목록에 들어온 뒤 고른다');
  assert.match(open, /if \(text\) getComposerSession\(JSON\.stringify\(\[SB_URL, uid, PERSONAL, cid\]\), composerTransport\(supabase, \{ orgId: PERSONAL, chId: cid, uid, personal: true \}\)\)\.setText\(text\);/, '그 방 입력창과 같은 세션 키·개인 통로');
});

// 공간 전환 안내·버튼 이름(유건 2026-10-04) — 판정 행동은 test/space-move-notice.test.mjs·agent-groups.test.mjs가 잠근다. 여기는 배선만.
test('공간 전환 안내 — 관문이 spaceMoveNotice로 정하고(폰 에이전트 탭은 source agents), 같은 토스트에 6초, 누르면 spaceMoveBack으로 직전 조직', () => {
  const gate = app.slice(app.indexOf('const openDm = async (kind, id, text = \'\', opts = {}) => {'), app.indexOf('const openPersonalCrewDm = async'));
  assert.match(gate, /const here = orgId; const hereCh = chId; const crew = crewOf\(id\);/, '옮기기 전의 조직·보던 채널을 기억한다');
  assert.match(app, /const move = spaceMoveNotice\(\{ from: here, fromCh: hereCh, to: PERSONAL, source, personalKey: PERSONAL \}\);/);
  assert.match(gate, /toPersonalTwin\(crew, twin, \{ text, source: opts\.source, here, hereCh \}\)/, '출처(폰 에이전트 탭 agents)를 넘긴다');
  assert.match(app, /fn\.dmWithCrew\(c\.id, '', \{ source: 'agents' \}\)/, '폰 에이전트 탭의 조직 행은 출처 agents(안내 없음)');
  assert.match(app, /latestOpen\.current = \{ dmWithCrew, openPersonalCrewDm, setSheet, crewOf, note: setNote, orgBlocked, moveNotice: showMoveNotice \};/);
  assert.match(app, /const showMoveNotice = \(n\) => \{ const text = \(lang === 'en' \? \(x\) => x : koJosa\)\(t\('personal\.moved', \{ name: n\.name, org: n\.org \}\)\); flashed\.current = \{ text, ms: MOVE_NOTICE_MS \};/, '기존 토스트·문구별 시간, ko는 koJosa로 으로/로');
  assert.match(app, /const clearToast = \(\) => \{ flashed\.current = null; setErr\(''\); setNote\(''\); setMoveNote\(null\); \};/, '닫히면 돌아가기도 잊는다');
  assert.match(app, /const tapToast = \(\) => \{ const back = !err && moveNote\?\.text === note \? spaceMoveBack\(moveNote, orgs\) : null; clearToast\(\); if \(back\) runInSpace\(back\.space, \(\) => \{ if \(back\.ch\) setChId\(back\.ch\); setPage\('chat'\); setRail\(false\); \}\); \};/, '그 안내가 떠 있을 때만 돌아간다(다른 안내가 덮었으면 닫기만)');
});

test('버튼 이름 — 조직 화면의 레일 메뉴·즐겨찾기 줄·크루 카드·방 밖 멘션만, 판정은 dmGoesPersonal(personalRoomKnown — 이미 가진 행)', () => {
  assert.match(app, /const dmGoesPersonal = \(c\) => !isPersonal && personalRoomKnown\(c, myAgents, uid\);/);
  assert.match(app, /\{ icon: 'at', label: t\(dmGoesPersonal\(c\) \? 'ui\.dm\.personal' : 'ui\.dm'\), run: \(\) => \{ dmWithCrew\(c\.id\); setRail\(false\); \} \}/, '레일 메뉴(조직)');
  assert.match(app, /const crewCtx = \(c\) => isPersonal \? \[\{ icon: 'at', label: t\('ui\.dm'\),/, '개인 공간 메뉴는 그대로(공간이 바뀌지 않는다)');
  assert.match(app, /onDm=\{\(\) => dmWithCrew\(sheet\)\} dmPersonal=\{dmGoesPersonal\(crewOf\(sheet\)\)\}/);
  assert.match(app, /\{t\(dmPersonal \? 'ui\.dm\.personal' : 'ui\.dm'\)\}<\/button>/, '크루 카드');
  assert.match(app, /onOutsideDm=\{dmWithCrew\} outsideDmPersonal=\{dmGoesPersonal\}/);
  assert.match(app, /<Composer broadcast=\{broadcast\} onOutsideDm=\{onOutsideDm\} outsideDmPersonal=\{outsideDmPersonal\}/);
  assert.match(app, /\{t\(outsideDmPersonal\?\.\(c\) \? 'mention\.outside\.dm\.personal' : 'mention\.outside\.dm'\)\}/, '방 밖 멘션');
  assert.match(app, /label: t\(c\.targetKind === 'crew' && dmGoesPersonal\(crewOf\(c\.targetId\)\) \? 'ui\.dm\.personal' : 'ui\.dm'\), run: \(\) => openDm\(c\.targetKind, c\.targetId\)/, '즐겨찾기 줄 메뉴(재검수 L-c)');
  assert.match(app, /\(lang === 'en' \? \(x\) => x : koJosa\)\(t\(view\.line, \{ name: c\.display_name \}\)\)/, '방 밖 멘션 안내의 은(는)·을(를)을 이름에 맞춘다(그대로 보였다) — 줄 선택은 outsideRowView(mention-candidates.test.mjs)');
  assert.match(app, /const myAgentsAsked = useRef\(false\);\n\s*useEffect\(\(\) => \{ if \(myAgentsAsked\.current \|\| myAgents !== null \|\| !uid \|\| !orgId \|\| orgId === PERSONAL \|\| !crews\.some\(\(c\) => c\.owner_user_id === uid\)\) return; myAgentsAsked\.current = true; loadMyAgents\(\{ reuse: true \}\)\.catch\(\(\) => \{\}\); \}, \[uid, orgId, crews, myAgents\]\);/, '판정 재료는 세션에 한 번만 읽는다(렌더마다 조회 없음, 실패해도 다시 묻지 않는다) — 얼굴 지도가 같은 회차에 읽은 행을 다시 쓴다(분리 검수 #4, 행동은 rail-state.test.mjs)');
});

test('설정 > 내 에이전트 — 공간 글자 없이 줄 하나, 외부 표시는 유지, 누르면 종전대로 지금 공간의 카드', () => {
  assert.match(app, /onOpenAgent=\{\(g\) => openAgentCard\(rowForSpace\(g, orgId, PERSONAL\)\)\}/);
  assert.match(app, /\{g\.ext && <span className="snip">\{t\('agentcard\.ext'\)\}<\/span>\}<\/span>\{chev\}<\/button>/);
});

test('파견 해제 확인 문구 — 조직 채널 기억이 10분 안에 PC에서 지워지고 다시 파견해도 돌아오지 않는다(P1 #816)', () => {
  assert.match(i18n, /'crew\.recall\.confirm': \['모든 채널에서 빠지고 지시를 받지 않습니다\. 이 조직 채널에서 나눈 대화 기억은 10분 안에 PC에서 지워지고, 다시 파견해도 돌아오지 않습니다\.', "Leaves every channel and stops taking instructions\. Its memory of this organization's channels is erased from your PC within 10 minutes and does not come back if you dispatch it again\."\],/);
});

// 옛 조직 1:1(유건 2026-10-05) — 판정 행동은 test/agent-identity.test.mjs(legacyAgentDm·agentDmRedirect)가 잠근다. 여기는 입구 배선만:
// 대화 목록 줄·알림함·알림 탭(OS 알림·푸시·전경 카드가 모두 지나는 navInbox 'open')·미리보기가 같은 함수를 먼저 지나고, 열린 옛 방에는 안내 띠.
test('옛 조직 1:1 — 모든 입구가 openAgentDmInstead를 먼저 지나고, 열린 옛 방에는 안내 띠', () => {
  assert.match(app, /onClick=\{\(\) => \{ if \(openAgentDmInstead\(c\.id\)\) \{ setRail\(false\); return; \} setChId\(c\.id\);/, '대화 목록 줄');
  assert.match(app, /if \(!it\?\.joinReq && openAgentDmInstead\(id\)\) return;/, '알림함');
  assert.match(app, /if \(act\.do === 'open'\) \{ diag\('open'\); navInbox\.done\(navReq\); if \(openAgentDmInstead\(navReq\.channelId\)\) return;/, '알림 탭·푸시·전경 카드');
  assert.match(app, /setDmPeek\(null\); if \(openAgentDmInstead\(c\.id\)\) return;/, '폰 미리보기');
  assert.match(app, /const openRoom = \(c\) => \{ setTabQ\(null\); if \(openAgentDmInstead\(c\.id\)\) return;/, '폰 채팅 탭 줄');
  assert.match(app, /const openAgentDmInstead = \(channelId\) => \{[\s\S]{0,300}agentDmRedirect\(channels\.find\(\(c\) => c\.id === channelId\), dmMembers\[channelId\], \{ uid, crewOf, myAgents \}\)[\s\S]{0,300}personalTwin\(go\.crew\)\.then/, '서버에 개인 행을 한 번 묻고 옮긴다');
  assert.match(app, /movedBar=\{legacyDm\?\.known \? <LegacyDmBar/, '알고 있을 때만 안내 띠');
});
