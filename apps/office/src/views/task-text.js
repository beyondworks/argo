// 페이지 → 새 할 일에 채울 글(유건 10/4 '할 일로 만들기') — 순수 함수. 창은 views/task-new.jsx, 규칙은 test/task-props.test.mjs.
import { docText } from '../core/crew-assign.js';

export const NOTE_MAX = 1000;

/** 페이지 본문(편집기 문서) → 메모에 넣을 앞부분. 첫 줄이 페이지 제목과 같으면 뺀다(제목은 할 일 제목으로 따로 들어간다), 빈 줄은 두 줄까지 */
export function pageExcerpt(title, content, max = NOTE_MAX) {
  const lines = docText(content).split('\n').map((l) => l.trimEnd());
  while (lines.length && !lines[0].trim()) lines.shift();
  if (lines.length && lines[0].trim() === String(title ?? '').trim()) lines.shift();
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}
