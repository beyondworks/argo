// 종류·분류·유형 뱃지 색(유건 10/9 "뱃지들은 종류별로 색을 다르게 표시") — 값 → 색 규칙(ui/badge-tone.js)과 그 색을 칠하는 css를 잠근다.
// 색이 셸·테마 어디서나 실제로 이기는지·읽히는지·상태 색과 떨어져 있는지는 test/themes.test.mjs '실제로 이기는 규칙' 절이 잰다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { badgeTone, TONES, HASH_TONES } from '../src/ui/badge-tone.js';
import { kindKey, tagTone } from '../src/files/tones.js';
import { sampleList } from '../src/files/sample.js';
import { matches } from '../src/files/model.js';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const toneOf = (v) => badgeTone(v).replace(/^tone tone-/, '') || 'gray';
const nameOf = (cls) => cls.replace(/^tone tone-/, '') || 'gray';

// 이유: 캡처의 문서함은 분류(견적서·명함·계약서·사업자등록증·일반)와 유형(PDF·그림)이 모두 같은 회색이라 한눈에 갈리지 않았다.
// 짝은 아래 두 규칙(한 칸 안에서 겹치지 않음 · 한 줄에 함께 나오는 값끼리 겹치지 않음)을 지키게 골랐다 — 바꾸면 이 시험과 아래 시험이 함께 바뀐다.
test('정해진 값은 고정 색 — 분류·유형·출처', () => {
  const want = {
    quote: 'blue', contract: 'indigo', bizcert: 'teal', card: 'pink', bankbook: 'sky', evidence: 'violet', archive: 'gray', general: 'gray',
    pdf: 'pink', image: 'blue', doc: 'teal', link: 'sky', other: 'gray',
    drive: 'blue', generated: 'violet', esign: 'teal', mail: 'sky', agent: 'indigo',
  };
  assert.deepEqual(Object.fromEntries(Object.keys(want).map((k) => [k, toneOf(k)])), want);
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

// 이유(검수 #908 LOW): 문서함 한 줄에는 출처·분류·유형·태그가 나란히 놓인다 — 분류 '통장사본'과 유형 '그림'이 같은 청록이라 한 줄에서 겹쳤다.
// 함께 자주 나오는 짝(만든 견적·계약 PDF, 서명본 계약 PDF, 그림으로 올리는 명함·사업자등록증·통장사본·증빙, 메일로 온 증빙, 드라이브 링크·문서)은 서로 다른 색이다.
const TOGETHER = [
  ['generated', 'quote'], ['generated', 'contract'], ['generated', 'pdf'], ['quote', 'pdf'], ['contract', 'pdf'], ['esign', 'contract'], ['esign', 'pdf'],
  ['bizcert', 'pdf'], ['bizcert', 'image'], ['card', 'image'], ['bankbook', 'image'], ['bankbook', 'pdf'], ['evidence', 'pdf'], ['evidence', 'image'],
  ['mail', 'evidence'], ['mail', 'pdf'], ['mail', 'image'], ['drive', 'link'], ['drive', 'doc'], ['drive', 'pdf'], ['quote', 'doc'], ['contract', 'doc'], ['agent', 'doc'], ['agent', 'pdf'],
];
test('한 줄에 함께 나오는 값끼리 색이 겹치지 않는다 — 분류 × 유형 × 출처', () => {
  const same = TOGETHER.filter(([a, b]) => toneOf(a) !== 'gray' && toneOf(a) === toneOf(b)).map(([a, b]) => `${a}·${b}=${toneOf(a)}`);
  assert.deepEqual(same, []);
});

// 이유(검수 #908 LOW): 미리보기의 출처 '서명본'과 태그('계약서'·'signed')도 같은 줄이다 — 예시 문서함(유건이 보는 화면)의 줄마다
// 출처(올린 파일 제외)·분류·유형·태그 뱃지를 화면과 같은 규칙으로 만들어, 색이 있는 뱃지끼리 겹치지 않는지 본다.
// 분류 이름과 같은 태그('견적서' 등)는 일부러 그 분류와 같은 색이라 분류 뱃지와의 겹침은 뺀다.
test('예시 문서함의 줄·미리보기: 색 있는 뱃지끼리 겹치지 않는다', async () => {
  const rows = [];
  for (const space of ['beyondworks', 'me', 'lean-studio']) for (const trash of [false, true]) rows.push(...(await sampleList(space, { trash, match: matches })).files);
  assert.ok(rows.length >= 10, `예시 파일 ${rows.length}개`);
  const bad = [];
  for (const f of rows) {
    const cat = badgeTone(f.category ?? 'general');
    const badges = [f.source !== 'upload' && ['출처', badgeTone(f.source)], ['분류', cat], ['유형', badgeTone(kindKey(f))], ...(f.tags ?? []).map((x) => [`태그 ${x}`, tagTone(x), tagTone(x) === cat && cat])].filter(Boolean);
    const seen = new Map();
    for (const [what, cls, sameAsCat] of badges) {
      if (!cls || sameAsCat) continue;
      if (seen.has(cls)) bad.push(`${f.title}: ${seen.get(cls)}·${what} = ${nameOf(cls)}`);
      seen.set(cls, what);
    }
  }
  assert.deepEqual(bad, []);
  // 만든 견적서의 '견적서' 태그는 분류와 같은 색(같은 말은 같은 색)
  assert.equal(tagTone('견적서'), badgeTone('quote'));
  assert.equal(tagTone('Contract'), badgeTone('contract'));
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

// 이유: 태그처럼 사람이 적는 값은 미리 정할 수 없다 — 같은 글자는 어디서나 같은 색, 여러 값이 고르게 퍼진다. 회색은 해시로 나오지 않는다.
// 종류 색 여섯에는 상태로 읽히는 색이 없어 해시도 여섯 모두를 쓴다(순서만 다르다 — badge-tone.js HASH_TONES 주석).
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
  assert.deepEqual([...HASH_TONES].sort(), [...TONES].sort(), '해시는 종류 색 여섯 모두');
  assert.ok(!HASH_TONES.includes('gray'));
  assert.equal(toneOf(' VIP '), toneOf('vip'), '앞뒤 빈칸·대소문자는 같은 값');
});

// 이유: 클래스만 붙이고 css가 없으면 회색 그대로다. 색마다 --tone 규칙이 있고, 그 값은 종류 전용 토큰(--kind-*)이며 라이트·다크 값이 모두 있다.
test('css: 색마다 .tone-* → --kind-* 토큰(라이트·다크·OS 다크 그래파이트), 뱃지 규칙, 칩의 작은 색 점(.dot)', () => {
  const css = read('../src/base.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (re) => { const m = css.match(re); assert.ok(m, String(re)); return m[1]; };
  const light = block(/^:root \{ (--kind-[^}]*)\}/m), dark = block(/^:root:is\(\[data-theme\$='-dark'\], \.dark-emul\) \{ (--kind-[^}]*)\}/m);
  const osDark = block(/@media \(prefers-color-scheme: dark\) \{ :root\[data-theme='graphite'\] \{ (--kind-[^}]*)\} \}/);
  for (const name of TONES) {
    assert.match(css, new RegExp(`\\.tone-${name} \\{ --tone: var\\(--kind-${name}\\); \\}`), `.tone-${name}`);
    for (const [k, b] of [['라이트', light], ['다크', dark], ['OS 다크', osDark]]) assert.match(b, new RegExp(`--kind-${name}: #[0-9a-f]{6};`), `${k} --kind-${name}`);
  }
  assert.equal(dark, osDark, 'OS 다크의 그래파이트(시스템 자동)도 다크 값과 같다');
  assert.match(css, /:root \.badge\.tone:not\(\.ok, \.warn, \.danger\) \{ background: color-mix\(in srgb, var\(--tone\) 14%, transparent\); color: var\(--tone\); \}/);
  assert.match(css, /\.dot\.tone \{ background: var\(--tone\); \}/); // 칩의 작은 색 점 — 회색 값은 기본 .dot(--fg-3)
});

// 이유: 첫 화면 JS 상한(150KB deflate)에 여유가 거의 없다 — 색 규칙은 늦게 불러오는 화면만 가져다 쓴다.
// 한계: 이 시험은 소스 글자(import 줄)만 본다 — 다른 모듈을 거쳐 첫 화면 묶음에 들어가는 길은 못 잡는다. 실제 관문은 빌드 측정(vite build 뒤 첫 화면 JS의 deflate 합)이다.
test('첫 화면 모듈은 badge-tone.js를 가져오지 않는다(소스 글자 검사)', () => {
  for (const f of ['../src/App.jsx', '../src/main.jsx', '../src/pages/Home.jsx', '../src/ui/Sidebar.jsx', '../src/pages/modules.jsx']) assert.doesNotMatch(read(f), /badge-tone|files\/tones/, f);
});
