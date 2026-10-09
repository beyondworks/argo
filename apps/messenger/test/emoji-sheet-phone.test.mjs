// 폰 반응 시트(이모지 격자) — 칸 최소 폭이 단추 최소 폭(44px 누름 크기)보다 좁으면 390 폭에서 칸 42.5px 안에 단추 44px가 들어가 칸마다 1.5px씩 넘친다(H73).
// 실제 레이아웃 측정(scrollWidth·칸 밖으로 나간 양·누름 크기)은 emoji-sheet-phone.browser.mjs가 하고(실행법은 그 파일 머리), 여기서는 CI에서 도는 두 가지를 잠근다:
// ① CSS 불변식 — 폰 격자의 칸 최소 폭 ≥ 44px 목록에 든 단추 최소 폭. 칸이 단추보다 넓으니 폭이 몇이든 넘치지 않고, 단추를 줄이지 않으니 누름 크기도 44px 그대로다.
// ② 판정 함수 — 측정값 판정(verifyEmojiSheet)이 넘침과 44px 미만을 실제로 잡는지(줄여서 넘침만 없애는 `min-width: 0` 수정은 누름 폭이 42.5px가 돼 빨강).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyEmojiSheet, TOUCH } from './emoji-sheet-phone.browser.mjs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const bodyOf = (selector) => { // 한 줄 규칙 `selector { … }`의 본문(공백 정규화). 같은 선택자가 여럿이면 마지막(캐스케이드에서 이기는 쪽)
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const all = [...css.matchAll(new RegExp(`(?:^|[\\n}])\\s*${esc}\\s*\\{([^}]*)\\}`, 'g'))];
  assert.ok(all.length, `규칙을 찾지 못함: ${selector}`);
  return all.at(-1)[1].replace(/\s+/g, ' ').trim();
};
const decl = (body, prop) => body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`))?.[1].trim();

test('폰 격자 칸 최소 폭 ≥ 단추 최소 폭(44px 누름 크기) — 칸 안에 단추가 항상 들어간다', () => {
  const track = decl(bodyOf('.msgr-emojipop.phone .grid'), 'grid-template-columns');
  const m = track?.match(/^repeat\(auto-fill, minmax\((\d+(?:\.\d+)?)px, 1fr\)\)$/);
  assert.ok(m, `폰 격자는 repeat(auto-fill, minmax(Npx, 1fr)): ${track}`);
  const trackMin = Number(m[1]);
  const touch = css.match(/\.argo-messenger :is\(([^)]*\.msgr-emojipop \.grid button[^)]*)\) \{ min-width: (\d+)px; min-height: (\d+)px;/);
  assert.ok(touch, '44px 누름 크기 목록에 .msgr-emojipop .grid button이 있다 — 단추를 줄여서 넘침을 없애지 않는다');
  const btnMin = Number(touch[2]);
  assert.equal(btnMin, TOUCH, `누름 크기 ${TOUCH}px`);
  assert.equal(Number(touch[3]), TOUCH);
  assert.ok(trackMin >= btnMin, `칸 최소 ${trackMin}px < 단추 최소 ${btnMin}px — 폭에 따라 칸이 단추보다 좁아져 넘친다(390 폭: 칸 42.5px 안에 단추 44px)`);
  // 폭마다 확인 — auto-fill 칸 수 = floor(가용 폭 / 최소 칸), 칸 폭 = 가용 폭 / 칸 수(gap 0). 폰 시트 가용 폭: 320폰 ~270 → 720 경계 ~670
  for (let avail = 200; avail <= 700; avail += 0.5) {
    const n = Math.max(1, Math.floor(avail / trackMin)); const cell = avail / n;
    if (avail >= btnMin) assert.ok(cell >= btnMin - 1e-9, `가용 폭 ${avail}px: 칸 ${cell}px < 단추 ${btnMin}px`);
  }
  assert.equal(decl(bodyOf('.msgr-emojipop.phone .grid'), 'gap'), '0', '칸 사이 틈 0(칸 폭 계산이 위와 같다)');
});

test('폰 단추는 칸을 채우고(width 100%) 누름 크기를 줄이는 min-width·max-width 덮어쓰기가 없다', () => {
  const b = bodyOf('.msgr-emojipop.phone .grid button');
  assert.equal(decl(b, 'width'), '100%');
  assert.equal(decl(b, 'min-width'), undefined, '폰 단추 규칙에 min-width를 다시 쓰지 않는다(0으로 낮추면 누름 폭이 칸 폭(<44px)이 된다)');
  assert.equal(decl(b, 'max-width'), undefined);
});

test('측정값 판정 — 넘침(scrollWidth>clientWidth·칸 밖·이웃과 겹침)과 44px 미만 누름 크기를 잡고, 정상값은 통과시킨다', () => {
  const ok = { viewport: 390, bodyScroll: 340, bodyClient: 340, gridScroll: 0, columns: [7], buttons: 319, cellOverflow: 0, neighborOverlap: 0, outsideSheet: 0, minButtonW: 48.57, minButtonH: 44 };
  assert.deepEqual(verifyEmojiSheet(ok), [], '고친 뒤 값(7칸×48.57px)은 통과');
  // 수정 전 실측(390, ego): 칸 42.5px 안에 단추 44px → 본문 342>340, 칸마다 1.5px 넘침
  const before = { ...ok, bodyScroll: 342, gridScroll: 2, columns: [8], cellOverflow: 1.5, neighborOverlap: 1.5, minButtonW: 44 };
  const f = verifyEmojiSheet(before);
  assert.ok(f.some((x) => /가로로 넘치지 않는다\(scrollWidth/.test(x)), f);
  assert.ok(f.some((x) => /자기 칸을 넘지 않는다/.test(x)), f);
  assert.ok(f.some((x) => /이웃 단추와 겹치지 않는다/.test(x)), f);
  // `min-width: 0`만 넣은 수정 — 넘침은 없지만 누르는 폭이 칸 폭 42.5px로 줄어 44px 미만
  const shrunk = { ...ok, columns: [8], minButtonW: 42.5 };
  assert.ok(verifyEmojiSheet(shrunk).some((x) => /누르는 영역 44px 이상/.test(x)), 'min-width:0 수정은 누름 폭을 줄여 판정이 막는다');
  assert.deepEqual(verifyEmojiSheet(null), ['반응 시트가 열려 있지 않다']);
});
