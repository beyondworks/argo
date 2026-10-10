import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UPDATE_NOTES, UPDATE_NOTES_STORAGE_KEY, stableVersion, updateNotesFor, shouldShowUpdateNotes, isEditingElement,
  readUpdateNotesVersion, acknowledgeUpdateNotesVersion, updateNotesView } from '../app/update-notes-state.mjs';

const eligible = { current: '0.1.89', bundleVersion: '0.1.89', ready: true, loaded: true };
const store = (initial = null) => {
  let value = initial; const writes = [];
  return { getItem: (key) => { assert.equal(key, UPDATE_NOTES_STORAGE_KEY); return value; },
    setItem: (key, next) => { assert.equal(key, UPDATE_NOTES_STORAGE_KEY); writes.push(next); value = next; }, writes };
};

test('only exact, safe, stable x.y.z versions with authored notes are eligible', () => {
  for (const version of ['0.1.89', '1.10.0', '10.0.1']) assert.equal(stableVersion(version), true);
  for (const version of ['', null, 1, 'v0.1.89', '0.1', '01.1.88', '0.1.89-rc.1', '0.1.89+dev', ' 0.1.89', '99999999999999999999.1.0']) {
    assert.equal(stableVersion(version), false, String(version));
  }
  assert.equal(updateNotesFor('0.1.89', '0.1.89').length, 4);
  assert.deepEqual(updateNotesFor('0.1.88', '0.1.88'), []);
  assert.deepEqual(updateNotesFor('0.1.88', '0.1.89'), []);
  assert.deepEqual(updateNotesFor('0.1.9999', '0.1.9999'), []);
  assert.deepEqual(updateNotesFor('0.1.89-rc.1', '0.1.89-rc.1'), []);
});

test('first visit and skipped versions show current notes; acknowledged or downgraded versions do not', () => {
  assert.equal(shouldShowUpdateNotes(eligible), true);
  assert.equal(shouldShowUpdateNotes({ ...eligible, ackVersion: '0.1.1' }), true);
  assert.equal(shouldShowUpdateNotes({ ...eligible, ackVersion: '0.1.89' }), false);
  assert.equal(shouldShowUpdateNotes({ ...eligible, ackVersion: '0.1.100' }), false);
  assert.equal(shouldShowUpdateNotes({ ...eligible, ackVersion: 'bad marker' }), true);
  assert.equal(shouldShowUpdateNotes({ ...eligible, current: '0.1.88' }), false);
  assert.equal(shouldShowUpdateNotes({ ...eligible, current: '0.1.88', bundleVersion: '0.1.88' }), false);
  assert.equal(shouldShowUpdateNotes({ ...eligible, current: '0.1.9999', bundleVersion: '0.1.9999' }), false);
});

test('busy, hidden, overlay and session dismissal defer display without acknowledgement', () => {
  for (const flag of ['blocked', 'hidden', 'overlay', 'dismissed']) {
    assert.equal(shouldShowUpdateNotes({ ...eligible, [flag]: true }), false, flag);
  }
  for (const flag of ['ready', 'loaded']) assert.equal(shouldShowUpdateNotes({ ...eligible, [flag]: false }), false, flag);
  for (const element of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'DIV', isContentEditable: true }]) {
    assert.equal(isEditingElement(element), true);
  }
  assert.equal(isEditingElement(null), false);
  assert.equal(isEditingElement({ tagName: 'BUTTON' }), false);
});

test('web marker is written only by explicit acknowledgement and never moved backwards', async () => {
  const storage = store();
  assert.equal(await readUpdateNotesVersion({ isApp: false, storage }), null);
  assert.deepEqual(storage.writes, []);
  await acknowledgeUpdateNotesVersion('0.1.89', { isApp: false, storage });
  assert.equal(await readUpdateNotesVersion({ isApp: false, storage }), '0.1.89');
  await acknowledgeUpdateNotesVersion('0.1.89', { isApp: false, storage });
  assert.deepEqual(storage.writes, ['0.1.89']);
  const newer = store('0.1.100');
  await acknowledgeUpdateNotesVersion('0.1.89', { isApp: false, storage: newer });
  assert.deepEqual(newer.writes, []);
  await assert.rejects(acknowledgeUpdateNotesVersion('0.1.9999', { isApp: false, storage }), /No update notes/);
});

test('native uses exact commands and waits for successful acknowledgement, with no web fallback', async () => {
  const calls = []; const storage = store();
  let finish;
  const invoke = (command, args) => {
    calls.push([command, args]);
    return command === 'read_update_notes_version' ? Promise.resolve('0.1.88') : new Promise((resolve) => { finish = resolve; });
  };
  assert.equal(await readUpdateNotesVersion({ isApp: true, invoke, storage }), '0.1.88');
  let acknowledged = false;
  const pending = acknowledgeUpdateNotesVersion('0.1.89', { isApp: true, invoke, storage }).then(() => { acknowledged = true; });
  await Promise.resolve();
  assert.equal(acknowledged, false);
  finish('0.1.89'); await pending;
  assert.equal(acknowledged, true);
  assert.deepEqual(calls, [['read_update_notes_version', undefined], ['acknowledge_update_notes_version', { version: '0.1.89' }]]);
  assert.deepEqual(storage.writes, []);
  await assert.rejects(acknowledgeUpdateNotesVersion('0.1.89', { isApp: true, invoke: async () => undefined }), /not saved/);
  await assert.rejects(readUpdateNotesVersion({ isApp: true, invoke: async () => 'bad marker' }), /Invalid native/);
});

test('native and web storage failures reject instead of claiming a saved acknowledgement', async () => {
  const storage = store();
  const invoke = async () => { throw new Error('native unavailable'); };
  await assert.rejects(readUpdateNotesVersion({ isApp: true, invoke, storage }), /native unavailable/);
  await assert.rejects(acknowledgeUpdateNotesVersion('0.1.89', { isApp: true, invoke, storage }), /native unavailable/);
  assert.deepEqual(storage.writes, []);
  await assert.rejects(readUpdateNotesVersion({ isApp: false, storage: { getItem() { throw new Error('storage blocked'); } } }), /storage blocked/);
  await assert.rejects(acknowledgeUpdateNotesVersion('0.1.89', { isApp: false,
    storage: { getItem: () => null, setItem() { throw new Error('storage full'); } } }), /storage full/);
});

// 0.1.90 안내(#751 대기열 바로 보내기) — 항목이 빠지면 업데이트 뒤 안내가 조용히 안 뜬다.
test('0.1.90 업데이트 안내 항목이 있고 i18n 사전에 ko·en 둘 다 있다', async () => {
  const keys = updateNotesFor('0.1.90', '0.1.90');
  assert.deepEqual([...keys], ['updates.note.steer', 'updates.note.firstSend']);
  const src = (await import('node:fs')).readFileSync(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  for (const k of keys) assert.match(src, new RegExp(`'${k.replace('.', '\\.')}': \\['[^']+', '[^']+'\\]`), k);
});

// 0.1.100 — 처음 나오는 세 자리 패치 번호. 버전을 글자로 비교하면 '0.1.100' < '0.1.99'라 0.1.99를 확인한 사용자에게 안내가 안 뜨고,
// 확인 기록도 앞으로 못 간다. 판정(cmpVersion)·웹 확인 기록이 숫자로 비교하는지 잠근다(네이티브는 update_notes.rs가 [u64; 3]으로 비교).
test('0.1.100 안내 항목이 있고, 0.1.99를 확인한 사용자에게 뜨며 0.1.100을 확인하면 다시 뜨지 않는다', async () => {
  const keys = updateNotesFor('0.1.100', '0.1.100');
  assert.deepEqual([...keys], ['updates.note.contextBudget', 'updates.note.chatImages', 'updates.note.macFirst', 'updates.note.gpt55Retire', 'updates.note.assistantOnce']);
  const v100 = { current: '0.1.100', bundleVersion: '0.1.100', ready: true, loaded: true };
  assert.equal(shouldShowUpdateNotes({ ...v100, ackVersion: '0.1.99' }), true);
  assert.equal(shouldShowUpdateNotes({ ...v100, ackVersion: '0.1.100' }), false);
  const storage = store('0.1.99');
  await acknowledgeUpdateNotesVersion('0.1.100', { isApp: false, storage });
  assert.deepEqual(storage.writes, ['0.1.100'], '0.1.99 → 0.1.100은 앞으로 가는 기록');
  assert.equal(shouldShowUpdateNotes({ ...v100, ackVersion: await readUpdateNotesVersion({ isApp: false, storage }) }), false);
});

// 범프에 안내 항목이 빠지면 업데이트한 사용자에게 안내가 조용히 안 뜬다 — 0.1.90·0.1.95 두 번 빠뜨렸다(2026-09-29·10-05, 0.1.95는 빌드를 다시 했다).
// 그래서 버전 파일(package.json)과 안내 항목을 같이 잠근다: 범프 PR이 항목 없이 올라오면 이 테스트가 실패한다.
test('package.json 버전에 업데이트 안내 항목이 있고, 모든 안내 항목이 i18n 사전에 ko·en으로 있다', async () => {
  const { readFileSync } = await import('node:fs');
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(updateNotesFor(version, version).length > 0, `UPDATE_NOTES['${version}'] 없음 — 범프 PR에 이 버전 안내 항목과 i18n 문구를 같이 넣는다`);
  const src = readFileSync(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  const STR = String.raw`(?:'(?:[^'\\]|\\.)+'|"(?:[^"\\]|\\.)+")`; // 작은따옴표(\' 포함)·큰따옴표 문자열 둘 다
  for (const k of Object.values(UPDATE_NOTES).flat()) assert.match(src, new RegExp(String.raw`'${k.replaceAll('.', '\\.')}': \[${STR}, ${STR}\]`), k);
});

// UX-A01(2026-10-05): 카드가 입력 중엔 숨었다가 blur 때 다시 그려져 보내기 클릭을 먹었고, 닫아도 다음 실행에 다시 떴다.
test('떠 있는 카드는 입력을 시작하면 이번 실행에서 접는다(다시 튀어나오지 않게) — 저장 중·안 보일 때는 접지 않는다', async () => {
  const { shouldAutoDismissUpdateNotes, UPDATE_NOTES_BLUR_SETTLE_MS } = await import('../app/update-notes-state.mjs');
  assert.equal(shouldAutoDismissUpdateNotes({ visible: true, editing: true }), true);
  assert.equal(shouldAutoDismissUpdateNotes({ visible: true, editing: false }), false);
  assert.equal(shouldAutoDismissUpdateNotes({ visible: false, editing: true }), false, '아직 안 뜬 카드는 접을 대상이 아니다');
  assert.equal(shouldAutoDismissUpdateNotes({ visible: true, editing: true, saving: true }), false);
  assert.ok(UPDATE_NOTES_BLUR_SETTLE_MS >= 1000, '입력창 → 버튼 클릭 한 번(포커스 이동~클릭 완료) 동안은 카드를 그리지 않는다');
});

test('닫기(×)는 같은 버전 확인 기록을 남겨 다시 띄우지 않는다 — 기록 실패면 false(이번 실행에서만 접는다)', async () => {
  const { closeUpdateNotes } = await import('../app/update-notes-state.mjs');
  const storage = store();
  assert.equal(await closeUpdateNotes('0.1.95', { isApp: false, storage }), true);
  const ack = await readUpdateNotesVersion({ isApp: false, storage });
  assert.equal(shouldShowUpdateNotes({ current: '0.1.95', bundleVersion: '0.1.95', ready: true, loaded: true, ackVersion: ack }), false,
    '닫은 버전은 새 실행(세션 기억 없음)에서도 다시 뜨지 않는다');
  assert.equal(await closeUpdateNotes('0.1.95', { isApp: true, invoke: async () => { throw new Error('native down'); } }), false);
});

// T6 발견(2026-10-05): 칩을 눌러 펼친 카드가 상단바 아래 오른쪽에 떠서 데크 '설정에서 연결하기'를 덮었다(390·1280 × ko/en × 라이트/다크 8조합).
// 0.1.95는 카드가 저절로 떠서 오른쪽 아래(또는 폰 화면 절반)를 덮었다. → 회사 화면은 본문 맨 위 자리에 흐름대로 놓아 아래 내용을 밀어낸다.
test('펼친 카드 자리 — 본문 자리가 있으면 그 안에 흐름대로(덮는 위치 지정 없음), 없을 때만 떠 있는 카드', async () => {
  const { updateNotesCardPlacement, UPDATE_NOTES_INLINE_STYLE, UPDATE_NOTES_SLOT_ID } = await import('../app/update-notes-state.mjs');
  const slot = { id: UPDATE_NOTES_SLOT_ID };
  assert.deepEqual(updateNotesCardPlacement(slot), { inline: true, host: slot });
  assert.deepEqual(updateNotesCardPlacement(null), { inline: false, host: null });
  for (const prop of ['position', 'top', 'right', 'bottom', 'left', 'inset', 'zIndex', 'transform', 'float', 'marginTop']) {
    assert.ok(!Object.hasOwn(UPDATE_NOTES_INLINE_STYLE, prop), `흐름 카드에 ${prop} — 다른 요소 위에 겹칠 수 있다`);
  }
  assert.equal(UPDATE_NOTES_INLINE_STYLE.width, '100%');
  assert.ok(UPDATE_NOTES_INLINE_STYLE.scrollMarginTop >= 56, '스크롤을 내린 화면에서 펼치면 카드를 끌어올리는데, 붙박이 상단바(56px) 밑에 숨으면 안 된다');
});

test('배선 — 회사 화면 본문 맨 앞에 빈 자리, 펼친 카드는 그 자리를 찾아 inline으로 그린다', async () => {
  const { UPDATE_NOTES_SLOT_ID } = await import('../app/update-notes-state.mjs');
  const { readFileSync } = await import('node:fs');
  const layout = readFileSync(new URL('../app/c/[ws]/layout.jsx', import.meta.url), 'utf8');
  const main = layout.match(/<main ref=\{contentRef\} className="content"[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? '';
  const firstEl = main.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').trim();
  assert.ok(firstEl.startsWith(`<div id="${UPDATE_NOTES_SLOT_ID}" />`), '본문 첫 요소가 빈 안내 자리여야 한다(내용 앞 — 카드가 위에서 아래를 밀어낸다)');
  const notes = readFileSync(new URL('../app/update-notes.jsx', import.meta.url), 'utf8');
  assert.match(notes, /const place = updateNotesCardPlacement\(document\.getElementById\(UPDATE_NOTES_SLOT_ID\)\);/);
  assert.match(notes, /<UpdateNotesCard [^>]*inline=\{place\.inline\}/);
  assert.match(notes, /, place\.host \?\? document\.body\);/);
  assert.match(notes, /style=\{inline \? UPDATE_NOTES_INLINE_STYLE : \{ position: 'fixed'/, '흐름 카드는 고정 위치 스타일을 쓰지 않는다');
});

// 0.1.96 rc 실측: 대화 화면을 주소로 열거나 새로 고치면 입력창이 바로 포커스를 받아(editing) 안내가 꺼내지지 않았고,
// 상단바 '새 소식' 칩이 입력창을 떠날 때까지 안 나왔다. 업데이트 뒤 앱이 대화 화면으로 다시 열리면 안내를 못 본다.
test('typing in the chat input does not hold back the collapsed top-bar chip', () => {
  assert.equal(shouldShowUpdateNotes({ ...eligible, editing: true }), true);
  assert.equal(updateNotesView({ hasChipHost: true, editing: true }), 'chip');
  assert.equal(updateNotesView({ hasChipHost: true, editing: true, overlay: true, hidden: true }), 'chip', 'chip covers nothing');
  assert.equal(updateNotesView({ hasChipHost: true }), 'chip');
});

test('floating pill and expanded card still wait while typing, behind overlays and in hidden tabs', () => {
  for (const flag of ['editing', 'overlay', 'hidden']) {
    assert.equal(updateNotesView({ hasChipHost: false, [flag]: true }), null, 'pill ' + flag);
    assert.equal(updateNotesView({ hasChipHost: true, expanded: true, [flag]: true }), null, 'card ' + flag);
    assert.equal(updateNotesView({ hasChipHost: true, error: 'updates.saveError', [flag]: true }), null, 'error card ' + flag);
  }
  assert.equal(updateNotesView({ hasChipHost: false }), 'pill');
  assert.equal(updateNotesView({ hasChipHost: true, expanded: true }), 'card');
  assert.equal(updateNotesView({ hasChipHost: true, errorOnly: true, error: 'updates.readError' }), 'card');
  assert.equal(updateNotesView({ hasChipHost: false, error: 'updates.saveError' }), 'card');
});

test('UpdateNotes renders through updateNotesView and its show gate receives the live surface', () => {
  const src = readFileSync(new URL('../app/update-notes.jsx', import.meta.url), 'utf8');
  assert.match(src, /const view = updateNotesView\(\{ hasChipHost: !!host, expanded,[^}]*\.\.\.surface \}\)/);
  assert.match(src, /if \(view === 'chip'\) return createPortal\(<UpdateNotesChip/);
  assert.doesNotMatch(src, /surface\.editing \|\|/, 'render path must not gate on editing outside updateNotesView');
});

// 비서 → 하트비트 이름 변경(10/10) — 0.1.101 업데이트 안내에 옛 이름과 새 이름이 같이 있어야 옛 이름으로 알던 사용자가 같은 기능임을 안다.
test('0.1.101 안내 — 비서가 하트비트로 이름이 바뀐 항목이 ko·en 사전에 있다', () => {
  assert.deepEqual([...updateNotesFor('0.1.101', '0.1.101')], ['updates.note.heartbeatName']);
  const src = readFileSync(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  const line = src.split('\n').find((l) => l.includes("'updates.note.heartbeatName'"));
  assert.ok(line && line.includes('비서') && line.includes('하트비트') && line.includes('Assistant') && line.includes('Heartbeat'), '옛 이름·새 이름이 ko·en 모두에 적혀 있다');
});
