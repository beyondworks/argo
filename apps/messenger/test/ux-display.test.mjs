// UX 판독(2026-10-05) 표시 항목 — App.jsx의 실제 식을 꺼내 돌린다. APP_SRC를 주면 그 파일로(수정 전 비교용).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { koJosa } from '../src/ko-josa.mjs';
import { t as tm } from '../src/i18n.js';

const app = readFileSync(process.env.APP_SRC || new URL('../src/App.jsx', import.meta.url), 'utf8');

test('UXM-15 꺼진 에이전트 안내는 조사를 고른다 — "Fixture Agent은(는)"이 아니라 "Fixture Agent는"(한국어), 영어는 그대로', () => {
  const line = app.split('\n').find((l) => l.includes('className="msgr-replychip msgr-awaychip"'));
  const expr = line.slice(line.indexOf('<span className="q">{') + '<span className="q">{'.length, line.indexOf('}</span><button type="button" className="msgr-titlebtn" onClick={() => setAwayNote(null)}'));
  const run = (lang) => new Function('awayNote', 'lang', 'koJosa', 't', `return (${expr});`)([{ display_name: 'Fixture Agent' }, { display_name: '페퍼' }], lang, koJosa, (k, v) => tm(k, lang, v));
  assert.equal(run('ko'), 'Fixture Agent는 지금 꺼져 있어요 — 다시 켜지면 이 글에 답합니다. 페퍼는 지금 꺼져 있어요 — 다시 켜지면 이 글에 답합니다.');
  assert.match(run('en'), /^Fixture Agent is offline/);
});

test('UXM-11 데스크톱 친구 링크 끊기가 실패하면 링크를 그대로 둔다 — 실제 FriendsCard call·끊기 단추', async () => {
  const lines = app.split('\n');
  const callLine = lines.find((l) => l.includes('const call = async (fn, args, ok) =>') && l.includes('msgr_friend_blocked') && !l.includes('if (res) await find()')); // FriendsCard 것(FriendFinder 것은 검색 결과를 다시 읽는다)
  const btn = lines.find((l) => l.includes("msgr_friend_link_revoke', {}, t('friends.link.revoked')"));
  const onClick = btn.slice(btn.indexOf('onClick={async () => {') + 'onClick={'.length, btn.indexOf("}}>{t('friends.link.revoke')}") + 1);
  const run = async (ok) => {
    const seen = [];
    const scope = { setBusy: () => {}, q: async () => { if (!ok) throw new Error('network'); return null; }, supabase: { rpc: () => null }, onNote: (m) => seen.push(['note', m]), onChanged: async () => {}, onError: (m) => seen.push(['error', m]), t: (k) => k, setLink: (v) => seen.push(['link', v]) };
    const fn = new Function(...Object.keys(scope), `${callLine}\nreturn (${onClick});`)(...Object.values(scope));
    await fn(); return seen;
  };
  assert.deepEqual(await run(false), [['error', 'network']], '실패 — 링크를 지우지 않는다');
  assert.deepEqual(await run(true), [['note', 'friends.link.revoked'], ['link', null]]);
});

test('UXM-11 폰 친구 추가 시트에도 링크 끊기가 있다', () => {
  const sheet = app.slice(app.indexOf('function PhoneFriendAdd('), app.indexOf('\n}\n', app.indexOf('function PhoneFriendAdd(')));
  assert.match(sheet, /onClick=\{revoke\}>\{t\('friends\.link\.revoke'\)\}/);
  assert.match(sheet, /const revoke = async \(\) => \{ setBusy\(true\); try \{ await q\(supabase\.rpc\('msgr_friend_link_revoke', \{\}\)\); setLink\(null\);/);
});

// 화면 검수 UM2(2026-10-05): 터치 기기에서 확인 창 머리의 '닫기 ESC' 단추를 통째로 숨겨(UXM-18), 아래 '취소'가 없는 DangerModal(계정·채널·자동화 삭제)은
// 닫을 길이 비활성 '영구 삭제' 하나뿐이었다. 단추는 남기고 'ESC'(키보드 힌트) 글자만 숨긴다 — 공유 모달(app/ui.jsx)은 ESC를 span으로 나눴다(본체 화면은 같은 글자).
test('UM2 확인 창 머리의 닫기 단추는 터치에서도 남고, 키보드 힌트 ESC만 숨는다', () => {
  const ui = readFileSync(new URL('../../../app/ui.jsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  for (const name of ['DangerModal', 'ConfirmModal', 'InputModal', 'FeedbackModal']) {
    const s = ui.indexOf(`export function ${name}(`); const e = ui.indexOf('\nexport function ', s + 10);
    assert.match(ui.slice(s, e), /<button type="button" className="btn sm" onClick=\{onClose\}><span>\{t\('common\.close'\)\}<span className="kbd-hint"> ESC<\/span><\/span><\/button>/, name); // 한 덩어리로 감싸 본체 화면의 간격('닫기 ESC')은 그대로(.btn gap이 끼지 않게)
  }
  const coarse = [...css.matchAll(/@media \(pointer: coarse\) \{([^{}]*\{[^}]*\})+\s*\}/g)].map((m) => m[0]).join('\n');
  assert.doesNotMatch(coarse, /\.card-head > \.btn\.sm \{[^}]*display: none/, '닫기 단추 자체는 숨기지 않는다');
  assert.match(coarse, /\.card-float > \.card-head > \.btn\.sm \.kbd-hint \{ display: none; \}/, 'ESC 글자만');
});

// 화면 검수 UM3(2026-10-05): '.msgr-awaychip .q { white-space: normal }'이 같은 명시도의 뒤쪽 '.msgr-replychip .q { nowrap }'에 져서 실제로는 한 줄 말줄임이었다.
// 실제 렌더 측정은 test/awaychip.browser.mjs(scrollWidth·줄 수) — 여기서는 규칙의 명시도와 순서를 잠근다.
test('UM3 꺼짐 안내 칩의 두 줄 규칙은 칩 공통 nowrap보다 명시도가 높고 뒤에 있다', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const common = css.indexOf('.msgr-replychip .q { flex: 1;'); const away = css.indexOf('.msgr-replychip.msgr-awaychip .q {');
  assert.ok(common > 0 && away > common, '두 클래스 규칙이 공통 규칙 뒤에');
  assert.match(css.slice(away, css.indexOf('}', away)), /white-space: normal;[^}]*-webkit-line-clamp: 2;/);
  assert.doesNotMatch(css, /^\.msgr-awaychip \.q \{/m, '한 클래스 규칙(지는 규칙)은 없앴다');
});

// 화면 검수 UM5(2026-10-05): @ 단추의 누르는 영역(::before)이 오른쪽으로 20px 넓어 입력창 시작점을 덮었다 — 단추가 기준 상자가 아니라 더 큰 상자 기준으로 펼쳐졌다.
// 실제 렌더 측정은 test/composer-hit.browser.mjs(elementFromPoint).
test('UM5 폰 @ 단추의 누르는 영역은 오른쪽으로 4px 이하 — @ 단추는 흐름 밖 그대로', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.msgr-composer \.msgr-tools \.tb:nth-child\(2\) \{ position: absolute; left: 44px;/, '@ 단추는 입력 시작점 위에 겹친 흐름 밖 단추 — ::before의 기준 상자');
  assert.doesNotMatch(css, /\.tb:nth-child\(2\), [^{]*\{ position: relative; \}/, '흐름 밖 배치를 relative로 덮지 않는다(덮으면 @가 입력창 위로 떠 버렸다)');
  const m = css.match(/\.msgr-tools \.tb:nth-child\(2\)::before \{ content: ''; position: absolute; inset: (-?\d+)(?:px)? (-?\d+)(?:px)? (-?\d+)(?:px)? (-?\d+)(?:px)?; \}/);
  assert.ok(m, '@ 누르는 영역 규칙'); assert.ok(Number(m[2]) >= -4, `오른쪽 확장 ${m[2]}px`);
});

// 화면 검수 UL6(2026-10-05): 데스크톱 줄 배지 'Reconnect'(e6c58f92)는 상태 배지인데 동사라 단추처럼 읽혔고, 폰은 'Reconnect needed' 그대로였다 — 두 자리를 상태 말로 통일.
test('UL6 다시 연결 필요 배지 — 데스크톱 줄·폰 상태가 같은 상태 말(동사 아님)', () => {
  for (const lang of ['ko', 'en']) assert.equal(tm('rail.relink', lang), tm('phone.agent.relink', lang), lang);
  assert.doesNotMatch(tm('rail.relink', 'en'), /^Reconnect/, '동사로 시작하지 않는다');
  assert.equal(tm('rail.relink', 'ko'), '연결 끊김'); assert.equal(tm('rail.relink', 'en'), 'Unlinked');
});

// 화면 검수 UL7(2026-10-05): UXM-10에서 기억 아이콘을 폴더로 바꾸며 기억 화면의 '그래프' 탭 단추도 폴더가 됐다 — 이름(그래프)과 그림(폴더)이 어긋났다.
// 아이콘 세트에 그래프 그림이 없어(추가하려면 Material 원본 패키지가 필요) 단추에 이름을 글자로 보인다.
test('UL7 기억 화면 그래프 탭 단추는 이름을 글자로 보이고 폴더 그림을 쓰지 않는다', () => {
  const m = app.match(/<button type="button" className=\{`tb label\$\{focusTab\?\.id === 'graph' \? ' on' : ''\}`\} onClick=\{\(\) => openTab\(GRAPH_TAB\)\}[^>]*>([^\n]*?)<\/button>/);
  assert.ok(m, '그래프 탭 단추');
  assert.match(m[1], /^\{t\('act\.tab\.graph'\)\}$/, '글자 이름만');
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.vault-toolbar \.tb\.label \{[^}]*width: auto;/, '글자 단추는 26px 고정 폭을 풀었다');
});

// 화면 검수 UL8(2026-10-05): 터치에서 창의 첫 단추로 초점을 옮기지 않아(UXM-17) 화면 낭독기 사용자가 창 안으로 못 들어갔다 — 터치면 창 자체로(링 없음).
test('UL8 창을 열면 터치에서도 초점이 창 안으로 — 터치는 창 자체, 마우스·키보드는 첫 단추', async () => {
  const { focusEntry } = await import('../src/focus-entry.mjs');
  const el = (name) => ({ name, focused: 0, focus() { this.focused++; } });
  const d1 = el('dialog'), b1 = el('button');
  assert.equal(focusEntry({ dialog: d1, first: b1, coarse: true }).name, 'dialog'); assert.deepEqual([d1.focused, b1.focused], [1, 0]);
  const d2 = el('dialog'), b2 = el('button');
  assert.equal(focusEntry({ dialog: d2, first: b2, coarse: false }).name, 'button');
  for (const f of ['work-panel.jsx', 'invite-dialog.jsx']) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /if \(!window\.matchMedia\?\.\('\(pointer: coarse\)'\)\.matches\) [a-zA-Z]+\.current\?\.focus\(\)|if \(!touch\) dialog/, `${f}: 터치에서 초점을 건너뛰지 않는다`);
    assert.match(src, /focusEntry\(/, `${f}: focusEntry`);
  }
});

// 화면 검수 UL9(2026-10-05): 링크 끊기가 실패한 뒤 다시 해서 성공해도 앞 오류 토스트가 8초 남아 성공 안내를 가렸다(토스트는 오류가 있으면 오류를 그린다).
// 성공 안내(setNote)가 오면 같은 자리의 앞 오류를 지운다 — 나중에 온 것이 보인다. 실제 셸 줄을 꺼내 돌린다.
test('UL9 성공 안내가 오면 앞 오류 토스트를 지운다 — 같은 순간 뒤에 온 오류는 남는다', () => {
  const m = app.match(/const setNote = useCallback\(\(v\) => \{([^}]*)\}, \[\]\);/); assert.ok(m, 'setNote 감싸기');
  const st = { err: '', note: '' }; const setErr = (v) => { st.err = v; }; const setNoteState = (v) => { st.note = v; };
  const setNote = new Function('setErr', 'setNoteState', `return (v) => {${m[1]}};`)(setErr, setNoteState);
  setErr('msgr_friend_link_revoke failed'); setNote('링크를 끊었습니다');
  assert.deepEqual(st, { err: '', note: '링크를 끊었습니다' });
  setNote('안내'); setErr('나중 오류'); assert.equal(st.err, '나중 오류', '뒤에 온 오류는 그대로');
  setErr('x'); setNote(''); assert.equal(st.err, 'x', '안내를 비우는 것은 오류를 건드리지 않는다');
});

// 화면 검수 UL10(2026-10-05): 에이전트 0명 구역(UXM-08)에도 정렬 단추가 남았다 — 정렬할 것이 없으면 숨긴다.
test('UL10 데스크톱 에이전트 구역 — 보이는 에이전트가 0명이면 정렬 단추를 그리지 않는다', () => {
  const sec = app.slice(app.indexOf('<RailSection id="mine"'), app.indexOf('<div className="msgr-list mine">'));
  assert.match(sec, /right=\{<span className="right">\{railVisible\.length > 0 && <span className="msgr-sortwrap msgr-railsort">/);
});
