// 설정 저장본(유건 10/1 6차 확정 1) — '현재 설정 저장'으로 지금 상태(그 공간 홈 배치 + 테마·셸·커스텀 테마 + 언어 + 본문 폭)를
// 이름 붙여 계정에 보관하고, 골라서 되돌리거나 지운다. 순수 함수만 — 화면은 pages/Presets.jsx, 규칙은 test/presets.test.mjs.
// 저장 자리: 기존 배치 저장(layout.set)의 'presets:me' 한 줄(사람마다, office_user_layouts — 새 표 없음). 공간마다 space로 나눈다.
// 서버는 그 줄을 16KB(octet_length(prefs::text) <= 16384)까지 받는다 — 넘을 저장은 보내기 전에 여기서 거절한다.
import { THEMES, SHELLS } from './theme.js';
import { FONTS, COLORS, RADIUS_MAX, ALPHA_MAX } from './custom-theme.js';

export const PRESETS_KEY = 'presets:me';
export const PRESET_LIMIT = 10; // 공간마다
export const PRESET_BYTES = 16384; // 서버 검사(20260926210000_office_layouts.sql)와 같은 값
export const NAME_MAX = 40;

const obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const HEX = /^#[0-9a-f]{6}$/i;

/** 서버가 재는 크기(jsonb를 글자로 바꾼 바이트)보다 작지 않은 추정 — jsonb 글자는 ':'·',' 뒤에 빈칸이 붙는다 */
export function jsonbBytes(value) {
  const s = JSON.stringify(value);
  return new TextEncoder().encode(s).length + (s.match(/[,:]/g)?.length ?? 0);
}

/** 커스텀 테마 값 — 모르는 칸·범위 밖 값은 버린다. null = 커스텀 없음(되돌리면 지운다) */
export function cleanCustom(c) {
  if (c === null) return null;
  if (!obj(c)) return undefined;
  const mode = (m) => Object.fromEntries(COLORS.filter((k) => HEX.test(m?.[k] ?? '')).map((k) => [k, m[k]]));
  const radius = Number.isFinite(c.radius) ? Math.min(RADIUS_MAX, Math.max(0, c.radius)) : null;
  return { radius, font: c.font in FONTS ? c.font : 'pretendard', alpha: Number.isFinite(c.alpha) ? Math.min(ALPHA_MAX, Math.max(0, c.alpha)) : 0, light: mode(c.light), dark: mode(c.dark) };
}

/** 화면 설정 — 알 수 없는 값은 빼서(undefined) 되돌릴 때 그 항목은 지금 값을 그대로 둔다 */
export function cleanDisplay(d = {}) {
  return {
    theme: THEMES.includes(d.theme) ? d.theme : undefined,
    shell: SHELLS.includes(d.shell) ? d.shell : undefined,
    custom: cleanCustom(d.custom),
    lang: d.lang === 'ko' || d.lang === 'en' ? d.lang : undefined,
    width: d.width === 'full' || d.width === 'center' ? d.width : undefined,
  };
}

const cleanName = (name) => (typeof name === 'string' ? name.trim().slice(0, NAME_MAX) : '');

/** 저장된 한 줄 → 쓸 수 있는 저장본, 모양이 틀리면(옛 값·깨진 값) null */
export function readPreset(raw) {
  if (!obj(raw) || typeof raw.space !== 'string' || !raw.space || !Array.isArray(raw.home)) return null;
  const name = cleanName(raw.name);
  if (!name) return null;
  const home = raw.home.filter((it) => obj(it) && typeof it.id === 'string' && it.id);
  return { space: raw.space, name, at: typeof raw.at === 'string' ? raw.at : '', home, ...cleanDisplay(raw) };
}

/** 저장값 전체 → 쓸 수 있는 저장본 목록(모든 공간) */
export const readAll = (items) => (Array.isArray(items) ? items.map(readPreset).filter(Boolean) : []);
/** 이 공간의 저장본 — 최근 저장이 위 */
export const presetsFor = (items, space) => readAll(items).filter((p) => p.space === space).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

/** 지금 상태 → 저장본 한 줄. home은 지금 그리는 배치(숨김·사본·cfg 포함), display는 이 기기 화면 설정 */
export function capture({ space, name, home, display, at }) {
  const d = cleanDisplay(display);
  return { space, name: cleanName(name), at, home: home.map(({ hidden, ...it }) => (hidden ? { ...it, hidden: true } : it)), theme: d.theme, shell: d.shell, custom: d.custom ?? null, lang: d.lang, width: d.width };
}

/**
 * 저장본을 더한다. 같은 공간에 같은 이름이 있으면 replace일 때만 바꾼다.
 * 돌려주는 값: { items } | { exists: true } | { error: 'limit' | 'size' | 'name' }
 */
export function addPreset(items, preset, { replace = false } = {}) {
  if (!cleanName(preset.name)) return { error: 'name' };
  const all = readAll(items);
  const same = all.find((p) => p.space === preset.space && p.name === preset.name);
  if (same && !replace) return { exists: true };
  const rest = all.filter((p) => p !== same);
  if (rest.filter((p) => p.space === preset.space).length >= PRESET_LIMIT) return { error: 'limit' };
  const next = [...rest, preset];
  if (jsonbBytes({ items: next }) > PRESET_BYTES) return { error: 'size' };
  return { items: next };
}

export const removePreset = (items, space, name) => readAll(items).filter((p) => !(p.space === space && p.name === name));

/**
 * 되돌리기 — 배치를 먼저 저장하고(못 하면 아무것도 바꾸지 않는다), 그 뒤 이 기기 화면 설정을 입힌다.
 * 커스텀 테마는 테마·셸을 입힌 뒤(지금 색 위에서 글자 색을 다시 계산한다).
 * fx: { current, saveHome, applyTheme, applyShell, saveCustom(null = 지우기), refreshCustom, setLang, setWidth } — 돌려주는 값: 배치 저장 성공 여부
 */
export function applyPreset(preset, fx) {
  const same = JSON.stringify(fx.current ?? null) === JSON.stringify(preset.home);
  if (!same && fx.saveHome(preset.home) === false) return false;
  if (preset.theme) fx.applyTheme(preset.theme);
  if (preset.shell) fx.applyShell(preset.shell);
  if (preset.custom !== undefined) fx.saveCustom(preset.custom);
  else if (preset.theme || preset.shell) fx.refreshCustom(); // 커스텀 값이 없는 옛 저장본 — 지금 커스텀을 새 색 위에서 다시 계산
  if (preset.width) fx.setWidth(preset.width === 'full');
  if (preset.lang) fx.setLang(preset.lang);
  return true;
}
