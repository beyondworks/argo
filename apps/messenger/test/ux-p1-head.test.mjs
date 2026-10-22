// UX 정리 P1 묶음 2(2026-10-22) — 방 머리띠·폰 채팅 탭 머리. 행동은 픽스처(test/v2-shell.fixture.html)에서 눌러 봤다(PR 본문).
// 이 시험은 배선이 되돌아가지 않게 잠근다: 상시 탭은 '전체·결재', 멘션·에이전트는 '다른 보기' 메뉴, 알림·기억은 꺼졌을 때만 머리에, v2 결재 탭은 일 카드.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const hook = readFileSync(new URL('../src/v2/useWorkCards.jsx', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');

test('방 탭: 상시 전체·결재(글자로), 멘션·에이전트는 고른 동안만 셋째 칸, 메뉴에서 고른다', () => {
  assert.match(app, /const tabs = \[\['all', null, 0\], \['approval', null, counts\.approval\], \.\.\.\(\['mention', 'crew'\]\.includes\(tab\) \? \[\[tab, null, counts\[tab\]\]\] : \[\]\)\];/);
  assert.match(app, /const moreTabs = \[\['mention', 'at', counts\.mention\], \['crew', 'star', counts\.crew\]\];/);
  assert.match(app, /<span className="msgr-sortwrap msgr-tabmore">[\s\S]*?aria-haspopup="menu" aria-expanded=\{tabMore\}[\s\S]*?moreTabs\.map\(\(\[k, ic, n\]\) => <button key=\{k\} type="button" role="menuitemradio" aria-checked=\{tab === k\} onClick=\{\(\) => \{ setTab\(k\); setTabMore\(false\); \}\}>/);
  assert.match(i18n, /'ch\.tabs\.more': \['[^']+', '[^']+'\]/, 'ko·en');
  assert.match(css, /\.msgr-phone \.msgr-main \.msgr-top \.msgr-seg, \.msgr-phone \.msgr-main \.msgr-top \.msgr-tabmore \{ display: none; \}/, '폰 머리에는 탭 줄과 다른 보기를 그리지 않는다(종전 규칙)');
});

test('v2 결재 탭: 결재 대기 일 카드를 세고 그 카드만 그린다(옛 결재 행은 v2에서 비어 있다) — 요청 추가 없음', () => {
  assert.match(hook, /pendingCount: enabled \? cards\.filter\(\(c\) => c\.card\.phase === 'approval'\)\.length : 0,/);
  assert.match(hook, /approvalRows: \(\) => \(enabled \? cards\.filter\(\(c\) => c\.card\.phase === 'approval'\)\.map\(render\) : \[\]\),/);
  assert.match(app, /approval: all\.filter\(isPending\)\.length \+ v2cards\.pendingCount,/);
  assert.match(app, /if \(tab === 'approval'\) rows\.push\(\.\.\.v2cards\.approvalRows\(\)\);/);
  assert.match(app, /shown: shown\.length \+ \(tab === 'approval' \? v2cards\.pendingCount : 0\)/, '결재 카드가 있으면 "결재 없음" 안내를 띄우지 않는다');
});

test('알림·기억 표지: 꺼졌을 때만 머리에(눌러서 다시 켬), 켜고 끄기는 채널 시트 — 시트에 두 토글이 그대로 있다', () => {
  assert.match(app, /\{!archived && \(muted \|\| \(!isPersonal && channel\.crew_memory === false\)\) && <span className="msgr-hchips">/);
  assert.match(app, /\{muted && <button type="button" className="msgr-hchip off" onClick=\{onToggleMute\}/);
  assert.match(app, /channel\.crew_memory === false && <button type="button" className="msgr-hchip off mem" onClick=\{onToggleMemory\}/);
  assert.match(css, /\.msgr-phone \.msgr-main \.msgr-top \.msgr-hchips \.msgr-hchip\.mem \{ display: none; \}/, '폰은 기억 표지를 머리에 두지 않는다(종전 규칙)');
  const sheet = app.slice(app.indexOf('function ChannelSheet('), app.indexOf('function ChannelSheet(') + 40000);
  assert.ok(sheet.includes('onClick={onToggleMute} aria-pressed={muted}'), '시트 알림 버튼');
  assert.ok(sheet.includes("checked={channel.crew_memory !== false}"), '시트 기억 스위치');
});

test('폰 채팅 탭 머리: 검색·새 대화만(새 대화는 폰에서 그룹 대화를 만드는 유일한 입구), 설정은 친구·에이전트 탭 머리에', () => {
  const chats = app.slice(app.indexOf("{rootTab === 'chats' && (<PhoneHead"), app.indexOf("{rootTab === 'channels' && (<PhoneHead"));
  assert.ok(chats.length > 50);
  assert.ok(chats.includes('searchAct') && chats.includes("key: 'new', icon: 'chatplus'") && chats.includes('setDmGroup(true)'));
  assert.ok(!chats.includes('gearAct'), '채팅 탭에는 톱니가 없다');
  assert.match(app, /\{rootTab === 'friends' && \(<PhoneHead[^\n]*gearAct\]\} \/>\)\}/, '친구 탭 톱니는 그대로');
});
