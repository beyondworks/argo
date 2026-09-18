import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 공유 정본 app/globals.css — Argo 본체와 메신저(@argo/globals.css) 둘 다 쓴다.
// 마우스 효과는 입력 기기로 가른다: hover는 (hover: hover) 안, 눌림은 모든 기기(메신저 1차 #582와 같은 규칙, 2026-09-18 감사).
const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');

// 중괄호 깊이로 규칙과 감싼 at-rule 문맥을 뽑는다(주석 제거). CSSOM 최상위 순회는 @media 안을 빠뜨린다 — 파일을 직접 읽는다.
function rules(src) {
  const out = []; const ctx = []; let buf = ''; let depth = 0;
  for (const c of src.replace(/\/\*[\s\S]*?\*\//g, '')) {
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
const all = rules(css);
const parts = (sel) => sel.split(/,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean);
const inHover = (r) => r.at.some((a) => /\(hover:\s*hover\)/.test(a));
const inNoHover = (r) => r.at.some((a) => /\(hover:\s*none\)/.test(a));
const actives = new Set(all.filter((r) => !inHover(r)).flatMap((r) => parts(r.sel)).filter((p) => p.includes(':active')));
const stripNot = (s) => s.replace(/:not\([^)]*\)/g, '');

test('공용 :hover는 전부 @media (hover: hover) 안 — 터치 기기에 hover 잔상이 남지 않는다(본체·메신저 공통)', () => {
  const loose = all.filter((r) => r.sel.includes(':hover') && !inHover(r)).map((r) => r.sel);
  assert.deepEqual(loose, [], `감싸지 않은 hover: ${loose.join(' | ')}`);
});

test('(hover: hover) 안에는 hover 조각만 — 열림·선택·초점·비활성 상태가 감싸기에 딸려 터치에서 사라지지 않는다', () => {
  const dragged = all.filter(inHover).flatMap((r) => parts(r.sel).filter((p) => !p.includes(':hover')));
  assert.deepEqual(dragged, [], `hover 없이 감싸진 상태: ${dragged.join(' | ')}`);
  for (const state of ['.split-pane > .split-handle.on', '.crew-row .crew-pin.pinned', '.msg-actions:focus-within', '.vault-tree .row.active .when', '.vault-toolbar .tb.on', '.vault-tab.active .vault-tab-x', '.rulerow:focus-within .ruletools']) {
    assert.ok(all.some((r) => !inHover(r) && parts(r.sel).includes(state)), `${state}가 감싸기 밖에 없다`);
  }
});

test('마우스 hover가 주던 반응은 모든 기기에서 눌림(:active)으로도 난다 — 이미 눌림이 있는 요소는 그 규칙과 합친다', () => {
  const subject = all.filter(inHover).flatMap((r) => parts(r.sel)).filter((p) => /:hover[^\s>+~]*$/.test(p));
  // 짝이 정확히 있거나, :not()을 뺀 같은 요소에 테마 전용 눌림이 이미 있으면 통과(clay·porcelain의 안쪽 그림자 눌림을 덮지 않는다)
  // 조상 hover까지 함께 바꾼다 — 자식을 누르는 동안 조상도 :active다
  const missing = subject.filter((p) => { const a = p.replaceAll(':hover', ':active'); return !actives.has(a) && !actives.has(stripNot(a)); });
  assert.deepEqual(missing, [], `:active 짝이 없는 hover: ${missing.join(' | ')}`);
  const btnActive = all.filter((r) => !inHover(r) && parts(r.sel).includes('.btn:active'));
  assert.equal(btnActive.length, 1, '.btn:active는 한 규칙(hover 배경을 기존 축소와 합친다 — 두 번 정의하지 않는다)');
});

test('hover가 없는 기기에서도 조상 hover로만 드러나던 조작 8개에 닿는다', () => {
  const none = new Set(all.filter(inNoHover).flatMap((r) => parts(r.sel)));
  for (const s of ['.side-group-row .tm-edit', '.rail-item .rail-actions', '.crew-row .crew-pin', '.crew-row .crew-side', '.vault-tree .row-wrap .row-side', '.msg-actions', '.rulerow .ruletools', '.vault-tab-x']) {
    assert.ok(none.has(s), `${s} — 터치 기기에서 드러날 길이 없다`);
  }
});
