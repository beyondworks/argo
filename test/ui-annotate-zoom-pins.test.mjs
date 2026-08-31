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
  // 노트 줄: 무공백 긴 토큰(URL 등) 강제 줄바꿈
  assert.match(block, /overflowWrap: 'anywhere'[^}]*\}\}>→ \{a\.note\}/, '노트 줄에 overflowWrap anywhere');
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
  // 구간: ZoomCard의 btn 스타일 선언 전체 — 표현식 전체를 앵커한다(부분 앵커 오타겟 선례).
  const decl = settingsSrc.match(/const btn = \{[^}]*\};/)?.[0];
  assert.ok(decl, 'ZoomCard btn 스타일 선언');
  assert.match(decl, /justifyContent: 'center'/, '글리프 가운데 정렬은 justifyContent가 정답');
  assert.doesNotMatch(decl, /textAlign/, 'flex에서 무효한 textAlign 처방으로 되돌아가면 안 된다');
});
