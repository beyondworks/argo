// 유건 제보(2026-10-22): 개인 공간 데스크톱 레일의 '친구' 구역 — 화살표가 보이는데 눌러도 접히지 않았다(forceOpen이 늘 켜져 있었다).
// 판정·저장은 src/rail-fold.mjs(이 시험이 행동으로 잠근다), 화면은 픽스처(test/v2-shell.fixture.html?space=personal)에서 390·1280으로 봤다(PR 본문).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FOLD_KEY, readFold, initialOpen, foldToggle, railForceOpen } from '../src/rail-fold.mjs';

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m }; };

test('데스크톱 친구 구역: 접고 → 새로고침 뒤에도 접힘 → 다시 펼침이 저장된다', () => {
  const st = mem(); const force = railForceOpen('friends', { phone: false, dmTab: false });
  assert.equal(force, false, '데스크톱은 늘 펼침이 아니다');
  assert.equal(initialOpen('friends', st), true, '처음엔 펼침');
  assert.deepEqual(foldToggle({ id: 'friends', forceOpen: force, nextOpen: false, storage: st }), { open: false, revert: false });
  assert.equal(initialOpen('friends', st), false, '새로고침(다시 읽기) 뒤에도 접힘');
  assert.deepEqual(readFold(st), { friends: true });
  assert.deepEqual(foldToggle({ id: 'friends', forceOpen: force, nextOpen: true, storage: st }), { open: true, revert: false });
  assert.equal(initialOpen('friends', st), true, '다시 펼침도 유지');
});

test('폰 친구 홈: 늘 펼침 — 접기 사건은 되돌리고 저장하지 않는다(저장된 접힘이 있어도 펼침)', () => {
  const st = mem(); st.setItem(FOLD_KEY, JSON.stringify({ friends: true }));
  const force = railForceOpen('friends', { phone: true, dmTab: false });
  assert.equal(force, true);
  assert.deepEqual(foldToggle({ id: 'friends', forceOpen: force, nextOpen: false, storage: st }), { open: true, revert: true });
  assert.equal(st.map.get(FOLD_KEY), JSON.stringify({ friends: true }), '저장 그대로(데스크톱 접힘을 지우지 않는다)');
});

test('다른 늘 펼침 구역은 종전 그대로: 폰 DM 탭의 채팅, 고정 DM — 그 밖의 구역은 접힌다', () => {
  assert.equal(railForceOpen('dms', { phone: true, dmTab: true }), true);
  assert.equal(railForceOpen('dms', { phone: true, dmTab: false }), false, '폰 홈의 채팅 구역은 접힌다');
  assert.equal(railForceOpen('dms', { phone: false, dmTab: false }), false);
  assert.equal(railForceOpen('dmpin', { phone: false }), true);
  for (const id of ['fav', 'channels', 'people', 'mine', 'start']) assert.equal(railForceOpen(id, { phone: false }), false, id);
  const st = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(initialOpen('friends', st), true, '저장소를 못 읽으면 펼침');
  assert.deepEqual(foldToggle({ id: 'friends', nextOpen: false, storage: st }), { open: false, revert: false }, '저장 못 해도 이번엔 접힌다');
});

test('배선: 세 늘 펼침 구역이 railForceOpen을 쓰고, 늘 펼침이면 화살표를 숨긴다(locked)', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  for (const id of ['friends', 'dms', 'dmpin']) assert.match(app, new RegExp(`<RailSection id="${id}"[^\\n]*forceOpen=\\{railForceOpen\\('${id}', \\{ phone: isPhone, dmTab \\}\\)\\}`), id);
  assert.doesNotMatch(app, /<RailSection [^\n]*forceOpen(?=[ >])(?!=)/, '맨 forceOpen(늘 켬)이 남아 있지 않다');
  assert.match(app, /const r = foldToggle\(\{ id, forceOpen, nextOpen: e\.currentTarget\.open, storage: foldStore\(\) \}\); if \(r\.revert\) \{ e\.currentTarget\.open = true; return; \} setOpen\(r\.open\);/);
  assert.match(app, /<details className=\{`msgr-sec\$\{forceOpen \? ' locked' : ''\}`\}/);
  assert.match(css, /\.msgr-sec\.locked > summary \.lbl::before \{ display: none; \}/);
});
