// rc-0195 회귀(T3 발견): 본체 폰 폭 사이드바 서랍(UX-A04, 629e6eb2)이 공용 app/globals.css의 `.side`에 걸려,
// 같은 파일을 그대로 가져오는 메신저 레일(class="side msgr-side")까지 화면 밖(translateX(-105%))·visibility:hidden이 됐다.
// 폰 홈은 탭 내용이 통째로 사라졌고(픽스처 dminvite 390폭 본문 글자 3자), 폰 레일·900px 아래 데스크톱 창 레일도 같은 규칙을 받았다.
//
// 소스 문자열 단언 대신 두 CSS 파일(메신저가 불러오는 순서: globals.css → styles.css)을 실제로 적용해 계산한다 —
// 매체 조건(폭·높이·hover·pointer)을 판정하고, 선택자를 요소·조상에 맞춰 보고, 명시도·순서·!important로 이긴 값을 고른다.
// 조상 조합은 "어느 조상이든 맞으면" 근사다(.side 쪽 규칙에는 충분하다). 실제 렌더러 확인은 PR 본문의 스크린샷·getComputedStyle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const globals = readFileSync(new URL('../../../app/globals.css', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

// ── 규칙 목록 ──────────────────────────────────────────────────────────
function cssRules(text, base = 0) {
  const out = []; const ctx = []; let depth = 0; let buf = '';
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{') {
      const head = buf.trim().replace(/\s+/g, ' '); buf = '';
      if (head.startsWith('@')) { ctx.push({ head, depth }); depth++; continue; }
      let d = 1; let j = i + 1; while (d > 0 && j < src.length) { if (src[j] === '{') d++; else if (src[j] === '}') d--; j++; }
      out.push({ sel: head, body: src.slice(i + 1, j - 1), at: ctx.map((x) => x.head), order: base + out.length }); i = j - 1;
    } else if (c === '}') { depth--; while (ctx.length && ctx.at(-1).depth >= depth) ctx.pop(); buf = ''; }
    else if (c === ';' && !buf.includes('{')) buf = ''; // @import·@charset 같은 문장형 at-rule
    else buf += c;
  }
  return out;
}

// 괄호 밖의 구분자로 자른다(선택자 목록·선언 목록·매체 목록)
function splitTop(s, sep) {
  const out = []; let d = 0; let q = null; let cur = '';
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '(' || c === '[') d++; else if (c === ')' || c === ']') d--;
    if (c === sep && d === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out.map((x) => x.trim()).filter(Boolean);
}

// ── 매체 조건 ──────────────────────────────────────────────────────────
function mediaFeature(f, env) {
  const m = f.match(/^\(\s*([a-z-]+)\s*(?::\s*([^)]+))?\)$/); if (!m) return false;
  const [, name, raw] = m; const v = raw?.trim(); const px = v ? parseFloat(v) : NaN;
  switch (name) {
    case 'max-width': return env.width <= px;
    case 'min-width': return env.width >= px;
    case 'max-height': return env.height <= px;
    case 'min-height': return env.height >= px;
    case 'hover': case 'any-hover': return v ? v === env.hover : env.hover !== 'none';
    case 'pointer': case 'any-pointer': return v ? v === env.pointer : env.pointer !== 'none';
    case 'prefers-reduced-motion': case 'prefers-reduced-transparency': return v === 'no-preference';
    case 'prefers-color-scheme': return v === 'light';
    default: return false;
  }
}
function atApplies(head, env) {
  if (head.startsWith('@supports')) return true;
  if (!head.startsWith('@media')) return false; // @container·@keyframes·@font-face — .side와 무관, 계산에서 뺀다
  return splitTop(head.slice(6), ',').some((q) => {
    let s = q.replace(/^only\s+/, ''); let neg = false;
    if (s.startsWith('not ')) { neg = true; s = s.slice(4); }
    const ok = s.split(/\s+and\s+/).every((p) => (p === 'screen' || p === 'all') ? true : p === 'print' ? false : mediaFeature(p, env));
    return neg ? !ok : ok;
  });
}

// ── 선택자 ─────────────────────────────────────────────────────────────
// 복합 선택자 → 단순 선택자 토큰들
function compoundTokens(c) {
  const out = []; let i = 0;
  const ident = () => { const m = c.slice(i).match(/^-?[_a-zA-Z0-9\\-]+/); i += m ? m[0].length : 0; return m ? m[0] : ''; };
  const paren = () => { let d = 0; const s = i; for (; i < c.length; i++) { if (c[i] === '(') d++; else if (c[i] === ')') { d--; if (d === 0) { i++; break; } } } return c.slice(s + 1, i - 1); };
  while (i < c.length) {
    const ch = c[i];
    if (ch === '.') { i++; out.push({ t: 'class', v: ident() }); }
    else if (ch === '#') { i++; out.push({ t: 'id', v: ident() }); }
    else if (ch === '*') { i++; }
    else if (ch === '[') { const e = c.indexOf(']', i); out.push({ t: 'attr', v: c.slice(i + 1, e) }); i = e + 1; }
    else if (c.startsWith('::', i)) { i += 2; ident(); if (c[i] === '(') paren(); out.push({ t: 'pseudo-el' }); }
    else if (ch === ':') { i++; const name = ident(); const arg = c[i] === '(' ? paren() : null; out.push({ t: 'pseudo', v: name, arg }); }
    else if (/[a-zA-Z]/.test(ch)) out.push({ t: 'tag', v: ident() });
    else i++;
  }
  return out;
}
// 복합 선택자 → 결합자로 나눈 복합 선택자 목록(마지막이 대상)
function compounds(sel) {
  return splitTop(sel.replace(/\s*([>+~])\s*/g, ' '), ' ');
}
function attrMatch(expr, el) {
  const m = expr.match(/^\s*([\w-]+)\s*(?:([~|^$*]?=)\s*['"]?([^'"]*)['"]?)?\s*$/); if (!m) return false;
  const val = el.attrs?.[m[1]]; if (val == null) return false; if (!m[2]) return true;
  if (m[2] === '=') return val === m[3];
  if (m[2] === '~=') return val.split(/\s+/).includes(m[3]);
  if (m[2] === '^=') return val.startsWith(m[3]);
  if (m[2] === '$=') return val.endsWith(m[3]);
  if (m[2] === '*=') return val.includes(m[3]);
  return false;
}
function matchCompound(c, el, anc) {
  return compoundTokens(c).every((k) => {
    if (k.t === 'class') return el.classes.has(k.v);
    if (k.t === 'id') return el.id === k.v;
    if (k.t === 'tag') return el.tag === k.v;
    if (k.t === 'attr') return attrMatch(k.v, el);
    if (k.t === 'pseudo-el') return false; // ::before 등은 다른 상자
    if (k.v === 'root') return el.tag === 'html';
    if (k.v === 'not') return !splitTop(k.arg, ',').some((s) => matchComplex(s, el, anc));
    if (k.v === 'is' || k.v === 'where' || k.v === 'matches') return splitTop(k.arg, ',').some((s) => matchComplex(s, el, anc));
    return false; // :hover·:focus-visible·:has 등 — 정지 상태 계산에선 안 맞는 것으로 본다
  });
}
function matchComplex(sel, el, anc) {
  const cs = compounds(sel); const subject = cs.pop();
  if (!matchCompound(subject, el, anc)) return false;
  return cs.every((c) => anc.some((a, i) => matchCompound(c, a, anc.slice(0, i))));
}
function specificity(sel) {
  const s = [0, 0, 0];
  for (const c of compounds(sel)) for (const k of compoundTokens(c)) {
    if (k.t === 'id') s[0]++;
    else if (k.t === 'class' || k.t === 'attr') s[1]++;
    else if (k.t === 'tag' || k.t === 'pseudo-el') s[2]++;
    else if (k.t === 'pseudo') {
      if (k.v === 'where') continue;
      if (k.v === 'not' || k.v === 'is' || k.v === 'matches' || k.v === 'has') {
        const best = splitTop(k.arg, ',').map(specificity).sort(cmpSpec).at(-1) || [0, 0, 0];
        s[0] += best[0]; s[1] += best[1]; s[2] += best[2];
      } else s[1]++;
    }
  }
  return s;
}
function cmpSpec(a, b) { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; }

// ── 계산 ──────────────────────────────────────────────────────────────
// 요소(el)에 이기는 선언 — { prop: { value, sel } }
function computed(rules, env, el, anc) {
  const win = {};
  for (const r of rules) {
    if (!r.at.every((h) => atApplies(h, env))) continue;
    const matched = splitTop(r.sel, ',').filter((s) => matchComplex(s, el, anc));
    if (!matched.length) continue;
    const spec = matched.map(specificity).sort(cmpSpec).at(-1);
    for (const d of splitTop(r.body, ';')) {
      const k = d.indexOf(':'); if (k < 0) continue;
      const prop = d.slice(0, k).trim(); let value = d.slice(k + 1).trim();
      const important = /!important\s*$/.test(value); value = value.replace(/\s*!important\s*$/, '');
      const cand = { value, important, spec, order: r.order, sel: r.sel };
      const cur = win[prop];
      if (!cur || (important !== cur.important ? important : (cmpSpec(spec, cur.spec) || r.order - cur.order) > 0)) win[prop] = cand;
    }
  }
  return win;
}
const v = (w, p) => w[p]?.value;
const node = (tag, cls = '', extra = {}) => ({ tag, classes: new Set(cls.split(/\s+/).filter(Boolean)), ...extra });

const messengerRules = [...cssRules(globals), ...cssRules(styles, 1e6)]; // 메신저: globals.css 다음 styles.css(main.jsx 순서)
const bodyRules = cssRules(globals);
const PHONE = { width: 390, height: 844, hover: 'none', pointer: 'coarse' };
const NARROW_DESKTOP = { width: 880, height: 800, hover: 'hover', pointer: 'fine' };
const WIDE = { width: 1280, height: 800, hover: 'hover', pointer: 'fine' };

const msgrAnc = (shell, theme = 'linen') => [node('html', '', { attrs: { 'data-theme': theme } }), node('body', 'argo-messenger'), node('div', `shell msgr-shell ${shell}`)];
const msgrSide = node('aside', 'side msgr-side', { id: 'msgr-navigation' });
const bodyAnc = [node('html', '', { attrs: { 'data-theme': 'graphite' } }), node('body'), node('div', 'shell')];
const bodySide = (open) => node('aside', `side${open ? ' open' : ''}`, { id: 'argo-side' });

const notDrawer = (w, where) => {
  assert.ok(!/translateX/.test(v(w, 'transform') || ''), `${where}: 서랍 transform이 메신저 레일에 왔다 — ${v(w, 'transform')} (${w.transform?.sel})`);
  assert.notEqual(v(w, 'visibility'), 'hidden', `${where}: 메신저 레일이 visibility:hidden (${w.visibility?.sel})`);
};

test('메신저 폰 홈(390): 레일이 전체 화면 탭 페이지로 보인다 — 본체 서랍 규칙을 받지 않는다', () => {
  const w = computed(messengerRules, PHONE, msgrSide, msgrAnc('msgr-phone phone-home phone-root'));
  notDrawer(w, '폰 홈');
  assert.equal(v(w, 'display'), 'flex');
  assert.equal(v(w, 'position'), 'relative', '폰 홈 레일은 styles.css의 position: relative');
  assert.equal(v(w, 'width'), '100%');
});

test('메신저 폰 레일 열림(390, 대화 화면): 메신저 자기 서랍(fixed)으로 열리고 숨지 않는다', () => {
  const w = computed(messengerRules, PHONE, msgrSide, msgrAnc('msgr-phone phone-chat rail-open'));
  notDrawer(w, '폰 레일');
  assert.equal(v(w, 'display'), 'flex');
  assert.equal(v(w, 'position'), 'fixed');
});

test('메신저 900px 아래 데스크톱 창(880): 레일이 종전처럼 제자리(static)에 보인다', () => {
  const w = computed(messengerRules, NARROW_DESKTOP, msgrSide, msgrAnc(''));
  notDrawer(w, '880 데스크톱');
  assert.equal(v(w, 'position'), 'static');
  assert.equal(v(w, 'height'), 'auto');
});

test('메신저 넓은 창(1280): 레일은 sticky 그대로', () => {
  const w = computed(messengerRules, WIDE, msgrSide, msgrAnc(''));
  notDrawer(w, '1280');
  assert.equal(v(w, 'position'), 'sticky');
});

test('본체 폰 폭(390): 사이드바는 닫힌 서랍(화면 밖·숨김), .open이면 들어오고 보인다 — UX-A04 유지', () => {
  const shut = computed(bodyRules, PHONE, bodySide(false), bodyAnc);
  assert.equal(v(shut, 'position'), 'fixed');
  assert.equal(v(shut, 'transform'), 'translateX(-105%)');
  assert.equal(v(shut, 'visibility'), 'hidden');
  const open = computed(bodyRules, PHONE, bodySide(true), bodyAnc);
  assert.equal(v(open, 'position'), 'fixed');
  assert.equal(v(open, 'transform'), 'none');
  assert.equal(v(open, 'visibility'), 'visible');
});

test('본체 폰 폭 서랍에서도 테마별 .side 배경이 이긴다 — 범위를 좁힌 뒤에도 종전과 같다', () => {
  const w = computed(bodyRules, PHONE, bodySide(false), bodyAnc);
  assert.equal(v(w, 'background'), '#f0f0f0', `graphite 사이드바 배경 — 받은 값 ${v(w, 'background')} (${w.background?.sel})`);
});

test('본체 넓은 창(1280): 고정 사이드바(sticky) 그대로, 서랍 아님', () => {
  const w = computed(bodyRules, WIDE, bodySide(false), bodyAnc);
  assert.equal(v(w, 'position'), 'sticky');
  assert.equal(v(w, 'transform'), undefined);
  assert.equal(v(w, 'visibility'), undefined);
});
