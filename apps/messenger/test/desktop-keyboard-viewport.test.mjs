import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 총괄 실측(2026-09-27, native-landscape-14-right-draftkept.png): 아이패드 데스크톱 배치(넓은 폭)에서
// 소프트 키보드가 뜨면 입력창 아랫부분(첨부·멘션·보내기)이 키보드 위 도구 막대에 가려지고, 웹뷰가
// 포커스한 칸을 보여주려고 문서 전체를 위로 스크롤해 머리(레일 로고·채널명)가 화면 밖으로 밀렸다.
// 원인 ①: html.msgr-kb(mobile-viewport.js가 visualViewport로 계산)가 .msgr-phone 스코프에만 있어
// 데스크톱 폭에는 셸을 visualViewport 높이에 고정하는 규칙이 없었다.
// 원인 ②(1차 수정 뒤 총괄 재확인으로 발견): position:fixed + height만 넣고 grid-template-rows를
// 안 넣으면 grid 행이 auto로 잡혀 .msgr-main/.msgr-side의 height:100%가 셸의 줄어든 높이가 아니라
// 콘텐츠 높이(스레드 실제 길이, 예 1376px)를 기준으로 계산돼 셸 밖으로 넘쳤다 — 헤더가 화면 위로
// 밀려나고 컴포저가 안 잘려도 레이아웃 자체가 셸을 벗어났다. ego-browser로 getBoundingClientRect
// 실측 후 grid-template-rows: minmax(0, 1fr) 추가로 확인.
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

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
function declarationsFor(selectorLine) {
  const idx = css.indexOf(selectorLine);
  assert.ok(idx >= 0, `선택자를 못 찾음: ${selectorLine}`);
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}
const all = rules(css);

test('넓은 폭(데스크톱 배치) + 터치 기기에서 셸이 visualViewport 높이에 고정된다 — 폭 제한 없음', () => {
  const r = all.find((x) => x.sel === '.msgr-shell:not(.msgr-phone)' && x.at.some((a) => /\(pointer:\s*coarse\)/.test(a)));
  assert.ok(r, '.msgr-shell:not(.msgr-phone)가 (pointer: coarse) 블록에 없다');
  assert.ok(!r.at.some((a) => /max-width|min-width/.test(a)), '폭 제한이 걸려 있으면 안 된다 — 아이패드 세로·가로 폭 모두에 적용돼야 한다');
  const decl = declarationsFor('.msgr-shell:not(.msgr-phone) {\n    position: fixed;');
  assert.match(decl, /position:\s*fixed/, 'position: fixed 없음 — 문서 전체 스크롤을 못 막는다');
  assert.match(decl, /height:\s*var\(--msgr-viewport-height/, '--msgr-viewport-height를 안 쓴다');
  assert.match(decl, /top:\s*var\(--msgr-viewport-top/, '--msgr-viewport-top를 안 쓴다');
  assert.match(decl, /overflow:\s*hidden/, 'overflow: hidden 없음 — 셸 자신이 scrollIntoView 대상이 돼 채널 머리가 위로 밀렸다(실사고 2026-09-27 재확인)');
  assert.match(decl, /grid-template-rows:\s*minmax\(0,\s*1fr\)/, 'grid-template-rows 없음 — 행이 auto가 되면 .msgr-main/.msgr-side의 height:100%가 셸이 아니라 콘텐츠 높이 기준이 된다(실사고 2026-09-27)');
});

test('그 안에서 .msgr-main·.msgr-side 둘 다 셸의 100%로 맞춰진다 — 100vh/콘텐츠 높이 기준으로 새면 안 된다', () => {
  const r = all.find((x) => x.sel === '.msgr-shell:not(.msgr-phone) .msgr-main, .msgr-shell:not(.msgr-phone) .msgr-side' && x.at.some((a) => /\(pointer:\s*coarse\)/.test(a)));
  assert.ok(r, '.msgr-main·.msgr-side 규칙이 (pointer: coarse) 블록에 없다');
  const decl = declarationsFor('.msgr-shell:not(.msgr-phone) .msgr-main, .msgr-shell:not(.msgr-phone) .msgr-side { height: 100%;');
  assert.match(decl, /height:\s*100%/, '100%로 안 맞춰져 있다');
  assert.match(decl, /overflow:\s*hidden/, 'overflow: hidden 없음 — 내부 스크롤이 셸 밖으로 넘칠 수 있다');
});

test('맥·윈도우(마우스, pointer: fine)는 이 규칙에 안 걸린다 — 화면이 바뀌면 안 된다', () => {
  // pointer: coarse 미디어 쿼리는 정의상 마우스·트랙패드(pointer: fine)에서 매치되지 않는다.
  // 이 셀렉터가 다른 폭/포인터 제한 없는 블록에도 중복 정의돼 있지 않은지 확인한다.
  const dup = all.filter((x) => x.sel === '.msgr-shell:not(.msgr-phone)' && !x.at.some((a) => /\(pointer:\s*coarse\)/.test(a)) && x.at.length === 0);
  assert.deepEqual(dup, [], '최상위(미디어 쿼리 밖)에 같은 셀렉터가 있으면 맥·윈도우에도 적용된다');
});
