// UX 판독 UXM-05(2026-10-05): 오류 토스트가 서버·JS 원문('duplicate key value violates…', 'TypeError: …', 'Failed to fetch')을 그대로 보이고
// 다음 행동을 알려 주지 않았다. 원문을 넘기는 호출이 60곳이 넘어, 토스트를 그리는 한 곳에서 거른다: 연결 끊김 → 연결 안내, 아는 서버 코드 → 그 문구,
// 기계가 낸 원문 → '처리하지 못했습니다 … 진단' + 원문은 진단 기록에. 이미 번역해 넘긴 문구(사전)는 그대로 둔다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toastError, MACHINE_ERROR } from '../src/error-toast.mjs';
import { DICT, t as tm } from '../src/i18n.js';

for (const lang of ['ko', 'en']) {
  const t = (k, v) => tm(k, lang, { path: tm('diag.path.desktop', lang), ...v }); // 기댓값의 진단 경로(데스크톱 기본) — 경로 자체는 L-h 테스트
  test(`UXM-05 원문은 사용자 문구로 — ${lang}`, () => {
    assert.equal(toastError('TypeError: Failed to fetch', { t }), t('err.offline'));
    assert.equal(toastError('Load failed', { t }), t('err.offline'));
    assert.equal(toastError('new row violates row-level security policy for table "msgr_channels"', { t }), t('err.denied'));
    assert.equal(toastError('msgr_room_limit', { t }), t('room.limit'));
    assert.equal(toastError('msgr_pro_required', { t }), t('err.proRequired')); // 무료 계정 에이전트 파견(2026-10-10 서버 관문)
    assert.notEqual(t('err.proRequired'), 'err.proRequired');
    for (const raw of ['duplicate key value violates unique constraint "msgr_channels_org_id_name_key"', "TypeError: Cannot read properties of undefined (reading 'id')", 'JWT expired', 'PGRST116: JSON object requested, multiple (or no) rows returned', 'Edge Function returned a non-2xx status code'])
      assert.equal(toastError(raw, { t }), t('err.raw'), raw);
    assert.notEqual(t('err.raw'), 'err.raw'); assert.notEqual(t('err.offline'), 'err.offline');
  });
}

test('UXM-05 이미 번역해 넘긴 사전 문구(ko·en 전부)는 기계 원문으로 보지 않는다', () => {
  const bad = [];
  for (const [k, [ko, en]] of Object.entries(DICT)) for (const v of [ko, en]) if (MACHINE_ERROR.test(v)) bad.push(`${k}: ${v}`);
  assert.deepEqual(bad, []);
  assert.equal(toastError(tm('err.denied', 'en'), { t: (k, v) => tm(k, 'en', v) }), tm('err.denied', 'en'));
  assert.equal(toastError('설정을 저장하지 못했습니다.', { t: (k, v) => tm(k, 'ko', v) }), '설정을 저장하지 못했습니다.');
});

// 화면 검수 UM1(2026-10-05): 서버 코드 154종 중 8종만 문구로 바뀌고 나머지는 '잠시 뒤 다시 시도' — 권한·한도는 다시 해도 같은 거절이라 틀린 안내였다.
// 여러 줄 오류는 번역된 앞줄까지, '실패: msgr_bot_exists'는 앞말까지 사라졌다. 남은 영어 원문(용량·시간 초과)도 거른다.
import { readFileSync, readdirSync } from 'node:fs';
const codes = [...new Set(readdirSync(new URL('../../../supabase/migrations/', import.meta.url)).filter((f) => f.endsWith('.sql'))
  .flatMap((f) => [...readFileSync(new URL(`../../../supabase/migrations/${f}`, import.meta.url), 'utf8').matchAll(/raise exception '(msgr_[a-z0-9_]+)/g)].map((m) => m[1])))];
for (const lang of ['ko', 'en']) {
  const t = (k, v) => tm(k, lang, { path: tm('diag.path.desktop', lang), ...v }); // 기댓값의 진단 경로(데스크톱 기본) — 경로 자체는 L-h 테스트
  test(`UM1 권한 계열은 권한 없음, 한도 계열은 한도 문구, 그 밖 서버 코드는 다시 시도 없는 안내 — ${lang}`, () => {
    for (const raw of ['msgr_forbidden', 'msgr_not_allowed', 'msgr_owner_only', 'msgr_admin_only', 'msgr_routine_forbidden', 'msgr_channel_admins_owner_only', 'permission denied for table msgr_channels', 'msgr_bot_unauthorized'])
      assert.equal(toastError(raw, { t }), t('err.denied'), raw);
    for (const raw of ['msgr_group_too_big', 'msgr_dm_full', 'msgr_hide_limit', 'msgr_routine_too_many', 'msgr_bot_file_too_large', 'msgr_bot_too_many_files', 'msgr_channel_limit', 'Payload too large', 'The object exceeded the maximum allowed size'])
      assert.equal(toastError(raw, { t }), t('err.limit'), raw);
    for (const raw of ['canceling statement due to statement timeout', 'AbortError: signal is aborted without reason', 'AbortError'])
      assert.equal(toastError(raw, { t }), t('err.timeout'), raw);
    assert.equal(toastError('msgr_bot_exists', { t }), t('err.code'));
    assert.doesNotMatch(t('err.code'), lang === 'ko' ? /다시 시도/ : /try again/i, '같은 거절이 반복되는 요청에 다시 시도를 권하지 않는다');
    assert.doesNotMatch(t('err.denied') + t('err.limit'), lang === 'ko' ? /잠시 뒤/ : /shortly/i);
  });
  test(`UM1 서버 코드 전부(마이그레이션 ${codes.length}종)가 원문으로 보이지 않고 '잠시 뒤 다시 시도'(err.raw)로도 가지 않는다 — ${lang}`, () => {
    assert.ok(codes.length > 100);
    const leaked = codes.filter((c) => { const v = toastError(c, { t }); return /msgr_/.test(v) || v === t('err.raw'); });
    assert.deepEqual(leaked, []);
  });
  test(`UM1 여러 줄 오류는 줄마다 거르고, 사람 말 앞줄·앞말(이름: )은 남긴다 — ${lang}`, () => {
    const first = lang === 'ko' ? 'My Agent: 이 에이전트는 지금 넣을 수 없습니다.' : 'My Agent: This agent can’t be added right now.';
    assert.equal(toastError(`${first}\nOther Agent: msgr_crew_not_visible`, { t }), `${first}\nOther Agent: ${t('err.code')}`);
    assert.equal(toastError('실패: msgr_bot_exists', { t }), `실패: ${t('err.code')}`);
    assert.equal(toastError('Error: msgr_forbidden', { t }), t('err.denied'), '기계 머리말(Error:)은 남기지 않는다');
    assert.equal(toastError('a.png: Payload too large\nb.png: Payload too large', { t }), `a.png: ${t('err.limit')}\nb.png: ${t('err.limit')}`);
    assert.equal(toastError('msgr_forbidden\nmsgr_forbidden', { t }), t('err.denied'), '같은 줄은 한 번');
  });
}

test('UM1 사전 문구(ko·en, 변수 채움)는 어떤 갈래에도 걸리지 않고 그대로 보인다 — "Attachment upload failed"가 연결 끊김으로, "read-only" 안내가 짧은 잠김 문구로 바뀌던 것', () => {
  const bad = [];
  for (const [k, pair] of Object.entries(DICT)) for (const [i, lang] of [[0, 'ko'], [1, 'en']]) {
    const v = String(pair[i]).replace(/\{(\w+)\}/g, '7');
    for (const line of v.split('\n')) if (line.trim() && toastError(line, { t: (x, vv) => tm(x, lang, vv) }) !== line) bad.push(`${k}(${lang})`);
  }
  assert.deepEqual(bad, []);
});

// 화면 검수 UM1(2026-10-05): 폰에서 게스트에게도 보이던 '새 채널'(서버 msgr_create_channel은 owner·admin·member만, 잠긴 조직 제외 → msgr_forbidden).
// 못 하는 행동은 아예 보이지 않게 — 폰 + 메뉴와 데스크톱 + 단추 모두 같은 판정(canNewCh)을 쓴다.
test('UM1 새 채널은 게스트·잠긴 조직·개인 공간에서 보이지 않는다(폰 메뉴·데스크톱 단추 모두)', async () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const line = app.match(/const chOffer = (newChannelOffer\([^;]+\)); const canNewCh = chOffer\.can;/); assert.ok(line, 'canNewCh 판정이 없다');
  const { newChannelOffer } = await import('../src/onboard.mjs');
  const can = (org, { isPersonal = false, orgLocked = false } = {}) => new Function('newChannelOffer', 'org', 'isPersonal', 'orgLocked', `return (${line[1]}).can;`)(newChannelOffer, org, isPersonal, orgLocked);
  assert.deepEqual(['owner', 'admin', 'member', 'guest'].map((role) => can({ role })), [true, true, true, false]);
  assert.equal(can({ role: 'member' }, { orgLocked: true }), false, '잠긴 조직');
  assert.equal(can({ role: 'owner' }, { isPersonal: true }), false, '개인 공간');
  assert.equal(can(null), false);
  assert.match(app, /\{canNewCh && <button type="button" role="menuitem" onClick=\{\(\) => \{ setChPlus\(false\); setBrowse\(null\); openNewCh\(\); \}\}>/, '폰 + 메뉴');
  assert.match(app, /\{canNewCh && <button type="button" className="btn msgr-chnew"/, '데스크톱 + 단추');
});

// 2차 검수 L-h(2026-10-05): 안내의 '설정 → 진단'은 없는 경로였다 — 폰은 설정 → 정보·약관 → 진단, 데스크톱은 설정 → 내 계정 → 진단(App.jsx 진단 카드 위치).
test('L-h 진단 안내는 실제 경로로 — 폰·데스크톱, ko·en (토스트·최상위 오류 화면·계정 삭제 실패)', async () => {
  const { rootErrorView } = await import('../src/root-error.mjs');
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const tabOf = (k) => tm(k, 'ko');
  assert.match(app, /sub === 'about' && \([^\n]*\n[^\n]*\n\s*<section className="msgr-setcard msgr-diagcard"><h2>\{t\('set\.diag'\)\}/, '폰: 정보·약관 화면에 진단 카드');
  assert.match(app.slice(app.indexOf("{tab === 'me' && (<>"), app.indexOf("{tab === 'me' && (<>") + 4000), /msgr-diagcard/, '데스크톱: 내 계정 탭에 진단 카드');
  for (const lang of ['ko', 'en']) {
    const t = (k, v) => tm(k, lang, { path: tm('diag.path.desktop', lang), ...v }); // 기댓값의 진단 경로(데스크톱 기본) — 경로 자체는 L-h 테스트
    const phone = toastError('TypeError: x is not a function', { t, phone: true }); const desk = toastError('TypeError: x is not a function', { t });
    assert.ok(phone.includes(`${tm('ui.settings', lang)} → ${tm('phone.set.about', lang)} → ${tm('set.diag', lang)}`), `${lang} 폰: ${phone}`);
    assert.ok(desk.includes(`${tm('ui.settings', lang)} → ${tm('set.tab.me', lang)} → ${tm('set.diag', lang)}`), `${lang} 데스크톱: ${desk}`);
    assert.ok(toastError('msgr_bot_exists', { t, phone: true }).includes(tm('phone.set.about', lang)));
    assert.ok(rootErrorView({ lang, phone: true }).hint.includes(tm('phone.set.about', lang)), 'root phone');
    assert.ok(rootErrorView({ lang }).hint.includes(tm('set.tab.me', lang)), 'root desktop');
    for (const k of ['err.raw', 'err.code', 'root.error.hint', 'acct.delete.failed']) assert.doesNotMatch(tm(k, lang), /설정 [→›] 진단|Settings [→›] Diagnostics/, `${k} ${lang}`);
  }
  void tabOf;
});
