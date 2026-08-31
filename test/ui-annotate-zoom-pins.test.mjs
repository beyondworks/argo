// 빨간펜 패널 돌출·배율 버튼 정렬 회귀 핀 (2026-08-31 유건 제보 2건)
// JSX 시각 속성은 소스 구간 불변식으로만 잠긴다(기억 그래프 빈 하늘 선례) — 행동 재현은
// 브라우저 실측(격리 서버)이 담당했고, 여기서는 처방이 소스에서 사라지는 회귀만 문다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const crewSrc = await readFile(new URL('../app/c/[ws]/crew/[slug]/page.jsx', import.meta.url), 'utf8');
const settingsSrc = await readFile(new URL('../app/c/[ws]/settings/page.jsx', import.meta.url), 'utf8');

test('빨간펜 항목 행: grid 자식 minWidth 0 잠금 (없으면 nowrap 인용·무공백 노트가 행을 패널 밖 ~1000px 돌출)', () => {
  // 구간: annotItems.map 렌더 블록 전체 — 행 여는 태그에 minWidth: 0이 있어야 한다.
  const start = crewSrc.indexOf('{annotItems.map((a, j) => (');
  assert.ok(start > 0, 'annotItems.map 렌더 블록이 존재해야 한다');
  const block = crewSrc.slice(start, crewSrc.indexOf('))}', start));
  const rowTag = block.match(/<div key=\{j\} style=\{\{[^}]*\}\}/)?.[0];
  assert.ok(rowTag, '항목 행 여는 태그');
  assert.match(rowTag, /minWidth: 0/, '항목 행(grid 자식)에 minWidth: 0 — 암묵 min-width:auto 차단');
});

test('빨간펜 노트 줄바꿈의 원천: globals.css `.thread .card` 상속 (분리 검수 F3 — 인라인은 무동작 중복이라 두지 않는다)', async () => {
  // 무공백 긴 노트(URL 등)의 줄바꿈은 이 규칙의 상속이 보장한다(2026-08-21 제보 처방). 이 규칙이
  // 사라지면 minWidth: 0만으로는 무공백 노트가 다시 행을 민다 — 원천을 직접 잠근다.
  const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /\.thread \.card, \.msg-user \{ overflow-wrap: anywhere; min-width: 0; \}/, '상속 원천 규칙 존재');
});

test('빨간펜 인용 대기 블록: grid 자식 minWidth 0 잠금', () => {
  const start = crewSrc.indexOf('{pendQuote ? (');
  assert.ok(start > 0);
  const block = crewSrc.slice(start, start + 400);
  const tag = block.match(/<div style=\{\{ display: 'grid', gap: 6[^}]*\}\}/)?.[0];
  assert.ok(tag, 'pendQuote 컨테이너 여는 태그');
  assert.match(tag, /minWidth: 0/, 'pendQuote 컨테이너(grid 자식)에 minWidth: 0');
});

test('배율 −/+ 버튼: flex 컨테이너 가운데 정렬 (justifyContent — textAlign은 flex 자식에 무효)', () => {
  // 구간을 ZoomCard 함수 몸통으로 한정(분리 검수 F1 — 파일 전역 첫 `const btn` 매치는 다른 카드의
  // 동명 선언에 오타겟된다: "부분 앵커 오타겟[x3]" 재발형). 이웃 함수 선언을 폐합 앵커로 쓴다.
  const zStart = settingsSrc.indexOf('function ZoomCard()');
  const zEnd = settingsSrc.indexOf('function CrewLanguageCard');
  assert.ok(zStart > 0 && zEnd > zStart, 'ZoomCard 구간 확보');
  const zoom = settingsSrc.slice(zStart, zEnd);
  const decl = zoom.match(/const btn = \{[^}]*\};/)?.[0];
  assert.ok(decl, 'ZoomCard btn 스타일 선언');
  assert.match(decl, /justifyContent: 'center'/, '글리프 가운데 정렬은 justifyContent가 정답');
  assert.doesNotMatch(decl, /textAlign/, 'flex에서 무효한 textAlign 처방으로 되돌아가면 안 된다');
  // 배선(분리 검수 F2) — 선언만 잠그면 style={btn}을 인라인 객체로 풀며 justifyContent를 빠뜨리는
  // 변이에 침묵한다. −/+ 두 버튼이 이 선언을 실제로 소비하는지까지 잠근다.
  assert.equal((zoom.match(/style=\{btn\}/g) ?? []).length, 2, '−/+ 두 버튼이 btn 선언을 소비');
});
