// 점검 A·B #10 — 데스크톱에서 오른쪽 패널(업무 창·채널 패널)이 열리면 말풍선·시각의 오른쪽 끝을 덮던 결함.
// 재현(ego, QA DB, 업무 창 열기): 창 1440에서는 본문(.msgr-main) 폭이 1172라 스레드 오른쪽 여백이 428로 늘어 겹침 없음.
// 창 1280(본문 1012)에서는 스레드 여백이 146 그대로라 말풍선 오른쪽 끝(1126)이 패널 왼쪽(876)보다 250px 안쪽까지 들어가 덮였다.
// 원인: 스레드가 비키는 규칙이 본문 폭 1044px 이상에서만 있었다(그보다 좁으면 입력창만 비킴). 지금은 입력창이 비킬 수 있는 폭(732px)부터 스레드도 비킨다.
// 이 테스트는 규칙의 문턱을 잠근다 — 실제 겹침은 브라우저에서 측정해 확인한다(scratchpad/uxqa/fix-AB).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

// @container msgr-main (min-width: N) { ... } 블록을 괄호를 세어 꺼낸다
function containerBlocks(min) {
  const out = []; const re = /@container msgr-main \(min-width: (\d+)px\)\s*\{/g; let m;
  while ((m = re.exec(css))) {
    let depth = 1; let i = re.lastIndex;
    while (depth > 0 && i < css.length) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++; }
    out.push({ min: Number(m[1]), body: css.slice(re.lastIndex, i - 1) });
  }
  return out;
}

const AVOID = /\.msgr-main:has\(> \.msgr-sheetwrap > \.msgr-crewsheet:not\(\.msgr-dmpeek\)\) > \.msgr-thread \{[^}]*padding-right:[^;}]*404px/;

test('패널이 열렸을 때 스레드가 비키는 규칙의 문턱은 입력창이 비키는 문턱(732px) 이하다', () => {
  const blocks = containerBlocks().filter((b) => AVOID.test(b.body));
  assert.ok(blocks.length >= 1, '스레드가 패널 폭(404)만큼 비키는 규칙이 컨테이너 쿼리 안에 있다');
  assert.ok(Math.min(...blocks.map((b) => b.min)) <= 732, `문턱 ${Math.min(...blocks.map((b) => b.min))}px — 1044px면 본문 1012px에서 말풍선이 패널 밑으로 들어간다`);
});

test('입력창이 패널 옆에 못 서는 폭(731 이하)에서는 종전대로 패널이 받침 위에서 끝난다 — 이 규칙은 그대로', () => {
  assert.match(css, /@container msgr-main \(max-width: 731px\)/);
});
