// 업무 · 자동화 목록 한 줄 정렬(유건 제보 2026-09-27) — 항목마다 이름 한 줄 + 말줄임, 소속·상태 배지가 줄어들지 않고
// 카드마다 같은 자리에 온다. 긴 이름이 3줄로 접히며 배지가 카드마다 다른 자리로 밀리던 회귀를 소스 계약으로 고정한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('자동화·루틴 카드 윗줄 — 제목은 한 줄 말줄임, 소속·상태 배지는 줄지 않는다', () => {
  const css = readFileSync(new URL('../src/work-panel.css', import.meta.url), 'utf8');
  assert.match(css, /\.work-item-top strong \{[^}]*white-space: nowrap;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/, '제목 줄바꿈 대신 말줄임');
  assert.doesNotMatch(css, /\.work-item-top \{ align-items: flex-start; \}/, '접힌 윗줄은 가운데 정렬 — 여러 줄을 전제로 한 위쪽 정렬 금지');
  assert.match(css, /\.work-item-title \{[^}]*flex: 1 1 auto;/, '제목 칸이 줄어드는 몫을 가져간다');
  assert.match(css, /\.work-source-badge \{ flex: none;/, '소속 배지는 줄지 않는다 — 카드마다 같은 폭');
  assert.match(css, /\.work-status \{ flex: none;/, '상태 배지는 줄지 않는다 — 카드마다 같은 자리');

  const jsx = readFileSync(new URL('../src/work-panel.jsx', import.meta.url), 'utf8');
  assert.match(jsx, /<strong title=\{automation\.title\}>\{automation\.title\}<\/strong>/, '잘린 제목도 가리키면 전체를 볼 수 있어야 한다');
  assert.match(jsx, /<strong title=\{routine\.title\}>\{routine\.title\}<\/strong>/);
});
