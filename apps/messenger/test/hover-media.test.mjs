import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 눌림·마우스 효과의 기준은 화면 크기가 아니라 입력 기기다(2026-09-18 감사).
// 폰 블록은 폭(max-width: 720px)으로 갈리는데 hover 잔상·눌림 반응은 포인터 종류로 갈린다 — 그 어긋남 때문에
// 1920×1080 터치 노트북은 폰 블록에도 못 들어가고 hover 잔상만 남았다. 공용 hover는 전부 (hover: hover) 안에 둔다.
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

// 중괄호 깊이로 규칙과 그 규칙을 감싼 at-rule 문맥을 뽑는다(주석 제거). CSSOM 최상위 순회는 @media 안을 빠뜨린다 — 파일을 직접 읽는다.
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
const all = rules(css);
const parts = (sel) => sel.split(/,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean);
const phoneScoped = (r) => /\.msgr-phone/.test(r.sel.replace(/:not\([^)]*\)/g, '')) || r.at.some((a) => /max-width: 720px|pointer: coarse/.test(a));
const inHoverMedia = (r) => r.at.some((a) => /\(hover:\s*hover\)/.test(a));

test('폰 블록 밖의 :hover는 전부 @media (hover: hover) 안에 있다 — 터치 기기에 hover 잔상이 남지 않는다', () => {
  const loose = all.filter((r) => r.sel.includes(':hover') && !phoneScoped(r) && !inHoverMedia(r)).map((r) => r.sel);
  assert.deepEqual(loose, [], `감싸지 않은 hover: ${loose.join(' | ')}`);
});

test('(hover: hover) 안에는 hover 조각만 있다 — 열림·선택·초점·비활성 상태가 감싸기에 같이 딸려 들어가 터치에서 사라지지 않는다', () => {
  const dragged = all.filter(inHoverMedia).flatMap((r) => parts(r.sel).filter((p) => !p.includes(':hover')));
  assert.deepEqual(dragged, [], `hover 없이 감싸진 상태: ${dragged.join(' | ')}`);
  // 쪼개 둔 상태들이 감싸기 밖에 실제로 남아 있다
  for (const state of ['.msgr-org.open', '.msgr-menu-pop button.on', '.msgr-foot .btn.ghost.on', '.msgr-row:focus-within .msgr-acts', '.msgr-pop button.on', '.msgr-railrow.open .more', '.msgr-railrow .dispatch:disabled', '.msgr-sortbtn.on']) {
    assert.ok(all.some((r) => !inHoverMedia(r) && parts(r.sel).includes(state)), `${state}가 감싸기 밖에 없다`);
  }
});

test('마우스 hover가 주던 반응은 모든 기기에서 :active로도 난다 — 터치 노트북의 눌림 반응', () => {
  const hovers = all.filter((r) => inHoverMedia(r)).flatMap((r) => parts(r.sel));
  const subject = hovers.filter((p) => /:hover[^\s>+~]*$/.test(p)); // 조상 hover로 자손을 드러내는 규칙은 눌림 짝이 필요 없다
  const actives = new Set(all.filter((r) => !inHoverMedia(r)).flatMap((r) => parts(r.sel)));
  const missing = subject.filter((p) => !actives.has(p.replace(':hover', ':active')));
  assert.deepEqual(missing, [], `:active 짝이 없는 hover: ${missing.join(' | ')}`);
});

test('hover가 없는 넓은 화면에서도 레일 행 메뉴(…)와 파견 버튼에 닿을 수 있다', () => {
  const none = all.filter((r) => r.at.some((a) => /\(hover:\s*none\)/.test(a))).flatMap((r) => parts(r.sel));
  assert.ok(none.includes('.msgr-shell:not(.msgr-phone) .msgr-railrow .more'), '터치 데스크톱에서 … 가 드러나지 않는다');
  assert.ok(none.includes('.msgr-shell:not(.msgr-phone) .msgr-railrow .dispatch'), '터치 데스크톱에서 파견 버튼이 드러나지 않는다');
});
