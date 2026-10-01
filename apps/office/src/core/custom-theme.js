// 커스텀 테마(유건 9/30) — 고른 셸·색상 위에 둥글기·글꼴·투명도(모드 공통)와 배경·사이드바·카드·강조·배지 색(라이트·다크 따로)을 덮어쓴다.
// 글자 색은 고르지 않는다: 바꾼 바탕 위 글자가 대비 4.5:1 이상이 되게 여기서 정한다. 저장은 기기별(localStorage).
// 설정 화면과 함께 지연 로드된다. 첫 페인트·모드 전환은 index.html의 window.__argoCustom이 계산해 둔 값(CSS_KEY)만 입힌다.
export const KEY = 'argo-office-custom', CSS_KEY = 'argo-office-custom-css';
export const FONTS = {
  pretendard: null, // 셸·색상의 기본 글꼴 그대로
  system: "-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Malgun Gothic', 'Segoe UI', sans-serif",
  serif: "'AppleMyungjo', 'Nanum Myeongjo', 'Noto Serif KR', 'Batang', serif",
  mono: "ui-monospace, 'SF Mono', Menlo, 'D2Coding', monospace",
};
export const COLORS = ['bg', 'side', 'card', 'accent', 'badge'];
export const RADIUS_MAX = 24, ALPHA_MAX = 40;
export const EMPTY = { radius: null, font: 'pretendard', alpha: 0, light: {}, dark: {} };

const DARK_INK = [22, 22, 22], LIGHT_INK = [243, 242, 239];

/* ── 색 계산(순수) ── */
export const hex = (s) => { const m = /^#?([0-9a-f]{6})$/i.exec(s ?? ''); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null; };
export const toHex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const rgba = (c, a) => `rgba(${c.map(Math.round).join(', ')}, ${+a.toFixed(3)})`;
/** 두 색 섞기 — w는 a의 비율 */
export const mix = (a, b, w) => a.map((v, i) => v * w + b[i] * (1 - w));
const lum = (c) => c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const worst = (ink, surfaces) => Math.min(...surfaces.map((s) => contrast(ink, s)));
/** 여러 바탕 위에서 가장 읽히는 글자 색 — 지금 테마 글자 색이 되면 그대로(모양 유지), 아니면 검정·흰색 계열 중 나은 쪽 */
export function inkFor(surfaces, current) {
  if (current && worst(current, surfaces) >= 4.5) return current;
  return worst(DARK_INK, surfaces) >= worst(LIGHT_INK, surfaces) ? DARK_INK : LIGHT_INK;
}
/** 흐린 글자(보조·설명) — 바탕 쪽으로 w만큼 흐리게, 단 모든 바탕에서 4.5:1 밑으로는 내려가지 않는다 */
function soft(ink, surfaces, w) {
  const base = surfaces[0];
  for (let x = w; x < 1; x += 0.02) { const c = mix(ink, base, x); if (worst(c, surfaces) >= 4.5) return c; }
  return ink;
}

/**
 * 한 모드의 덮어쓸 CSS 변수. c: 저장값, m: 그 모드 색({bg, side, ...} 16진수), base: 셸·색상이 정한 지금 색(rgb 배열들).
 * 돌려주는 값: vars({ '--bg': '#…' }), flags(themes.css가 읽는 data-custom 낱말), warn(글자를 4.5:1로 맞출 수 없음).
 */
export function buildVars(c, m, base) {
  const v = {}, flags = [];
  const a = Math.min(ALPHA_MAX, Math.max(0, c.alpha || 0)) / 100;
  const bg = hex(m.bg) ?? base.bg, card = hex(m.card) ?? base.card;
  const side = hex(m.side) ?? base.side, accent = hex(m.accent), badge = hex(m.badge);
  // 투명도 — 카드·사이드바가 바탕을 a만큼 비친다. 글자 대비는 비친 뒤의 색으로 잰다
  const cardSeen = mix(card, bg, 1 - a), sideSeen = mix(side, bg, 1 - a);
  const surface = hex(m.card) || hex(m.bg) ? mix(cardSeen, bg, 0.85) : base.surface; // base.css --surface(카드 85%)
  if (hex(m.bg)) {
    v['--bg'] = toHex(bg);
    v['--frame'] = toHex(mix(bg, inkFor([bg]), 0.9));
    v['--secondary'] = toHex(mix(bg, inkFor([bg]), 0.92));
  }
  // 카드 위 표면(--surface·--lift·--field·--float)과 본문 판은 base.css·themes.css가 --card에서 섞어 만든다(유건 9/30 흰색 줄이기) — 여기서는 --card만
  if (hex(m.card) || a) v['--card'] = a ? rgba(card, 1 - a) : toHex(card);
  const surfaces = [bg, cardSeen, surface];
  if (hex(m.bg) || hex(m.card) || a) {
    const ink = inkFor(surfaces, base.fg);
    v['--fg'] = toHex(ink); v['--fg-2'] = toHex(soft(ink, surfaces, 0.78)); v['--fg-3'] = toHex(soft(ink, surfaces, 0.62));
    v['--ink-rgb'] = ink.map(Math.round).join(', ');
    v['--border'] = rgba(ink, 0.16); v['--border-soft'] = rgba(ink, 0.09);
    if (worst(ink, surfaces) < 4.5) flags.push('warn');
  }
  const sideInk = inkFor([sideSeen], hex(m.side) || a ? null : base.sideFg);
  if (hex(m.side) || a) {
    v['--side-bg'] = a ? rgba(side, 1 - a) : toHex(side);
    v['--side-fg'] = toHex(sideInk); v['--side-fg-2'] = toHex(soft(sideInk, [sideSeen], 0.78)); v['--side-fg-3'] = toHex(soft(sideInk, [sideSeen], 0.62));
    v['--side-line'] = rgba(sideInk, 0.14); v['--side-hover'] = rgba(sideInk, 0.07); v['--side-active'] = rgba(sideInk, 0.12);
    if (hex(m.side)) flags.push('side'); // 사이드바가 창 바탕에 녹는 셸에서도 고른 색을 칠한다
  }
  if (accent) { // 선택·호버 — 선택된 메뉴 바탕이 강조색, 그 위 글자는 자동
    v['--side-active'] = toHex(accent);
    v['--c-active-fg'] = toHex(inkFor([accent]));
    const fg = hex(v['--side-fg']) ?? base.sideFg;
    let h = 0.3; while (h > 0.08 && contrast(fg, mix(accent, sideSeen, h)) < 4.5) h -= 0.02;
    v['--side-hover'] = rgba(accent, h);
    v['--primary-soft'] = rgba(accent, 0.16);
    flags.push('accent');
  }
  if (badge) { v['--mark'] = v['--side-mark'] = toHex(badge); v['--mark-fg'] = toHex(inkFor([badge])); }
  if (c.radius != null) {
    const r = Math.min(RADIUS_MAX, Math.max(0, c.radius)), px = (k) => `${Math.round(r * k)}px`;
    Object.assign(v, {
      '--rs': px(1), '--r-lg': px(1), '--t-main-r': px(1), '--t-win-r': px(1.25), '--r': px(0.75),
      '--rc': px(0.5), '--t-nav-r': px(0.5), '--t-btn-r': px(0.5), '--t-icon-r': px(0.5), '--t-chip-r': px(0.5), '--r-sm': px(0.45),
      '--t-input-r': px(0.55), '--t-seg-r': px(0.55),
    });
  }
  if (FONTS[c.font]) v['--font'] = FONTS[c.font];
  return { vars: v, flags: flags.join(' ') };
}

/* ── 저장·적용(브라우저) ── */
export function readCustom() {
  try { const c = JSON.parse(localStorage.getItem(KEY) || 'null'); return c ? { ...EMPTY, ...c, light: c.light ?? {}, dark: c.dark ?? {} } : { ...EMPTY }; } catch { return { ...EMPTY }; }
}
export const isEmpty = (c) => c.radius == null && !FONTS[c.font] && !c.alpha && ['light', 'dark'].every((k) => !COLORS.some((x) => c[k][x]));

/** 지금 셸·색상이 정한 색을 읽는다 — 덮어쓴 값을 걷고, 원하는 모드로 잠깐 바꿔 그려 보고 되돌린다(같은 작업 안이라 화면에는 안 보인다) */
function probe(theme) {
  const el = document.documentElement, keep = { th: el.dataset.theme, emul: el.classList.contains('dark-emul') };
  el.dataset.theme = theme; el.classList.remove('dark-emul');
  const d = document.createElement('div'); d.style.cssText = 'position:absolute;visibility:hidden'; document.body.append(d);
  const read = (tok, prop = 'backgroundColor') => { d.style.background = ''; d.style.color = ''; d.style[prop === 'color' ? 'color' : 'background'] = `var(${tok})`; return parse(getComputedStyle(d)[prop]); };
  const out = { bg: read('--bg'), card: read('--card'), side: read('--side-bg'), surface: read('--float'), /* --surface는 반투명 — 캔버스 위에 보이는 색은 불투명한 --float에 가깝다(다크는 --float가 조금 더 밝다) */ fg: read('--fg', 'color'), sideFg: read('--side-fg', 'color') };
  d.remove(); el.dataset.theme = keep.th; el.classList.toggle('dark-emul', keep.emul);
  return out;
}
function parse(s) {
  const n = (s.match(/[\d.]+/g) || []).map(Number);
  if (s.startsWith('color(')) return n.slice(0, 3).map((x) => x * 255);
  return n.slice(0, 3);
}

/** 저장하고, 두 모드의 변수를 계산해 두고, 지금 화면에 입힌다 */
export function saveCustom(c) {
  const el = document.documentElement;
  for (const k of el.__cv ?? []) el.style.removeProperty(k);
  el.__cv = []; delete el.dataset.custom;
  try {
    if (isEmpty(c)) { localStorage.removeItem(KEY); localStorage.removeItem(CSS_KEY); }
    else {
      const fam = el.dataset.theme.replace(/-(light|dark)$/, '');
      const css = {};
      for (const mode of ['light', 'dark']) { const r = buildVars(c, c[mode], probe(`${fam}-${mode}`)); css[mode] = { ...r.vars, '@flags': r.flags }; }
      localStorage.setItem(KEY, JSON.stringify(c)); localStorage.setItem(CSS_KEY, JSON.stringify(css));
    }
  } catch { /* 사생활 보호 모드 — 이번 화면만 */ }
  globalThis.__argoCustom?.();
}
/** 저장된 값으로 다시 계산 — 색상 가족을 바꾸면 바탕 색이 달라지므로 */
export const refreshCustom = () => { const c = readCustom(); if (!isEmpty(c)) saveCustom(c); };
