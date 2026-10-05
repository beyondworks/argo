// 안 읽은 수 뱃지 대비 — 다크에서 조직 전환 버튼·폰 제목 옆 뱃지 바탕(--card-2)이 주변 바탕과 같아 숫자만 떠 보이던 결함(유건 제보 2026-10-01),
// 라이트(argo·linen)에서 멘션 뱃지(--mark 노랑)가 종이 바탕과 같은 밝기라 모양이 안 보이던 것.
// 기준: 뱃지 경계(바탕 채움 또는 테두리)와 주변 바탕 3:1 이상(WCAG 1.4.11), 뱃지 안 숫자 4.5:1 이상 — 6개 테마(아르고·리넨·그래파이트 × 라이트·다크).
// 픽스처(badge-contrast.fixture.json)는 실제 화면에서 잰 자리별 조상 클래스·주변 바탕·토큰 값이다. 이 테스트는 styles.css를 읽어
// 그 자리에서 이기는 background·color·box-shadow 선언(명시도·순서)을 고르고 토큰 값으로 대비를 계산한다(단순 모형: 클래스 선택자만).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const fx = JSON.parse(readFileSync(new URL('./badge-contrast.fixture.json', import.meta.url), 'utf8')).contexts;

function rules(src) { // 중첩은 @media·@supports 한 겹까지(이 파일의 구조). top: @media 밖 규칙인지
  const out = []; let order = 0;
  const block = (s, from) => { let d = 1, j = from; while (d && j < s.length) { if (s[j] === '{') d++; else if (s[j] === '}') d--; j++; } return j; };
  const walk = (s, top) => {
    let k = 0;
    while (k < s.length) {
      const open = s.indexOf('{', k); if (open < 0) break;
      const head = s.slice(k, open).trim(); const end = block(s, open + 1);
      if (head.startsWith('@media') || head.startsWith('@supports')) walk(s.slice(open + 1, end - 1), false);
      else if (!head.startsWith('@')) out.push({ sels: head.split(',').map((x) => x.trim()), body: s.slice(open + 1, end - 1), order: order++, top });
      k = end;
    }
  };
  walk(src, true); return out;
}
const R = rules(css);
// 한 단계 선택자: 태그(선택)·클래스 여럿 — 'button', '.ic', 'button.on'. 픽스처 조상은 'tag:button' 꼴로 태그를 담는다
const compound = (s) => { const m = s.match(/^([a-z][\w-]*)?((?:\.[\w-]+)*)$/); if (!m || !s) return null; return [...(m[1] ? [`tag:${m[1]}`] : []), ...m[2].split('.').filter(Boolean)]; };
const prop = (body, name) => { const m = [...body.matchAll(new RegExp(`(?:^|;|\\s)${name}\\s*:\\s*([^;]+)`, 'g'))]; return m.length ? m[m.length - 1][1].trim() : null; };

/** chain: 바깥→안쪽 요소 클래스 목록(마지막이 뱃지). 이기는 선언 값을 돌려준다. */
function winner(chain, name) {
  let best = null;
  for (const r of R) for (const sel of r.sels) {
    const parts = sel.split(/\s+/).map(compound); if (parts.some((p) => !p)) continue;
    if (!parts[parts.length - 1].every((c) => chain[chain.length - 1].includes(c))) continue;
    let at = chain.length - 2, ok = true;
    for (let p = parts.length - 2; p >= 0 && ok; p--) { while (at >= 0 && !parts[p].every((c) => chain[at].includes(c))) at--; if (at < 0) ok = false; else at--; }
    if (!ok) continue;
    const v = prop(r.body, name); if (v == null) continue;
    const spec = parts.reduce((n, p) => n + p.length, 0);
    if (!best || spec > best.spec || (spec === best.spec && r.order > best.order)) best = { spec, order: r.order, v };
  }
  return best?.v ?? null;
}
/** 테마 고정 토큰(:root[data-theme='x'] { --name: … }) — @media 밖 선언만(고정 라이트·다크 테마는 시스템 설정을 따르지 않는다) */
function themeToken(theme, name) {
  let v = null;
  for (const r of R) if (r.top && r.sels.includes(`:root[data-theme='${theme}']`)) v = prop(r.body, name) ?? v;
  return v;
}

const L = ([r, g, b]) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const varName = (v) => v?.match(/^var\((--[\w-]+)\)$/)?.[1] ?? null;

function measure(ctx, theme) {
  const { chain, themes } = fx[ctx]; const { around, tokens } = themes[theme];
  const tok = (v, what) => { const n = varName(v); assert.ok(n && tokens[n], `${ctx}/${theme}: ${what} = ${v} — 토큰 하나(var(--x))여야 잴 수 있다`); return tokens[n]; };
  const fill = tok(winner(chain, 'background'), 'background');
  let ring = null; // box-shadow: 0 0 0 1px var(--msgr-badge-ring) — 테마가 테두리 색을 줄 때만
  const sh = winner(chain, 'box-shadow');
  if (sh && sh.includes('var(--msgr-badge-ring')) { const rv = themeToken(theme, '--msgr-badge-ring'); if (rv && rv !== 'transparent') ring = tok(rv, '--msgr-badge-ring'); }
  const edge = Math.max(ratio(fill, around), ring ? ratio(ring, around) : 0);
  const text = ctx.endsWith('tabdot') ? null : ratio(tok(winner(chain, 'color'), 'color'), fill);
  return { edge, text };
}

const THEMES = ['argo-light', 'argo-dark', 'linen-light', 'linen-dark', 'graphite-light', 'graphite-dark'];

test('픽스처가 6개 테마와 뱃지 자리를 모두 덮는다', () => {
  for (const ctx of ['desk-org', 'desk-row', 'desk-row-mark', 'desk-row-active', 'desk-row-active-mark', 'desk-bell', 'phone-title', 'phone-row', 'phone-row-mark', 'phone-row-active', 'phone-row-active-mark', 'phone-tabdot']) {
    assert.ok(fx[ctx], ctx);
    assert.deepEqual(Object.keys(fx[ctx].themes).sort(), [...THEMES].sort(), ctx);
  }
});

test('모든 뱃지 자리 × 6개 테마 — 경계 3:1 이상, 숫자 4.5:1 이상', () => {
  const bad = [];
  for (const ctx of Object.keys(fx)) for (const theme of THEMES) {
    const { edge, text } = measure(ctx, theme);
    if (edge < 3) bad.push(`${ctx}/${theme} 경계 ${edge.toFixed(2)}`);
    if (text != null && text < 4.5) bad.push(`${ctx}/${theme} 숫자 ${text.toFixed(2)}`);
  }
  assert.deepEqual(bad, []);
});

test('조직 전환 버튼·폰 제목 옆 뱃지는 목록 뱃지와 같은 잉크 알약(--fg 바탕·--bg 숫자)', () => {
  for (const ctx of ['desk-org', 'phone-title']) {
    assert.equal(winner(fx[ctx].chain, 'background'), 'var(--fg)', ctx);
    assert.equal(winner(fx[ctx].chain, 'color'), 'var(--bg)', ctx);
  }
});

// UX 판독 UXM-02(2026-10-05): 결재 슬립의 '꼭 확인' 배지가 카드에서 가장 흐렸다 — .msgr-klabel의 --fg-3 글자색이 띠 글자색을 덮고 opacity .9까지.
// 위험 배지는 띠 글자색을 그대로 쓰고(inherit) 불투명 — 대기(노란 띠 --mark)·확정(--primary 띠) 모두 6개 테마에서 4.5:1 이상.
test('결재 슬립 위험 배지 — 띠 글자색 그대로·불투명, 6개 테마 × 대기·확정 띠에서 4.5:1 이상', () => {
  const badge = ['tag:span', 'msgr-klabel', 'risk'];
  for (const state of ['pending', 'approved']) {
    const slip = [['tag:div'], ['tag:div', 'msgr-slip', state, 'high'], ['tag:div', 'band']];
    assert.equal(winner([...slip, badge], 'color'), 'inherit', `${state}: 배지 글자색은 띠를 따른다`);
    assert.ok([null, '1'].includes(winner([...slip, badge], 'opacity')), `${state}: 흐리게 하지 않는다`);
    const bg = varName(winner(slip, 'background')); const fg = varName(winner(slip, 'color'));
    for (const theme of THEMES) {
      const tk = fx['desk-org'].themes[theme].tokens;
      const r = ratio(tk[fg], tk[bg]);
      assert.ok(r >= 4.5, `${state}/${theme}: ${fg} on ${bg} = ${r.toFixed(2)}`);
    }
  }
});
