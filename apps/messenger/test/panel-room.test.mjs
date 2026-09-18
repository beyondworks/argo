// 우측 패널이 열리면 본문이 패널 왼쪽 공간만 쓴다(유건 제보 2026-09-18: 패널이 입력창·전송 버튼을 덮음, 0.1.28부터).
// 행동 확인은 픽스처(test/msgr-ui-feedback.*) 폭별 실측으로 했다 — 여기는 그 규칙의 구조와 수치가 서로 맞는지 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const OPEN = '.msgr-main:has(> .msgr-sheetwrap > .msgr-crewsheet:not(.msgr-dmpeek))';
const PANEL = 380 + 24; // .msgr-crewsheet 폭 + 오른쪽 띄움
const num = (re) => Number(css.match(re)?.[1]);

test('패널 폭과 비킴 폭이 같다 — 패널 규칙이 바뀌면 비킴 수치도 같이 바뀌어야 한다', () => {
  assert.match(css, /\.msgr-crewsheet \{ position: absolute; top: calc\(var\(--msgr-top-h, 63px\) \+ 9px\); right: 24px; width: min\(380px,/, '패널 폭 380 + 오른쪽 24, 위는 상단 바 실제 높이 아래(#603)');
  assert.equal(num(/@container msgr-main \(min-width: (\d+)px\)/), 640 + PANEL, '둘 다 비키는 경계 = 글 폭 640 + 패널');
  assert.equal(num(/calc\(\(100% - (\d+)px\) \/ 2\)\) \+ 404px\)/), 720 + PANEL, '가운데 정렬 기준 = 스레드 최대 720 + 패널');
  assert.ok(css.includes(`${OPEN} > .msgr-dock { padding-left: calc(24px + var(--sbw, 0px)); padding-right: calc(${PANEL + 24}px + var(--sbw, 0px)); }`), '좁을 때는 입력창만 패널 왼쪽까지');
  assert.ok(css.includes(`${OPEN} > .msgr-dock > div { min-width: 280px; }`), '입력창 하한 280');
});

test('데스크톱에서만, 열린 패널에만 — 폰 시트와 아래에서 뜨는 dmpeek는 제외', () => {
  const rules = css.split('\n').filter((l) => l.includes(':has(> .msgr-sheetwrap > .msgr-crewsheet'));
  assert.ok(rules.length >= 4);
  for (const l of rules) assert.match(l, /\.msgr-shell:not\(\.msgr-phone\) \.msgr-main:has\(> \.msgr-sheetwrap > \.msgr-crewsheet:not\(\.msgr-dmpeek\)\)/);
  assert.match(css, /\.msgr-shell:not\(\.msgr-phone\) \.msgr-main \{ container: msgr-main \/ inline-size; \}/);
});

test('여백은 패널 등장(msgrPopIn)과 같은 180ms 곡선으로 옮기고 움직임 줄이기 설정에서는 즉시', () => {
  assert.match(css, /\.msgr-crewsheet \{[^}]*animation: msgrPopIn 180ms cubic-bezier\(\.23,1,\.32,1\)/, '패널 등장 곡선 — 바뀌면 여백 곡선도 같이 바꾼다(검수 #600 LOW-1)');
  assert.match(css, /\.msgr-shell:not\(\.msgr-phone\) \.msgr-main > \.msgr-thread, \.msgr-shell:not\(\.msgr-phone\) \.msgr-main > \.msgr-dock \{ transition: padding 180ms cubic-bezier\(\.23,1,\.32,1\); \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.msgr-shell:not\(\.msgr-phone\) \.msgr-main > \.msgr-thread, \.msgr-shell:not\(\.msgr-phone\) \.msgr-main > \.msgr-dock \{ transition: none; \} \}/);
});
