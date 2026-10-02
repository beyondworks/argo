// 폰 설정(유건 피드백 5·9, 2026-10-01 밤): 톱니는 어느 탭에서 눌러도 같은 '설정' 한 화면 — 묶음 순서 개인 / 조직 / 에이전트 / 서버 / 기억 / 공통.
// 에이전트·기억 탭에서 열면 그 묶음으로 바로 스크롤. 조직 범위 화면은 그 조직 공간으로 바꿔 그린다. 배선은 App.jsx라 소스로 잠근다(행동은 보고서의 ego 측정).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const list = src.slice(src.indexOf("if (!sub) return body(t('ui.settings')"), src.indexOf("return body(t(`phone.set.${sub}`)"));

test('설정 묶음 순서 — 개인 · 조직 · 에이전트 · 서버(관리자 조직이 있을 때) · 기억 · 공통, 조직 줄은 조직 수와 무관하게 한 줄(4차 피드백)', () => {
  const order = [...list.matchAll(/group\('(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(order, ['me', 'orgs', 'agents', 'server', 'memory', 'common']);
  assert.doesNotMatch(list, /orgs\.map\(|adminOrgs\.map\(|memOrgs/, '조직마다 쌓이는 줄 없음');
  for (const k of ['org', 'ext', 'server', 'memory']) assert.match(list, new RegExp(`onSub\\?\\.\\('${k}'\\)|onOrgSub\\?\\.\\('${k}'\\)`), `${k} 한 줄`);
  assert.match(list, /orow\.server && group\('server'/, '서버 묶음은 조직 관리자에게만');
  assert.doesNotMatch(list, /name: o\.name|o\.name\)/, '줄 설명에 조직 이름 없음');
  assert.equal((list.match(/onSub\?\.\('profile'\)/g) ?? []).length, 1, "맨 위 '나' 카드와 '내 프로필·계정' 줄은 하나");
});

test('톱니는 탭마다 같은 화면 — 에이전트·기억 탭은 그 묶음으로 바로 스크롤', () => {
  assert.match(src, /const gearAct = \{ key: 'gear', icon: 'gear', label: t\('ui\.settings'\), run: \(\) => openSettings\(\) \};/);
  assert.match(src, /actions=\{\[searchAct, \{ \.\.\.gearAct, run: \(\) => openSettings\(null, 'agents'\) \}\]\}/);
  assert.match(src, /\{ \.\.\.gearAct, run: \(\) => openSettings\(null, 'memory'\) \}/);
  assert.match(src, /document\.querySelector\(`\.ph-setlist \[data-group="\$\{focusGroup\}"\]`\)\?\.scrollIntoView\(\{ block: 'start' \}\)/);
  assert.match(src, /const openOrgSub = \(kind\) => \{ if \(chOrg && orgId !== chOrg\) setOrgId\(chOrg\); setPage\(`set-\$\{kind\}`\); \};/, '조직 화면은 고른 조직(채널·기억 탭과 같은 값) 공간으로');
  assert.match(src, /const pickSettingsOrg = \(id\) => \{ if \(id && id !== orgId\) setOrgId\(id\); \};/, '화면 안 드롭다운은 앱 전체 공간을 바꾼다');
  assert.match(src, /const ready = !!os\.org && spaceReady && !gated;/, '공간이 바뀌어 목록이 올 때까지는 기다림 표시');
  for (const v of ['org', 'server', 'ext', 'memory']) assert.match(src, new RegExp(`if \\(view === '${v}'\\) return body\\(t\\('[\\w.]+'\\), <>\\{pick\\}`), `${v} 화면 맨 위 '조직 이름 ▾', 제목에 조직 이름 없음`);
  assert.match(src, /return body\(t\('phone\.org\.settings'\), !org \|\| gated \? <>\{pick\}/, '조직 설정(관리자)도 같은 드롭다운');
  assert.match(src, /os\.locked \? lockedWhy/, '관리자 전용 화면에서 관리자가 아닌 조직이면 이유 한 줄');
});

test('조직 프로필 — 역할 표시와 본인 부서·직급(남의 것은 글자로만), 관리자에게만 조직 설정 진입', () => {
  const card = src.slice(src.indexOf('function OrgProfileCard('), src.indexOf('function MemoryChannelsCard('));
  assert.match(card, /t\(`role\.\$\{org\.role\}`\)/);
  assert.match(card, /<MemberProfile org=\{org\} m=\{\{ user_id: uid \}\} uid=\{uid\}/);
  assert.match(src, /\{isAdmin && <div className="ph-setgroup">\{row\('admin', ic\('gear'\), t\('phone\.org\.settings'\)/);
  const mem = src.slice(src.indexOf('function MemoryChannelsCard('), src.indexOf("/* ─── 폰 조직 설정 '기록'"));
  assert.match(mem, /const can = !locked && \(isAdmin \|\| c\.created_by === uid \|\| \(c\.admin_user_ids \?\? \[\]\)\.includes\(uid\)\);/, '채널 관리자만, 정책 고정이면 잠금');
});

test('2차 피드백 — 이름(에이전트 연결·서버 연결), 결재 알림 줄 없음·알림 하나, 기억 정렬은 기억 탭으로', () => {
  const dict = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
  assert.match(dict, /'phone\.set\.ext': \['에이전트 연결', 'Connect agents'\]/);
  assert.match(dict, /'phone\.set\.server': \['서버 연결', 'Connect server'\]/);
  assert.doesNotMatch(list, /approvalNotify|'approvals'/, '에이전트 묶음의 결재 알림 줄 없음');
  assert.doesNotMatch(list, /memSort|onMemSort/, '설정 목록에 기억 정렬 없음');
  assert.match(src, /<p className="note">\{t\('phone\.set\.notify\.scope'\)\}<\/p>/, '알림 화면 안 한 줄');
  const mem = src.slice(src.indexOf('function PhoneMemory('), src.indexOf('function PhoneMemDoc('));
  assert.match(mem, /\{g\.org\.length > 0 && <div className="ph-sechead">\{t\('phone\.mem\.org'\)\}\{sortCtl\}<\/div>\}/, "'조직 전체 기억' 줄 오른쪽 정렬");
  assert.match(mem, /onSort\?\.\(v\)/);
});

test('2차 피드백 — 친구 관리: 가로 탭(친구·차단·숨긴 에이전트), 친구 줄 끝 ⋯ 메뉴(대화하기·차단·삭제, 삭제·차단은 확인)', () => {
  const fm = src.slice(src.indexOf('function PhoneFriendsManage('), src.indexOf('/* ─── 개인 에이전트 카드'));
  assert.match(fm, /\['friends', 'blocked', 'hidden'\]\.map/);
  assert.match(fm, /className="ph-mmore"/);
  assert.match(fm, /hideUser && \{ icon: 'eyeoff', label: t\('fm\.hide'\)/, '⋯ 메뉴에 숨김(대화하기 / 숨김 / 차단 / 삭제)');
  assert.match(fm, /run: \(\) => setConfirm\(\{ kind: 'hide', f: menu\.f \}\)/, '친구 숨김도 확인 창');
  assert.match(fm, /title=\{t\('fm\.hide\.title', \{ name: nameOf\(confirm\.f\) \}\)\} description=\{t\('fm\.hide\.note'\)\}/, '친구 숨김 확인 창 안내 한 줄');
  assert.match(fm, /<div className="ph-mhead">\{t\('fm\.hidden\.agents'\)\}<\/div><p className="ph-mnote">\{t\('fm\.hideAgent\.note'\)\}<\/p>/, "숨김 탭 '에이전트' 소제목 아래 안내");
  assert.match(src, /confirmMute \? <ConfirmModal tone="primary" title=\{t\('fm\.hideAgent\.title'\)\} description=\{t\('fm\.hideAgent\.note'\)\}/, '에이전트 숨기기 확인 창 안내(폰)');
  const dict = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
  assert.match(dict, /'fm\.hideAgent\.note': \['숨긴 에이전트의 글은 대화방에서 접혀 보이고, 알림과 검색에서 빠집니다\.', 'Posts from hidden agents are collapsed in chats and left out of notifications and search\.'\]/);
  assert.match(dict, /'fm\.hide\.note': \['목록에서만 빠지고, 대화와 알림은 그대로입니다\.', "They're only removed from your list — chats and notifications stay\."\]/);
  assert.match(fm, /run: \(\) => setConfirm\(\{ kind: 'block', f: menu\.f \}\)/); assert.match(fm, /run: \(\) => setConfirm\(\{ kind: 'remove', f: menu\.f \}\)/);
  assert.match(fm, /<ConfirmModal /);
  assert.doesNotMatch(fm, /msgr-rows|className="empty"/, '카드 안 목록·점선 빈 상자 없음');
  assert.match(src, /\{sub === 'friends' && <PhoneFriendsManage /);
});
