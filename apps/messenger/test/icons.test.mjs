// 아이콘 세트(Material Symbols, 2026-10-02) — 앱에서 쓰는 아이콘 이름이 모두 정의돼 있는지, 대응표의 Material 이름마다 path가 있는지.
// 없는 이름을 쓰면 <use>가 빈 그림이 되어 버튼이 비어 보인다(빌드·타입 검사로 안 잡힌다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../src/', import.meta.url);
const icons = readFileSync(new URL('icons.jsx', dir), 'utf8');
const block = (name, open, close) => { const i = icons.indexOf(name); const a = icons.indexOf(open, i); return icons.slice(a, icons.indexOf(close, a) + 1); };
const MATERIAL = Object.fromEntries([...block('export const MATERIAL', '{', '}').matchAll(/(\w+): '(\w+)'/g)].map((m) => [m[1], m[2]]));
const FILLED = [...block('export const FILLED', '[', ']').matchAll(/'(\w+)'/g)].map((m) => m[1]);
const MS = new Set([...block('const MS = {', '{', '}').matchAll(/^ {2}'?([\w-]+)'?: '/gm)].map((m) => m[1]));
const BRAND = [...block('const BRAND', '{', '}').matchAll(/(\w+):/g)].map((m) => m[1]);
const NAMES = new Set([...Object.keys(MATERIAL), ...BRAND]);

const VAL = /(?<![=!]==?\s*)'(\w+)'/g; // 비교 대상(c.kind === 'private')이 아니라 고른 값('lock' : 'hash')만
/** 소스에서 아이콘 이름으로 쓰인 문자열을 모은다 — <I name="x">, <I name={…'x'…}>, icon: 'x', ic('x'), 탭 아이콘 표, 결재 띠 아이콘 */
function usedNames(src) {
  const out = new Set();
  for (const m of src.matchAll(/<I name="(\w+)"/g)) out.add(m[1]);
  for (const m of src.matchAll(/<I name=\{\{([^}]*)\}/g)) for (const v of m[1].matchAll(/'(\w+)'/g)) out.add(v[1]);
  for (const m of src.matchAll(/<I name=\{([^{}]*)\}/g)) for (const v of m[1].matchAll(VAL)) out.add(v[1]);
  for (const m of src.matchAll(/\bicon: '(\w+)'/g)) out.add(m[1]);
  for (const m of src.matchAll(/\bic\('(\w+)'\)/g)) out.add(m[1]);
  const tabs = src.match(/const PHONE_TAB_ICONS = \{([^}]*)\}/); if (tabs) for (const v of tabs[1].matchAll(/: '(\w+)'/g)) out.add(v[1]);
  const band = src.match(/const bandIcon = ([^;]*);/); if (band) for (const v of band[1].matchAll(VAL)) out.add(v[1]);
  return out;
}
const missing = (src) => [...usedNames(src)].filter((n) => !NAMES.has(n));

test('검사기 자체 — 없는 이름을 쓰면 찾아낸다', () => {
  assert.deepEqual(missing('<I name="nope" size={12} />'), ['nope']);
  assert.deepEqual(missing("<I name={on ? 'bell' : 'nada'} />"), ['nada']);
  assert.deepEqual(missing("<I name={c.kind === 'private' ? 'lock' : 'hash'} />"), [], '비교 대상 문자열은 이름이 아니다');
  assert.deepEqual(missing("items={[{ icon: 'ghost', label: 'x' }]}"), ['ghost']);
  assert.deepEqual(missing("<I name={{ a: 'star', b: 'zzz' }[k]} />"), ['zzz']);
});

test('앱에서 쓰는 아이콘 이름은 모두 정의돼 있다(icons.jsx를 쓰는 모든 파일)', () => {
  const files = readdirSync(dir).filter((f) => /\.(jsx|js|mjs)$/.test(f) && f !== 'icons.jsx');
  let seen = 0;
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    if (!/from '\.\/icons\.jsx'/.test(src)) continue;
    seen += usedNames(src).size;
    assert.deepEqual(missing(src), [], `${f}에서 정의 안 된 아이콘 이름`);
  }
  assert.ok(seen > 30, '이름을 실제로 모았다');
});

test('대응표의 Material 이름마다 path가 있고, 채운 모양이 필요한 탭 아이콘은 -fill path도 있다', () => {
  for (const [app, n] of Object.entries(MATERIAL)) assert.ok(MS.has(n), `${app} → ${n} path 없음`);
  for (const app of FILLED) { assert.ok(MATERIAL[app], `FILLED ${app}가 대응표에 없음`); assert.ok(MS.has(`${MATERIAL[app]}-fill`), `${app} 채운 모양 없음`); }
  const tabs = readFileSync(new URL('App.jsx', dir), 'utf8').match(/const PHONE_TAB_ICONS = \{([^}]*)\}/)[1];
  for (const v of tabs.matchAll(/: '(\w+)'/g)) assert.ok(FILLED.includes(v[1]), `아래 탭 아이콘 ${v[1]}은 선택 시 채운 모양`);
  assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(icons), '런타임에 구글 글꼴을 불러오지 않는다');
  assert.match(icons, /^\/\*! Icons: Material Symbols .*Apache License 2\.0/, '번들에 남는 고지 주석');
});
