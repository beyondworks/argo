// 설정 저장본(유건 10/1 6차 확정 1) — 저장·되돌리기·지우기 규칙과 서버 크기 한도를 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { capture, addPreset, removePreset, presetsFor, readAll, applyPreset, jsonbBytes, PRESET_LIMIT, PRESET_BYTES, PRESETS_KEY } from '../src/core/presets-model.js';
import { EMPTY } from '../src/core/custom-theme.js';

const HOME = [
  { id: 'calendar', size: 'm', span: 6, h: 480, x: 0, y: 0, hidden: false, cfg: { view: 'month' } },
  { id: 'cal-2', moduleId: 'calendar', size: 'm', x: 6, y: 0, hidden: false, cfg: { view: 'week' } },
  { id: 'todo', size: 's', hidden: true },
];
const DISPLAY = { theme: 'ocean-dark', shell: 'glass', custom: { ...EMPTY, radius: 12, light: { bg: '#ffffff' }, dark: {} }, lang: 'en', width: 'full' };
const make = (over = {}) => capture({ space: 'me', name: '평소', home: HOME, display: DISPLAY, at: '2026-10-01T12:30:00.000Z', ...over });

// 서버가 재는 크기 — jsonb를 글자로 바꾸면 ':'와 ',' 뒤에 빈칸이 붙는다(문자열 안은 그대로)
function pgText(v) {
  let out = '', inStr = false, esc = false;
  for (const ch of JSON.stringify(v)) {
    out += ch;
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === ':' || ch === ',') out += ' ';
  }
  return Buffer.byteLength(out, 'utf8');
}

// 이유: 저장본을 되돌리면 저장할 때 보던 그대로여야 한다 — 숨김·사본·모듈별 설정(cfg)·자리(x·y·h)까지.
test('저장 → 다시 읽기: 홈 배치(숨김·사본·cfg 포함)와 테마·셸·커스텀·언어·폭이 그대로 돌아온다', () => {
  const { items } = addPreset([], make());
  const [p] = presetsFor(items, 'me');
  assert.equal(p.name, '평소');
  assert.deepEqual(p.home.map((it) => [it.id, !!it.hidden, it.cfg?.view, it.x, it.h]), [['calendar', false, 'month', 0, 480], ['cal-2', false, 'week', 6, undefined], ['todo', true, undefined, undefined, undefined]]);
  assert.equal(p.home[1].moduleId, 'calendar');
  assert.deepEqual([p.theme, p.shell, p.lang, p.width, p.custom.radius, p.custom.light.bg], ['ocean-dark', 'glass', 'en', 'full', 12, '#ffffff']);
  assert.deepEqual(presetsFor(items, 'acme'), [], '다른 공간에는 보이지 않는다');
  assert.equal(PRESETS_KEY, 'presets:me', '사람마다 저장되는 줄(office_user_layouts, space_key=me)');
});

// 이유: 서버는 16KB를 넘는 값을 거절한다 — 보내기 전에 막지 않으면 저장 실패가 충돌로 잠긴다.
test('크기 추정은 서버가 재는 jsonb 글자 크기보다 작지 않고, 넘을 저장은 size로 거절한다', () => {
  for (const v of [{ items: [make()] }, { items: [make({ name: '이름, 쉼표: 콜론 "따옴표"' })] }, { a: [1, 2, { b: 'x:y,z' }] }]) assert.ok(jsonbBytes(v) >= pgText(v), JSON.stringify(v));
  const big = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, size: 'm', span: 6, h: 320, x: (i % 2) * 6, y: i, cfg: { note: '가나다라마바사'.repeat(4) } }));
  let items = [], err = null;
  for (let i = 0; i < PRESET_LIMIT && !err; i++) { const r = addPreset(items, make({ name: `큰 ${i}`, home: big })); if (r.error) err = r.error; else items = r.items; }
  assert.equal(err, 'size');
  assert.ok(pgText({ items }) <= PRESET_BYTES, '저장된 값은 서버 한도 안');
});

test('공간마다 10개까지 — 11번째는 limit, 다른 공간은 따로 센다', () => {
  let items = [];
  for (let i = 0; i < PRESET_LIMIT; i++) items = addPreset(items, make({ name: `s${i}`, home: [] })).items;
  assert.deepEqual(addPreset(items, make({ name: 'more', home: [] })), { error: 'limit' });
  assert.ok(addPreset(items, make({ space: 'acme', name: 'more', home: [] })).items);
  assert.ok(addPreset(items, make({ name: 's3', home: [{ id: 'x' }] }), { replace: true }).items, '같은 이름 덮어쓰기는 개수를 늘리지 않는다');
  assert.deepEqual(addPreset(items, make({ name: '   ' })), { error: 'name' });
});

// 이유(유건 확정): 같은 이름이면 덮어쓸지 한 번 묻는다 — 묻기 전에는 바꾸지 않는다.
test('같은 이름: replace 없이는 exists, 확인 뒤(replace)에는 그 하나만 새 값으로', () => {
  let items = addPreset([], make()).items;
  items = addPreset(items, make({ name: '월말 정리용' })).items;
  assert.deepEqual(addPreset(items, make({ home: [{ id: 'new' }] })), { exists: true });
  const next = addPreset(items, make({ home: [{ id: 'new' }], at: '2026-10-02T00:00:00.000Z' }), { replace: true }).items;
  assert.equal(next.length, 2);
  assert.deepEqual(presetsFor(next, 'me').map((p) => [p.name, p.home[0].id]), [['평소', 'new'], ['월말 정리용', 'calendar']], '최근 저장이 위');
  assert.deepEqual(removePreset(next, 'me', '평소').map((p) => p.name), ['월말 정리용']);
  assert.equal(removePreset(next, 'acme', '평소').length, 2, '다른 공간의 같은 이름은 지우지 않는다');
});

function fakeFx(over = {}) {
  const calls = [];
  const fx = { current: [{ id: 'old' }], saveHome: (h) => { calls.push(['home', h.map((it) => it.id)]); return true; },
    applyTheme: (v) => calls.push(['theme', v]), applyShell: (v) => calls.push(['shell', v]), saveCustom: (v) => calls.push(['custom', v && v.radius]),
    refreshCustom: () => calls.push(['refresh']), setLang: (v) => calls.push(['lang', v]), setWidth: (v) => calls.push(['width', v]), ...over };
  return { fx, calls };
}

test('되돌리기: 배치를 먼저 저장하고, 테마 → 셸 → 커스텀(새 색 위에서) → 폭 → 언어를 입힌다', () => {
  const [p] = presetsFor(addPreset([], make()).items, 'me');
  const { fx, calls } = fakeFx();
  assert.equal(applyPreset(p, fx), true);
  assert.deepEqual(calls, [['home', ['calendar', 'cal-2', 'todo']], ['theme', 'ocean-dark'], ['shell', 'glass'], ['custom', 12], ['width', true], ['lang', 'en']]);
  const plain = presetsFor(addPreset([], make({ display: { ...DISPLAY, custom: null, width: 'center' } })).items, 'me')[0];
  const b = fakeFx(); applyPreset(plain, b.fx);
  assert.deepEqual(b.calls.filter(([k]) => k === 'custom' || k === 'width'), [['custom', null], ['width', false]], '커스텀이 없던 저장본은 지금 커스텀을 지운다');
});

// 이유(DB 위생): 같은 배치면 쓰지 않는다. 저장이 막히면(충돌·불러오는 중) 화면 설정도 그대로 둔다(반쪽 되돌리기 금지).
test('되돌리기: 같은 배치면 배치 쓰기 0, 배치 저장이 막히면 아무것도 바꾸지 않는다', () => {
  const [p] = presetsFor(addPreset([], make()).items, 'me');
  const same = fakeFx({ current: JSON.parse(JSON.stringify(p.home)) });
  applyPreset(p, same.fx);
  assert.equal(same.calls.some(([k]) => k === 'home'), false);
  const blocked = fakeFx({ saveHome: () => false });
  assert.equal(applyPreset(p, blocked.fx), false);
  assert.deepEqual(blocked.calls, []);
});

// 이유: 저장값은 다른 버전의 앱도 쓴다 — 모양이 틀린 줄은 건너뛰고, 알 수 없는 값은 지금 설정을 건드리지 않는다.
test('옛 값·깨진 값: 모양이 틀린 줄은 버리고, 모르는 테마·언어·폭은 되돌릴 때 건드리지 않는다', () => {
  const junk = [null, 'x', 3, [], { space: 'me' }, { space: 'me', name: '', home: [] }, { space: 'me', name: 'a', home: 'x' }, { space: '', name: 'a', home: [] }];
  assert.deepEqual(readAll(junk), []);
  assert.deepEqual(readAll('not-an-array'), []);
  const old = { space: 'me', name: '옛것', home: [{ id: 'calendar' }, null, { id: 7 }], theme: 'neon', shell: 'cube', lang: 'fr', width: 'huge' };
  const [p] = presetsFor([...junk, old], 'me');
  assert.deepEqual(p.home, [{ id: 'calendar' }]);
  const { fx, calls } = fakeFx();
  applyPreset(p, fx);
  assert.deepEqual(calls, [['home', ['calendar']]], '배치만 되돌리고 테마·언어·폭은 지금 값 그대로');
  const legacy = presetsFor([{ space: 'me', name: 'b', home: [], theme: 'sage' }], 'me')[0];
  const r = fakeFx(); applyPreset(legacy, r.fx);
  assert.deepEqual(r.calls.slice(1), [['theme', 'sage'], ['refresh']], '커스텀 칸이 없던 저장본은 지금 커스텀을 새 색 위에서 다시 계산');
  const bad = presetsFor([{ space: 'me', name: 'c', home: [], custom: { radius: 999, font: 'comic', alpha: -5, light: { bg: 'red', card: '#123456' } } }], 'me')[0];
  assert.deepEqual(bad.custom, { radius: 24, font: 'pretendard', alpha: 0, light: { card: '#123456' }, dark: {} });
  assert.equal(addPreset([...junk, old], make()).items.length, 2, '깨진 줄은 다음 저장 때 빠지고 쓸 수 있는 저장본은 남는다');
});

// 이유: 로그인 상태에서 저장본 줄이 서버에 아직 없으면 버전을 몰라 저장이 막혔다 — 다른 사람별 줄(nav·fav)처럼 빈 줄(버전 0)로 시작한다.
test('불러오기: 서버에 저장본 줄이 없으면 빈 목록·버전 0으로 시작하고, 있으면 그 값', async () => {
  const load = (file, deps) => {
    const source = readFileSync(new URL(`../src/core/${file}`, import.meta.url), 'utf8').replace(/^import .*;$/gm, '');
    const module = { exports: {} };
    new Function(...Object.keys(deps), 'module', 'exports', transformSync(source, { loader: 'js', format: 'cjs' }).code)(...Object.values(deps), module, module.exports);
    return module.exports;
  };
  let response = { data: [] };
  const state = { layouts: {} };
  const query = { select() { return this; }, eq() { return this; }, then(resolve) { return Promise.resolve(response).then(resolve); } };
  const pull = load('pull.js', { getStorageScope: () => 'alice', ME: { id: 'alice' }, SPACES: [], getClient: async () => ({ from: () => query }),
    getState: () => state, update: (fn) => Object.assign(state, fn(state)), outbox: { has: () => false, drop: async () => {} }, mergePages() {}, mapBoard() {} });
  await pull.pullLayouts();
  assert.deepEqual(state.layouts['presets:me'], { items: [], version: 0 });
  response = { data: [{ surface: 'presets', prefs: { items: [make()] }, version: 4 }] };
  await pull.pullLayouts();
  assert.equal(state.layouts['presets:me'].version, 4);
  assert.equal(presetsFor(state.layouts['presets:me'].items, 'me')[0].name, '평소');
});
