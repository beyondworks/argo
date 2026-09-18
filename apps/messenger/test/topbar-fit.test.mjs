// 데스크톱 상단 바가 가로로 넘치지 않는다(900·820px에서 문서가 옆으로 밀리던 것, 2026-09-18).
// 행동 확인은 픽스처 실측(폭 1920·1312·1100·900·820 × 라이트·다크: 넘침 0) — 여기는 그 규칙과 탭 이름 보존을 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
const TOP = '.msgr-shell:not(.msgr-phone) .msgr-main > .msgr-top';

test('안전망 — 상단 바는 줄바꿈하고, 주제는 남는 자리만 쓴다(주제 때문에 줄이 바뀌지 않게)', () => {
  assert.ok(css.includes(`${TOP} { flex-wrap: wrap; row-gap: 8px; }`));
  assert.ok(css.includes(`${TOP} .topic { flex: 1 1 0; }`));
});

test('좁을 때 주제 숨김 · 인원 칩과 탭은 아이콘만 — 경계는 한 줄 전체 표시 실측 최대(영어 922px)보다 크다', () => {
  const m = css.match(/@container msgr-main \(max-width: (\d+)px\) \{\n([^}]*)\}/);
  assert.ok(m, '줄인 표시 컨테이너 쿼리');
  assert.ok(Number(m[1]) + 1 > 922);
  for (const sel of ['.topic', '.members .n', '.msgr-seg .lbl']) assert.ok(m[2].includes(`${TOP} ${sel}`), sel);
});

test('아이콘만 남아도 탭 이름은 title·aria-label로 남고, 아이콘 없는 탭(전체)은 글자를 숨기지 않는다', () => {
  assert.match(app, /onClick=\{\(\) => setTab\(k\)\} title=\{t\(`tab\.\$\{k\}`\)\} aria-label=\{n > 0 \? `\$\{t\(`tab\.\$\{k\}`\)\} \$\{n\}` : t\(`tab\.\$\{k\}`\)\}>/);
  assert.match(app, /<span className=\{ic \? 'lbl' : undefined\}>\{t\(`tab\.\$\{k\}`\)\}<\/span>/);
  assert.match(app, /const tabs = \[\['all', null, 0\]/, '전체 탭은 아이콘이 없다 — 글자가 남아야 한다');
});

test('폰 셸은 건드리지 않는다 — 규칙은 모두 데스크톱 셸 한정', () => {
  const lines = css.split('\n').filter((l) => l.includes('> .msgr-top'));
  assert.ok(lines.length >= 3);
  for (const l of lines) assert.ok(!/(^|[\s,{])\.msgr-main > \.msgr-top/.test(l.replaceAll(TOP, '')), l.slice(0, 80));
});
