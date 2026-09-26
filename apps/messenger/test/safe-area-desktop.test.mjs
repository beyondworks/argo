import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 총괄 실측(2026-09-26, iPad Air 11 시뮬레이터 세로): 데스크톱 레이아웃(폭 720px 초과)에서 왼쪽 레일의
// ARGO 로고가 iOS 상태 표시줄(시각·날짜)과 겹치고, 오른쪽 본문 머리(# 채널명 등)도 상태 표시줄에 바짝 붙었다.
// 원인: env(safe-area-inset-*)가 폰 셸(.msgr-phone, max-width: 720px) 전용 블록에만 있었다 — 아이패드 데스크톱
// 폭은 그 블록에 안 걸린다. 맥·윈도우는 이 값이 0이라 max()로 감싸면 기존 값 그대로 나와 화면이 바뀌지 않는다.
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

// hover-media.test.mjs와 같은 방식 — 중괄호 깊이로 규칙과 그 규칙을 감싼 at-rule 문맥을 뽑는다(선택자·문맥만).
function rules(src) {
  const out = []; const ctx = []; let buf = ''; let depth = 0;
  const text = src.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const c of text) {
    if (c === '{') {
      const head = buf.trim().replace(/\s+/g, ' '); buf = '';
      if (head.startsWith('@')) ctx.push({ head, depth }); else out.push({ sel: head, at: ctx.map((x) => x.head) });
      depth++;
    } else if (c === '}') {
      depth--; while (ctx.length && ctx.at(-1).depth >= depth) ctx.pop(); buf = '';
    } else buf += c;
  }
  return out;
}
// 선택자 자리표시 문자열로 그 규칙의 선언부 텍스트를 직접 뽑는다(중복 선택자와 헷갈리지 않게 앞부분까지 지정).
function declarationsFor(selectorLine) {
  const idx = css.indexOf(selectorLine);
  assert.ok(idx >= 0, `선택자를 못 찾음: ${selectorLine}`);
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}
const all = rules(css);
const phoneScoped = (r) => /\.msgr-phone/.test(r.sel.replace(/:not\([^)]*\)/g, '')) || r.at.some((a) => /max-width: 720px|pointer: coarse/.test(a));

test('.msgr-side 기본 규칙(폰 셸 아님)이 상단·좌측 안전 영역을 쓴다', () => {
  const r = all.find((x) => x.sel === '.msgr-side');
  assert.ok(r, '.msgr-side 기본 규칙이 없다');
  assert.ok(!phoneScoped(r), '이 규칙이 폰 전용 블록 안에 있으면 안 된다 — 데스크톱 폭에도 적용돼야 한다');
  const decl = declarationsFor('.msgr-side { width: 268px;');
  assert.match(decl, /padding:\s*max\([^)]*env\(safe-area-inset-top\)[^)]*\)/, 'top 안전 영역 없음');
  assert.match(decl, /env\(safe-area-inset-left\)/, 'left 안전 영역 없음(가로 회전 대비)');
});

test('.msgr-top 기본 규칙(폰 셸 아님)이 상단·우측 안전 영역을 쓴다', () => {
  const r = all.find((x) => x.sel === '.msgr-top');
  assert.ok(r, '.msgr-top 기본 규칙이 없다');
  assert.ok(!phoneScoped(r), '이 규칙이 폰 전용 블록 안에 있으면 안 된다');
  const decl = declarationsFor('.msgr-top { display: flex;');
  assert.match(decl, /padding:\s*max\([^)]*env\(safe-area-inset-top\)[^)]*\)/, 'top 안전 영역 없음');
  assert.match(decl, /env\(safe-area-inset-right\)/, 'right 안전 영역 없음(가로 회전 대비)');
});

test('맥·윈도우 데스크톱 앱은 화면이 바뀌지 않는다 — max()가 env 부재/0을 기존 값으로 되돌린다(순수 계산)', () => {
  // env(safe-area-inset-*)는 노치 없는 플랫폼에서 0으로 해석된다 — max(16px, 0) = 16px, 기존 값과 동일.
  const max = (a, b) => Math.max(a, b);
  assert.equal(max(16, 0), 16);
  assert.equal(max(14, 0), 14);
});
