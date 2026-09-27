// 폰 컴포저 첨부 칩 vs 멘션 후보창 겹침(유건 제보 2026-09-27, 재검수 2026-09-27) — 1차 수정은 고정 68px 오프셋을
// 썼는데, 칩이 2개 이상이면 실제 높이보다 모자라 후보창이 첫 칩 위에 겹쳐 떴다(실측: overlapPx>0).
// 고정값 대신 칩 묶음(.msgr-filechips)을 후보창과 같은 정상 흐름 형제로 렌더해, 후보창의 bottom: calc(100% + 8px)이
// 부모의 실제 쌓인 높이를 따라가게 했다 — 칩 0·1·2·3개 모두 겹침 0px(실측: apps/messenger 재검수 스크린샷).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('첨부 칩 묶음은 한 번만 만들고(fileChipsNode), 폰은 알약(form) 앞 형제로, 데스크톱은 툴바 안에 렌더', () => {
  assert.match(app, /const fileChipsNode = files\.length > 0 && <span className="msgr-filechips">/, '칩 묶음 노드는 한 번만 계산 — 두 자리에서 같은 마크업 중복 금지');
  assert.match(app, /<span className="filechip-name">\{f\.name\}<\/span>/, '파일명은 별도 span — 이름만 줄어들어 말줄임');
  assert.match(app, /\{phone && fileChipsNode\}\s*\n\s*<form className=\{`msgr-composer/, '폰: 칩 줄이 알약(form) 바로 앞 형제 — 멘션 후보창과 같은 흐름');
  assert.match(app, /\{!phone && fileChipsNode\}/, '데스크톱: 칩이 기존처럼 툴바 줄 안에');
});

test('.filechip 기본 모양은 .msgr-tools 스코프가 아니다 — 폰에서 .msgr-tools 밖(.msgr-filechips 안)에 렌더돼도 모양이 빠지면 안 된다', () => {
  assert.match(css, /^\.filechip \{ display: inline-flex;/m, '.msgr-tools .filechip 이 아니라 .filechip 자체에 걸어야 폰에서도 적용된다');
  assert.doesNotMatch(css, /\.msgr-tools \.filechip \{/, '스코프를 좁히는 옛 선택자가 되살아나면 폰에서 다시 모양이 빠진다');
});

test('폰: 첨부 칩 줄은 정상 흐름 요소(margin만, position:absolute 아님) — 멘션 후보창 오프셋을 고정값으로 미리 계산하지 않는다', () => {
  assert.match(css, /\.msgr-phone [^\n]*\.msgr-filechips \{ display: flex; flex-direction: column;[^}]*margin: 0 var\(--ph-pad\) 6px; \}/, '알약 앞 형제로 정상 흐름 — position:absolute면 후보창이 실제 높이를 못 따라간다');
  assert.doesNotMatch(css, /\.msgr-filechips \{[^}]*position: absolute/, '칩 줄에 절대배치를 다시 걸면 멘션 후보창 오프셋 계산이 고정값 추측으로 되돌아간다');
  assert.doesNotMatch(css, /\.msgr-pop:has\(~ \.msgr-composer \.filechip\)/, '후보창에 칩 존재 여부로 고정 px를 더하는 :has() 땜질은 칩 개수마다 값이 달라 겹침이 재발한다 — 정상 흐름 배치로 대체');
});

test('폰: 첨부가 있으면 빈 칸 안내용 @ 글리프를 숨긴다 — 칩이 형제로 이동했으니 :has(.filechip) 대신 형제 결합자로', () => {
  assert.match(css, /\.msgr-phone [^\n]*\.msgr-filechips ~ \.msgr-composer \.msgr-tools \.tb:nth-child\(2\) \{ display: none; \}/);
});

test('폰: 크기 표시·삭제 버튼은 줄지 않는다 — 안 그러면 이름 옆 나머지가 한 글자씩 세로로 쪼개진다', () => {
  assert.match(css, /\.filechip \.msgr-klabel, \.filechip \.x \{ flex: none; white-space: nowrap; \}/);
});

test('폰: 삭제(×) 버튼은 탭 영역 44px을 유지하되 시각 상자는 작게 — 안 그러면 크기표시와 × 사이가 벌어져 보인다', () => {
  assert.match(css, /\.msgr-phone \.filechip \.x \{ position: relative; min-width: 0; min-height: 0; width: 14px; height: 14px;/, '보이는 상자는 작게');
  assert.match(css, /\.msgr-phone \.filechip \.x::before \{ content: ''; position: absolute; inset: -15px; \}/, '보이지 않는 탭 영역은 44×44 유지(접근성)');
});

test('멘션 후보창 배경은 기존 --card 토큰(라이트·다크 모두 불투명 hex) — 별도 투명도/블러를 걸지 않는다', () => {
  assert.match(css, /\.msgr-pop \{ position: absolute; bottom: calc\(100% \+ 8px\); left: 0; z-index: 40;[^}]*background: var\(--card\);/);
  assert.doesNotMatch(css, /\.msgr-pop \{[^}]*(opacity: 0\.|backdrop-filter)/, '후보창에 반투명·블러를 걸면 뒤 칩 글자가 비친다');
});
