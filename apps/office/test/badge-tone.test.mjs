// 종류·분류·유형 뱃지 색(유건 10/9 "뱃지들은 종류별로 색을 다르게 표시") — 값 → 색 규칙(ui/badge-tone.js)과 그 색을 칠하는 css를 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { badgeTone, TONES, HASH_TONES } from '../src/ui/badge-tone.js';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const toneOf = (v) => badgeTone(v).replace(/^tone tone-/, '') || 'gray';

// 이유: 캡처의 문서함은 분류(견적서·명함·계약서·사업자등록증·일반)와 유형(PDF·그림)이 모두 같은 회색이라 한눈에 갈리지 않았다. 유건이 고른 짝을 고정한다.
test('정해진 값은 고정 색 — 분류·유형', () => {
  assert.equal(toneOf('quote'), 'blue');
  assert.equal(toneOf('contract'), 'green');
  assert.equal(toneOf('bizcert'), 'amber');
  assert.equal(toneOf('card'), 'violet');
  assert.equal(toneOf('general'), 'gray');
  assert.equal(toneOf('pdf'), 'red');
  assert.equal(toneOf('image'), 'teal');
  assert.equal(toneOf('doc'), 'blue');
  assert.equal(toneOf('other'), 'gray');
});

test('회색은 클래스 없이 — 기본 .badge(회색) 그대로, 색이 있으면 "tone tone-이름"', () => {
  for (const v of ['general', 'archive', 'other', '', null, undefined]) assert.equal(badgeTone(v), '', String(v));
  assert.equal(badgeTone('quote'), 'tone tone-blue');
});

// 이유: 같은 화면의 같은 칸에서 두 값이 같은 색이면 '종류별로 다르게'가 깨진다. 회색(일반·보관·기타)만 같은 색을 나눠 쓴다.
const SETS = {
  'files.cat': ['quote', 'contract', 'bizcert', 'card', 'bankbook', 'evidence', 'archive', 'general'],
  'files.kind': ['pdf', 'image', 'doc', 'link', 'other'],
  'files.src': ['drive', 'generated', 'esign', 'mail', 'agent'],
  'docs.kind': ['quote', 'contract'],
  'tool.kind': ['service', 'mcp', 'plugin', 'account', 'other'],
  'asset.kind': ['knowhow', 'set'],
  'ev.type': ['ceo', 'staff', 'agent'],
  'bizui.tax': ['taxable', 'zero', 'exempt'],
  'bizui.link': ['note', 'mail', 'page', 'file'],
};
test('한 칸 안의 값끼리는 색이 겹치지 않는다(회색 제외)', () => {
  for (const [set, keys] of Object.entries(SETS)) {
    const colored = keys.map(toneOf).filter((x) => x !== 'gray');
    assert.equal(new Set(colored).size, colored.length, `${set}: ${keys.map((k) => `${k}=${toneOf(k)}`).join(' ')}`);
  }
});

// 이유: 목록이 사전과 어긋나면(새 분류를 추가했는데 여기서 모르면) 그 값은 해시 색이 돼 칸 안에서 겹칠 수 있다 — 지금 사전의 키와 위 목록이 같아야 한다.
test('위 목록 = 지금 사전의 키', () => {
  const dicts = ['../src/files/files-i18n.js', '../src/docs/docs-i18n.js', '../src/pages/tools-i18n.js', '../src/pages/assets-i18n.js', '../src/pages/eval-i18n.js', '../src/business/ui-i18n.js'].map(read).join('\n');
  for (const [set, keys] of Object.entries(SETS)) {
    const found = [...dicts.matchAll(new RegExp(`'${set.replace('.', '\\.')}\\.([a-z_]+)'`, 'g'))].map((m) => m[1]);
    assert.deepEqual([...new Set(found)].sort(), [...keys].sort(), set);
  }
  // 분류 목록의 정본(files/model.js CATEGORIES)과도 같다
  const cats = read('../src/files/model.js').match(/export const CATEGORIES = \[([^\]]*)\]/)[1].match(/'([a-z]+)'/g).map((x) => x.slice(1, -1));
  assert.deepEqual(cats, SETS['files.cat']);
});

// 이유: 태그처럼 사람이 적는 값은 미리 정할 수 없다 — 같은 글자는 어디서나 같은 색, 여러 값이 고르게 퍼진다. 빨강(위험 뜻)·회색은 해시로 나오지 않는다.
test('모르는 값: 문자열 해시로 정해진 여러 색 중 하나 — 같은 값은 늘 같은 색', () => {
  const tags = ['한빛코퍼레이션', 'signed', '세금계산서', '긴급', '9월', 'VIP', '재계약', '증빙 원본', '영수증', 'NDA', '파트너', '광고'];
  const seen = new Set();
  for (const x of tags) {
    const a = toneOf(x);
    assert.equal(toneOf(x), a, x);
    assert.ok(HASH_TONES.includes(a), `${x} → ${a}`);
    seen.add(a);
  }
  assert.ok(seen.size >= 4, `고르게 퍼진다: ${[...seen]}`);
  assert.ok(!HASH_TONES.includes('red') && !HASH_TONES.includes('gray'));
  assert.ok(HASH_TONES.length >= 6 && HASH_TONES.length <= 8);
  assert.equal(toneOf(' VIP '), toneOf('vip'), '앞뒤 빈칸·대소문자는 같은 값');
});

// 이유: 클래스만 붙이고 css가 없으면 회색 그대로다. 색마다 --tone 규칙이 있고, 색은 테마 토큰에서만 만든다(새 하드코딩 색 없음).
test('css: 색마다 --tone 규칙, 값은 토큰만, 칩의 작은 색 점(.dot)', () => {
  const css = read('../src/base.css').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const name of TONES) {
    const m = css.match(new RegExp(`\\.tone-${name} \\{ --tone: ([^;]+); \\}`));
    assert.ok(m, `.tone-${name}`);
    assert.doesNotMatch(m[1], /#[0-9a-f]|\brgba?\(|\b(white|black)\b/i, `토큰만: ${m[1]}`);
  }
  assert.match(css, /\.badge\.tone \{ background: color-mix\(in srgb, var\(--tone\) [\d.]+%, transparent\); color: color-mix\(in srgb, var\(--tone\) [\d.]+%, var\(--fg\)\); \}/);
  assert.match(css, /\.dot\.tone \{ background: var\(--tone\); \}/); // 칩의 작은 색 점 — 회색 값은 기본 .dot(--fg-3)
});

// 이유: 첫 화면 JS 상한(150KB deflate)에 여유가 거의 없다 — 색 규칙은 늦게 불러오는 화면만 가져다 쓴다.
test('첫 화면 모듈은 badge-tone.js를 가져오지 않는다', () => {
  for (const f of ['../src/App.jsx', '../src/main.jsx', '../src/pages/Home.jsx', '../src/ui/Sidebar.jsx', '../src/pages/modules.jsx']) assert.doesNotMatch(read(f), /badge-tone/, f);
});
